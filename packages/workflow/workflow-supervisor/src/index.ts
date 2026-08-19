/**
 * Workflow run supervisor (`ctx.workflowSupervisor`): session-scoped display
 * handles, live + retained runs, background launch, same-process pause/resume
 * with a host-call journal, stop, save-into-definitions, and a completion
 * notice to the parent session. It owns every live `WorkflowRun` handle — the
 * launching tool/command returns immediately.
 *
 * Runs key by display name, never by internal id: `meta.name` for the first
 * live/retained run in a session, then `meta.name-2`, `meta.name-3`, …
 * @module @deepseek-ai/dsh-workflow-supervisor
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowGateInfo,
  WorkflowMeta,
  WorkflowResult,
  WorkflowRun,
} from '@deepseek-ai/dsh-workflow'
import type { WorkflowDefinition } from '@deepseek-ai/dsh-workflow-registry'
import type {
  WorkflowLaunched,
  WorkflowRunMemberView,
  WorkflowRunStatus,
  WorkflowRunView,
  WorkflowSaveScope,
  WorkflowValidation,
} from './types.ts'

export type {
  WorkflowLaunched,
  WorkflowRunMemberView,
  WorkflowRunStatus,
  WorkflowRunView,
  WorkflowSaveScope,
  WorkflowValidation,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowSupervisor: WorkflowSupervisor
  }

  interface Events {
    /**
     * One supervised run's visible set changed (start, progress, park, settle,
     * pause, resume, stop, save). Unfiltered; consumers re-read `listRuns`.
     * @mode emit
     */
    'workflows/run-change'(): void
  }
}

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** Whether the supervisor serves runs (default true). */
  enabled?: boolean
  /** Harness home under which run directories live. */
  dshHome?: string
  /** Default per-run logical agent budget (default 128). */
  defaultAgentBudget?: number
  /** Absolute per-run logical agent budget ceiling (default 1024). */
  maxAgentBudget?: number
  /** Base directory owning per-run scratch + script projections (default `<dshHome>/workflow-runs`). */
  runsRoot?: string
  /** Default save scope when the caller does not choose (default `project`). */
  saveScope?: WorkflowSaveScope
}

export const Config: Schema<Config> = z.object({
  enabled: z.boolean().default(true),
  dshHome: z.string(),
  defaultAgentBudget: z.natural().min(1).default(128),
  maxAgentBudget: z.natural().min(1).default(1024),
  runsRoot: z.string(),
  saveScope: z.union(['project', 'user'] as const).default('project'),
})

/** A launched run's supervisor-owned book-keeping. */
interface SupervisedRun {
  runId: WorkflowRunId
  displayName: string
  sessionId: SessionId
  meta: WorkflowMeta
  args: unknown
  script: string
  budget: number
  scriptPath: string
  scratchDir: string
  builtin: boolean
  numberedHandle: boolean
  parent: Agent
  status: WorkflowRunStatus
  phase: string | undefined
  members: Map<number, { label: string; phase?: string; status: WorkflowRunMemberView['status'] }>
  logs: string[]
  journal: Map<number, unknown>
  /** Cumulative live `agent()` launches across the run and its resumes (replayed calls excluded). */
  launched: number
  gate: WorkflowGateInfo | undefined
  result: WorkflowResult | undefined
  pausedByUser: boolean
  startedAt: number
  settledAt: number | undefined
  handle: WorkflowRun
}

/** Render any thrown value without trusting coercion. */
function renderThrown(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/** Walk upward from `cwd` to the nearest `.git` ancestor; fall back to `cwd`. */
async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd)
  while (true) {
    if (await isGitRoot(current)) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

async function isGitRoot(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises')
    return (await stat(join(path, '.git'))).isDirectory()
  } catch {
    return false
  }
}

/** Clamp a budget to [1, min(requested ceiling, deployment ceiling)]. */
function clampBudget(requested: number | undefined, defaultBudget: number, maxBudget: number): number {
  const value = requested ?? defaultBudget
  return Math.max(1, Math.min(value, maxBudget))
}

/** The terminal dashboard status for a settled engine result. */
function statusForResult(result: WorkflowResult): WorkflowRunStatus {
  switch (result.stopReason) {
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'error': return 'failed'
    /* v8 ignore next -- WorkflowStopReason is closed; a future variant fails loud. */
    default: return result.stopReason satisfies never
  }
}

/**
 * Run supervisor. Background launch returns the display handle immediately;
 * the supervisor owns the returned `WorkflowRun`, routes `workflow/*` events
 * into each run's live view, and posts a completion notice to the parent
 * session. Same-process pause saves the committed host-call journal; resume
 * replays it under the original immutable script, args, and budget.
 */
export class WorkflowSupervisor extends Service {
  static inject = ['workflowEngine', 'workflows']

  static Config = Config

  private readonly enabled: boolean
  private readonly defaultAgentBudget: number
  private readonly maxAgentBudget: number
  private readonly runsRoot: string
  private readonly dshRoot: string
  private readonly saveScope: WorkflowSaveScope
  private readonly runs = new Map<string, SupervisedRun>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'workflowSupervisor')
    this.enabled = config.enabled ?? true
    this.dshRoot = resolveDshHome(config.dshHome)
    this.defaultAgentBudget = config.defaultAgentBudget ?? 128
    this.maxAgentBudget = config.maxAgentBudget ?? 1024
    this.runsRoot = config.runsRoot === undefined ? join(this.dshRoot, 'workflow-runs') : resolve(config.runsRoot)
    this.saveScope = config.saveScope ?? 'project'

    ctx.on('workflow/phase', (info, title) => { this.withRun(info.id, (run) => { run.phase = title }) })
    ctx.on('workflow/log', (info, message) => { this.withRun(info.id, (run) => { run.logs.push(message) }) })
    ctx.on('workflow/agent-start', (info, agent) => { this.onAgentStart(info.id, agent) })
    ctx.on('workflow/agent-end', (info, agent) => { this.onAgentEnd(info.id, agent) })
    ctx.on('workflow/agent-result', (info, seq, result) => { this.withRun(info.id, (run) => { run.journal.set(seq, result) }) })
    ctx.on('workflow/gate', (info, gate) => { this.onGate(info.id, gate) })
    ctx.on('workflow/end', (info) => { this.onEnd(info.id) })
  }

  /**
   * Launch one workflow run in the background (or smoke-check it).
   * @param spec - the run source, args, budget, and parent agent.
   * @returns the display handle and started status immediately.
   */
  async start(spec: {
    definition?: WorkflowDefinition | undefined
    script?: string | undefined
    meta?: WorkflowMeta | undefined
    args?: unknown
    agentBudget?: number
    parent: Agent
  }): Promise<WorkflowLaunched> {
    if (!this.enabled) throw new Error('workflow supervisor is disabled')
    const { script, meta, builtin } = await this.resolveSource(spec)
    const parent = spec.parent
    const session = parent.session
    const budget = Math.min(clampBudget(spec.agentBudget, this.defaultAgentBudget, this.maxAgentBudget), this.maxAgentBudget)
    const displayName = this.allocate(session.id, meta.name)
    // The run DIRECTORY keys by its own minted id; the run IDENTITY is the
    // engine-minted id (the one `workflow/*` events and resume address).
    const runDir = join(this.runsRoot, randomUUID())
    await mkdir(join(runDir, 'scratch'), { recursive: true })
    const scriptPath = join(runDir, 'script.js')
    await writeFile(scriptPath, script, 'utf8')
    const handle = this.ctx.workflowEngine.start({
      script,
      meta,
      ...spec.args !== undefined ? { args: spec.args } : {},
      maxTotalAgents: budget,
      scratchDir: runDir,
      parent,
    })
    const runId = handle.id

    const record: SupervisedRun = {
      runId,
      displayName,
      sessionId: session.id,
      meta,
      args: spec.args,
      script,
      budget,
      scriptPath,
      scratchDir: runDir,
      builtin,
      numberedHandle: displayName !== meta.name,
      parent,
      status: 'running',
      phase: undefined,
      members: new Map(),
      logs: [],
      journal: new Map(),
      launched: 0,
      gate: undefined,
      result: undefined,
      pausedByUser: false,
      startedAt: Date.now(),
      settledAt: undefined,
      handle,
    }
    this.runs.set(this.key(session.id, displayName), record)
    void this.observe(record)
    this.emitChange()
    return { displayName, runId, scriptPath, status: 'started' }
  }

  /**
   * Smoke-check one path with canned hosts; never starts a live run.
   * @param spec - the run source, args, and parent agent.
   * @returns `ok: true` with the smoke result, or `ok: false` with the failure.
   */
  async validate(spec: {
    definition?: WorkflowDefinition | undefined
    script?: string | undefined
    meta?: WorkflowMeta | undefined
    args?: unknown
    parent?: Agent | undefined
  }): Promise<WorkflowValidation> {
    const { script, meta } = await this.resolveSource(spec)
    const parent = spec.parent
    if (parent === undefined) return { ok: false, error: 'validate_only requires a calling agent' }
    const run = this.ctx.workflowEngine.start({
      script,
      meta,
      ...spec.args !== undefined ? { args: spec.args } : {},
      parent,
      validateOnly: true,
    })
    try {
      const result = await run.result
      if (result.stopReason === 'completed') return { ok: true, result: result.value }
      return { ok: false, error: result.error ?? 'workflow smoke check failed' }
    } finally {
      await run.dispose()
    }
  }

  /**
   * Pause a running run: cancel it and keep the committed journal for resume.
   * @param displayName - the run's session display handle.
   * @param agent - the session-owning agent fencing the run.
   */
  pause(displayName: string, agent: Agent): void {
    const run = this.lookup(displayName, agent.session.id)
    if (run.status !== 'running') throw new Error(`workflow "${displayName}" is not running (${run.status})`)
    run.pausedByUser = true
    run.status = 'paused'
    run.handle.cancel('paused by user')
    this.emitChange()
  }

  /**
   * Resume a parked gate (alive worker) or a paused run (journal replay).
   * @param displayName - the run's session display handle.
   * @param agent - the session-owning agent fencing the run.
   */
  resume(displayName: string, agent: Agent): void {
    const run = this.lookup(displayName, agent.session.id)
    this.resumeRecord(run)
  }

  /**
   * Resume by internal run id (the model-facing tool path). Returns the display handle.
   * @param runId - the engine-minted run id returned by a launch.
   * @param agent - the session-owning agent fencing the run.
   * @returns the resumed run's display handle.
   */
  resumeById(runId: string, agent: Agent): string {
    for (const run of this.runs.values()) {
      if (run.sessionId === agent.session.id && String(run.runId) === runId) {
        this.resumeRecord(run)
        return run.displayName
      }
    }
    throw new Error(`no workflow run with id "${runId}" in this session`)
  }

  /** Resume one supervised run from its parked/paused state. */
  private resumeRecord(run: SupervisedRun): void {
    if (run.status === 'needs-input') {
      run.status = 'running'
      run.gate = undefined
      run.handle.resume()
      this.emitChange()
      return
    }
    if (run.status === 'paused') {
      const journal = [...run.journal].map(([seq, result]) => ({ seq, result }))
      const handle = this.ctx.workflowEngine.start({
        script: run.script,
        meta: run.meta,
        ...run.args !== undefined ? { args: run.args } : {},
        maxTotalAgents: run.budget,
        scratchDir: run.scratchDir,
        journal,
        parent: run.parent,
      })
      run.runId = handle.id
      run.handle = handle
      run.status = 'running'
      run.gate = undefined
      run.pausedByUser = false
      void this.observe(run)
      this.emitChange()
      return
    }
    throw new Error(`workflow "${run.displayName}" cannot resume from ${run.status}`)
  }

  /**
   * Stop a run: cancel it and mark it cancelled.
   * @param displayName - the run's session display handle.
   * @param agent - the session-owning agent fencing the run.
   */
  stop(displayName: string, agent: Agent): void {
    const run = this.lookup(displayName, agent.session.id)
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted') {
      throw new Error(`workflow "${displayName}" already settled (${run.status})`)
    }
    run.status = 'cancelled'
    run.handle.cancel('stopped by user')
    this.emitChange()
  }

  /**
   * Save the run's script projection as a project or user definition.
   * @param displayName - the run's session display handle.
   * @param agent - the session-owning agent fencing the run.
   * @param scope - target scope (`project` or `user`); defaults to the config value.
   * @returns the written `.workflow.json` path.
   */
  async save(displayName: string, agent: Agent, scope?: WorkflowSaveScope): Promise<string> {
    const run = this.lookup(displayName, agent.session.id)
    if (run.builtin) throw new Error(`workflow "${displayName}" is a built-in: save a copy under a new meta.name instead`)
    if (run.numberedHandle) throw new Error(`workflow "${displayName}" is a numbered handle: pick a new unique meta.name and save the edited copy explicitly`)
    const targetScope = scope ?? this.saveScope
    const dir = await this.scopeDir(targetScope, agent)
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${run.meta.name}.workflow.json`)
    const envelope = { meta: run.meta, script: run.script }
    await writeFile(path, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
    const cwd = agent.session.header.cwd
    void this.ctx.workflows.list({ ...cwd !== undefined ? { cwd } : {} }).catch(() => {})
    this.emitChange()
    return path
  }

  /**
   * List every retained run for one agent's session, live-first.
   * @param agent - the reading agent; a non-agent caller sees nothing.
   * @returns the session's run views in start order (live runs first).
   */
  listRuns(agent?: Agent | undefined): WorkflowRunView[] {
    if (agent === undefined) return []
    const prefix = `${agent.session.id}\u0000`
    const rows: SupervisedRun[] = []
    for (const [key, run] of this.runs) {
      if (key.startsWith(prefix)) rows.push(run)
    }
    rows.sort((a, b) => (a.status === 'running' || a.status === 'needs-input' ? -1 : 1) - (b.status === 'running' || b.status === 'needs-input' ? -1 : 1) || a.startedAt - b.startedAt)
    return rows.map(run => this.view(run))
  }

  /** Mark every live run interrupted on process exit (called via beforeExit hook). */
  markInterrupted(): void {
    for (const run of this.runs.values()) {
      if (run.status === 'running' || run.status === 'needs-input' || run.status === 'paused') {
        run.status = 'interrupted'
      }
    }
    this.emitChange()
  }

  /** Resolve a launch source into (script, meta, builtin), failing loud when absent. */
  private async resolveSource(spec: {
    definition?: WorkflowDefinition | undefined
    script?: string | undefined
    meta?: WorkflowMeta | undefined
  }): Promise<{ script: string; meta: WorkflowMeta; builtin: boolean }> {
    if (spec.definition !== undefined) {
      return { script: spec.definition.script, meta: definitionMeta(spec.definition), builtin: spec.definition.scope === 'bundled' }
    }
    if (spec.script !== undefined && spec.meta !== undefined) {
      return { script: spec.script, meta: spec.meta, builtin: false }
    }
    throw new Error('workflow launch requires a saved definition (name) or an inline script plus meta')
  }

  /** Allocate the session-unique display handle for one definition name. */
  private allocate(sessionId: SessionId, name: string): string {
    let count = 0
    const prefix = `${sessionId}\u0000`
    for (const [key, run] of this.runs) {
      if (key.startsWith(prefix) && run.meta.name === name) count += 1
    }
    return count === 0 ? name : `${name}-${count + 1}`
  }

  private key(sessionId: SessionId, displayName: string): string {
    return `${sessionId}\u0000${displayName}`
  }

  private lookup(displayName: string, sessionId: SessionId): SupervisedRun {
    const run = this.runs.get(this.key(sessionId, displayName))
    if (run === undefined) throw new Error(`no workflow run named "${displayName}" in this session`)
    return run
  }

  private view(run: SupervisedRun): WorkflowRunView {
    const members = [...run.members.values()].map((member, index) => ({
      seq: index + 1,
      label: member.label,
      ...member.phase !== undefined ? { phase: member.phase } : {},
      status: member.status,
    }))
    const spent = run.launched
    return {
      runId: run.runId,
      displayName: run.displayName,
      name: run.meta.name,
      description: run.meta.description,
      status: run.status,
      ...run.phase !== undefined ? { phase: run.phase } : {},
      ...run.meta.phases !== undefined ? { phases: run.meta.phases } : {},
      budget: { total: run.budget, spent, remaining: run.budget - spent },
      members,
      logs: run.logs,
      ...run.result?.value !== undefined ? { result: run.result.value } : {},
      ...run.result?.error !== undefined ? { error: run.result.error } : {},
      ...run.gate !== undefined ? { gate: run.gate } : {},
      builtin: run.builtin,
      numberedHandle: run.numberedHandle,
      scriptPath: run.scriptPath,
      startedAt: run.startedAt,
      ...run.settledAt !== undefined ? { settledAt: run.settledAt } : {},
    }
  }

  private withRun(runId: string, mutate: (run: SupervisedRun) => void): void {
    for (const run of this.runs.values()) {
      if (String(run.runId) === runId) {
        mutate(run)
        this.emitChange()
        return
      }
    }
  }

  private onAgentStart(runId: string, agent: WorkflowAgentInfo): void {
    this.withRun(runId, (run) => {
      run.launched += 1
      run.members.set(agent.seq, {
        label: agent.label,
        ...agent.phase !== undefined ? { phase: agent.phase } : {},
        status: 'running',
      })
    })
  }

  private onAgentEnd(runId: string, agent: WorkflowAgentEndInfo): void {
    this.withRun(runId, (run) => {
      const member = run.members.get(agent.seq)
      if (member !== undefined) member.status = agent.outcome
    })
  }

  private onGate(runId: string, gate: WorkflowGateInfo): void {
    this.withRun(runId, (run) => {
      run.gate = gate
      run.status = 'needs-input'
    })
  }

  private onEnd(runId: string): void {
    this.withRun(runId, (run) => {
      // The result value lands through `observe`'s `run.result` continuation;
      // the end event only marks stopReason-derived status for non-paused runs.
      if (run.pausedByUser) run.status = 'paused'
    })
  }

  /** Own the live run handle to its settlement and post the completion notice. */
  private observe(run: SupervisedRun): void {
    void run.handle.result.then((result) => {
      try {
        run.result = result
        run.settledAt = Date.now()
        if (run.pausedByUser) {
          run.status = 'paused'
        } else if (run.status !== 'cancelled') {
          run.status = statusForResult(result)
        }
        this.notifyCompletion(run, result)
      } finally {
        this.emitChange()
      }
    })
  }

  /** Inject the completion notice + result/report into the parent conversation. */
  private notifyCompletion(run: SupervisedRun, result: WorkflowResult): void {
    try {
      let text: string
      if (result.stopReason === 'completed') {
        const value = JSON.stringify(result.value, null, 2) ?? 'null'
        text = `workflow "${run.displayName}" completed.\nResult:\n${value.length > 2000 ? `${value.slice(0, 2000)}… [truncated]` : value}`
      } else {
        text = `workflow "${run.displayName}" ended (${result.stopReason}${result.error !== undefined ? `: ${result.error}` : ''}).`
      }
      run.parent.inject(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'workflow-supervisor', form: 'notice', summary: text },
      }))
    } catch (error) {
      this.ctx.logger.warn(`workflow-supervisor: completion notice failed: ${renderThrown(error)}`)
    }
  }

  /** Resolve a save scope to an absolute directory. */
  private async scopeDir(scope: WorkflowSaveScope, agent: Agent): Promise<string> {
    if (scope === 'user') return join(this.dshRoot, 'workflows')
    const cwd = agent.session.header.cwd ?? process.cwd()
    return join(await findProjectRoot(cwd), '.dsh', 'workflows')
  }

  /** Dispatch the run-change event while containing listener failures. */
  private emitChange(): void {
    for (const callback of this.ctx.events.dispatch('emit', ['workflows/run-change'])) {
      try {
        const returned: unknown = callback()
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`workflow-supervisor: workflows/run-change listener rejected: ${renderThrown(error)}`)
        })
      } catch (error) {
        this.ctx.logger.warn(`workflow-supervisor: workflows/run-change listener threw: ${renderThrown(error)}`)
      }
    }
  }
}

/** Meta view of a saved definition (definition's summary fields). */
function definitionMeta(definition: WorkflowDefinition): WorkflowMeta {
  return {
    name: definition.name,
    description: definition.description,
    ...definition.whenToUse !== undefined ? { whenToUse: definition.whenToUse } : {},
    ...definition.phases !== undefined ? { phases: [...definition.phases] } : {},
  }
}

export default WorkflowSupervisor
