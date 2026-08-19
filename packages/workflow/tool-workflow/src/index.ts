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
 * `ctx.workflowRunRecorder` projects explicitly top-level launches into the
 * durable `workflow-run` Chat node.
 * @module @deepseek-ai/dsh-tool-workflow
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { WorkflowMeta } from '@deepseek-ai/dsh-workflow'
import { parseDefinitionFile } from '@deepseek-ai/dsh-workflow-registry'
import type { WorkflowDefinition } from '@deepseek-ai/dsh-workflow-registry'
import { SupervisedWorkflowRunId } from '@deepseek-ai/dsh-workflow-supervisor'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { SupervisedWorkflowRunId as LogicalRunId } from '@deepseek-ai/dsh-workflow-supervisor/types'
// Declaration merge only: makes ctx.fs visible for session-world source reads.
import type {} from '@deepseek-ai/dsh-fs'
// Declaration merge only: makes ctx.systemPrompt visible for the section registration.
import type {} from '@deepseek-ai/dsh-system-prompt'
// Declaration merge only: makes ctx.workflowRunRecorder visible for root launch attribution.
import type {} from '@deepseek-ai/dsh-workflow-run-recorder'
// Declaration merge only: makes ctx.workflowSupervisor visible for the launch.
import type {} from '@deepseek-ai/dsh-workflow-supervisor'
// Declaration merge only: makes ctx.workflows visible for source discovery.
import type {} from '@deepseek-ai/dsh-workflow-registry'

export const name = 'tool-workflow'
export const inject = [
  'tools',
  'systemPrompt',
  'workflowSupervisor',
  'workflowRunRecorder',
  'workflows',
  'fs',
]

/** Config: the model-facing tool name plus rendering and source-size limits. */
export interface Config {
  /** The model-facing tool name to register (default `workflow`). */
  toolName?: string
  /** Rendered validate-only result ceiling in characters (default 50000). */
  maxResultChars?: number
  /** Maximum UTF-8 bytes accepted from one inline script or `script_path` file (default 1048576). */
  maxDefinitionBytes?: number
}

export const Config: z<Config> = z.object({
  toolName: z.string().default('workflow'),
  maxResultChars: z.natural().min(1).default(50_000),
  maxDefinitionBytes: z.natural().min(1).default(1024 * 1024),
})

type ResolvedConfig = Required<Config>

/** Validate and brand one model-supplied logical workflow-run identity. */
function parseSupervisedWorkflowRunId(value: string): LogicalRunId {
  if (value.length === 0) {
    throw new Error('workflow resume_from_run_id must be a non-empty string')
  }
  return SupervisedWorkflowRunId(value)
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
- \`agent(prompt, opts?): Promise<any>\` — run one subagent to completion. Without \`opts.schema\` it resolves to the child's final text; with \`opts.schema\` (an object-rooted JSON Schema using ONLY type/properties/required/additionalProperties/items/minItems/maxItems/enum/const/oneOf — \`minItems\`/\`maxItems\` are array-only non-negative integer bounds; no pattern/format/numeric bounds) it resolves to the validated object. Resolves \`null\` when the child fails (filter with \`.filter(Boolean)\`). Other opts: \`label\` (display), \`phase\` (progress group), and independent \`provider\`/\`model\` LLM target overrides (either may be provided alone). Anything else is rejected loudly.
- \`parallel(items): Promise<any[]>\` — run zero-argument functions OR job maps \`{prompt, label?, phase?, schema?, provider?, model?}\` concurrently and await ALL (a barrier). Failed slots resolve to \`null\`.
- \`pipeline(items, ...stages): Promise<any[]>\` — run each item through the stages independently with NO barrier between stages. Each stage receives \`(prev, item, index)\`.
- \`phase(title)\` — start a progress phase; \`log(message)\` — narrate progress; \`args\` — the tool call's \`args\` input, verbatim.
- \`complete(value)\` — end the run successfully with a JSON value (use this instead of \`return\`).
- \`await_user(kind, message)\` — park the run for a human answer; resume continues past it. \`pause(kind, message)\` — park a run for a condition resume cannot change; resume re-fires it. Kinds: user, back_off, no_progress, verification, infra.
- \`budget(): { total, spent, reserved, remaining }\` — this run's logical agent budget. \`write_scratch_file(name, content)\` / \`read_scratch_file(name)\` — per-run scratch storage (single-component names).

Misused hooks (bad arguments, unknown options, unsupported schemas, tripped caps) throw errors that ALWAYS kill the script — they never dissolve into a per-item \`null\`.

Launch is BACKGROUND: the call returns immediately with \`{ displayName, runId, script_path, status: "started" }\`; the supervisor owns the run and posts the final report to the conversation when it settles. Concurrency and total-agent caps apply; no filesystem, network, timers, or Node.js APIs are provided to the script — the agents do the work, the script only coordinates them. Set \`validate_only: true\` to smoke-check one canned-host path without launching children. To resume a paused, needs-input, or budget-limited run, supply only \`resume_from_run_id\` and optionally a higher \`agent_budget\` for a budget-limited run.`

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
  options: { cwd?: string; signal: AbortSignal; maxDefinitionBytes: number },
): Promise<{ definition?: WorkflowDefinition; script?: string; meta?: WorkflowMeta }> {
  const sources = [args.name, args.script, args.script_path].filter(source => source !== undefined)
  if (sources.length === 0) {
    throw new Error('workflow requires one source: name, script (with meta), or script_path')
  }
  if (sources.length > 1) {
    throw new Error('workflow accepts exactly ONE source: name, script, or script_path — not a combination')
  }
  if (args.name !== undefined) {
    if (args.meta !== undefined) throw new Error('workflow name source must not include meta; the saved definition owns it')
    const definition = await ctx.workflows.get(args.name, {
      ...options.cwd === undefined ? {} : { cwd: options.cwd },
      signal: options.signal,
    })
    if (definition === undefined) throw new Error(`no saved workflow named "${args.name}"`)
    return { definition }
  }
  if (args.script !== undefined) {
    if (args.meta === undefined) throw new Error('workflow script source requires the meta object')
    if (new TextEncoder().encode(args.script).byteLength > options.maxDefinitionBytes) {
      throw new Error(`workflow script exceeds the ${options.maxDefinitionBytes}-byte limit`)
    }
    return { script: args.script, meta: args.meta }
  }
  // script_path: a .workflow.json envelope, or a bare script file with meta.
  const scriptPath = args.script_path as string
  if (scriptPath.endsWith('.workflow.json')) {
    if (args.meta !== undefined) throw new Error('workflow .workflow.json source must not include meta; the envelope owns it')
    const raw = await readScriptPath(ctx, scriptPath, options)
    const fileName = scriptPath.replaceAll('\\', '/').slice(scriptPath.replaceAll('\\', '/').lastIndexOf('/') + 1)
    const baseName = fileName.slice(0, -'.workflow.json'.length)
    return { definition: { ...parseDefinitionFile(raw, scriptPath, baseName), scope: 'project' } }
  }
  if (args.meta === undefined) throw new Error('workflow script_path to a bare script requires the meta object')
  const raw = await readScriptPath(ctx, scriptPath, options)
  return { script: raw, meta: args.meta }
}

/** Read one bounded regular UTF-8 file through the session filesystem without following its final symlink. */
async function readScriptPath(
  ctx: Context,
  path: string,
  options: { cwd?: string; signal: AbortSignal; maxDefinitionBytes: number },
): Promise<string> {
  let bytes: Uint8Array
  try {
    bytes = await ctx.fs.readBytesNoFollow(
      path,
      options.cwd === undefined ? {} : { cwd: options.cwd },
      options.signal,
      options.maxDefinitionBytes,
    )
  } catch (error: unknown) {
    if (error instanceof FsError) {
      switch (error.code) {
        case 'FS_NOT_FOUND':
          throw new Error(`workflow script_path "${path}" was not found`, { cause: error })
        case 'FS_NOT_REGULAR_FILE':
          throw new Error(
            `workflow script_path "${path}" must be a regular file and must not be a symbolic link`,
            { cause: error },
          )
        case 'FS_TOO_LARGE':
          throw new Error(
            `workflow script_path "${path}" exceeds the ${options.maxDefinitionBytes}-byte limit`,
            { cause: error },
          )
        default:
          throw error
      }
    }
    throw error
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error(`workflow script_path "${path}" is not valid UTF-8`, { cause: error })
  }
}

type WorkflowToolOutput =
  | { status: 'started'; displayName: string; runId: string; script_path?: string }
  | { status: 'resumed'; displayName: string; runId: string }
  | { status: 'validated'; ok: true; result?: JsonValue }

/** Render the launch/validate outcome for the tool result. */
function renderLaunch(value: WorkflowToolOutput, maxChars: number): string {
  switch (value.status) {
    case 'validated': {
      const rendered = JSON.stringify(value.result ?? null, null, 2)
      const clipped = rendered.length > maxChars ? `${rendered.slice(0, maxChars)}\n… [truncated]` : rendered
      return `workflow smoke check passed.\nResult:\n${clipped}`
    }
    case 'started':
      return JSON.stringify(value)
    case 'resumed':
      return JSON.stringify(value)
    default:
      return assertNever(value, 'workflow tool output')
  }
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (the exported Config schema) has already filled the defaulted
  // fields; the assertion records that resolution, not a hidden fallback.
  const { toolName, maxResultChars, maxDefinitionBytes } = config as ResolvedConfig
  const recorder = ctx.workflowRunRecorder
  const supervisor = ctx.workflowSupervisor
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
        additionalProperties: false,
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
              additionalProperties: false,
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
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', const: 'started', required: true },
              displayName: { type: 'string', required: true },
              runId: { type: 'string', required: true },
              script_path: { type: 'string' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', const: 'resumed', required: true },
              displayName: { type: 'string', required: true },
              runId: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', const: 'validated', required: true },
              ok: { type: 'boolean', const: true, required: true },
              result: { type: 'json' },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderLaunch(value, maxResultChars),
      }],
    },
    async execute(args, exec): Promise<WorkflowToolOutput> {
      const parent = exec.agent
      if (!parent) {
        // The loop sets `exec.agent` for every model-driven call; its absence
        // means a non-agent caller invoked the tool directly, which has no
        // parent to attribute the children to. Fail loud rather than guess.
        throw new Error('workflow tool requires a calling agent (exec.agent was undefined)')
      }
      // Resume path: the original immutable script, args, and budget.
      if (args.resume_from_run_id !== undefined) {
        if (args.name !== undefined || args.script !== undefined || args.script_path !== undefined
          || args.meta !== undefined || args.args !== undefined || args.validate_only !== undefined) {
          throw new Error('workflow resume_from_run_id cannot be combined with a source, meta, args, or validate_only')
        }
        const runId = parseSupervisedWorkflowRunId(args.resume_from_run_id)
        const displayName = supervisor.resumeById(runId, parent, args.agent_budget, exec.signal)
        return { status: 'resumed', displayName, runId }
      }

      const source = await resolveSource(ctx, args, {
        ...parent.session.header.cwd === undefined ? {} : { cwd: parent.session.header.cwd },
        signal: exec.signal,
        maxDefinitionBytes,
      })

      // Smoke check: no live run, no destination record, no dashboard row.
      if (args.validate_only === true) {
        const validation = await supervisor.validate({
          ...source,
          ...args.args !== undefined ? { args: args.args } : {},
          ...args.agent_budget !== undefined ? { agentBudget: args.agent_budget } : {},
          signal: exec.signal,
          parent,
        })
        if (!validation.ok) throw new Error(validation.error)
        return {
          status: 'validated',
          ok: true,
          ...validation.result === undefined ? {} : { result: validation.result as JsonValue },
        }
      }

      const start = () => supervisor.start({
        ...source,
        ...args.args !== undefined ? { args: args.args } : {},
        ...args.agent_budget !== undefined ? { agentBudget: args.agent_budget } : {},
        signal: exec.signal,
        parent,
      })
      // Only root transport calls establish recorder attribution. The
      // supervisor publishes logical lifecycle events during start and owns
      // every later attempt, including pause/resume replays.
      const launched = exec.parent === undefined
        ? await recorder.launch(parent.session, start)
        : await start()
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
