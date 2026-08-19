import { describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { WorkflowEngine, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowEventName,
  WorkflowMeta,
  WorkflowResult,
  WorkflowRun,
  WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowDefinitionEnvelope,
  WorkflowSaveOptions,
} from '@deepseek-ai/dsh-workflow-registry/types'
import WorkflowSupervisor, { WorkflowGateId, WorkflowMemberId } from '../src/index.ts'
import type { Config, WorkflowGateRequest } from '../src/index.ts'

interface Attempt {
  readonly id: ReturnType<typeof WorkflowRunId>
  readonly request: WorkflowStartRequest
  readonly settlement: PromiseWithResolvers<WorkflowResult>
  readonly disposeGate: PromiseWithResolvers<undefined>
  cancelReason?: string
  disposeStarted: number
  disposed: number
  resumeCalls: number
}

class ControlledEngine extends WorkflowEngine {
  static inject = [] as const
  readonly attempts: Attempt[] = []
  autoSettleCancellation = false
  blockDisposal = false
  failNextDisposal = false
  failNextStart = false

  start(request: WorkflowStartRequest): WorkflowRun {
    if (this.failNextStart) {
      this.failNextStart = false
      throw new Error('engine rejected launch')
    }
    const id = WorkflowRunId(`attempt-${this.attempts.length + 1}`)
    const attempt: Attempt = {
      id,
      request,
      settlement: Promise.withResolvers<WorkflowResult>(),
      disposeGate: Promise.withResolvers<undefined>(),
      disposeStarted: 0,
      disposed: 0,
      resumeCalls: 0,
    }
    this.attempts.push(attempt)
    return {
      id,
      meta: request.meta,
      result: attempt.settlement.promise,
      cancel: (reason?: string) => {
        attempt.cancelReason = reason ?? 'cancelled'
        if (this.autoSettleCancellation) {
          attempt.settlement.resolve(cancelled(attempt.cancelReason))
        }
      },
      resume: () => { attempt.resumeCalls += 1 },
      dispose: async () => {
        attempt.disposeStarted += 1
        if (this.blockDisposal) await attempt.disposeGate.promise
        if (this.failNextDisposal) {
          this.failNextDisposal = false
          throw new Error('engine disposal failed')
        }
        attempt.disposed += 1
      },
    }
  }

  event(attemptIndex: number, name: WorkflowEventName, ...payload: unknown[]): void {
    const attempt = this.attempts[attemptIndex]
    if (attempt === undefined) throw new Error(`missing attempt ${attemptIndex}`)
    this.emitWorkflowEvent(name, { id: attempt.id, meta: attempt.request.meta }, ...payload)
  }

  settle(attemptIndex: number, result: WorkflowResult): void {
    const attempt = this.attempts[attemptIndex]
    if (attempt === undefined) throw new Error(`missing attempt ${attemptIndex}`)
    attempt.settlement.resolve(result)
  }

  releaseDisposal(attemptIndex: number): void {
    const attempt = this.attempts[attemptIndex]
    if (attempt === undefined) throw new Error(`missing attempt ${attemptIndex}`)
    attempt.disposeGate.resolve(undefined)
  }
}

const META: WorkflowMeta = { name: 'audit', description: 'review' }

function completed(value: JsonValue = null, agentsStarted = 0): WorkflowResult {
  return { value, stopReason: 'completed', agentsStarted }
}

function cancelled(error = 'cancelled', agentsStarted = 0): WorkflowResult {
  return { value: null, stopReason: 'cancelled', error, agentsStarted }
}

function budgetLimited(agentsStarted: number): WorkflowResult {
  return {
    value: null,
    stopReason: 'error',
    error: 'agent budget exhausted',
    errorCode: 'AGENT_CAP',
    agentsStarted,
  }
}

interface Harness {
  readonly ctx: Context
  readonly engine: ControlledEngine
  readonly parent: Agent
  readonly supervisorFiber: Fiber
  readonly notices: unknown[]
  readonly whenIdle: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly save: ReturnType<typeof vi.fn<(
    envelope: WorkflowDefinitionEnvelope,
    options: WorkflowSaveOptions,
  ) => Promise<string>>>
  readonly dshHome: string
  readonly runsRoot: string
}

type InternalRun = {
  runId: ReturnType<typeof WorkflowRunId>
  sessionId: ReturnType<typeof SessionId>
  displayName: string
  parent?: Agent
  status: string
  phase?: string
  gate?: { generation: number; executionId: ReturnType<typeof WorkflowRunId>; gateId: ReturnType<typeof WorkflowGateId> }
  durableGate?: unknown
  attempt?: { generation: number; executionId: ReturnType<typeof WorkflowRunId>; intent: string }
  generation: number
  revision: number
  detailRevision: number
  membersRevision: number
  logsRevision: number
  resultRevision: number
  artifactsRevision: number
  resultView: unknown
  terminalPublished: boolean
  published: boolean
  ownerCleanup?: () => void | Promise<void>
  durablePublication: Promise<void>
  completionDelivery: Promise<void>
  lifecyclePublication: Promise<void>
  lifecyclePending: number
  members: Map<number, unknown>
  logs: unknown[]
  artifacts: unknown[]
  journal: Map<string, unknown>
  runDirectory: string
  scratchDir: string
}

type InternalSupervisor = {
  runsById: Map<string, InternalRun>
  runsByDisplayName: Map<string, InternalRun>
  executions: Map<string, { run: InternalRun; generation: number }>
  recovery: Map<string, Promise<void>>
  manifests: {
    insertWithNextDisplayName: (...args: unknown[]) => Promise<unknown>
    upsert: (...args: unknown[]) => Promise<{ evicted: readonly unknown[] }>
    recoverSession: (...args: unknown[]) => Promise<readonly unknown[]>
  }
  reserveStartSlot: (agent: Agent) => () => void
  raiseIntent: (attempt: { intent: string }, intent: 'pause' | 'stop' | 'teardown') => void
  ownerHasUnquiescedWork: (agent: Agent) => boolean
  waitForOwnerChange: (agent: Agent, signal?: AbortSignal) => Promise<void>
  awaitWithSignal: <T>(promise: Promise<T>, signal?: AbortSignal) => Promise<T>
  removeDirectory: (path: string) => Promise<void>
  removeEvicted: (manifest: unknown) => void
  finishTerminal: (run: InternalRun, status: 'completed' | 'failed' | 'cancelled', result: WorkflowResult) => void
  finishInterrupted: (run: InternalRun) => void
  createAttempt: (run: InternalRun, signal?: AbortSignal) => unknown
  resumeRecord: (run: InternalRun, agent: Agent, signal?: AbortSignal) => void
  fromRecovered: (manifest: unknown) => InternalRun
  resumeLiveGate: (run: InternalRun) => void
  withAttempt: (executionId: ReturnType<typeof WorkflowRunId>, callback: () => void) => void
  commit: (run: InternalRun, aspect: 'detail' | 'members' | 'logs' | 'result' | 'artifacts') => void
  persist: (run: InternalRun, signal?: AbortSignal) => Promise<void>
  manifest: (run: InternalRun) => unknown
  loadRecovered: (sessionId: ReturnType<typeof SessionId>, signal?: AbortSignal) => Promise<void>
  disposeOwner: (agent: Agent) => Promise<void>
  disposeOwnedRun: (run: InternalRun, reason: string) => Promise<void>
  disposeService: () => Promise<void>
}

function internal(harness: Harness): InternalSupervisor {
  return harness.ctx.workflowSupervisor as unknown as InternalSupervisor
}

interface DeferredManifestWrite {
  readonly manifest: unknown
  readonly settlement: PromiseWithResolvers<undefined>
}

async function setup(config: Record<string, unknown> = {}): Promise<Harness> {
  const dshHome = typeof config.dshHome === 'string'
    ? config.dshHome
    : await mkdtemp(join(tmpdir(), 'dsh-supervisor-contracts-'))
  const runsRoot = typeof config.runsRoot === 'string'
    ? config.runsRoot
    : join(dshHome, 'workflow-runs')
  const ctx = new Context()
  await ctx.plugin(ControlledEngine)
  const save = vi.fn(async (
    _envelope: WorkflowDefinitionEnvelope,
    _options: WorkflowSaveOptions,
  ) => '/saved/audit.js')
  ctx.provide('workflows', {
    get: async () => undefined,
    list: async () => [],
    save,
  } as never)
  const supervisorFiber = await ctx.plugin(WorkflowSupervisor, {
    enabled: true,
    dshHome,
    runsRoot,
    ...config,
  })
  const session = Session.create(SessionId('session-contracts'))
  const notices: unknown[] = []
  const whenIdle = vi.fn<() => Promise<void>>(async () => {})
  const parent = {
    id: session.id,
    options: {},
    session,
    status: 'running',
    ctx,
    inject: (message: unknown) => { notices.push(message) },
    followup: (message: unknown) => { notices.push(message) },
    whenIdle,
  } as unknown as Agent
  return {
    ctx,
    engine: ctx.workflowEngine as ControlledEngine,
    parent,
    supervisorFiber,
    notices,
    whenIdle,
    save,
    dshHome,
    runsRoot,
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function agentFor(ctx: Context, id: string, cwd?: string): Agent {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, [], cwd === undefined ? undefined : {
    version: 0,
    id: sessionId,
    createdAt: Date.now(),
    cwd,
  })
  return {
    id: session.id,
    options: {},
    session,
    status: 'running',
    ctx,
    inject: () => {},
    followup: () => {},
    whenIdle: async () => {},
  } as unknown as Agent
}

function cursor(payload: unknown): never {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url') as never
}

async function waitForStatus(
  harness: Pick<Harness, 'ctx' | 'parent'>,
  displayName: string,
  status: string,
): Promise<void> {
  await vi.waitFor(() => {
    return harness.ctx.workflowSupervisor.listForClient(
      harness.parent,
      {},
      new AbortController().signal,
    ).then((page) => {
      expect(page.items.find(run => run.displayName === displayName)?.status).toBe(status)
    })
  })
}

async function runs(harness: Pick<Harness, 'ctx' | 'parent'>) {
  return (await harness.ctx.workflowSupervisor.listForClient(
    harness.parent,
    {},
    new AbortController().signal,
  )).items
}

async function pauseToQuiescence(harness: Harness, displayName = 'audit'): Promise<void> {
  const pause = harness.ctx.workflowSupervisor.pause(displayName, harness.parent)
  expect((await runs(harness)).find(run => run.displayName === displayName)?.status).toBe('pausing')
  const attemptIndex = harness.engine.attempts.length - 1
  harness.engine.settle(attemptIndex, cancelled('paused by user'))
  await pause
  await waitForStatus(harness, displayName, 'paused')
}

function deferManifestWrites(harness: Harness): DeferredManifestWrite[] {
  const store = (harness.ctx.workflowSupervisor as unknown as {
    manifests: {
      upsert: (manifest: unknown, signal?: AbortSignal) => Promise<{ readonly evicted: readonly unknown[] }>
    }
  }).manifests
  const writes: DeferredManifestWrite[] = []
  vi.spyOn(store, 'upsert').mockImplementation((manifest: unknown) => {
    const settlement = Promise.withResolvers<undefined>()
    writes.push({ manifest, settlement })
    return settlement.promise.then(() => ({ evicted: [] }))
  })
  return writes
}

describe('WorkflowSupervisor logical-run regressions', () => {
  it('keeps one logical run id across a journal-replay resume', async () => {
    const harness = await setup()
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })

    await pauseToQuiescence(harness)
    harness.ctx.workflowSupervisor.resume('audit', harness.parent)

    expect(harness.engine.attempts).toHaveLength(2)
    expect(harness.engine.attempts.map(attempt => String(attempt.id)))
      .toEqual(['attempt-1', 'attempt-2'])
    expect((await runs(harness))[0]?.runId)
      .toBe(launched.runId)
    expect(String(launched.runId)).not.toMatch(/^attempt-/)
  })

  it('replays every journal kind in strict commit order while only agents allocate members', async () => {
    const harness = await setup({ defaultAgentBudget: 8, maxAgentBudget: 8, maxMembersPerRun: 8 })
    const warnings: string[] = []
    harness.ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof harness.ctx.logger.warn
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, args: { input: true }, parent: harness.parent,
    })
    let gateRequest: WorkflowGateRequest | undefined
    harness.ctx.on('workflows/gate-request', (request) => { gateRequest = request })
    harness.engine.event(0, 'workflow/gate', {
      kind: 'user', message: 'Continue?', resumable: true,
    })
    expect(gateRequest).toBeDefined()
    if (gateRequest === undefined) throw new Error('gate request was not emitted')
    expect(harness.ctx.workflowSupervisor.resumeGate(
      launched.runId,
      harness.engine.attempts[0]!.id,
      gateRequest.gateId,
      harness.parent,
    )).toBe(true)
    const childId = SessionId('journal-child')
    harness.engine.event(0, 'workflow/agent-start', { seq: 2, label: 'child', childId })
    harness.engine.event(0, 'workflow/phase', 'review')
    harness.engine.event(0, 'workflow/log', 'one retained line')
    const entries = [
      { kind: 'phase' as const, ordinal: 1, callId: 'root/phase:0', fingerprint: '1'.repeat(64), title: 'review' },
      { kind: 'log' as const, ordinal: 2, callId: 'root/log:0', fingerprint: '2'.repeat(64), message: 'one retained line' },
      { kind: 'scratch-write' as const, ordinal: 3, callId: 'root/write:0', fingerprint: '3'.repeat(64) },
      { kind: 'scratch-read' as const, ordinal: 4, callId: 'root/read:0', fingerprint: '4'.repeat(64), content: 'retained' },
      { kind: 'await-user' as const, ordinal: 5, callId: 'root/await:0', fingerprint: '5'.repeat(64) },
      { kind: 'agent' as const, ordinal: 6, callId: 'root/agent:0', fingerprint: '6'.repeat(64), seq: 2, result: { ok: true } },
    ]
    for (const entry of entries) harness.engine.event(0, 'workflow/journal-commit', entry)

    const before = await harness.ctx.workflowSupervisor.membersForClient(harness.parent, {
      runId: launched.runId,
    }, signal())
    const memberId = before.items[0]?.memberId
    expect(memberId).toBeDefined()
    expect(before.items).toMatchObject([{ seq: 2, outcome: 'available' }])

    harness.engine.event(0, 'workflow/journal-commit', entries[5]!)
    harness.engine.event(0, 'workflow/journal-commit', { ...entries[5]!, result: 'conflict' })
    harness.engine.event(0, 'workflow/journal-commit', {
      kind: 'log', ordinal: 6, callId: 'root/log:reused', fingerprint: '7'.repeat(64), message: 'duplicate ordinal',
    })
    harness.engine.event(0, 'workflow/journal-commit', {
      kind: 'agent', ordinal: 7, callId: 'root/agent:reused', fingerprint: '8'.repeat(64), seq: 2, result: 'duplicate seq',
    })
    harness.engine.event(0, 'workflow/journal-commit', {
      kind: 'log', ordinal: 4, callId: 'root/log:regressed', fingerprint: '9'.repeat(64), message: 'regressed',
    })

    await pauseToQuiescence(harness)
    harness.ctx.workflowSupervisor.resume('audit', harness.parent)
    expect(harness.engine.attempts[1]?.request).toMatchObject({
      args: { input: true },
      initialAgentSpend: 1,
      initialAgentSeq: 2,
      journal: entries,
    })
    expect(harness.engine.attempts[1]?.request.journal?.map(entry => entry.ordinal))
      .toEqual([1, 2, 3, 4, 5, 6])
    expect((await harness.ctx.workflowSupervisor.logsForClient(harness.parent, {
      runId: launched.runId,
    }, signal())).items).toEqual([{ index: 0, text: 'one retained line' }])

    harness.engine.event(1, 'workflow/agent-start', { seq: 2, label: 'replayed child', childId })
    harness.engine.event(1, 'workflow/agent-start', {
      seq: 3, label: 'new child', childId: SessionId('journal-child-2'),
    })
    const after = await harness.ctx.workflowSupervisor.membersForClient(harness.parent, {
      runId: launched.runId,
    }, signal())
    expect(after.items[0]?.memberId).toBe(memberId)
    expect(after.items.map(member => member.seq)).toEqual([2, 3])
    expect(warnings.filter(message => message.includes('journal'))).toHaveLength(4)
    expect(warnings.some(message => message.includes('duplicate member sequence 2'))).toBe(true)
  })

  it('reserves monotonic display ordinals before concurrent launch publication', async () => {
    const harness = await setup()
    const launched = await Promise.all(Array.from({ length: 4 }, async (_, index) =>
      await harness.ctx.workflowSupervisor.start({
        script: `return ${index}`,
        meta: META,
        parent: harness.parent,
      })))

    expect(launched.map(run => run.displayName).sort()).toEqual([
      'audit', 'audit-2', 'audit-3', 'audit-4',
    ])
    expect(new Set(launched.map(run => run.runId)).size).toBe(4)
    expect(await runs(harness)).toHaveLength(4)

    const collidingBase = await harness.ctx.workflowSupervisor.start({
      script: 'return 4',
      meta: { ...META, name: 'audit-2' },
      parent: harness.parent,
    })
    expect(collidingBase.displayName).toBe('audit-2-2')

    harness.engine.failNextStart = true
    await expect(harness.ctx.workflowSupervisor.start({
      script: 'return 5', meta: META, parent: harness.parent,
    })).rejects.toThrow('engine rejected launch')
    const afterFailedReservation = await harness.ctx.workflowSupervisor.start({
      script: 'return 6', meta: META, parent: harness.parent,
    })
    expect(afterFailedReservation.displayName).toBe('audit-6')
  })

  it('does not consume a display name or leak a run directory when projection aborts', async () => {
    const harness = await setup()
    const controller = new AbortController()
    const signal = controller.signal
    const original = signal.throwIfAborted.bind(signal)
    Object.defineProperty(signal, 'throwIfAborted', {
      value: () => {
        const projected = existsSync(harness.runsRoot)
          && readdirSync(harness.runsRoot, { withFileTypes: true }).some((entry) => {
            if (!entry.isDirectory() || entry.name === 'sessions') return false
            const path = join(harness.runsRoot, entry.name, 'script.js')
            return existsSync(path) && statSync(path).size > 0
          })
        if (projected) controller.abort()
        original()
      },
    })

    await expect(harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent, signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(readdirSync(harness.runsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'sessions')).toEqual([])
    await expect(harness.ctx.workflowSupervisor.start({
      script: 'return 2', meta: META, parent: harness.parent,
    })).resolves.toMatchObject({ displayName: 'audit' })
  })

  it('rejects ambiguous launch sources and rolls a failed budget increase back', async () => {
    const harness = await setup({ defaultAgentBudget: 2, maxAgentBudget: 8 })
    const definition = {
      name: 'saved', description: 'saved', script: 'return 1', scope: 'project' as const, path: '/saved.js',
    }
    await expect(harness.ctx.workflowSupervisor.start({
      definition, script: 'return 2', parent: harness.parent,
    })).rejects.toThrow(/either a definition or an inline script/)
    await expect(harness.ctx.workflowSupervisor.start({
      script: 'return 2', parent: harness.parent,
    })).rejects.toThrow(/requires both script and meta/)

    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, agentBudget: 2, parent: harness.parent,
    })
    harness.engine.settle(0, budgetLimited(2))
    await waitForStatus(harness, 'audit', 'budget-limited')
    harness.engine.failNextStart = true
    expect(() => harness.ctx.workflowSupervisor.resumeById(launched.runId, harness.parent, 3))
      .toThrow('engine rejected launch')
    expect((await runs(harness))[0]?.budget).toEqual({ total: 2, spent: 2, remaining: 0 })
  })

  it('validates smoke checks and disposes every validation handle', async () => {
    const harness = await setup({ defaultAgentBudget: 2, maxAgentBudget: 4 })
    await expect(harness.ctx.workflowSupervisor.validate({
      script: 'return 1', meta: META,
    })).resolves.toEqual({ ok: false, error: 'validate_only requires a calling agent' })

    const completedValidation = harness.ctx.workflowSupervisor.validate({
      script: 'return 1', meta: META, args: { input: true }, agentBudget: 3,
      parent: harness.parent, signal: signal(),
    })
    expect(harness.engine.attempts[0]?.request).toMatchObject({
      args: { input: true }, maxTotalAgents: 3, validateOnly: true,
    })
    harness.engine.settle(0, completed({ valid: true }))
    await expect(completedValidation).resolves.toEqual({ ok: true, result: { valid: true } })
    expect(harness.engine.attempts[0]?.disposed).toBe(1)

    const failedValidation = harness.ctx.workflowSupervisor.validate({
      script: 'return 2', meta: META, parent: harness.parent,
    })
    harness.engine.settle(1, { value: null, stopReason: 'error', agentsStarted: 0 })
    await expect(failedValidation).resolves.toEqual({ ok: false, error: 'workflow smoke check failed' })
    expect(harness.engine.attempts[1]?.disposed).toBe(1)

    const explainedValidation = harness.ctx.workflowSupervisor.validate({
      script: 'return 3', meta: META, parent: harness.parent,
    })
    harness.engine.settle(2, { value: null, stopReason: 'error', error: 'invalid host', agentsStarted: 0 })
    await expect(explainedValidation).resolves.toEqual({ ok: false, error: 'invalid host' })
  })

  it('uses direct-construction defaults and rejects inconsistent configured limits', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-supervisor-constructor-'))
    const direct = new WorkflowSupervisor(new Context(), { dshHome })
    expect(direct).toBeInstanceOf(WorkflowSupervisor)

    const invalid: Array<[Config, RegExp]> = [
      [{ defaultAgentBudget: 2, maxAgentBudget: 1 }, /defaultAgentBudget/],
      [{ maxActiveRunsPerSession: 2, maxActiveRunsGlobal: 1 }, /maxActiveRunsPerSession/],
      [{ maxLogLineBytes: 2, maxLogTotalBytes: 1 }, /maxLogLineBytes/],
      [{ maxGateKindBytes: 1 }, /maxGateKindBytes/],
      [{ defaultAgentBudget: 1, maxAgentBudget: 2, maxMembersPerRun: 1 }, /maxMembersPerRun/],
      [{ remotePageDefault: 2, remotePageMax: 1 }, /remotePageDefault/],
      [{ artifactChunkDefaultBytes: 5, artifactChunkMaxBytes: 4 }, /artifactChunkDefaultBytes/],
    ]
    for (const [config, message] of invalid) {
      expect(() => new WorkflowSupervisor(new Context(), Object.assign({ dshHome }, config)))
        .toThrow(message)
    }
  })

  it('rejects disabled, shutting-down, missing-source, oversized, and invalid-budget launches', async () => {
    const disabled = await setup({ enabled: false })
    await expect(disabled.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: disabled.parent,
    })).rejects.toThrow(/disabled/)

    const stopped = await setup()
    const stoppedSupervisor = stopped.ctx.workflowSupervisor
    await stopped.supervisorFiber.dispose()
    await expect(stoppedSupervisor.start({
      script: 'return 1', meta: META, parent: stopped.parent,
    })).rejects.toThrow(/shutting down/)

    const harness = await setup({ maxScriptProjectionBytes: 4, defaultAgentBudget: 1, maxAgentBudget: 2 })
    await expect(harness.ctx.workflowSupervisor.start({ parent: harness.parent }))
      .rejects.toThrow(/requires a saved definition/)
    await expect(harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })).rejects.toThrow(/projection exceeds/)
    await expect(harness.ctx.workflowSupervisor.start({
      script: 'x', meta: META, agentBudget: 0, parent: harness.parent,
    })).rejects.toThrow(/agent_budget/)
    await expect(harness.ctx.workflowSupervisor.start({
      script: 'x', meta: META, agentBudget: Number.MAX_VALUE, parent: harness.parent,
    })).rejects.toThrow(/agent_budget/)
  })

  it('retains optional saved-definition metadata', async () => {
    const harness = await setup()
    await harness.ctx.workflowSupervisor.start({
      definition: {
        name: 'saved',
        description: 'saved workflow',
        whenToUse: 'when auditing',
        phases: [{ title: 'inspect' }],
        script: 'return 1',
        scope: 'bundled',
        path: '/saved.js',
      },
      parent: harness.parent,
    })
    expect(harness.engine.attempts[0]?.request.meta).toEqual({
      name: 'saved', description: 'saved workflow', whenToUse: 'when auditing', phases: [{ title: 'inspect' }],
    })
  })

  it('fences a stale attempt settlement and sends one terminal event and notice', async () => {
    const harness = await setup()
    const terminal: unknown[][] = []
    harness.ctx.on('workflows/run-end', (...args: unknown[]) => { terminal.push(args) })
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })

    await pauseToQuiescence(harness)
    expect(harness.notices).toEqual([])
    expect(terminal).toEqual([])
    harness.ctx.workflowSupervisor.resume('audit', harness.parent)
    harness.engine.settle(0, completed('stale'))
    await Promise.resolve()
    expect((await runs(harness))[0]).toMatchObject({
      runId: launched.runId,
      status: 'running',
    })
    expect(harness.notices).toEqual([])
    expect(terminal).toEqual([])

    harness.engine.settle(1, completed({ ok: true }))
    await waitForStatus(harness, 'audit', 'completed')
    await vi.waitFor(() => { expect(terminal).toHaveLength(1) })
    await vi.waitFor(() => { expect(harness.notices).toHaveLength(1) })
    expect(terminal[0]?.[0]).toMatchObject({ id: launched.runId, displayName: 'audit' })
    expect(harness.notices).toHaveLength(1)
    harness.engine.settle(1, completed('duplicate'))
    await Promise.resolve()
    expect(terminal).toHaveLength(1)
    expect(harness.notices).toHaveLength(1)
    expect(harness.engine.attempts.map(attempt => attempt.disposed)).toEqual([1, 1])
  })

  it('ignores a settlement after both execution and generation ownership move', async () => {
    const harness = await setup()
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const supervisor = internal(harness)
    const run = supervisor.runsById.get(String(launched.runId))
    if (run?.attempt === undefined) throw new Error('attempt was not retained')
    const lookup = supervisor.executions.get(String(run.attempt.executionId))
    if (lookup === undefined) throw new Error('execution lookup was not retained')
    lookup.generation += 1
    run.generation += 1
    harness.engine.settle(0, completed('stale'))
    await vi.waitFor(() => { expect(harness.engine.attempts[0]?.disposed).toBe(1) })
    expect(run.status).toBe('running')
  })

  it('maps ordinary engine stop reasons and error-free budget and stop settlements', async () => {
    const harness = await setup({ defaultAgentBudget: 2, maxAgentBudget: 4 })
    const cancelledRun = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: { ...META, name: 'cancelled' }, parent: harness.parent,
    })
    harness.engine.settle(0, { value: null, stopReason: 'cancelled', agentsStarted: 0 })
    await waitForStatus(harness, cancelledRun.displayName, 'cancelled')

    const failedRun = await harness.ctx.workflowSupervisor.start({
      script: 'return 2', meta: { ...META, name: 'failed' }, parent: harness.parent,
    })
    harness.engine.settle(1, { value: null, stopReason: 'error', error: 'failed normally', agentsStarted: 0 })
    await waitForStatus(harness, failedRun.displayName, 'failed')

    const budgetRun = await harness.ctx.workflowSupervisor.start({
      script: 'return 3', meta: { ...META, name: 'budget' }, parent: harness.parent,
    })
    harness.engine.settle(2, {
      value: null, stopReason: 'error', errorCode: 'AGENT_CAP', agentsStarted: 2,
    })
    await waitForStatus(harness, budgetRun.displayName, 'budget-limited')
    expect((await harness.ctx.workflowSupervisor.resultForClient(
      harness.parent, { runId: budgetRun.runId }, signal(),
    ))).not.toHaveProperty('error')

    const stoppedRun = await harness.ctx.workflowSupervisor.start({
      script: 'return 4', meta: { ...META, name: 'stopped' }, parent: harness.parent,
    })
    const stop = harness.ctx.workflowSupervisor.stop(stoppedRun.displayName, harness.parent)
    harness.engine.settle(3, { value: null, stopReason: 'cancelled', agentsStarted: 0 })
    await stop
    expect((await harness.ctx.workflowSupervisor.resultForClient(
      harness.parent, { runId: stoppedRun.runId }, signal(),
    )).error).toBe('stopped by user')
  })

  it('treats terminal finishers as idempotent and publishes without an owner', async () => {
    const harness = await setup()
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const run = internal(harness).runsById.get(String(launched.runId))
    if (run === undefined) throw new Error('run was not published')
    delete run.parent
    delete run.ownerCleanup
    internal(harness).finishTerminal(run, 'completed', completed(null))
    internal(harness).finishTerminal(run, 'completed', completed(null))
    internal(harness).finishInterrupted(run)
    await run.completionDelivery
    expect(run.status).toBe('completed')
    expect(harness.notices).toEqual([])
  })

  it('evicts a committed member value that is absent during terminal release', async () => {
    const harness = await setup()
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    harness.engine.event(0, 'workflow/agent-start', {
      seq: 1, label: 'child', childId: SessionId('missing-result-child'),
    })
    const run = internal(harness).runsById.get(String(launched.runId))
    if (run === undefined) throw new Error('run was not published')
    const members = run.members as Map<number, {
      resultCommitted: boolean
      result: JsonValue | undefined
      outcomeView: unknown
    }>
    const member = members.get(1)
    if (member === undefined) throw new Error('member was not retained')
    member.resultCommitted = true
    member.result = undefined
    harness.engine.settle(0, completed(null, 1))
    await waitForStatus(harness, launched.displayName, 'completed')
    expect(member.outcomeView).toEqual({ state: 'evicted' })
  })

  it('does not publish pause or stop completion before captured-attempt disposal', async () => {
    const paused = await setup()
    paused.engine.blockDisposal = true
    await paused.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: paused.parent })
    const pause = paused.ctx.workflowSupervisor.pause('audit', paused.parent)
    paused.engine.settle(0, cancelled('paused by user'))
    await vi.waitFor(() => { expect(paused.engine.attempts[0]?.disposeStarted).toBe(1) })
    expect((await runs(paused))[0]?.status).toBe('pausing')
    expect(paused.notices).toEqual([])
    paused.engine.releaseDisposal(0)
    await pause
    await waitForStatus(paused, 'audit', 'paused')
    expect(paused.engine.attempts[0]?.disposed).toBe(1)
    expect(paused.notices).toEqual([])

    const stopped = await setup()
    stopped.engine.blockDisposal = true
    await stopped.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: stopped.parent })
    const stop = stopped.ctx.workflowSupervisor.stop('audit', stopped.parent)
    stopped.engine.settle(0, cancelled('stopped by user'))
    await vi.waitFor(() => { expect(stopped.engine.attempts[0]?.disposeStarted).toBe(1) })
    expect((await runs(stopped))[0]?.status).toBe('stopping')
    expect(stopped.notices).toEqual([])
    stopped.engine.releaseDisposal(0)
    await stop
    await waitForStatus(stopped, 'audit', 'cancelled')
    expect(stopped.engine.attempts[0]?.disposed).toBe(1)
    await vi.waitFor(() => { expect(stopped.notices).toHaveLength(1) })
  })

  it('waits for running work but treats every parked state as owner-quiescent', async () => {
    const running = await setup()
    await running.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: running.parent })
    let settled = false
    const wait = running.ctx.workflowSupervisor.whenOwnerQuiescent(running.parent).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    running.engine.settle(0, completed())
    await wait
    expect(running.whenIdle).toHaveBeenCalled()

    const gated = await setup()
    await gated.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: gated.parent })
    gated.engine.event(0, 'workflow/gate', { kind: 'user', message: 'answer', resumable: true })
    await expect(gated.ctx.workflowSupervisor.whenOwnerQuiescent(gated.parent)).resolves.toBeUndefined()

    const paused = await setup()
    await paused.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: paused.parent })
    await pauseToQuiescence(paused)
    await expect(paused.ctx.workflowSupervisor.whenOwnerQuiescent(paused.parent)).resolves.toBeUndefined()

    const limited = await setup({ defaultAgentBudget: 1, maxAgentBudget: 1, maxMembersPerRun: 1 })
    await limited.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: limited.parent })
    limited.engine.settle(0, budgetLimited(1))
    await waitForStatus(limited, 'audit', 'budget-limited')
    await expect(limited.ctx.workflowSupervisor.whenOwnerQuiescent(limited.parent)).resolves.toBeUndefined()
  })

  it('releases every concurrent owner-quiescence waiter', async () => {
    const harness = await setup()
    await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const first = harness.ctx.workflowSupervisor.whenOwnerQuiescent(harness.parent)
    const second = harness.ctx.workflowSupervisor.whenOwnerQuiescent(harness.parent)
    harness.engine.settle(0, completed())
    await Promise.all([first, second])
  })

  it('cancels owner waits without cancelling admitted workflow lifecycle work', async () => {
    const before = await setup()
    const beforeReason = new Error('before wait')
    await expect(before.ctx.workflowSupervisor.whenOwnerQuiescent(
      before.parent,
      AbortSignal.abort(beforeReason),
    )).rejects.toBe(beforeReason)
    expect(before.whenIdle).not.toHaveBeenCalled()

    const during = await setup()
    await during.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: during.parent })
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const reason = new Error('stop waiting')
    const ownerWait = during.ctx.workflowSupervisor.whenOwnerQuiescent(during.parent, controller.signal)
    await vi.waitFor(() => { expect(add).toHaveBeenCalled() })
    controller.abort(reason)
    await expect(ownerWait).rejects.toBe(reason)
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length)
    expect(during.engine.attempts[0]?.cancelReason).toBeUndefined()
    during.engine.settle(0, completed())
    await waitForStatus(during, 'audit', 'completed')

    const normal = await setup()
    await normal.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: normal.parent })
    const normalController = new AbortController()
    const normalAdd = vi.spyOn(normalController.signal, 'addEventListener')
    const normalRemove = vi.spyOn(normalController.signal, 'removeEventListener')
    const normalWait = normal.ctx.workflowSupervisor.whenOwnerQuiescent(normal.parent, normalController.signal)
    normal.engine.settle(0, completed())
    await normalWait
    expect(normalRemove).toHaveBeenCalledTimes(normalAdd.mock.calls.length)
  })

  it('lets pause and stop callers abandon their waits while captured attempts still settle', async () => {
    const paused = await setup()
    await paused.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: paused.parent })
    const pauseController = new AbortController()
    const pauseWait = paused.ctx.workflowSupervisor.pause('audit', paused.parent, pauseController.signal)
    pauseController.abort(new Error('caller left'))
    await expect(pauseWait).rejects.toThrow('caller left')
    expect(paused.engine.attempts[0]?.cancelReason).toBe('paused by user')
    paused.engine.settle(0, cancelled())
    await waitForStatus(paused, 'audit', 'paused')

    const stopped = await setup()
    await stopped.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: stopped.parent })
    const stopController = new AbortController()
    const stopWait = stopped.ctx.workflowSupervisor.stop('audit', stopped.parent, stopController.signal)
    stopController.abort(new Error('caller left'))
    await expect(stopWait).rejects.toThrow('caller left')
    expect(stopped.engine.attempts[0]?.cancelReason).toBe('stopped by user')
    stopped.engine.settle(0, cancelled())
    await waitForStatus(stopped, 'audit', 'cancelled')
  })

  it('publishes ordered lifecycle identities and contains throwing or rejecting listeners', async () => {
    const harness = await setup()
    const order: string[] = []
    const warnings: string[] = []
    harness.ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof harness.ctx.logger.warn
    harness.ctx.on('workflows/run-start', () => { order.push('run-start'); throw new Error('broken start listener') })
    // The containment path must also tolerate a runtime listener that violates
    // the typed void event slot by returning a rejected promise.
    // oxlint-disable-next-line typescript/no-misused-promises
    harness.ctx.on('workflows/run-start', async () => {
      order.push('run-start-async')
      throw new Error('rejected start listener')
    })
    harness.ctx.on('workflows/run-start', () => { order.push('run-start-later') })
    let memberPayload: unknown
    harness.ctx.on('workflows/member-start', (_run, member) => {
      order.push('member-start')
      memberPayload = member
    })
    harness.ctx.on('workflows/member-end', () => { order.push('member-end') })
    harness.ctx.on('workflows/run-end', () => { order.push('run-end') })
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const childSessionId = SessionId('lifecycle-child')
    harness.engine.event(0, 'workflow/agent-start', { seq: 1, label: 'child', childId: childSessionId })
    harness.engine.event(0, 'workflow/agent-end', {
      seq: 1, label: 'child', childId: childSessionId, outcome: 'completed',
    })
    harness.engine.settle(0, completed(null, 1))
    await waitForStatus(harness, 'audit', 'completed')
    await vi.waitFor(() => { expect(order).toHaveLength(6) })
    await vi.waitFor(() => { expect(warnings).toHaveLength(2) })
    expect(order).toEqual([
      'run-start', 'run-start-async', 'run-start-later', 'member-start', 'member-end', 'run-end',
    ])
    expect(memberPayload).toMatchObject({ childSessionId, seq: 1 })
    expect(launched.runId).toBeDefined()
  })

  it('publishes member and terminal lifecycle only after their FIFO manifest commits', async () => {
    const harness = await setup()
    await harness.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: harness.parent })
    const writes = deferManifestWrites(harness)
    const lifecycle: string[] = []
    harness.ctx.on('workflows/member-start', () => { lifecycle.push('member-start') })
    harness.ctx.on('workflows/member-end', () => { lifecycle.push('member-end') })
    harness.ctx.on('workflows/run-end', () => { lifecycle.push('run-end') })

    const childId = SessionId('durable-child')
    harness.engine.event(0, 'workflow/agent-start', { seq: 1, label: 'child', childId })
    harness.engine.event(0, 'workflow/agent-end', {
      seq: 1, label: 'child', childId, outcome: 'completed',
    })
    harness.engine.settle(0, completed(null, 1))
    await vi.waitFor(() => { expect(writes).toHaveLength(3) })

    let quiescent = false
    const ownerWait = harness.ctx.workflowSupervisor.whenOwnerQuiescent(harness.parent)
      .then(() => { quiescent = true })
    writes[1]!.settlement.resolve(undefined)
    await Promise.resolve()
    expect(lifecycle).toEqual([])
    expect(quiescent).toBe(false)

    writes[0]!.settlement.resolve(undefined)
    await vi.waitFor(() => { expect(lifecycle).toEqual(['member-start', 'member-end']) })
    expect(quiescent).toBe(false)
    expect(harness.notices).toEqual([])

    writes[2]!.settlement.resolve(undefined)
    await ownerWait
    expect(lifecycle).toEqual(['member-start', 'member-end', 'run-end'])
    expect(harness.notices).toHaveLength(1)
  })

  it('suppresses later lifecycle when an earlier member manifest commit fails', async () => {
    const harness = await setup()
    await harness.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: harness.parent })
    const writes = deferManifestWrites(harness)
    const lifecycle: string[] = []
    harness.ctx.on('workflows/member-start', () => { lifecycle.push('member-start') })
    harness.ctx.on('workflows/member-end', () => { lifecycle.push('member-end') })
    harness.ctx.on('workflows/run-end', () => { lifecycle.push('run-end') })

    const childId = SessionId('failed-durable-child')
    harness.engine.event(0, 'workflow/agent-start', { seq: 1, label: 'child', childId })
    harness.engine.event(0, 'workflow/agent-end', {
      seq: 1, label: 'child', childId, outcome: 'completed',
    })
    harness.engine.settle(0, completed(null, 1))
    await vi.waitFor(() => { expect(writes).toHaveLength(3) })
    writes[0]!.settlement.reject(new Error('member manifest unavailable'))
    writes[1]!.settlement.resolve(undefined)
    writes[2]!.settlement.resolve(undefined)

    await harness.ctx.workflowSupervisor.whenOwnerQuiescent(harness.parent)
    expect(lifecycle).toEqual([])
    expect(harness.notices).toEqual([])
  })

  it('awaits the lifecycle publication chain during supervisor disposal', async () => {
    const harness = await setup()
    await harness.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: harness.parent })
    const writes = deferManifestWrites(harness)
    const lifecycle: string[] = []
    harness.ctx.on('workflows/member-start', () => { lifecycle.push('member-start') })
    harness.ctx.on('workflows/member-end', () => { lifecycle.push('member-end') })
    harness.ctx.on('workflows/run-end', () => { lifecycle.push('run-end') })
    harness.engine.autoSettleCancellation = true
    harness.engine.event(0, 'workflow/agent-start', {
      seq: 1, label: 'child', childId: SessionId('disposed-child'),
    })

    let disposed = false
    const disposal = harness.supervisorFiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(writes).toHaveLength(2) })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(lifecycle).toEqual([])

    writes[0]!.settlement.resolve(undefined)
    await vi.waitFor(() => { expect(lifecycle).toEqual(['member-start']) })
    expect(disposed).toBe(false)
    writes[1]!.settlement.resolve(undefined)
    await disposal
    expect(lifecycle).toEqual(['member-start', 'member-end', 'run-end'])
  })

  it('returns atomic sorted recording snapshots and distinguishes absence from authorization failure', async () => {
    const harness = await setup({ defaultAgentBudget: 4, maxAgentBudget: 4, maxMembersPerRun: 4 })
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    harness.engine.event(0, 'workflow/agent-start', {
      seq: 2, label: 'second', childId: SessionId('child-2'),
    })
    harness.engine.event(0, 'workflow/agent-start', {
      seq: 1, label: 'first', childId: SessionId('child-1'),
    })

    const active = await harness.ctx.workflowSupervisor.recordingSnapshot(
      harness.parent, launched.runId,
    )
    expect(active).toMatchObject({
      info: { id: launched.runId, displayName: 'audit', name: 'audit' },
      run: { runId: launched.runId, status: 'running' },
      members: [
        { seq: 1, childSessionId: SessionId('child-1'), status: 'running' },
        { seq: 2, childSessionId: SessionId('child-2'), status: 'running' },
      ],
    })
    expect(active).not.toHaveProperty('result')
    await expect(harness.ctx.workflowSupervisor.recordingSnapshot(
      harness.parent, WorkflowRunId('absent') as never,
    )).resolves.toBeUndefined()

    const otherSession = Session.create(SessionId('other-session'))
    const otherAgent = {
      id: otherSession.id,
      options: {},
      session: otherSession,
      ctx: harness.ctx,
    } as unknown as Agent
    await expect(harness.ctx.workflowSupervisor.recordingSnapshot(otherAgent, launched.runId))
      .rejects.toThrow(/another Session/)

    harness.engine.settle(0, completed(null, 2))
    await harness.ctx.workflowSupervisor.whenOwnerQuiescent(harness.parent)
    await expect(harness.ctx.workflowSupervisor.recordingSnapshot(harness.parent, launched.runId))
      .resolves.toMatchObject({
        run: { status: 'completed' },
        result: { stopReason: 'completed', agentsStarted: 2 },
      })
  })

  it('recovers before recording and propagates recovery cancellation', async () => {
    const beforeRestart = await setup()
    const launched = await beforeRestart.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: beforeRestart.parent,
    })
    const afterRestart = await setup({
      dshHome: beforeRestart.dshHome,
      runsRoot: beforeRestart.runsRoot,
    })
    await expect(afterRestart.ctx.workflowSupervisor.recordingSnapshot(
      afterRestart.parent, launched.runId,
    )).resolves.toMatchObject({
      run: { status: 'interrupted' },
      result: { stopReason: 'interrupted', agentsStarted: 0 },
    })

    const cancelledRecovery = await setup()
    const pending = await cancelledRecovery.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: cancelledRecovery.parent,
    })
    const fresh = await setup({
      dshHome: cancelledRecovery.dshHome,
      runsRoot: cancelledRecovery.runsRoot,
    })
    const reason = new Error('stop recovery')
    await expect(fresh.ctx.workflowSupervisor.recordingSnapshot(
      fresh.parent, pending.runId, AbortSignal.abort(reason),
    )).rejects.toBe(reason)
  })

  it('allows a budget-limited run to resume only by id with a higher absolute cap', async () => {
    const harness = await setup({ defaultAgentBudget: 2, maxAgentBudget: 8 })
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, agentBudget: 2, parent: harness.parent,
    })
    harness.engine.settle(0, budgetLimited(2))
    await waitForStatus(harness, 'audit', 'budget-limited')

    expect(() => {
      harness.ctx.workflowSupervisor.resume('audit', harness.parent)
    })
      .toThrow(/higher|budget/i)
    expect(() => harness.ctx.workflowSupervisor.resumeById(launched.runId, harness.parent))
      .toThrow(/higher|budget/i)
    expect(() => harness.ctx.workflowSupervisor.resumeById(launched.runId, harness.parent, 2))
      .toThrow(/higher|budget/i)

    expect(harness.ctx.workflowSupervisor.resumeById(launched.runId, harness.parent, 3))
      .toBe('audit')
    expect(harness.engine.attempts[1]?.request).toMatchObject({
      maxTotalAgents: 3,
      initialAgentSpend: 2,
    })
    expect((await runs(harness))[0]).toMatchObject({
      runId: launched.runId,
      status: 'running',
      budget: { total: 3, spent: 2, remaining: 1 },
    })
  })

  it('rejects controls from ineligible states and stops a parked run without an attempt', async () => {
    const harness = await setup({ defaultAgentBudget: 2, maxAgentBudget: 4 })
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    await expect(harness.ctx.workflowSupervisor.pause('missing', harness.parent))
      .rejects.toThrow(/no workflow run/)
    await pauseToQuiescence(harness)
    await expect(harness.ctx.workflowSupervisor.pause('audit', harness.parent))
      .rejects.toThrow(/not running/)
    expect(() => harness.ctx.workflowSupervisor.resumeById(
      launched.runId, harness.parent, 3,
    )).toThrow(/may be raised only/)
    expect(harness.ctx.workflowSupervisor.resumeById(
      launched.runId, harness.parent, 2,
    )).toBe('audit')
    await pauseToQuiescence(harness)
    await harness.ctx.workflowSupervisor.stop('audit', harness.parent)
    await waitForStatus(harness, 'audit', 'cancelled')
    await expect(harness.ctx.workflowSupervisor.stop('audit', harness.parent))
      .rejects.toThrow(/already settled/)
  })

  it('retains a committed JSON null as an available member outcome', async () => {
    const harness = await setup()
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const childId = SessionId('child-null')
    harness.engine.event(0, 'workflow/agent-start', {
      seq: 1, label: 'null child', childId,
    })
    harness.engine.event(0, 'workflow/journal-commit', {
      kind: 'agent',
      ordinal: 1,
      seq: 1,
      callId: 'root/agent:0',
      fingerprint: 'fingerprint',
      result: null,
    })
    harness.engine.event(0, 'workflow/agent-end', {
      seq: 1, label: 'null child', childId, outcome: 'failed',
    })

    const members = await harness.ctx.workflowSupervisor.membersForClient(
      harness.parent,
      { runId: launched.runId },
      new AbortController().signal,
    )
    const member = members.items[0]
    expect(member).toMatchObject({ seq: 1, outcome: 'available' })
    if (member === undefined) throw new Error('member was not retained')
    expect(harness.ctx.workflowSupervisor.memberDetail(harness.parent, {
      runId: launched.runId, memberId: member.memberId,
    }))
      .toMatchObject({
        childSessionId: childId,
        outcome: {
          state: 'available',
          content: { kind: 'value', value: null },
          truncated: false,
        },
      })
  })

  it('reports every retained member-outcome state through local and Remote reads', async () => {
    const harness = await setup({ defaultAgentBudget: 4, maxAgentBudget: 4, maxMembersPerRun: 4 })
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    for (let seq = 1; seq <= 4; seq += 1) {
      harness.engine.event(0, 'workflow/agent-start', {
        seq,
        label: `member-${seq}`,
        ...(seq === 1 ? { phase: 'inspect' } : {}),
        childId: SessionId(`member-state-${seq}`),
      })
    }
    harness.engine.event(0, 'workflow/agent-end', {
      seq: 2, label: 'member-2', childId: SessionId('member-state-2'), outcome: 'completed',
    })
    const run = (harness.ctx.workflowSupervisor as unknown as {
      runsById: Map<string, { members: Map<number, {
        memberId: ReturnType<typeof WorkflowMemberId>
        status: 'running' | 'completed' | 'failed' | 'cancelled'
        resultCommitted: boolean
        outcomeEvicted: boolean
        result: JsonValue | undefined
        outcomeView: unknown
      }> }>
    }).runsById.get(String(launched.runId))
    if (run === undefined) throw new Error('run was not published')
    const committedWithoutValue = run.members.get(3)
    const explicitlyEvicted = run.members.get(4)
    if (committedWithoutValue === undefined || explicitlyEvicted === undefined) {
      throw new Error('members were not retained')
    }
    committedWithoutValue.resultCommitted = true
    committedWithoutValue.result = undefined
    committedWithoutValue.outcomeView = undefined
    explicitlyEvicted.status = 'failed'
    explicitlyEvicted.outcomeEvicted = true

    const members = await harness.ctx.workflowSupervisor.membersForClient(
      harness.parent, { runId: launched.runId }, signal(),
    )
    expect(members.items.map(member => [member.seq, member.phase, member.outcome])).toEqual([
      [1, 'inspect', 'pending'],
      [2, undefined, 'not-produced'],
      [3, undefined, 'available'],
      [4, undefined, 'evicted'],
    ])
    const outcomes = await Promise.all(members.items.map(async member =>
      await harness.ctx.workflowSupervisor.memberDetailForClient(harness.parent, {
        runId: launched.runId, memberId: member.memberId,
      }, signal())))
    expect(outcomes.map(detail => detail.outcome.state)).toEqual([
      'pending', 'not-produced', 'evicted', 'evicted',
    ])
    await expect(harness.ctx.workflowSupervisor.memberDetailForClient(harness.parent, {
      runId: launched.runId, memberId: WorkflowMemberId('missing'),
    }, signal())).rejects.toThrow(/member was not found/)
  })

  it('fences gate resumes and retains an interrupted gate for recovered detail', async () => {
    const harness = await setup()
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const requests: WorkflowGateRequest[] = []
    harness.ctx.on('workflows/gate-request', (request) => { requests.push(request) })
    harness.engine.event(0, 'workflow/gate', {
      kind: 'question', message: 'continue?', resumable: true,
    })
    expect(requests).toHaveLength(1)
    expect(await harness.ctx.workflowSupervisor.detailForClient(
      harness.parent, { runId: launched.runId }, signal(),
    )).toMatchObject({ gate: { kind: 'question', message: 'continue?', resumable: true } })
    const request = requests[0]!
    expect(harness.ctx.workflowSupervisor.resumeGate(
      WorkflowRunId('missing') as never, request.executionId, request.gateId, harness.parent,
    )).toBe(false)
    expect(harness.ctx.workflowSupervisor.resumeGate(
      launched.runId, WorkflowRunId('stale'), request.gateId, harness.parent,
    )).toBe(false)
    expect(harness.ctx.workflowSupervisor.resumeGate(
      launched.runId, request.executionId, WorkflowGateId('stale'), harness.parent,
    )).toBe(false)

    const run = (harness.ctx.workflowSupervisor as unknown as {
      runsById: Map<string, {
        gate?: { generation: number }
        attempt?: { generation: number }
      }>
      clearGate: (run: unknown, preserveInterrupted?: boolean) => void
    }).runsById.get(String(launched.runId))
    if (run?.gate === undefined || run.attempt === undefined) throw new Error('gate was not retained')
    const currentGate = run.gate
    const currentAttempt = run.attempt
    delete run.gate
    expect(harness.ctx.workflowSupervisor.resumeGate(
      launched.runId, request.executionId, request.gateId, harness.parent,
    )).toBe(false)
    run.gate = currentGate
    delete run.attempt
    expect(harness.ctx.workflowSupervisor.resumeGate(
      launched.runId, request.executionId, request.gateId, harness.parent,
    )).toBe(false)
    run.attempt = currentAttempt
    run.gate.generation += 1
    expect(harness.ctx.workflowSupervisor.resumeGate(
      launched.runId, request.executionId, request.gateId, harness.parent,
    )).toBe(false)
    run.gate.generation = run.attempt.generation
    expect(harness.ctx.workflowSupervisor.resumeGate(
      launched.runId, request.executionId, request.gateId, harness.parent,
    )).toBe(true)
    expect(harness.engine.attempts[0]?.resumeCalls).toBe(1)

    harness.engine.event(0, 'workflow/gate', {
      kind: 'question', message: 'resume by handle', resumable: true,
    })
    harness.ctx.workflowSupervisor.resume(launched.displayName, harness.parent)
    expect(harness.engine.attempts[0]?.resumeCalls).toBe(2)

    harness.engine.event(0, 'workflow/gate', {
      kind: 'verification', message: 'durable question', resumable: true,
    })
    const internal = harness.ctx.workflowSupervisor as unknown as {
      clearGate: (run: unknown, preserveInterrupted?: boolean) => void
    }
    internal.clearGate(run, true)
    expect(await harness.ctx.workflowSupervisor.detailForClient(
      harness.parent, { runId: launched.runId }, signal(),
    )).toMatchObject({
      gate: { kind: 'verification', message: 'durable question', resumable: false },
    })
  })

  it('paginates runs and rejects stale, malformed, and cross-collection cursors', async () => {
    const harness = await setup({ remotePageDefault: 2, remotePageMax: 3 })
    for (let index = 0; index < 3; index += 1) {
      await harness.ctx.workflowSupervisor.start({
        script: `return ${index}`, meta: META, parent: harness.parent,
      })
    }
    const first = await harness.ctx.workflowSupervisor.listForClient(
      harness.parent,
      { limit: 2 },
      signal(),
    )
    expect(first.items.map(run => run.displayName)).toEqual(['audit', 'audit-2'])
    expect(first.total).toBe(3)
    expect(first.nextCursor).toBeDefined()
    const second = await harness.ctx.workflowSupervisor.listForClient(
      harness.parent,
      { cursor: first.nextCursor!, limit: 2 },
      signal(),
    )
    expect(second.items.map(run => run.displayName)).toEqual(['audit-3'])

    await expect(harness.ctx.workflowSupervisor.membersForClient(
      harness.parent,
      { runId: first.items[0]!.runId, cursor: first.nextCursor! },
      signal(),
    )).rejects.toThrow(/invalid|another collection/)
    await expect(harness.ctx.workflowSupervisor.listForClient(
      harness.parent,
      { cursor: 'not-json' as never },
      signal(),
    )).rejects.toThrow(/cursor is invalid/)
    await expect(harness.ctx.workflowSupervisor.listForClient(
      harness.parent,
      { limit: 4 },
      signal(),
    )).rejects.toThrow(/safe integer from 1 through 3/)

    await harness.ctx.workflowSupervisor.start({
      script: 'return 4', meta: META, parent: harness.parent,
    })
    await expect(harness.ctx.workflowSupervisor.listForClient(
      harness.parent,
      { cursor: first.nextCursor! },
      signal(),
    )).rejects.toThrow(/stale/)
  })

  it('rejects non-object cursor payloads and invalid page and artifact byte bounds', async () => {
    const harness = await setup({
      remotePageDefault: 1,
      remotePageMax: 3,
      artifactChunkDefaultBytes: 4,
      artifactChunkMaxBytes: 8,
    })
    for (const payload of [null, [], 'text']) {
      await expect(harness.ctx.workflowSupervisor.listForClient(
        harness.parent, { cursor: cursor(payload) }, signal(),
      )).rejects.toThrow(/cursor is invalid/)
    }
    for (const limit of [0, 1.5, Number.MAX_VALUE]) {
      await expect(harness.ctx.workflowSupervisor.listForClient(
        harness.parent, { limit }, signal(),
      )).rejects.toThrow(/page limit/)
    }
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'x', meta: META, parent: harness.parent,
    })
    const scratch = join(dirname(launched.scriptPath!), 'scratch')
    await writeFile(join(scratch, 'file.txt'), 'data', 'utf8')
    for (const maxBytes of [3, 4.5, Number.MAX_VALUE]) {
      await expect(harness.ctx.workflowSupervisor.artifactForClient(
        harness.parent, { runId: launched.runId, name: 'file.txt', maxBytes }, signal(),
      )).rejects.toThrow(/artifact maxBytes/)
    }
  })

  it('paginates members and log tails with revision-fenced cursors', async () => {
    const harness = await setup({
      remotePageDefault: 1,
      remotePageMax: 2,
      maxLogLines: 2,
      maxLogLineBytes: 8,
      maxLogTotalBytes: 16,
      defaultAgentBudget: 4,
      maxAgentBudget: 4,
      maxMembersPerRun: 4,
    })
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    for (let seq = 1; seq <= 3; seq += 1) {
      harness.engine.event(0, 'workflow/agent-start', {
        seq, label: `member-${seq}`, childId: SessionId(`child-${seq}`),
      })
    }
    const members = await harness.ctx.workflowSupervisor.membersForClient(
      harness.parent,
      { runId: launched.runId },
      signal(),
    )
    expect(members.items.map(member => member.seq)).toEqual([1])
    const member2 = await harness.ctx.workflowSupervisor.membersForClient(
      harness.parent,
      { runId: launched.runId, cursor: members.nextCursor!, limit: 2 },
      signal(),
    )
    expect(member2.items.map(member => member.seq)).toEqual([2, 3])
    harness.engine.event(0, 'workflow/agent-end', {
      seq: 1, label: 'member-1', childId: SessionId('child-1'), outcome: 'failed',
    })
    await expect(harness.ctx.workflowSupervisor.membersForClient(
      harness.parent,
      { runId: launched.runId, cursor: members.nextCursor! },
      signal(),
    )).rejects.toThrow(/stale/)

    harness.engine.event(0, 'workflow/log', 'first')
    harness.engine.event(0, 'workflow/log', 'second')
    harness.engine.event(0, 'workflow/log', 'third-is-truncated')
    const logs = await harness.ctx.workflowSupervisor.logsForClient(
      harness.parent,
      { runId: launched.runId, limit: 1 },
      signal(),
    )
    expect(logs).toMatchObject({
      items: [{ index: 1, text: 'second' }], evicted: 1, total: 3,
    })
    expect(logs.nextCursor).toBeDefined()
    expect((await harness.ctx.workflowSupervisor.logsForClient(
      harness.parent,
      { runId: launched.runId, cursor: logs.nextCursor! },
      signal(),
    )).items).toEqual([{ index: 2, text: 'third-is' }])
    harness.engine.event(0, 'workflow/log', 'fourth')
    await expect(harness.ctx.workflowSupervisor.logsForClient(
      harness.parent,
      { runId: launched.runId, cursor: logs.nextCursor! },
      signal(),
    )).rejects.toThrow(/stale/)
  })

  it('sorts, caps, paginates, and reads UTF-8 scratch artifacts safely', async () => {
    const harness = await setup({
      maxRetainedArtifactsPerRun: 2,
      remotePageDefault: 1,
      remotePageMax: 2,
      artifactChunkDefaultBytes: 4,
      artifactChunkMaxBytes: 8,
    })
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const scratch = join(dirname(launched.scriptPath!), 'scratch')
    await writeFile(join(scratch, 'z.txt'), 'last', 'utf8')
    await writeFile(join(scratch, 'a.txt'), 'a😀b', 'utf8')
    await writeFile(join(scratch, 'm.txt'), 'middle', 'utf8')
    const first = await harness.ctx.workflowSupervisor.artifactsForClient(
      harness.parent,
      { runId: launched.runId },
      signal(),
    )
    expect(first).toMatchObject({
      items: [{ name: 'a.txt', bytes: 6 }], omitted: 1, total: 3,
    })
    expect((await harness.ctx.workflowSupervisor.artifactsForClient(
      harness.parent,
      { runId: launched.runId, cursor: first.nextCursor! },
      signal(),
    )).items).toEqual([{ name: 'm.txt', bytes: 6 }])

    const chunk1 = await harness.ctx.workflowSupervisor.artifactForClient(
      harness.parent,
      { runId: launched.runId, name: 'a.txt', maxBytes: 4, expectedRevision: first.revision },
      signal(),
    )
    expect(chunk1).toMatchObject({ text: 'a', offsetBytes: 0, returnedBytes: 1, totalBytes: 6 })
    const chunk2 = await harness.ctx.workflowSupervisor.artifactForClient(
      harness.parent,
      { runId: launched.runId, name: 'a.txt', maxBytes: 4, cursor: chunk1.nextCursor! },
      signal(),
    )
    expect(chunk2).toMatchObject({ text: '😀', offsetBytes: 1, returnedBytes: 4 })
    const chunk3 = await harness.ctx.workflowSupervisor.artifactForClient(
      harness.parent,
      { runId: launched.runId, name: 'a.txt', maxBytes: 4, cursor: chunk2.nextCursor! },
      signal(),
    )
    expect(chunk3).toMatchObject({ text: 'b', offsetBytes: 5, returnedBytes: 1 })
    expect(chunk3.nextCursor).toBeUndefined()

    await writeFile(join(scratch, 'a.txt'), 'changed', 'utf8')
    await expect(harness.ctx.workflowSupervisor.artifactForClient(
      harness.parent,
      { runId: launched.runId, name: 'a.txt', expectedRevision: first.revision },
      signal(),
    )).rejects.toThrow(/collection changed/)
    await expect(harness.ctx.workflowSupervisor.artifactForClient(
      harness.parent,
      { runId: launched.runId, name: '../secret' },
      signal(),
    )).rejects.toThrow(/one bounded scratch-file component/)
    await expect(harness.ctx.workflowSupervisor.artifactForClient(
      harness.parent,
      { runId: launched.runId, name: 'missing.txt' },
      signal(),
    )).rejects.toThrow(/not found/)
    await expect(harness.ctx.workflowSupervisor.artifactForClient(
      harness.parent,
      { runId: launched.runId, name: 'a.txt', maxBytes: 3 },
      signal(),
    )).rejects.toThrow(/safe integer from 4 through 8/)
  })

  it('rejects malformed, linked, and same-sized replaced artifact bytes', async () => {
    const harness = await setup({ artifactChunkDefaultBytes: 8, artifactChunkMaxBytes: 8 })
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const scratch = join(dirname(launched.scriptPath!), 'scratch')
    const malformed = join(scratch, 'malformed.txt')
    await writeFile(malformed, Buffer.from([0x61, 0xff]))
    await harness.ctx.workflowSupervisor.artifactsForClient(harness.parent, {
      runId: launched.runId,
    }, signal())
    await expect(harness.ctx.workflowSupervisor.artifactForClient(
      harness.parent,
      { runId: launched.runId, name: 'malformed.txt' },
      signal(),
    )).rejects.toThrow(/not valid UTF-8/)

    await writeFile(malformed, Buffer.from([0x61, 0xff, 0x62]))
    await expect(harness.ctx.workflowSupervisor.artifactForClient(
      harness.parent,
      { runId: launched.runId, name: 'malformed.txt' },
      signal(),
    )).rejects.toThrow(/not valid UTF-8/)

    const outside = join(harness.dshHome, 'outside.txt')
    await writeFile(outside, 'secret', 'utf8')
    await symlink(outside, join(scratch, 'linked.txt'))
    await expect(harness.ctx.workflowSupervisor.artifactForClient(
      harness.parent,
      { runId: launched.runId, name: 'linked.txt' },
      signal(),
    )).rejects.toThrow(/not found/)

    const stable = join(scratch, 'stable.txt')
    await writeFile(stable, 'first', 'utf8')
    await harness.ctx.workflowSupervisor.artifactsForClient(harness.parent, {
      runId: launched.runId,
    }, signal())
    const replacementSignal = new AbortController().signal
    const original = replacementSignal.throwIfAborted.bind(replacementSignal)
    let checks = 0
    Object.defineProperty(replacementSignal, 'throwIfAborted', {
      value: () => {
        checks += 1
        if (checks === 4) {
          renameSync(stable, `${stable}.old`)
          writeFileSync(stable, 'other', 'utf8')
        }
        original()
      },
    })
    await expect(harness.ctx.workflowSupervisor.artifactForClient(
      harness.parent,
      { runId: launched.runId, name: 'stable.txt' },
      replacementSignal,
    )).rejects.toThrow(/changed; refresh/)
  })

  it('handles missing and malformed scratch directories and cursors beyond EOF', async () => {
    const missing = await setup({ artifactChunkDefaultBytes: 4, artifactChunkMaxBytes: 8 })
    const missingRun = await missing.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: missing.parent,
    })
    const missingScratch = join(dirname(missingRun.scriptPath!), 'scratch')
    await rm(missingScratch, { recursive: true })
    expect(await missing.ctx.workflowSupervisor.artifactsForClient(
      missing.parent, { runId: missingRun.runId }, signal(),
    )).toMatchObject({ items: [], total: 0 })

    const malformed = await setup({ artifactChunkDefaultBytes: 4, artifactChunkMaxBytes: 8 })
    const malformedRun = await malformed.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: malformed.parent,
    })
    const malformedScratch = join(dirname(malformedRun.scriptPath!), 'scratch')
    await rm(malformedScratch, { recursive: true })
    await writeFile(malformedScratch, 'not a directory', 'utf8')
    await expect(malformed.ctx.workflowSupervisor.artifactsForClient(
      malformed.parent, { runId: malformedRun.runId }, signal(),
    )).rejects.toMatchObject({ code: 'ENOTDIR' })

    const bounded = await setup({ artifactChunkDefaultBytes: 4, artifactChunkMaxBytes: 8 })
    const boundedRun = await bounded.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: bounded.parent,
    })
    const boundedScratch = join(dirname(boundedRun.scriptPath!), 'scratch')
    await writeFile(join(boundedScratch, 'short.txt'), 'text', 'utf8')
    const page = await bounded.ctx.workflowSupervisor.artifactsForClient(
      bounded.parent, { runId: boundedRun.runId }, signal(),
    )
    await expect(bounded.ctx.workflowSupervisor.artifactForClient(
      bounded.parent,
      {
        runId: boundedRun.runId,
        name: 'short.txt',
        cursor: cursor({
          kind: 'artifact', owner: `${boundedRun.runId}\u0000short.txt`, revision: page.revision, offset: 5,
        }),
      },
      signal(),
    )).rejects.toThrow(/past the end/)
  })

  it('applies revision-checked controls and returns only durably published heads', async () => {
    const harness = await setup()
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const head = (await runs(harness))[0]!
    await expect(harness.ctx.workflowSupervisor.controlForClient(
      harness.parent,
      { runId: launched.runId, action: 'pause', expectedRevision: head.revision - 1 },
      signal(),
    )).rejects.toThrow(/changed; refresh/)
    expect(harness.engine.attempts[0]?.cancelReason).toBeUndefined()

    const pause = harness.ctx.workflowSupervisor.controlForClient(
      harness.parent,
      { runId: launched.runId, action: 'pause', expectedRevision: head.revision },
      signal(),
    )
    harness.engine.settle(0, cancelled('paused by user'))
    expect((await pause).run.status).toBe('paused')

    const pausedHead = (await runs(harness))[0]!
    expect((await harness.ctx.workflowSupervisor.controlForClient(
      harness.parent,
      { runId: launched.runId, action: 'resume', expectedRevision: pausedHead.revision },
      signal(),
    )).run.status).toBe('running')

    const runningHead = (await runs(harness))[0]!
    const stop = harness.ctx.workflowSupervisor.controlForClient(
      harness.parent,
      { runId: launched.runId, action: 'stop', expectedRevision: runningHead.revision },
      signal(),
    )
    harness.engine.settle(1, cancelled('stopped by user'))
    expect((await stop).run.status).toBe('cancelled')
  })

  it('enforces exact Session and Agent ownership across display and id lookups', async () => {
    const harness = await setup()
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const sameSessionAgent = {
      ...harness.parent,
      id: harness.parent.id,
      session: harness.parent.session,
    } as Agent
    await expect(harness.ctx.workflowSupervisor.pause(launched.displayName, sameSessionAgent))
      .rejects.toThrow(/owned by another Agent instance/)
    expect(() => harness.ctx.workflowSupervisor.resumeById(launched.runId, sameSessionAgent))
      .toThrow(/owned by another Agent instance/)

    const otherSession = agentFor(harness.ctx, 'unauthorized-session')
    await expect(harness.ctx.workflowSupervisor.memberDetailForClient(otherSession, {
      runId: launched.runId,
      memberId: WorkflowMemberId('missing'),
    }, signal())).rejects.toThrow(/no workflow run with that id/)
  })

  it('saves a no-follow bounded script projection and exposes selected detail and result views', async () => {
    const harness = await setup({
      remoteDetailMaxPhases: 1,
      remoteHeadTextMaxBytes: 64,
      maxScriptProjectionBytes: 128,
    })
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1',
      meta: {
        ...META,
        phases: [
          { title: 'first', detail: 'detail', provider: 'provider', model: 'model' },
          { title: 'second' },
        ],
      },
      parent: harness.parent,
    })
    expect(await harness.ctx.workflowSupervisor.save('audit', harness.parent, 'user')).toBe('/saved/audit.js')
    expect(harness.save).toHaveBeenCalledWith(
      {
        meta: {
          ...META,
          phases: [
            { title: 'first', detail: 'detail', provider: 'provider', model: 'model' },
            { title: 'second' },
          ],
        },
        script: 'return 1',
      },
      { scope: 'user' },
    )
    const detail = await harness.ctx.workflowSupervisor.detailForClient(
      harness.parent,
      { runId: launched.runId },
      signal(),
    )
    expect(detail).toMatchObject({
      phases: [{ title: 'first', detail: 'detail', provider: 'provider', model: 'model' }],
      scriptPath: launched.scriptPath,
    })
    expect((await harness.ctx.workflowSupervisor.resultForClient(
      harness.parent,
      { runId: launched.runId },
      signal(),
    )).value).toEqual({ state: 'pending' })

    const outside = join(harness.dshHome, 'outside.js')
    await writeFile(outside, 'HOST SECRET', 'utf8')
    await unlink(launched.scriptPath!)
    await symlink(outside, launched.scriptPath!)
    await expect(harness.ctx.workflowSupervisor.save('audit', harness.parent)).rejects.toThrow(/owned regular file|symbolic link|ELOOP/)
    expect(harness.save).toHaveBeenCalledTimes(1)
  })

  it('saves with the configured scope, caller cwd, and signal and exposes optional detail fields', async () => {
    const harness = await setup({ saveScope: 'user' })
    const parent = agentFor(harness.ctx, 'session-with-cwd', harness.dshHome)
    const meta: WorkflowMeta = { ...META, phases: [{ title: 'only' }] }
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta, parent,
    })
    const operationSignal = signal()
    await harness.ctx.workflowSupervisor.save('audit', parent, undefined, operationSignal)
    expect(harness.save).toHaveBeenCalledWith(
      { meta, script: 'return 1' },
      { scope: 'user', cwd: harness.dshHome, signal: operationSignal },
    )

    const run = internal(harness).runsById.get(String(launched.runId))
    if (run === undefined) throw new Error('run was not published')
    run.phase = 'working'
    ;(run as unknown as { error?: string }).error = 'visible failure'
    const detail = await harness.ctx.workflowSupervisor.detailForClient(
      parent, { runId: launched.runId }, signal(),
    )
    expect(detail).toMatchObject({
      run: { phase: 'working' },
      phases: [{ title: 'only' }],
      error: 'visible failure',
      scriptPath: launched.scriptPath,
    })
    expect(await harness.ctx.workflowSupervisor.resultForClient(
      parent, { runId: launched.runId }, signal(),
    )).toMatchObject({ error: 'visible failure' })
  })

  it('rejects a script projection that grew past its configured read limit', async () => {
    const harness = await setup({ maxScriptProjectionBytes: 8 })
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    await writeFile(launched.scriptPath!, 'x'.repeat(9), 'utf8')
    await expect(harness.ctx.workflowSupervisor.save(launched.displayName, harness.parent))
      .rejects.toThrow(/projection exceeds/)
  })

  it('rejects save without a process-owned projection', async () => {
    const beforeRestart = await setup()
    const launched = await beforeRestart.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: beforeRestart.parent,
    })
    const afterRestart = await setup({ dshHome: beforeRestart.dshHome, runsRoot: beforeRestart.runsRoot })
    await afterRestart.ctx.workflowSupervisor.recoverSession(afterRestart.parent)
    await internal(afterRestart).loadRecovered(afterRestart.parent.session.id)
    expect(await afterRestart.ctx.workflowSupervisor.detailForClient(
      afterRestart.parent, { runId: launched.runId }, signal(),
    )).not.toHaveProperty('scriptPath')
    await expect(afterRestart.ctx.workflowSupervisor.save(launched.displayName, afterRestart.parent))
      .rejects.toThrow(/no editable script projection/)
  })

  it('withholds completion delivery and rejects controls when manifest publication fails', async () => {
    const terminal = await setup()
    const terminalEvents: unknown[][] = []
    terminal.ctx.on('workflows/run-end', (...args: unknown[]) => { terminalEvents.push(args) })
    await terminal.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: terminal.parent })
    const terminalStore = (terminal.ctx.workflowSupervisor as unknown as {
      manifests: { upsert: (...args: unknown[]) => Promise<unknown> }
    }).manifests
    vi.spyOn(terminalStore, 'upsert').mockRejectedValueOnce(new Error('disk unavailable'))
    terminal.engine.settle(0, completed('done'))
    await waitForStatus(terminal, 'audit', 'completed')
    await terminal.ctx.workflowSupervisor.whenOwnerQuiescent(terminal.parent)
    expect(terminalEvents).toEqual([])
    expect(terminal.notices).toEqual([])

    const controlled = await setup()
    const launched = await controlled.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: controlled.parent,
    })
    const controlledStore = (controlled.ctx.workflowSupervisor as unknown as {
      manifests: { upsert: (...args: unknown[]) => Promise<unknown> }
    }).manifests
    vi.spyOn(controlledStore, 'upsert').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(controlled.ctx.workflowSupervisor.controlForClient(
      controlled.parent,
      { runId: launched.runId, action: 'save' },
      signal(),
    )).rejects.toThrow('disk unavailable')
  })

  it('removes prepublication directories after manifest insertion failures', async () => {
    const rejected = await setup()
    vi.spyOn(internal(rejected).manifests, 'insertWithNextDisplayName')
      .mockRejectedValueOnce(new Error('manifest insertion failed'))
    await expect(rejected.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: rejected.parent,
    })).rejects.toThrow('manifest insertion failed')
    expect(readdirSync(rejected.runsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'sessions')).toEqual([])

    const broken = await setup()
    vi.spyOn(internal(broken).manifests, 'insertWithNextDisplayName')
      .mockResolvedValueOnce({ evicted: [] })
    await expect(broken.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: broken.parent,
    })).rejects.toThrow(/did not create a run/)
  })

  it('contains unrenderable owner-disposal failures', async () => {
    const harness = await setup()
    const warnings: string[] = []
    harness.ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof harness.ctx.logger.warn
    const thrown = { toString() { throw new Error('cannot render') } }
    const supervisor = internal(harness)
    supervisor.disposeOwner = vi.fn().mockRejectedValue(thrown)
    harness.ctx.emit('agent/disposed', { agent: harness.parent })
    await vi.waitFor(() => {
      expect(warnings).toContain('workflow-supervisor: owner disposal failed: [unrenderable thrown value]')
    })
  })

  it('contains attempt-disposal and owner-cleanup failures', async () => {
    const harness = await setup()
    const warnings: string[] = []
    harness.ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof harness.ctx.logger.warn
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const run = internal(harness).runsById.get(String(launched.runId))
    if (run === undefined) throw new Error('run was not published')
    run.ownerCleanup = async () => { throw new Error('cleanup failed') }
    harness.engine.failNextDisposal = true
    harness.engine.settle(0, completed(null))
    await waitForStatus(harness, 'audit', 'completed')
    await vi.waitFor(() => {
      expect(warnings).toContain('workflow-supervisor: attempt disposal failed: Error: engine disposal failed')
      expect(warnings).toContain('workflow-supervisor: owner cleanup detach failed: Error: cleanup failed')
    })
  })

  it('releases terminal execution values while retaining bounded result projections', async () => {
    const harness = await setup()
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', args: { secret: 'argument' }, meta: META, parent: harness.parent,
    })
    const childId = SessionId('retained-child')
    harness.engine.event(0, 'workflow/agent-start', { seq: 1, label: 'child', childId })
    harness.engine.event(0, 'workflow/journal-commit', {
      kind: 'agent', ordinal: 1, seq: 1, callId: 'root/agent:0', fingerprint: 'a'.repeat(64), result: { member: true },
    })
    harness.engine.event(0, 'workflow/agent-end', {
      seq: 1, label: 'child', childId, outcome: 'completed',
    })
    harness.engine.settle(0, completed({ terminal: true }, 1))
    await waitForStatus(harness, 'audit', 'completed')

    const internal = (harness.ctx.workflowSupervisor as unknown as {
      runsById: Map<string, {
        script?: string
        args?: unknown
        journal: Map<unknown, unknown>
        members: Map<number, { result?: unknown; outcomeView?: unknown }>
      }>
    }).runsById.get(String(launched.runId))!
    expect(internal.script).toBeUndefined()
    expect(internal.args).toBeUndefined()
    expect(internal.journal.size).toBe(0)
    expect(internal.members.get(1)?.result).toBeUndefined()
    expect(internal.members.get(1)?.outcomeView).toMatchObject({ state: 'available' })
    expect((await harness.ctx.workflowSupervisor.resultForClient(
      harness.parent,
      { runId: launched.runId },
      signal(),
    )).value).toMatchObject({
      state: 'available', content: { kind: 'value', value: { terminal: true } },
    })
  })

  it('unlinks an evicted link-shaped run directory without touching its target', async () => {
    const harness = await setup({ maxRetainedRunsPerSession: 1 })
    const first = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    harness.engine.settle(0, completed())
    await waitForStatus(harness, 'audit', 'completed')
    const firstDirectory = dirname(first.scriptPath!)
    const savedDirectory = `${firstDirectory}.saved`
    await rename(firstDirectory, savedDirectory)
    const target = join(harness.dshHome, 'must-survive')
    await mkdir(target)
    await writeFile(join(target, 'marker.txt'), 'keep', 'utf8')
    await symlink(target, firstDirectory)

    await harness.ctx.workflowSupervisor.start({
      script: 'return 2', meta: META, parent: harness.parent,
    })
    await vi.waitFor(() => { expect(existsSync(firstDirectory)).toBe(false) })
    expect(await readFile(join(target, 'marker.txt'), 'utf8')).toBe('keep')
    expect(existsSync(savedDirectory)).toBe(true)
  })

  it('enforces per-Session and global active-run admission limits', async () => {
    const perSession = await setup({ maxActiveRunsPerSession: 1, maxActiveRunsGlobal: 2 })
    await perSession.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: perSession.parent,
    })
    await expect(perSession.ctx.workflowSupervisor.start({
      script: 'return 2', meta: META, parent: perSession.parent,
    })).rejects.toThrow(/session reached/)

    const global = await setup({ maxActiveRunsPerSession: 1, maxActiveRunsGlobal: 1 })
    await global.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: global.parent,
    })
    const secondOwner = agentFor(global.ctx, 'second-limit-session')
    await expect(global.ctx.workflowSupervisor.start({
      script: 'return 2', meta: META, parent: secondOwner,
    })).rejects.toThrow(/supervisor reached/)
  })

  it('releases stacked start reservations exactly once', async () => {
    const harness = await setup({ maxActiveRunsPerSession: 2, maxActiveRunsGlobal: 2 })
    const releaseFirst = internal(harness).reserveStartSlot(harness.parent)
    const releaseSecond = internal(harness).reserveStartSlot(harness.parent)
    const counters = internal(harness) as unknown as {
      pendingStartsBySession: Map<string, number>
      pendingStartsByOwner: WeakMap<Agent, number>
    }
    counters.pendingStartsBySession.delete(String(harness.parent.session.id))
    counters.pendingStartsByOwner.delete(harness.parent)
    releaseSecond()
    releaseFirst()
    releaseFirst()
    expect((internal(harness) as unknown as { pendingStarts: number }).pendingStarts).toBe(0)

    const attempt = { intent: 'teardown' }
    internal(harness).raiseIntent(attempt, 'pause')
    expect(attempt.intent).toBe('teardown')
  })

  it('counts reserved starts as owner work and normalizes non-Error wait rejections', async () => {
    const harness = await setup()
    const supervisor = internal(harness)
    const release = supervisor.reserveStartSlot(harness.parent)
    expect(supervisor.ownerHasUnquiescedWork(harness.parent)).toBe(true)
    release()
    expect(supervisor.ownerHasUnquiescedWork(harness.parent)).toBe(false)
    const pending = Promise.withResolvers<never>()
    const controller = new AbortController()
    const rejected = supervisor.awaitWithSignal(pending.promise, controller.signal)
    controller.abort('plain failure')
    await expect(rejected)
      .rejects.toEqual(new Error('plain failure', { cause: 'plain failure' }))
  })

  it('closes an owner waiter when work disappears during waiter installation', async () => {
    const harness = await setup()
    const supervisor = internal(harness)
    const original = supervisor.ownerHasUnquiescedWork.bind(supervisor)
    supervisor.ownerHasUnquiescedWork = () => false
    await expect(supervisor.waitForOwnerChange(harness.parent)).resolves.toBeUndefined()
    supervisor.ownerHasUnquiescedWork = original
  })

  it('removes terminal evictions and ignores absent or active defensive candidates', async () => {
    const harness = await setup()
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const store = internal(harness)
    const run = store.runsById.get(String(launched.runId))
    if (run === undefined) throw new Error('run was not published')
    store.removeEvicted({ runId: WorkflowRunId('absent') })
    store.removeEvicted({ runId: launched.runId })
    expect(store.runsById.has(String(launched.runId))).toBe(true)
    harness.engine.settle(0, completed())
    await waitForStatus(harness, 'audit', 'completed')
    ;(store as unknown as { sessionRevisions: Map<string, number> }).sessionRevisions
      .delete(String(harness.parent.session.id))
    store.removeEvicted({ runId: launched.runId })
    expect(store.runsById.has(String(launched.runId))).toBe(false)
  })

  it('applies evictions returned by an ordinary manifest update', async () => {
    const harness = await setup()
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const supervisor = internal(harness)
    const run = supervisor.runsById.get(String(launched.runId))
    if (run === undefined) throw new Error('run was not published')
    const candidate = { runId: WorkflowRunId('evicted') }
    vi.spyOn(supervisor.manifests, 'upsert').mockResolvedValueOnce({ evicted: [candidate] })
    const removeEvicted = vi.spyOn(supervisor, 'removeEvicted')
    await supervisor.persist(run)
    expect(removeEvicted).toHaveBeenCalledWith(candidate)
    const priorRevision = run.artifactsRevision
    supervisor.commit(run, 'artifacts')
    await run.durablePublication
    expect(run.artifactsRevision).toBe(priorRevision + 1)
  })

  it('recovers an active manifest as non-resumable Interrupted without reusing its handle', async () => {
    const beforeRestart = await setup()
    const launched = await beforeRestart.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: beforeRestart.parent,
    })

    const afterRestart = await setup({
      dshHome: beforeRestart.dshHome,
      runsRoot: beforeRestart.runsRoot,
    })
    await afterRestart.ctx.workflowSupervisor.recoverSession(afterRestart.parent)

    expect(afterRestart.engine.attempts).toEqual([])
    expect(await runs(afterRestart)).toMatchObject([{
      runId: launched.runId,
      displayName: 'audit',
      status: 'interrupted',
    }])
    expect(() => {
      afterRestart.ctx.workflowSupervisor.resume('audit', afterRestart.parent)
    })
      .toThrow(/interrupted|cannot resume/i)
    expect(() => afterRestart.ctx.workflowSupervisor.resumeById(launched.runId, afterRestart.parent, 8))
      .toThrow(/interrupted|cannot resume/i)

    const next = await afterRestart.ctx.workflowSupervisor.start({
      script: 'return 2', meta: META, parent: afterRestart.parent,
    })
    expect(next.displayName).toBe('audit-2')
  })

  it('recovers retained logs, members, JSON results, and preview results', async () => {
    const beforeRestart = await setup({
      memberOutcomeMaxBytes: 16,
      defaultAgentBudget: 2,
      maxAgentBudget: 2,
      maxMembersPerRun: 2,
    })
    const first = await beforeRestart.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: beforeRestart.parent,
    })
    beforeRestart.engine.event(0, 'workflow/log', 'retained log')
    beforeRestart.engine.event(0, 'workflow/agent-start', {
      seq: 1, label: 'child', phase: 'inspect', childId: SessionId('recovered-child'),
    })
    beforeRestart.engine.event(0, 'workflow/journal-commit', {
      kind: 'agent', ordinal: 1, seq: 1, callId: 'root/agent:0', fingerprint: 'f', result: null,
    })
    beforeRestart.engine.event(0, 'workflow/agent-end', {
      seq: 1, label: 'child', childId: SessionId('recovered-child'), outcome: 'completed',
    })
    beforeRestart.engine.settle(0, completed(null, 1))
    await waitForStatus(beforeRestart, first.displayName, 'completed')

    const second = await beforeRestart.ctx.workflowSupervisor.start({
      script: 'return 2', meta: META, parent: beforeRestart.parent,
    })
    beforeRestart.engine.event(1, 'workflow/agent-start', {
      seq: 1, label: 'unfinished', childId: SessionId('recovered-unfinished'),
    })
    beforeRestart.engine.settle(1, completed({ text: 'x'.repeat(100) }, 1))
    await beforeRestart.ctx.workflowSupervisor.whenOwnerQuiescent(beforeRestart.parent)

    const afterRestart = await setup({
      dshHome: beforeRestart.dshHome,
      runsRoot: beforeRestart.runsRoot,
      memberOutcomeMaxBytes: 16,
      defaultAgentBudget: 2,
      maxAgentBudget: 2,
      maxMembersPerRun: 2,
    })
    await afterRestart.ctx.workflowSupervisor.recoverSession(afterRestart.parent)
    expect((await afterRestart.ctx.workflowSupervisor.logsForClient(
      afterRestart.parent, { runId: first.runId }, signal(),
    )).items).toEqual([{ index: 0, text: 'retained log' }])
    expect((await afterRestart.ctx.workflowSupervisor.membersForClient(
      afterRestart.parent, { runId: first.runId }, signal(),
    )).items).toMatchObject([{ phase: 'inspect', status: 'completed', outcome: 'evicted' }])
    expect((await afterRestart.ctx.workflowSupervisor.resultForClient(
      afterRestart.parent, { runId: first.runId }, signal(),
    )).value).toMatchObject({ state: 'available', content: { kind: 'value', value: null } })
    expect((await afterRestart.ctx.workflowSupervisor.resultForClient(
      afterRestart.parent, { runId: second.runId }, signal(),
    )).value).toMatchObject({ state: 'available', content: { kind: 'preview' }, truncated: true })
  })

  it('defaults optional recovered member timestamps from the run', async () => {
    const harness = await setup()
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    harness.engine.event(0, 'workflow/agent-start', {
      seq: 1, label: 'child', childId: SessionId('timestamp-child'),
    })
    const live = internal(harness).runsById.get(String(launched.runId))
    if (live === undefined) throw new Error('run was not published')
    const manifest = structuredClone(internal(harness).manifest(live)) as {
      members: Array<{ startedAt?: number; settledAt?: number }>
    }
    const member = manifest.members[0]
    if (member === undefined) throw new Error('manifest member was not retained')
    delete member.startedAt
    delete member.settledAt
    const recovered = internal(harness).fromRecovered(manifest)
    const recoveredMember = recovered.members.get(1) as { startedAt: number; settledAt?: number }
    expect(recoveredMember.startedAt).toBe((manifest as unknown as { startedAt: number }).startedAt)
    expect(recoveredMember.settledAt).toBeUndefined()
  })

  it('cancels and disposes active attempts on owner and supervisor teardown', async () => {
    const owner = await setup()
    owner.engine.autoSettleCancellation = true
    await owner.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: owner.parent })
    owner.ctx.emit('agent/disposed', { agent: owner.parent })
    await vi.waitFor(() => { expect(owner.engine.attempts[0]?.disposed).toBe(1) })
    expect(owner.engine.attempts[0]?.cancelReason).toMatch(/disposed|owner|session/i)

    const service = await setup()
    service.engine.autoSettleCancellation = true
    await service.ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent: service.parent })
    await service.supervisorFiber.dispose()
    expect(service.engine.attempts[0]?.cancelReason).toMatch(/disposed|shutdown|supervisor/i)
    expect(service.engine.attempts[0]?.disposed).toBe(1)
  })

  it('disposes parked runs, skips unrelated owners, and makes service disposal idempotent', async () => {
    const harness = await setup()
    const parked = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    await pauseToQuiescence(harness)
    const other = agentFor(harness.ctx, 'other-disposal-session')
    await harness.ctx.workflowSupervisor.start({
      script: 'return 2', meta: META, parent: other,
    })
    await internal(harness).disposeOwner(harness.parent)
    await waitForStatus(harness, parked.displayName, 'interrupted')

    harness.engine.autoSettleCancellation = true
    await internal(harness).disposeService()
    await internal(harness).disposeService()
    expect(harness.engine.attempts[1]?.disposed).toBe(1)
  })

  it('contains missing-directory cleanup and warns for non-directory path failures', async () => {
    const harness = await setup()
    const warnings: string[] = []
    harness.ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof harness.ctx.logger.warn
    await internal(harness).removeDirectory(join(harness.dshHome, 'missing'))
    const parentFile = join(harness.dshHome, 'parent-file')
    await writeFile(parentFile, 'file', 'utf8')
    await internal(harness).removeDirectory(join(parentFile, 'child'))
    expect(warnings.some(message => message.includes('failed to remove run directory'))).toBe(true)
  })

  it('marks parked runs interrupted while skipping already terminal rows', async () => {
    const harness = await setup()
    const first = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    await pauseToQuiescence(harness)
    const second = await harness.ctx.workflowSupervisor.start({
      script: 'return 2', meta: { ...META, name: 'done' }, parent: harness.parent,
    })
    harness.engine.settle(1, completed())
    await waitForStatus(harness, second.displayName, 'completed')
    harness.ctx.workflowSupervisor.markInterrupted()
    await waitForStatus(harness, first.displayName, 'interrupted')
    expect((await runs(harness)).find(run => run.runId === second.runId)?.status).toBe('completed')
  })

  it('rejects execution helpers when process-owned resumability is absent', async () => {
    const harness = await setup()
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const run = internal(harness).runsById.get(String(launched.runId))
    if (run === undefined) throw new Error('run was not published')
    const processState = run as unknown as { script?: string; parent?: Agent; status: string; attempt?: unknown }
    const script = processState.script
    if (script === undefined) throw new Error('run script was not retained')
    delete processState.script
    expect(() => internal(harness).createAttempt(run)).toThrow(/no resumable execution/)
    processState.script = script
    processState.status = 'paused'
    expect(() => { internal(harness).resumeRecord(run, agentFor(harness.ctx, 'wrong-owner')) })
      .toThrow(/not owned by this Agent/)
    expect(() => { internal(harness).resumeLiveGate(run) }).toThrow(/no live input gate/)
    processState.status = 'running'
    delete processState.parent
    harness.engine.event(0, 'workflow/gate', {
      kind: 'question', message: 'owner is gone', resumable: true,
    })
  })

  it('enforces member retention and ignores missing, duplicate, settled, and stale callbacks', async () => {
    const harness = await setup({ defaultAgentBudget: 1, maxAgentBudget: 1, maxMembersPerRun: 1 })
    const warnings: string[] = []
    harness.ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof harness.ctx.logger.warn
    const launched = await harness.ctx.workflowSupervisor.start({
      script: 'return 1', meta: META, parent: harness.parent,
    })
    const childId = SessionId('limited-child')
    harness.engine.event(0, 'workflow/agent-start', { seq: 1, label: 'first', childId })
    harness.engine.event(0, 'workflow/agent-start', { seq: 2, label: 'overflow', childId })
    expect(harness.engine.attempts[0]?.cancelReason).toMatch(/retention limit/)
    harness.engine.event(0, 'workflow/agent-end', {
      seq: 99, label: 'missing', childId, outcome: 'failed',
    })
    harness.engine.event(0, 'workflow/agent-end', {
      seq: 1, label: 'first', childId, outcome: 'completed',
    })
    harness.engine.event(0, 'workflow/agent-end', {
      seq: 1, label: 'first', childId, outcome: 'failed',
    })
    harness.engine.event(0, 'workflow/journal-commit', {
      kind: 'tool', ordinal: 1, callId: 'root/tool:0', fingerprint: 'f', result: null,
    })
    harness.engine.event(0, 'workflow/journal-commit', {
      kind: 'agent', ordinal: 2, seq: 99, callId: 'root/agent:0', fingerprint: 'f', result: null,
    })
    harness.engine.event(0, 'workflow/phase', 'ignored after stale lookup')
    const supervisor = internal(harness)
    const run = supervisor.runsById.get(String(launched.runId))
    if (run?.attempt === undefined) throw new Error('attempt was not retained')
    const executionId = run.attempt.executionId
    const attempt = run.attempt
    delete run.attempt
    let called = false
    supervisor.withAttempt(executionId, () => { called = true })
    run.attempt = attempt
    const lookup = supervisor.executions.get(String(executionId))
    if (lookup === undefined) throw new Error('execution lookup was not retained')
    lookup.generation += 1
    supervisor.withAttempt(executionId, () => { called = true })
    lookup.generation = attempt.generation
    attempt.executionId = WorkflowRunId('different')
    supervisor.withAttempt(executionId, () => { called = true })
    attempt.executionId = executionId
    supervisor.withAttempt(WorkflowRunId('missing'), () => { called = true })
    expect(called).toBe(false)
    expect(warnings).toEqual([])
  })
})
