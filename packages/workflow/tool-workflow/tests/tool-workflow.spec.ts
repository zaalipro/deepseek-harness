import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkflowRunId, WorkflowEngine } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowMeta, WorkflowResult, WorkflowRun,
  WorkflowRunId as WorkflowRunIdType, WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as toolWorkflow from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** A controllable engine standing in behind the supervisor (the tool's only seam). */
class StubEngine extends WorkflowEngine {
  requests: WorkflowStartRequest[] = []
  cancels: string[] = []
  readonly settlements = new Map<WorkflowRunIdType, (result: WorkflowResult) => void>()
  startError: Error | undefined
  validateError: Error | undefined

  start(request: WorkflowStartRequest): WorkflowRun {
    if (this.startError) throw this.startError
    this.requests.push(request)
    const id = WorkflowRunId(`run-${this.requests.length}`)
    const result = new Promise<WorkflowResult>((resolve) => {
      this.settlements.set(id, resolve)
    })
    return {
      id,
      meta: request.meta,
      result,
      cancel: (reason?: string) => {
        this.cancels.push(reason ?? 'cancelled')
        this.settle(id, { value: null, stopReason: 'cancelled', ...reason !== undefined ? { error: reason } : {}, agentsStarted: 0 })
      },
      resume: () => {},
      dispose: async () => { this.settlements.delete(id) },
    }
  }

  settle(id: WorkflowRunIdType, result: WorkflowResult): void {
    const resolve = this.settlements.get(id)
    if (resolve === undefined) throw new Error(`unknown stub workflow ${id}`)
    resolve(result)
  }

  metaOf(id: WorkflowRunIdType): WorkflowMeta {
    return this.requests[Number(String(id).slice(4)) - 1]!.meta
  }

  agentStart(id: WorkflowRunIdType, agent: WorkflowAgentInfo): void {
    this.emitWorkflowEvent('workflow/agent-start', { id, meta: this.metaOf(id) }, agent)
  }

  agentEnd(id: WorkflowRunIdType, agent: WorkflowAgentEndInfo): void {
    this.emitWorkflowEvent('workflow/agent-end', { id, meta: this.metaOf(id) }, agent)
  }

  end(id: WorkflowRunIdType, result: WorkflowResult): void {
    this.emitWorkflowEvent('workflow/end', { id, meta: this.metaOf(id) }, {
      stopReason: result.stopReason,
      ...result.error !== undefined ? { error: result.error } : {},
      agentsStarted: result.agentsStarted,
    })
  }
}

/** A supervisor stub over the stub engine, mirroring the real launch contract. */
class StubSupervisor {
  readonly launched: { definition?: unknown; script?: string; meta?: WorkflowMeta; args?: unknown; parent: Agent }[] = []
  readonly resumed: string[] = []
  readonly validated: unknown[] = []
  validateResult: { ok: true; result?: unknown } | { ok: false; error: string } = { ok: true, result: { smoke: true } }

  constructor(readonly engine: StubEngine) {}

  async start(spec: { definition?: unknown; script?: string; meta?: WorkflowMeta; args?: unknown; agentBudget?: number; parent: Agent }): Promise<{ displayName: string; runId: WorkflowRunIdType; scriptPath: string; status: 'started' }> {
    this.launched.push(spec)
    const definition = spec.definition as { script: string; meta?: WorkflowMeta; name?: string } | undefined
    const script = spec.script ?? definition?.script
    const meta = spec.meta ?? definition?.meta ?? { name: definition?.name ?? 'workflow', description: 'd' }
    const run = this.engine.start({
      script: script!,
      meta,
      ...spec.args !== undefined ? { args: spec.args } : {},
      parent: spec.parent,
    })
    return { displayName: meta.name, runId: run.id, scriptPath: `/tmp/${meta.name}.js`, status: 'started' }
  }

  async validate(spec: {
    script?: string
    meta?: WorkflowMeta
    args?: unknown
    parent: Agent
  }): Promise<{ ok: true; result?: unknown } | { ok: false; error: string }> {
    this.validated.push(spec)
    return this.validateResult
  }

  resumeById(runId: string, _agent: Agent): string {
    this.resumed.push(runId)
    return 'audit'
  }
}

/** A workflow-registry stub resolving one saved definition. */
class StubRegistry {
  definitions = new Map<string, { name: string; description: string; script: string; scope: string }>()
  async get(name: string): Promise<{ name: string; description: string; script: string; scope: string } | undefined> {
    return this.definitions.get(name)
  }
  async list(): Promise<unknown[]> { return [...this.definitions.values()] }
}

async function setup(config?: { toolName?: string; maxResultChars?: number }) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubEngine)
  const engine = ctx.workflowEngine as StubEngine
  const supervisor = new StubSupervisor(engine)
  const registry = new StubRegistry()
  ctx.provide('workflowSupervisor', supervisor)
  ctx.provide('workflows', registry)
  await ctx.plugin(toolWorkflow, config ?? {})
  const session = Session.create(SessionId('caller'))
  const parent = { id: session.id, options: {}, session } as unknown as Agent
  return { ctx, engine, supervisor, registry, parent, session }
}

const SCRIPT = 'return 1'
const META = { name: 'audit', description: 'd' }

function execute(ctx: Context, args: unknown, extra?: {
  agent?: Agent
  signal?: AbortSignal
  parent?: ToolExecutionToken
}): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId('call-1'),
    name: 'workflow',
    arguments: args,
    ...extra?.agent ? { agent: extra.agent } : {},
    ...extra?.signal ? { signal: extra.signal } : {},
    ...extra?.parent ? { parent: extra.parent } : {},
  })
}

describe('dsh-tool-workflow (supervisor-backed background launch)', () => {
  it('launches in the background and returns the display handle immediately', async () => {
    const { ctx, supervisor, parent } = await setup()
    const launch = await execute(ctx, { script: SCRIPT, meta: META, args: { files: ['a.ts'] }, agent_budget: 32 }, { agent: parent })
    expect(launch.isError).toBe(false)
    if (launch.isError) throw new Error('expected launch success')
    expect(launch.value).toEqual({ status: 'started', displayName: 'audit', runId: 'run-1', script_path: '/tmp/audit.js' })
    expect(supervisor.launched).toHaveLength(1)
    expect(supervisor.launched[0]).toMatchObject({ script: SCRIPT, meta: META, args: { files: ['a.ts'] }, agentBudget: 32 })
  })

  it('resolves a saved definition by name and records the top-level run durably', async () => {
    const { ctx, engine, registry, parent, session } = await setup()
    registry.definitions.set('audit', { name: 'audit', description: 'd', script: SCRIPT, scope: 'project' })
    const launch = await execute(ctx, { name: 'audit', args: { files: [] } }, { agent: parent })
    expect(launch.isError).toBe(false)
    const runId = WorkflowRunId('run-1')
    engine.agentStart(runId, { seq: 1, label: 'member', childId: SessionId('child-1') })
    engine.agentEnd(runId, { seq: 1, label: 'member', childId: SessionId('child-1'), outcome: 'completed' })
    engine.end(runId, { value: null, stopReason: 'completed', agentsStarted: 1 })
    expect(session.events.map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/run-start', { runId: 'run-1', name: 'audit' }],
      ['tool-workflow/agent-start', { runId: 'run-1', seq: 1, label: 'member', childId: 'child-1' }],
      ['tool-workflow/agent-end', { runId: 'run-1', seq: 1, outcome: 'completed' }],
      ['tool-workflow/run-end', { runId: 'run-1', stopReason: 'completed' }],
    ])
  })

  it('does not record nested transport executions', async () => {
    const { ctx, registry, parent, session } = await setup()
    registry.definitions.set('audit', { name: 'audit', description: 'd', script: SCRIPT, scope: 'project' })
    const launch = await execute(ctx, { name: 'audit' }, { agent: parent, parent: Symbol('outer') as ToolExecutionToken })
    expect(launch.isError).toBe(false)
    expect(session.events).toEqual([])
  })

  it('validate_only smoke-checks without a live run or record', async () => {
    const { ctx, supervisor, parent, session } = await setup()
    const result = await execute(ctx, { script: SCRIPT, meta: META, args: { n: 1 }, validate_only: true }, { agent: parent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected validation success')
    expect(result.value).toEqual({ status: 'validated', ok: true, result: { smoke: true } })
    expect(supervisor.validated).toHaveLength(1)
    expect(supervisor.launched).toHaveLength(0)
    expect(session.events).toEqual([])
  })

  it('resume_from_run_id resumes and rejects combined sources', async () => {
    const { ctx, supervisor, parent } = await setup()
    const resumed = await execute(ctx, { resume_from_run_id: 'run-1' }, { agent: parent })
    expect(resumed.isError).toBe(false)
    if (resumed.isError) throw new Error('expected resume success')
    expect(resumed.value).toEqual({ status: 'resumed', displayName: 'audit', runId: 'run-1' })
    expect(supervisor.resumed).toEqual(['run-1'])

    const combined = await execute(ctx, { resume_from_run_id: 'run-1', script: SCRIPT, meta: META }, { agent: parent })
    expect(combined.isError).toBe(true)
    expect((combined.content[0] as { text: string }).text).toContain('cannot be combined')
  })

  it.each([
    ['no source', {}, 'requires one source'],
    ['script without meta', { script: SCRIPT }, 'requires the meta object'],
    ['unknown name', { name: 'missing' }, 'no saved workflow named "missing"'],
  ])('fails loud on %s', async (_label, args, fragment) => {
    const { ctx, parent } = await setup()
    const result = await execute(ctx, args, { agent: parent })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain(fragment)
  })

  it('requires a calling agent (fails loud without exec.agent)', async () => {
    const { ctx } = await setup()
    const result = await execute(ctx, { script: SCRIPT, meta: META })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('requires a calling agent')
  })

  it('registers under a configured toolName and unregisters on fiber dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubEngine)
    ctx.provide('workflowSupervisor', new StubSupervisor(ctx.workflowEngine as StubEngine))
    ctx.provide('workflows', new StubRegistry())
    const fiber = await ctx.plugin(toolWorkflow, { toolName: 'orchestrate' })
    expect(ctx.tools.get('orchestrate')).toBeDefined()
    expect(ctx.tools.get('workflow')).toBeUndefined()
    await fiber.dispose()
    expect(ctx.tools.get('orchestrate')).toBeUndefined()
  })

  it('presents a generic pending card titled by the source name', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('workflow')!
    expect(tool.presentCall!({ script: SCRIPT, meta: META })).toMatchObject({ card: 'generic', title: 'workflow: audit', rawInput: SCRIPT })
    expect(tool.presentCall!({ name: 'audit' })).toMatchObject({ card: 'generic', title: 'workflow: audit' })
    // Replay safety: a malformed logged shape still renders a generic card
    // instead of throwing mid-replay.
    expect(tool.presentCall!({ not: 'the schema' })).toMatchObject({ card: 'generic', title: 'workflow: workflow' })
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in toolWorkflow).toBe(false)
    expect(toolWorkflow.name).toBe('tool-workflow')
    expect(toolWorkflow.inject).toEqual(['tools', 'systemPrompt'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolWorkflow) as Record<string, unknown>
    expect(unwrapped).toBe(toolWorkflow)
    expect(typeof unwrapped.apply).toBe('function')
  })
})
