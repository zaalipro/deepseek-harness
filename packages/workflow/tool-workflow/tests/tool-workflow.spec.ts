import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { WorkflowRunId, WorkflowEngine } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowMeta, WorkflowResult, WorkflowRun,
  WorkflowRunId as WorkflowRunIdType, WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { SupervisedWorkflowRunId, WorkflowMemberId } from '@deepseek-ai/dsh-workflow-supervisor'
import WorkflowRunRecorder from '@deepseek-ai/dsh-workflow-run-recorder'
import type {
  SupervisedWorkflowRunId as LogicalRunId, SupervisedWorkflowRunInfo, WorkflowRunMemberHead,
} from '@deepseek-ai/dsh-workflow-supervisor'
import * as toolWorkflow from '../src/index.ts'

const testToolSignal = new AbortController().signal
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

type LifecycleMember = WorkflowRunMemberHead & { readonly childSessionId: SessionId }

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
  readonly resumed: Array<{ runId: LogicalRunId; higherBudget?: number; signal?: AbortSignal }> = []
  readonly validated: unknown[] = []
  readonly infos = new Map<LogicalRunId, SupervisedWorkflowRunInfo>()
  readonly members = new Map<LogicalRunId, Map<number, LifecycleMember>>()
  beforeStartLifecycle: ((runId: LogicalRunId) => void) | undefined
  startLifecycle: ((runId: LogicalRunId) => void) | undefined
  publishStart = true
  returnedRunId: LogicalRunId | undefined
  includeScriptPath = true
  validateResult: { ok: true; result?: unknown } | { ok: false; error: string } = { ok: true, result: { smoke: true } }

  constructor(readonly engine: StubEngine, readonly ctx: Context) {}

  async start(spec: { definition?: unknown; script?: string; meta?: WorkflowMeta; args?: unknown; agentBudget?: number; parent: Agent }): Promise<{ displayName: string; runId: LogicalRunId; scriptPath?: string; status: 'started' }> {
    this.launched.push(spec)
    const definition = spec.definition as { script: string; meta?: WorkflowMeta; name?: string } | undefined
    const script = spec.script ?? definition?.script
    const meta = spec.meta ?? definition?.meta ?? { name: definition?.name ?? 'workflow', description: 'd' }
    this.engine.start({
      script: script!,
      meta,
      ...spec.args !== undefined ? { args: spec.args } : {},
      parent: spec.parent,
    })
    const runId = SupervisedWorkflowRunId(`logical-${this.launched.length}`)
    const info = { id: runId, displayName: meta.name, name: meta.name }
    this.infos.set(runId, info)
    this.members.set(runId, new Map())
    this.beforeStartLifecycle?.(runId)
    if (this.publishStart) this.ctx.emit('workflows/run-start', info)
    this.startLifecycle?.(runId)
    return {
      displayName: meta.name,
      runId: this.returnedRunId ?? runId,
      ...this.includeScriptPath ? { scriptPath: `/tmp/${meta.name}.js` } : {},
      status: 'started',
    }
  }

  memberStart(runId: LogicalRunId, agent: WorkflowAgentInfo): void {
    const info = this.info(runId)
    const member: LifecycleMember = {
      memberId: WorkflowMemberId(`member-${agent.seq}`),
      seq: agent.seq,
      label: agent.label,
      ...agent.phase === undefined ? {} : { phase: agent.phase },
      childSessionId: agent.childId,
      status: 'running',
      outcome: 'pending',
    }
    this.members.get(runId)!.set(agent.seq, member)
    this.ctx.emit('workflows/member-start', info, member)
  }

  memberEnd(runId: LogicalRunId, seq: number, outcome: 'completed' | 'failed' | 'cancelled'): void {
    const current = this.members.get(runId)?.get(seq)
    if (current === undefined) throw new Error(`unknown logical member ${seq}`)
    const member: LifecycleMember = {
      ...current,
      status: outcome,
      outcome: outcome === 'completed' ? 'available' : 'not-produced',
    }
    this.members.get(runId)!.set(seq, member)
    this.ctx.emit('workflows/member-end', this.info(runId), member)
  }

  end(runId: LogicalRunId, stopReason: 'completed' | 'cancelled' | 'error' | 'interrupted'): void {
    this.ctx.emit('workflows/run-end', this.info(runId), { stopReason, agentsStarted: this.members.get(runId)?.size ?? 0 })
  }

  private info(runId: LogicalRunId): SupervisedWorkflowRunInfo {
    const info = this.infos.get(runId)
    if (info === undefined) throw new Error(`unknown logical run ${runId}`)
    return info
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

  resumeById(runId: LogicalRunId, _agent: Agent, higherBudget?: number, signal?: AbortSignal): string {
    this.resumed.push({ runId, ...higherBudget === undefined ? {} : { higherBudget }, ...signal === undefined ? {} : { signal } })
    return 'audit'
  }
}

/** A workflow-registry stub resolving one saved definition. */
class StubRegistry {
  definitions = new Map<string, { name: string; description: string; script: string; scope: string }>()
  readonly lookups: Array<{ name: string; cwd?: string; signal?: AbortSignal }> = []
  async get(
    name: string,
    options: { cwd?: string; signal?: AbortSignal } = {},
  ): Promise<{ name: string; description: string; script: string; scope: string } | undefined> {
    this.lookups.push({ name, ...options })
    return this.definitions.get(name)
  }
  async list(): Promise<unknown[]> { return [...this.definitions.values()] }
}

async function setup(
  config?: { toolName?: string; maxResultChars?: number; maxDefinitionBytes?: number },
  sessionCwd?: string,
) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
  await ctx.plugin(StubEngine)
  const engine = ctx.workflowEngine as StubEngine
  const supervisor = new StubSupervisor(engine, ctx)
  const registry = new StubRegistry()
  ctx.provide('workflowSupervisor', supervisor)
  ctx.provide('workflows', registry)
  await ctx.plugin(WorkflowRunRecorder)
  await ctx.plugin(toolWorkflow, config ?? {})
  const sessionId = SessionId('caller')
  const session = Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    ...sessionCwd === undefined ? {} : { cwd: sessionCwd },
  })
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

/** Replace one test Session's append face with a deterministic failure point. */
function failSessionAppend(session: Session, failureNumber: number, thrown: unknown): void {
  const original = session.append.bind(session) as (...args: unknown[]) => unknown
  let calls = 0
  const mutable = session as unknown as { append: (...args: unknown[]) => unknown }
  mutable.append = (...args: unknown[]): unknown => {
    calls += 1
    if (calls === failureNumber) throw thrown
    return original(...args)
  }
}

describe('dsh-tool-workflow (supervisor-backed background launch)', () => {
  it('launches in the background and returns the display handle immediately', async () => {
    const { ctx, supervisor, parent } = await setup()
    const launch = await execute(ctx, { script: SCRIPT, meta: META, args: { files: ['a.ts'] }, agent_budget: 32 }, { agent: parent })
    expect(launch.isError).toBe(false)
    if (launch.isError) throw new Error('expected launch success')
    expect(launch.value).toEqual({ status: 'started', displayName: 'audit', runId: 'logical-1', script_path: '/tmp/audit.js' })
    expect(supervisor.launched).toHaveLength(1)
    expect(supervisor.launched[0]).toMatchObject({ script: SCRIPT, meta: META, args: { files: ['a.ts'] }, agentBudget: 32 })
  })

  it('resolves a saved definition by name and records the top-level run durably', async () => {
    const { ctx, engine, supervisor, registry, parent, session } = await setup()
    registry.definitions.set('audit', { name: 'audit', description: 'd', script: SCRIPT, scope: 'project' })
    const launch = await execute(ctx, { name: 'audit', args: { files: [] } }, { agent: parent })
    expect(launch.isError).toBe(false)
    expect(registry.lookups).toEqual([{ name: 'audit', signal: testToolSignal }])
    const executionId = WorkflowRunId('run-1')
    const runId = SupervisedWorkflowRunId('logical-1')
    // Physical attempt events are intentionally irrelevant to the durable
    // logical projection.
    engine.agentStart(executionId, { seq: 99, label: 'attempt-only', childId: SessionId('attempt-child') })
    engine.agentEnd(executionId, {
      seq: 99, label: 'attempt-only', childId: SessionId('attempt-child'), outcome: 'completed',
    })
    engine.end(executionId, { value: null, stopReason: 'cancelled', agentsStarted: 1 })
    supervisor.memberStart(runId, { seq: 1, label: 'member', childId: SessionId('child-1') })
    supervisor.memberEnd(runId, 1, 'completed')
    supervisor.end(runId, 'completed')
    expect(session.events.map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/run-start', { runId: 'logical-1', name: 'audit' }],
      ['tool-workflow/agent-start', { runId: 'logical-1', seq: 1, label: 'member', childId: 'child-1' }],
      ['tool-workflow/agent-end', { runId: 'logical-1', seq: 1, outcome: 'completed' }],
      ['tool-workflow/run-end', { runId: 'logical-1', stopReason: 'completed' }],
    ])
  })

  it('records lifecycle emitted before background start returns', async () => {
    const { ctx, supervisor, parent, session } = await setup()
    supervisor.startLifecycle = (runId) => {
      supervisor.memberStart(runId, {
        seq: 1, label: 'early', phase: 'Inspect', childId: SessionId('early-child'),
      })
      supervisor.memberEnd(runId, 1, 'completed')
      supervisor.end(runId, 'interrupted')
    }
    const launch = await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    expect(launch.isError).toBe(false)
    expect(session.events.map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/run-start', { runId: 'logical-1', name: 'audit' }],
      ['tool-workflow/agent-start', {
        runId: 'logical-1', seq: 1, label: 'early', phase: 'Inspect', childId: 'early-child',
      }],
      ['tool-workflow/agent-end', { runId: 'logical-1', seq: 1, outcome: 'completed' }],
      ['tool-workflow/run-end', { runId: 'logical-1', stopReason: 'interrupted' }],
    ])
  })

  it('preserves ordered logical lifecycle emitted before run publication', async () => {
    const { ctx, supervisor, parent, session } = await setup()
    supervisor.beforeStartLifecycle = (runId) => {
      supervisor.memberStart(runId, { seq: 1, label: 'early', childId: SessionId('early-child') })
      supervisor.memberEnd(runId, 1, 'completed')
      supervisor.end(runId, 'completed')
    }

    const launch = await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })

    expect(launch.isError).toBe(false)
    expect(session.events.map(event => event.type)).toEqual([
      'tool-workflow/run-start',
      'tool-workflow/agent-start',
      'tool-workflow/agent-end',
      'tool-workflow/run-end',
    ])
  })

  it('falls back to the returned launch identity when start emits no publication', async () => {
    const { ctx, supervisor, parent, session } = await setup()
    supervisor.publishStart = false
    supervisor.beforeStartLifecycle = (runId) => {
      supervisor.memberStart(runId, { seq: 1, label: 'buffered', childId: SessionId('buffered-child') })
      supervisor.memberEnd(runId, 1, 'failed')
      supervisor.end(runId, 'error')
    }

    const launch = await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })

    expect(launch.isError).toBe(false)
    expect(session.events.map(event => event.type)).toEqual([
      'tool-workflow/run-start',
      'tool-workflow/agent-start',
      'tool-workflow/agent-end',
      'tool-workflow/run-end',
    ])
  })

  it('fails closed when lifecycle publication and the returned identity disagree', async () => {
    const { ctx, supervisor, parent, session } = await setup()
    supervisor.returnedRunId = SupervisedWorkflowRunId('different-logical-run')

    const launch = await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    supervisor.memberStart(SupervisedWorkflowRunId('logical-1'), {
      seq: 1, label: 'unrecorded', childId: SessionId('unrecorded-child'),
    })

    expect(launch.isError).toBe(false)
    expect(session.events.map(event => event.type)).toEqual(['tool-workflow/run-start'])
  })

  it('contains durable recording failures at every lifecycle stage', async () => {
    const unrenderable = Object.create(null) as { toString?: () => string }
    unrenderable.toString = () => { throw new Error('must not escape') }
    const start = await setup()
    failSessionAppend(start.session, 1, unrenderable)
    start.supervisor.startLifecycle = (runId) => {
      start.supervisor.memberStart(runId, {
        seq: 1, label: 'not recorded', childId: SessionId('unrecorded-after-start'),
      })
    }
    expect((await execute(start.ctx, { script: SCRIPT, meta: META }, { agent: start.parent })).isError).toBe(false)

    const fallbackStart = await setup()
    fallbackStart.supervisor.publishStart = false
    failSessionAppend(fallbackStart.session, 1, new Error('fallback start storage failed'))
    expect((await execute(
      fallbackStart.ctx,
      { script: SCRIPT, meta: META },
      { agent: fallbackStart.parent },
    )).isError).toBe(false)

    const memberStart = await setup()
    failSessionAppend(memberStart.session, 2, new Error('member start storage failed'))
    await execute(memberStart.ctx, { script: SCRIPT, meta: META }, { agent: memberStart.parent })
    const memberStartRun = SupervisedWorkflowRunId('logical-1')
    memberStart.supervisor.memberStart(memberStartRun, {
      seq: 1, label: 'failed append', childId: SessionId('child-start'),
    })
    memberStart.supervisor.memberEnd(memberStartRun, 1, 'completed')
    expect(memberStart.session.events.map(event => event.type)).toEqual(['tool-workflow/run-start'])

    const memberEnd = await setup()
    failSessionAppend(memberEnd.session, 3, new Error('member end storage failed'))
    await execute(memberEnd.ctx, { script: SCRIPT, meta: META }, { agent: memberEnd.parent })
    const memberEndRun = SupervisedWorkflowRunId('logical-1')
    memberEnd.supervisor.memberStart(memberEndRun, {
      seq: 1, label: 'recorded start', childId: SessionId('child-end'),
    })
    memberEnd.supervisor.memberEnd(memberEndRun, 1, 'cancelled')
    memberEnd.supervisor.end(memberEndRun, 'cancelled')
    expect(memberEnd.session.events.map(event => event.type)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/agent-start',
    ])
  })

  it('rejects an impossible running logical member end without corrupting the record', async () => {
    const { ctx, supervisor, parent, session } = await setup()
    await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    const runId = SupervisedWorkflowRunId('logical-1')
    supervisor.memberStart(runId, { seq: 1, label: 'open', childId: SessionId('open-child') })
    const running = supervisor.members.get(runId)!.get(1)!
    ctx.emit('workflows/member-end', supervisor.infos.get(runId)!, running)
    supervisor.end(runId, 'completed')

    expect(session.events.map(event => event.type)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/agent-start',
    ])
  })

  it('drops pending lifecycle for unrelated starts instead of leaking attribution', async () => {
    const { ctx, supervisor, parent, session } = await setup()
    supervisor.beforeStartLifecycle = (runId) => {
      const unrelated = SupervisedWorkflowRunId('unrelated')
      const info = { id: unrelated, displayName: 'unrelated', name: 'unrelated' }
      supervisor.infos.set(unrelated, info)
      supervisor.members.set(unrelated, new Map())
      supervisor.memberStart(unrelated, {
        seq: 1, label: 'unrelated', childId: SessionId('unrelated-child'),
      })
      void runId
    }

    await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })

    expect(session.events.map(event => event.type)).toEqual(['tool-workflow/run-start'])
  })

  it('keeps one logical record open across a resume attempt', async () => {
    const { ctx, supervisor, parent, session } = await setup()
    await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    const runId = SupervisedWorkflowRunId('logical-1')
    supervisor.memberStart(runId, { seq: 1, label: 'first attempt', childId: SessionId('child-1') })
    supervisor.memberEnd(runId, 1, 'cancelled')
    await execute(ctx, { resume_from_run_id: runId }, { agent: parent })
    supervisor.memberStart(runId, { seq: 2, label: 'second attempt', childId: SessionId('child-2') })
    supervisor.memberEnd(runId, 2, 'completed')
    supervisor.end(runId, 'completed')

    expect(session.events.filter(event => event.type === 'tool-workflow/run-start')).toHaveLength(1)
    expect(session.events.filter(event => event.type === 'tool-workflow/run-end')).toHaveLength(1)
    expect(session.events.filter(event => event.type === 'tool-workflow/agent-start'))
      .toHaveLength(2)
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

  it('omits an absent validate-only value instead of returning undefined', async () => {
    const { ctx, supervisor, parent } = await setup()
    supervisor.validateResult = { ok: true }
    const result = await execute(ctx, { script: SCRIPT, meta: META, validate_only: true }, { agent: parent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected validation success')
    expect(result.value).toEqual({ status: 'validated', ok: true })
  })

  it('forwards a validate-only budget and reports a failed smoke check', async () => {
    const { ctx, supervisor, parent } = await setup()
    supervisor.validateResult = { ok: false, error: 'canned execution failed' }

    const result = await execute(ctx, {
      script: SCRIPT, meta: META, validate_only: true, agent_budget: 7,
    }, { agent: parent })

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('canned execution failed')
    expect(supervisor.validated[0]).toMatchObject({ agentBudget: 7 })
  })

  it('resume_from_run_id resumes and rejects combined sources', async () => {
    const { ctx, supervisor, parent } = await setup()
    const resumed = await execute(ctx, { resume_from_run_id: 'run-1', agent_budget: 256 }, { agent: parent })
    expect(resumed.isError).toBe(false)
    if (resumed.isError) throw new Error('expected resume success')
    expect(resumed.value).toEqual({ status: 'resumed', displayName: 'audit', runId: 'run-1' })
    expect(supervisor.resumed).toEqual([{ runId: 'run-1', higherBudget: 256, signal: testToolSignal }])

    const empty = await execute(ctx, { resume_from_run_id: '' }, { agent: parent })
    expect(empty.isError).toBe(true)
    expect((empty.content[0] as { text: string }).text).toContain('must be a non-empty string')

    const combined = await execute(ctx, { resume_from_run_id: 'run-1', script: SCRIPT, meta: META }, { agent: parent })
    expect(combined.isError).toBe(true)
    expect((combined.content[0] as { text: string }).text).toContain('cannot be combined')
  })

  it.skipIf(process.platform === 'win32')('resolves saved and file sources from the calling Session cwd through ctx.fs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tool-workflow-'))
    temporaryDirectories.push(cwd)
    await writeFile(join(cwd, 'audit.js'), SCRIPT, 'utf8')
    const { ctx, supervisor, registry, parent } = await setup(undefined, cwd)
    registry.definitions.set('saved-audit', {
      name: 'saved-audit', description: 'd', script: SCRIPT, scope: 'project',
    })

    const saved = await execute(ctx, { name: 'saved-audit' }, { agent: parent })
    const file = await execute(ctx, { script_path: 'audit.js', meta: META }, { agent: parent })

    expect(saved.isError).toBe(false)
    expect(file.isError).toBe(false)
    expect(registry.lookups).toEqual([{ name: 'saved-audit', cwd, signal: testToolSignal }])
    expect(supervisor.launched[1]).toMatchObject({ script: SCRIPT, meta: META })
  })

  it.skipIf(process.platform === 'win32')('loads a workflow envelope and rejects source and metadata ambiguity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tool-workflow-'))
    temporaryDirectories.push(cwd)
    await writeFile(join(cwd, 'audit.workflow.json'), JSON.stringify({ meta: META, script: SCRIPT }), 'utf8')
    const { ctx, supervisor, parent } = await setup(undefined, cwd)

    const envelope = await execute(ctx, { script_path: 'audit.workflow.json' }, { agent: parent })
    expect(envelope.isError).toBe(false)
    expect(supervisor.launched[0]).toMatchObject({
      definition: { name: 'audit', description: 'd', script: SCRIPT, scope: 'project' },
    })

    const ambiguous = await execute(ctx, { name: 'audit', script: SCRIPT }, { agent: parent })
    expect(ambiguous.isError).toBe(true)
    expect((ambiguous.content[0] as { text: string }).text).toContain('exactly ONE source')

    const namedMeta = await execute(ctx, { name: 'audit', meta: META }, { agent: parent })
    expect(namedMeta.isError).toBe(true)
    expect((namedMeta.content[0] as { text: string }).text).toContain('name source must not include meta')

    const envelopeMeta = await execute(ctx, {
      script_path: 'audit.workflow.json', meta: META,
    }, { agent: parent })
    expect(envelopeMeta.isError).toBe(true)
    expect((envelopeMeta.content[0] as { text: string }).text).toContain('envelope owns it')

    const bareWithoutMeta = await execute(ctx, { script_path: 'audit.js' }, { agent: parent })
    expect(bareWithoutMeta.isError).toBe(true)
    expect((bareWithoutMeta.content[0] as { text: string }).text).toContain('bare script requires the meta object')
  })

  it.skipIf(process.platform === 'win32')('rejects missing, non-regular, oversized, and non-UTF-8 script files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tool-workflow-'))
    temporaryDirectories.push(cwd)
    await mkdir(join(cwd, 'directory.js'))
    await writeFile(join(cwd, 'large.js'), 'too large', 'utf8')
    await writeFile(join(cwd, 'invalid.js'), Uint8Array.from([0xff]))
    const { ctx, parent } = await setup({ maxDefinitionBytes: 8 }, cwd)

    const missing = await execute(ctx, { script_path: 'missing.js', meta: META }, { agent: parent })
    expect(missing.isError).toBe(true)
    expect((missing.content[0] as { text: string }).text).toContain('was not found')

    const directory = await execute(ctx, { script_path: 'directory.js', meta: META }, { agent: parent })
    expect(directory.isError).toBe(true)
    expect((directory.content[0] as { text: string }).text).toContain('must be a regular file')

    const oversized = await execute(ctx, { script_path: 'large.js', meta: META }, { agent: parent })
    expect(oversized.isError).toBe(true)
    expect((oversized.content[0] as { text: string }).text).toContain('exceeds the 8-byte limit')

    const invalid = await execute(ctx, { script_path: 'invalid.js', meta: META }, { agent: parent })
    expect(invalid.isError).toBe(true)
    expect((invalid.content[0] as { text: string }).text).toContain('is not valid UTF-8')
  })

  it.skipIf(process.platform === 'win32')('reads an absolute bare script without a Session cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tool-workflow-'))
    temporaryDirectories.push(cwd)
    const path = join(cwd, 'absolute.js')
    await writeFile(path, SCRIPT, 'utf8')
    const { ctx, supervisor, parent } = await setup()

    const result = await execute(ctx, { script_path: path, meta: META }, { agent: parent })

    expect(result.isError).toBe(false)
    expect(supervisor.launched[0]).toMatchObject({ script: SCRIPT, meta: META })
  })

  it.skipIf(process.platform === 'win32')('bounds inline and file sources by UTF-8 bytes and rejects a final symbolic link', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tool-workflow-'))
    temporaryDirectories.push(cwd)
    await writeFile(join(cwd, 'target.js'), 'x', 'utf8')
    await symlink('target.js', join(cwd, 'linked.js'))
    const { ctx, parent } = await setup({ maxDefinitionBytes: 2 }, cwd)

    const inline = await execute(ctx, { script: '€', meta: META }, { agent: parent })
    const linked = await execute(ctx, { script_path: 'linked.js', meta: META }, { agent: parent })

    expect(inline.isError).toBe(true)
    expect((inline.content[0] as { text: string }).text).toContain('exceeds the 2-byte limit')
    expect(linked.isError).toBe(true)
    expect((linked.content[0] as { text: string }).text).toContain('must not be a symbolic link')
  })

  it.skipIf(process.platform === 'win32')('uses the no-follow descriptor when script_path is substituted during its read', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tool-workflow-'))
    temporaryDirectories.push(cwd)
    const source = join(cwd, 'audit.js')
    await writeFile(source, SCRIPT)
    await writeFile(join(cwd, 'outside.js'), 'complete("substituted")')
    const { ctx, supervisor, parent } = await setup(undefined, cwd)
    const localFs = ctx.fs as LocalFileSystem
    localFs.internals.inspectReadBytesNoFollowAfterOpen = async () => {
      await rename(source, join(cwd, 'opened.js'))
      await symlink('outside.js', source)
    }

    const launch = await execute(ctx, { script_path: 'audit.js', meta: META }, { agent: parent })

    expect(launch.isError).toBe(false)
    expect(supervisor.launched[0]).toMatchObject({ script: SCRIPT, meta: META })
  })

  it('fails script_path loud when the local platform lacks a safe no-follow read', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tool-workflow-'))
    temporaryDirectories.push(cwd)
    await writeFile(join(cwd, 'audit.js'), SCRIPT)
    const { ctx, parent } = await setup(undefined, cwd)
    const localFs = ctx.fs as LocalFileSystem
    localFs.internals.platform = 'win32'

    const launch = await execute(ctx, { script_path: 'audit.js', meta: META }, { agent: parent })

    expect(launch.isError).toBe(true)
    expect((launch.content[0] as { text: string }).text)
      .toContain('cannot atomically refuse final symbolic links on win32')
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
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await ctx.plugin(StubEngine)
    ctx.provide('workflowSupervisor', new StubSupervisor(ctx.workflowEngine as StubEngine, ctx))
    ctx.provide('workflows', new StubRegistry())
    await ctx.plugin(WorkflowRunRecorder)
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

  it('renders all canonical launch outcomes and a generic completed card', async () => {
    const { ctx } = await setup({ maxResultChars: 4 })
    const tool = ctx.tools.get('workflow')!
    const render = tool.output.render.bind(tool.output)

    expect(render({}, {
      status: 'validated', ok: true, result: { answer: 'long' },
    })).toEqual([{ type: 'text', text: 'workflow smoke check passed.\nResult:\n{\n  \n… [truncated]' }])
    expect(render({}, { status: 'validated', ok: true })).toEqual([
      { type: 'text', text: 'workflow smoke check passed.\nResult:\nnull' },
    ])
    expect(render({}, {
      status: 'started', displayName: 'audit', runId: 'logical-1',
    })).toEqual([{ type: 'text', text: '{"status":"started","displayName":"audit","runId":"logical-1"}' }])
    expect(render({}, {
      status: 'resumed', displayName: 'audit', runId: 'logical-1',
    })).toEqual([{ type: 'text', text: '{"status":"resumed","displayName":"audit","runId":"logical-1"}' }])
    expect(() => render({}, { status: 'future' })).toThrow(/workflow tool output/)

    expect(tool.presentResult!({ name: 'audit' }, { content: [], isError: false }))
      .toEqual({ card: 'generic' })
  })

  it('omits script_path when the supervisor has no editable projection', async () => {
    const { ctx, supervisor, parent } = await setup()
    supervisor.includeScriptPath = false
    supervisor.publishStart = false

    const launch = await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })

    expect(launch.isError).toBe(false)
    if (launch.isError) throw new Error('expected launch success')
    expect(launch.value).toEqual({ status: 'started', displayName: 'audit', runId: 'logical-1' })
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in toolWorkflow).toBe(false)
    expect(toolWorkflow.name).toBe('tool-workflow')
    expect(toolWorkflow.inject).toEqual([
      'tools',
      'systemPrompt',
      'workflowSupervisor',
      'workflowRunRecorder',
      'workflows',
      'fs',
    ])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolWorkflow) as Record<string, unknown>
    expect(unwrapped).toBe(toolWorkflow)
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('declares exact launch, resume, and validation result schemas', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('workflow')!.output.schema).toEqual({
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', const: 'started' },
            displayName: { type: 'string' },
            runId: { type: 'string' },
            script_path: { type: 'string' },
          },
          required: ['status', 'displayName', 'runId'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', const: 'resumed' },
            displayName: { type: 'string' },
            runId: { type: 'string' },
          },
          required: ['status', 'displayName', 'runId'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', const: 'validated' },
            ok: { type: 'boolean', const: true },
            result: {},
          },
          required: ['status', 'ok'],
        },
      ],
    })
  })
})
