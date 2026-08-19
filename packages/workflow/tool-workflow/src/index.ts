/**
 * The model-facing `workflow` tool: launch a JavaScript orchestration script
 * that fans out subagents. It owns the model-facing schema and the launch
 * contract; discovery, execution, caps, script persistence, and cancellation
 * live behind `ctx.workflowSupervisor` (`@deepseek-ai/dsh-workflow-supervisor`),
 * so a launch returns immediately with the session display handle and the
 * supervisor owns the live run.
 *
 * Sources are exactly one of `name` (saved definition), `script` (inline body,
 * plus required `meta`), or `script_path` (a definition envelope or a bare
 * script file). `validate_only` smoke-checks one canned-host path without a
 * live run; `resume_from_run_id` resumes a same-process paused run with the
 * original immutable script, args, and budget.
 *
 * The generic tool card stays; the supervisor posts the completion notice and
 * this consumer still projects `tool-workflow/*` Session events for top-level
 * runs so the durable `workflow-run` Chat node keeps working.
 * @module @deepseek-ai/dsh-tool-workflow
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue, Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { WorkflowMeta, WorkflowRunId, WorkflowStopReason } from '@deepseek-ai/dsh-workflow'
import { parseDefinitionFile } from '@deepseek-ai/dsh-workflow-registry'
import type { WorkflowDefinition } from '@deepseek-ai/dsh-workflow-registry'
import type {
  ToolWorkflowAgentEndData, ToolWorkflowAgentStartData,
  ToolWorkflowRunEndData, ToolWorkflowRunStartData,
} from './types.ts'
// Declaration merge only: makes ctx.systemPrompt visible for the section registration.
import type {} from '@deepseek-ai/dsh-system-prompt'
// Declaration merge only: makes ctx.workflowSupervisor visible for the launch.
import type {} from '@deepseek-ai/dsh-workflow-supervisor'
// Declaration merge only: makes ctx.workflowSupervisor visible for the launch.
import type {} from '@deepseek-ai/dsh-workflow-registry'

export const name = 'tool-workflow'
export const inject = ['tools', 'systemPrompt']

/** Config: the model-facing tool name plus result rendering caps. */
export interface Config {
  /** The model-facing tool name to register (default `workflow`). */
  toolName?: string
  /** Rendered-result ceiling, in characters: a longer JSON value is truncated with a notice (default 50000). */
  maxResultChars?: number
}

export const Config: z<Config> = z.object({
  toolName: z.string().default('workflow'),
  maxResultChars: z.natural().min(1).default(50_000),
})

type ResolvedConfig = Required<Config>

interface WorkflowRecorder {
  start(session: Session, runId: WorkflowRunId, name: string): void
  abandon(runId: WorkflowRunId): void
}

interface ToolWorkflowRecordEventMap {
  'tool-workflow/run-start': ToolWorkflowRunStartData
  'tool-workflow/agent-start': ToolWorkflowAgentStartData
  'tool-workflow/agent-end': ToolWorkflowAgentEndData
  'tool-workflow/run-end': ToolWorkflowRunEndData
}

/** Render a contained recording failure without trusting the thrown value. */
function renderRecordingError(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/**
 * Project active top-level workflow runs into their parent Sessions without
 * letting recording failure affect tool execution. A background run now ends
 * through the `workflow/end` event, so the recorder owns finish on its own.
 */
function createWorkflowRecorder(ctx: Context): WorkflowRecorder {
  const active = new Map<WorkflowRunId, Session>()
  const append = <Type extends keyof ToolWorkflowRecordEventMap>(
    session: Session,
    type: Type,
    data: SessionEventMap[Type],
  ): boolean => {
    // These four package-owned events are all log-only. Narrowing the generic
    // append face here discharges Session.append's conditional options tuple.
    const appendRecord = session.append.bind(session) as <Event extends keyof ToolWorkflowRecordEventMap>(
      event: Event,
      value: SessionEventMap[Event],
    ) => void
    try {
      appendRecord(type, data)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`tool-workflow: disabled durable record after ${type} append failed: ${renderRecordingError(error)}`)
      return false
    }
  }
  const finish = (runId: WorkflowRunId, stopReason: WorkflowStopReason): void => {
    const session = active.get(runId)
    if (session !== undefined) append(session, 'tool-workflow/run-end', { runId, stopReason })
    active.delete(runId)
  }

  ctx.on('workflow/agent-start', (info, agent) => {
    const session = active.get(info.id)
    if (session === undefined) return
    const data: ToolWorkflowAgentStartData = {
      runId: info.id,
      seq: agent.seq,
      label: agent.label,
      ...agent.phase === undefined ? {} : { phase: agent.phase },
      childId: agent.childId,
    }
    if (!append(session, 'tool-workflow/agent-start', data)) active.delete(info.id)
  })
  ctx.on('workflow/agent-end', (info, agent) => {
    const session = active.get(info.id)
    if (session === undefined) return
    const data: ToolWorkflowAgentEndData = {
      runId: info.id,
      seq: agent.seq,
      outcome: agent.outcome,
    }
    if (!append(session, 'tool-workflow/agent-end', data)) active.delete(info.id)
  })
  ctx.on('workflow/end', (info, result) => { finish(info.id, result.stopReason) })

  return {
    start(session, runId, runName) {
      if (append(session, 'tool-workflow/run-start', { runId, name: runName })) {
        active.set(runId, session)
      }
    },
    abandon: (runId) => { active.delete(runId) },
  }
}

/**
 * The script-authoring contract, embedded in the tool description. This IS the
 * model-facing spec: the meta block, the hooks and their exact semantics, and
 * the supported schema subset.
 */
const DESCRIPTION = `Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — where you write the orchestration as a script instead of delegating turn by turn.

Supply EXACTLY ONE source: \`name\` (a saved workflow in .dsh/workflows), \`script\` (an inline plain-JS body, plus the required \`meta\` object), or \`script_path\` (a .workflow.json envelope or a script file on disk, plus \`meta\` for a bare file).

The workflow's identity rides \`meta\` as JSON: required \`name\` (short kebab-case) and \`description\` strings, optional \`whenToUse\` string and \`phases\` array (\`{title, detail?, provider?, model?}\`). The script body is plain JavaScript ONLY (NOT TypeScript, and NO \`export const meta\` statement — meta is data beside the body), running with top-level await.

Script-body hooks:
- \`agent(prompt, opts?): Promise<any>\` — run one subagent to completion. Without \`opts.schema\` it resolves to the child's final text; with \`opts.schema\` (an object-rooted JSON Schema using ONLY type/properties/required/additionalProperties/items/enum/const/oneOf — no pattern/format/numeric bounds) it resolves to the validated object. Resolves \`null\` when the child fails (filter with \`.filter(Boolean)\`). Other opts: \`label\` (display), \`phase\` (progress group), and independent \`provider\`/\`model\` LLM target overrides (either may be provided alone). Anything else is rejected loudly.
- \`parallel(items): Promise<any[]>\` — run zero-argument functions OR job maps \`{prompt, label?, phase?, schema?, provider?, model?}\` concurrently and await ALL (a barrier). Failed slots resolve to \`null\`.
- \`pipeline(items, ...stages): Promise<any[]>\` — run each item through the stages independently with NO barrier between stages. Each stage receives \`(prev, item, index)\`.
- \`phase(title)\` — start a progress phase; \`log(message)\` — narrate progress; \`args\` — the tool call's \`args\` input, verbatim.
- \`complete(value)\` — end the run successfully with a JSON value (use this instead of \`return\`).
- \`await_user(kind, message)\` — park the run for a human answer; resume continues past it. \`pause(kind, message)\` — park a run for a condition resume cannot change; resume re-fires it. Kinds: user, back_off, no_progress, verification, infra.
- \`budget(): { total, spent, reserved, remaining }\` — this run's logical agent budget. \`write_scratch_file(name, content)\` / \`read_scratch_file(name)\` — per-run scratch storage (single-component names).

Misused hooks (bad arguments, unknown options, unsupported schemas, tripped caps) throw errors that ALWAYS kill the script — they never dissolve into a per-item \`null\`.

Launch is BACKGROUND: the call returns immediately with \`{ displayName, runId, script_path, status: "started" }\`; the supervisor owns the run and posts the final report to the conversation when it settles. Concurrency and total-agent caps apply; no filesystem, network, timers, or Node.js APIs are provided to the script — the agents do the work, the script only coordinates them. Set \`validate_only: true\` to smoke-check one canned-host path without launching children.`

type WorkflowCallArgs = {
  name?: string
  script?: string
  script_path?: string
  meta?: WorkflowMeta
  args?: Record<string, unknown>
  validate_only?: boolean
  resume_from_run_id?: string
  agent_budget?: number
}

/** The pending-state card: a generic card titled by the workflow identity. */
function presentWorkflowCall(args: WorkflowCallArgs): ToolCallView {
  const title = args.name ?? args.meta?.name ?? 'workflow'
  return {
    card: 'generic',
    title: `workflow: ${title}`,
    ...args.script !== undefined ? { rawInput: args.script } : {},
  }
}

/** The completed-state card: keep the pending title; render the result content as-is. */
function presentWorkflowResult(args: WorkflowCallArgs, result: { content: ContentBlock[]; isError: boolean }): ToolResultView {
  void args
  void result
  return { card: 'generic' }
}

/** Resolve one launch source into a supervisor-start spec; a missing/ambiguous source fails loud. */
async function resolveSource(
  ctx: Context,
  args: WorkflowCallArgs,
): Promise<{ definition?: WorkflowDefinition; script?: string; meta?: WorkflowMeta }> {
  const sources = [args.name, args.script, args.script_path].filter(source => source !== undefined)
  if (sources.length === 0) {
    throw new Error('workflow requires one source: name, script (with meta), or script_path')
  }
  if (sources.length > 1) {
    throw new Error('workflow accepts exactly ONE source: name, script, or script_path — not a combination')
  }
  if (args.name !== undefined) {
    const cwd = process.cwd()
    const workflows = ctx.get('workflows')
    if (workflows === undefined) throw new Error('workflow registry is unavailable in this composition')
    const definition = await workflows.get(args.name, { cwd })
    if (definition === undefined) throw new Error(`no saved workflow named "${args.name}"`)
    return { definition }
  }
  if (args.script !== undefined) {
    if (args.meta === undefined) throw new Error('workflow script source requires the meta object')
    return { script: args.script, meta: args.meta }
  }
  // script_path: a .workflow.json envelope, or a bare script file with meta.
  const raw = await readFile(args.script_path as string, 'utf8')
  if ((args.script_path as string).endsWith('.workflow.json')) {
    const baseName = (args.script_path as string).slice((args.script_path as string).lastIndexOf('/') + 1, -'.workflow.json'.length)
    return { definition: { ...parseDefinitionFile(raw, args.script_path as string, baseName), scope: 'project' } }
  }
  if (args.meta === undefined) throw new Error('workflow script_path to a bare script requires the meta object')
  return { script: raw, meta: args.meta }
}

/** Render the launch/validate outcome for the tool result. */
function renderLaunch(value: { status: string; displayName?: string; result?: JsonValue }, maxChars: number): string {
  if (value.status === 'validated') {
    const rendered = JSON.stringify(value.result ?? null, null, 2)
    const clipped = rendered.length > maxChars ? `${rendered.slice(0, maxChars)}\n… [truncated]` : rendered
    return `workflow smoke check passed.\nResult:\n${clipped}`
  }
  if (value.status === 'started') return `workflow "${value.displayName ?? ''}" started in the background. Watch it with /workflows.`
  return `workflow "${value.displayName ?? ''}" resumed.`
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (the exported Config schema) has already filled the defaulted
  // fields; the assertion records that resolution, not a hidden fallback.
  const { toolName, maxResultChars } = config as ResolvedConfig
  const recorder = createWorkflowRecorder(ctx)
  const supervisor = ctx.get('workflowSupervisor')
  // Usage policy ships with the tool (the master convention: tool guidance
  // lives in tool plugins as prompt sections, not in the deployment persona).
  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: 115,
    text: `Use the ${toolName} tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.`,
  })
  ctx.tools.register(defineTool({
    name: toolName,
    description: DESCRIPTION,
    parameters: {
      name: {
        type: 'string',
        description: 'Saved workflow definition name to launch (one of name/script/script_path).',
      },
      script: {
        type: 'string',
        description: 'The plain-JS workflow script body (top-level await allowed; NO `export const meta` statement). Requires `meta`.',
      },
      script_path: {
        type: 'string',
        description: 'A .workflow.json envelope or a bare script file on disk to launch. A bare file requires `meta`.',
      },
      meta: {
        type: 'object',
        additionalProperties: true,
        description: 'The workflow identity block (plain JSON — never code); required with script or a bare script_path.',
        properties: {
          name: { type: 'string', required: true, description: 'Short kebab-case workflow name.' },
          description: { type: 'string', required: true, description: 'One-line description of what the workflow does.' },
          whenToUse: { type: 'string', description: 'Optional guidance on when this workflow applies.' },
          phases: {
            type: 'array',
            description: 'Optional phase declarations matched by phase() calls.',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                title: { type: 'string', required: true, description: 'The phase title phase() calls match by exact string.' },
                detail: { type: 'string', description: 'Optional one-line description of the phase.' },
                provider: { type: 'string', description: 'Optional provider override this phase is expected to use.' },
                model: { type: 'string', description: 'Optional model override this phase is expected to use.' },
              },
            },
          },
        },
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional JSON input exposed to the script as the `args` global (wrap a bare list as a field, e.g. {"files": [...]}).',
      },
      validate_only: {
        type: 'boolean',
        description: 'Smoke-check one canned-host path instead of starting a live run (no children, no run record).',
      },
      resume_from_run_id: {
        type: 'string',
        description: 'Resume a same-process paused run by its run id; reject combining with name/script/script_path.',
      },
      agent_budget: {
        type: 'integer',
        description: 'Absolute logical-agent cap for this run (default 128, allowed 1–1024).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          displayName: { type: 'string' },
          runId: { type: 'string' },
          script_path: { type: 'string' },
          ok: { type: 'boolean' },
          result: { type: 'json' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderLaunch(value as { status: string; displayName?: string; result?: JsonValue }, maxResultChars),
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        // The loop sets `exec.agent` for every model-driven call; its absence
        // means a non-agent caller invoked the tool directly, which has no
        // parent to attribute the children to. Fail loud rather than guess.
        throw new Error('workflow tool requires a calling agent (exec.agent was undefined)')
      }
      if (supervisor === undefined) throw new Error('workflow supervisor is unavailable in this composition')

      // Resume path: the original immutable script, args, and budget.
      if (args.resume_from_run_id !== undefined) {
        if (args.name !== undefined || args.script !== undefined || args.script_path !== undefined) {
          throw new Error('workflow resume_from_run_id cannot be combined with name, script, or script_path')
        }
        const displayName = supervisor.resumeById(args.resume_from_run_id, parent)
        return { status: 'resumed', displayName, runId: args.resume_from_run_id }
      }

      const source = await resolveSource(ctx, args)

      // Smoke check: no live run, no destination record, no dashboard row.
      if (args.validate_only === true) {
        const validation = await supervisor.validate({
          ...source,
          ...args.args !== undefined ? { args: args.args } : {},
          parent,
        })
        if (!validation.ok) throw new Error(validation.error)
        return { status: 'validated', ok: true, result: validation.result as JsonValue }
      }

      const launched = await supervisor.start({
        ...source,
        ...args.args !== undefined ? { args: args.args } : {},
        ...args.agent_budget !== undefined ? { agentBudget: args.agent_budget } : {},
        parent,
      })
      // Project the top-level run into the parent Session for the durable
      // workflow-run Chat node; nested transport calls write no record.
      if (exec.parent === undefined) recorder.start(parent.session, launched.runId, source.meta?.name ?? source.definition?.name ?? '')
      return {
        status: 'started',
        displayName: launched.displayName,
        runId: launched.runId,
        ...launched.scriptPath !== undefined ? { script_path: launched.scriptPath } : {},
      }
    },
    presentCall: args => presentWorkflowCall(args),
    presentResult: (args, result) => presentWorkflowResult(args, result),
  }))
}
