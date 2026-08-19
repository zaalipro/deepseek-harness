import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  SupervisedWorkflowRunId,
  WorkflowMemberId,
} from '@deepseek-ai/dsh-workflow-supervisor'
import type {
  SupervisedWorkflowRunId as LogicalRunId,
  SupervisedWorkflowRunInfo,
  WorkflowLaunched,
  WorkflowRunHead,
  WorkflowRunStatus,
} from '@deepseek-ai/dsh-workflow-supervisor/types'
import type { WorkflowRunRecordingSnapshot } from '@deepseek-ai/dsh-workflow-supervisor'
import WorkflowRunRecorder from '../src/index.ts'

/** Supervisor surface used by recovery while tests emit lifecycle directly. */
class StubSupervisor {
  readonly snapshots = new Map<LogicalRunId, WorkflowRunRecordingSnapshot | undefined>()
  recover = vi.fn(async (_agent: Agent, _signal?: AbortSignal): Promise<void> => {})
  snapshot = vi.fn(async (
    _agent: Agent,
    runId: LogicalRunId,
    _signal?: AbortSignal,
  ): Promise<WorkflowRunRecordingSnapshot | undefined> => this.snapshots.get(runId))

  async recoverSession(agent: Agent, signal?: AbortSignal): Promise<void> {
    return this.recover(agent, signal)
  }

  async recordingSnapshot(
    agent: Agent,
    runId: LogicalRunId,
    signal?: AbortSignal,
  ): Promise<WorkflowRunRecordingSnapshot | undefined> {
    return this.snapshot(agent, runId, signal)
  }
}

function info(runId: LogicalRunId, displayName = 'audit'): SupervisedWorkflowRunInfo {
  return { id: runId, displayName, name: 'audit' }
}

function member(
  seq: number,
  status: 'running' | 'completed' | 'failed' | 'cancelled',
  phase?: string,
) {
  return {
    memberId: WorkflowMemberId(`member-${seq}`),
    seq,
    label: `member-${seq}`,
    ...phase === undefined ? {} : { phase },
    childSessionId: SessionId(`child-${seq}`),
    status,
    outcome: status === 'running' ? 'pending' as const : 'available' as const,
  }
}

function launch(runId: LogicalRunId, displayName = 'audit'): WorkflowLaunched {
  return { runId, displayName, status: 'started' }
}

async function setup(options: {
  seed?: (session: Session) => void
  existingAgent?: boolean
  prepareSupervisor?: (supervisor: StubSupervisor, ctx: Context, session: Session) => void
} = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const supervisor = new StubSupervisor()
  ctx.provide('workflowSupervisor', supervisor as unknown as Context['workflowSupervisor'])
  const session = Session.create(SessionId('parent'))
  options.seed?.(session)
  options.prepareSupervisor?.(supervisor, ctx, session)
  const agent = { id: session.id, options: {}, session } as unknown as Agent
  const scope = createScope(ctx, agent)
  Object.assign(agent, { ctx: scope.ctx })
  if (options.existingAgent === true) ctx.agents.register(agent)
  const plugin = await ctx.plugin(WorkflowRunRecorder)
  return { ctx, supervisor, session, agent, plugin }
}

function head(runId: LogicalRunId, status: WorkflowRunStatus): WorkflowRunHead {
  return {
    runId,
    displayName: 'audit',
    name: 'audit',
    description: 'audit',
    status,
    budget: { total: 4, spent: 3, remaining: 1 },
    memberCounts: { total: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
    startedAt: 1,
    ...status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
      ? { settledAt: 2 }
      : {},
    allowedActions: [],
    revision: 2,
    detailRevision: 2,
    membersRevision: 2,
    logsRevision: 1,
    resultRevision: 2,
    artifactsRevision: 1,
  }
}

function snapshot(
  runId: LogicalRunId,
  status: WorkflowRunStatus,
  members: ReturnType<typeof member>[] = [],
): WorkflowRunRecordingSnapshot {
  const stopReason = status === 'completed'
    ? 'completed' as const
    : status === 'failed'
      ? 'error' as const
      : status === 'cancelled'
        ? 'cancelled' as const
        : status === 'interrupted'
          ? 'interrupted' as const
          : undefined
  return {
    info: info(runId),
    run: head(runId, status),
    members,
    ...(stopReason === undefined ? {} : {
      result: { stopReason, agentsStarted: members.length },
    }),
  }
}

/** Replace one test Session append with a deterministic failure point. */
function failAppend(session: Session, failureNumber: number, thrown: unknown): void {
  const original = session.append.bind(session) as (...args: unknown[]) => unknown
  let calls = 0
  const mutable = session as unknown as { append: (...args: unknown[]) => unknown }
  mutable.append = (...args: unknown[]): unknown => {
    calls += 1
    if (calls === failureNumber) throw thrown
    return original(...args)
  }
}

/** Append a JSON event that simulates a restored plugin payload outside static declarations. */
function appendRaw(session: Session, type: string, data: unknown): void {
  const append = session.append.bind(session) as (event: string, value: unknown) => void
  append(type, data)
}

describe('WorkflowRunRecorder', () => {
  it('records only one explicitly attributed logical lifecycle', async () => {
    const { ctx, session } = await setup()
    const runId = SupervisedWorkflowRunId('run')
    const unrelated = SupervisedWorkflowRunId('unrelated')

    ctx.emit('workflows/run-start', info(unrelated, 'unrelated'))
    await ctx.workflowRunRecorder.launch(session, async () => {
      ctx.emit('workflows/run-start', info(runId))
      ctx.emit('workflows/run-start', info(unrelated, 'unrelated'))
      return launch(runId)
    })
    ctx.emit('workflows/member-start', info(unrelated), member(9, 'running'))
    ctx.emit('workflows/member-start', info(runId), member(1, 'running', 'Inspect'))
    ctx.emit('workflows/member-end', info(runId), member(1, 'completed', 'Inspect'))
    ctx.emit('workflows/run-end', info(runId), { stopReason: 'completed', agentsStarted: 1 })

    expect(session.events.map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/run-start', { runId: 'run', name: 'audit' }],
      ['tool-workflow/agent-start', {
        runId: 'run', seq: 1, label: 'member-1', phase: 'Inspect', childId: 'child-1',
      }],
      ['tool-workflow/agent-end', { runId: 'run', seq: 1, outcome: 'completed' }],
      ['tool-workflow/run-end', { runId: 'run', stopReason: 'completed' }],
    ])
  })

  it('preserves pre-publication lifecycle and falls back to the returned identity', async () => {
    const { ctx, session } = await setup()
    const runId = SupervisedWorkflowRunId('run')

    await ctx.workflowRunRecorder.launch(session, async () => {
      ctx.emit('workflows/member-start', info(runId), member(1, 'running'))
      ctx.emit('workflows/member-end', info(runId), member(1, 'failed'))
      ctx.emit('workflows/run-end', info(runId), { stopReason: 'error', agentsStarted: 1 })
      return launch(runId)
    })

    expect(session.events.map(event => event.type)).toEqual([
      'tool-workflow/run-start',
      'tool-workflow/agent-start',
      'tool-workflow/agent-end',
      'tool-workflow/run-end',
    ])

    const reordered = await setup()
    await reordered.ctx.workflowRunRecorder.launch(reordered.session, async () => {
      reordered.ctx.emit('workflows/member-start', info(runId), member(1, 'running'))
      reordered.ctx.emit('workflows/run-start', info(runId))
      return launch(runId)
    })
    expect(reordered.session.events.map(event => event.type)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/agent-start',
    ])

    const fallback = await setup()
    await fallback.ctx.workflowRunRecorder.launch(fallback.session, async () => launch(runId))
    expect(fallback.session.events.map(event => event.type)).toEqual(['tool-workflow/run-start'])
  })

  it('contains recording faults, impossible member endings, and identity disagreement', async () => {
    const first = await setup()
    const warn = vi.spyOn(first.ctx.logger, 'warn').mockImplementation(() => {})
    const runId = SupervisedWorkflowRunId('run')
    const other = SupervisedWorkflowRunId('other')
    failAppend(first.session, 1, { toString() { throw new Error('unrenderable') } })
    await first.ctx.workflowRunRecorder.launch(first.session, async () => {
      first.ctx.emit('workflows/run-start', info(runId))
      return launch(runId)
    })
    first.ctx.emit('workflows/member-start', info(runId), member(1, 'running'))
    expect(first.session.events).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[unrenderable thrown value]'))

    const second = await setup()
    await second.ctx.workflowRunRecorder.launch(second.session, async () => {
      second.ctx.emit('workflows/run-start', info(runId))
      return launch(other)
    })
    second.ctx.emit('workflows/member-start', info(runId), member(1, 'running'))
    expect(second.session.events.map(event => event.type)).toEqual(['tool-workflow/run-start'])

    const third = await setup()
    await third.ctx.workflowRunRecorder.launch(third.session, async () => {
      third.ctx.emit('workflows/run-start', info(runId))
      return launch(runId)
    })
    third.ctx.emit('workflows/member-start', info(runId), member(1, 'running'))
    third.ctx.emit('workflows/member-end', info(runId), member(1, 'running'))
    third.ctx.emit('workflows/run-end', info(runId), { stopReason: 'completed', agentsStarted: 1 })
    expect(third.session.events.map(event => event.type)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/agent-start',
    ])
  })

  it('disables invalid or unrecordable normal lifecycle without appending an invalid suffix', async () => {
    const runId = SupervisedWorkflowRunId('run')

    const fallback = await setup()
    failAppend(fallback.session, 1, new Error('fallback start failed'))
    await fallback.ctx.workflowRunRecorder.launch(fallback.session, async () => launch(runId))
    expect(fallback.session.events).toEqual([])

    const duplicate = await setup()
    await duplicate.ctx.workflowRunRecorder.launch(duplicate.session, async () => {
      duplicate.ctx.emit('workflows/run-start', info(runId))
      return launch(runId)
    })
    duplicate.ctx.emit('workflows/member-start', info(runId), member(1, 'running'))
    duplicate.ctx.emit('workflows/member-start', info(runId), member(1, 'running'))
    expect(duplicate.session.events.map(event => event.type)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/agent-start',
    ])

    const unpaired = await setup()
    await unpaired.ctx.workflowRunRecorder.launch(unpaired.session, async () => {
      unpaired.ctx.emit('workflows/run-start', info(runId))
      return launch(runId)
    })
    unpaired.ctx.emit('workflows/member-end', info(runId), member(1, 'failed'))
    expect(unpaired.session.events.map(event => event.type)).toEqual(['tool-workflow/run-start'])

    const open = await setup()
    await open.ctx.workflowRunRecorder.launch(open.session, async () => {
      open.ctx.emit('workflows/run-start', info(runId))
      return launch(runId)
    })
    open.ctx.emit('workflows/member-start', info(runId), member(1, 'running'))
    open.ctx.emit('workflows/run-end', info(runId), { stopReason: 'completed', agentsStarted: 1 })
    expect(open.session.events.map(event => event.type)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/agent-start',
    ])

    for (const failureNumber of [2, 3]) {
      const failed = await setup()
      failAppend(failed.session, failureNumber, new Error('member append failed'))
      await failed.ctx.workflowRunRecorder.launch(failed.session, async () => {
        failed.ctx.emit('workflows/run-start', info(runId))
        return launch(runId)
      })
      failed.ctx.emit('workflows/member-start', info(runId), member(1, 'running'))
      failed.ctx.emit('workflows/member-end', info(runId), member(1, 'completed'))
      failed.ctx.emit('workflows/run-end', info(runId), { stopReason: 'completed', agentsStarted: 1 })
      expect(failed.session.events).toHaveLength(failureNumber - 1)
    }
  })

  it('records a terminal launch failure even when start rejects', async () => {
    const { ctx, session } = await setup()
    const runId = SupervisedWorkflowRunId('run')
    await expect(ctx.workflowRunRecorder.launch(session, async () => {
      ctx.emit('workflows/run-start', info(runId))
      ctx.emit('workflows/run-end', info(runId), { stopReason: 'error', agentsStarted: 0 })
      throw new Error('engine construction failed')
    })).rejects.toThrow('engine construction failed')
    expect(session.events.map(event => event.type)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/run-end',
    ])
  })

  it('reconstructs an open pre-restart record and closes it once as interrupted', async () => {
    const runId = SupervisedWorkflowRunId('recovered')
    const seeded = await setup({
      existingAgent: true,
      seed(session) {
        session.append('tool-workflow/run-start', { runId, name: 'audit' })
        session.append('tool-workflow/agent-start', {
          runId, seq: 2, label: 'second', childId: SessionId('child-2'),
        })
        session.append('tool-workflow/agent-start', {
          runId, seq: 1, label: 'first', childId: SessionId('child-1'),
        })
        session.append('tool-workflow/agent-end', { runId, seq: 2, outcome: 'completed' })
      },
      prepareSupervisor(supervisor) {
        supervisor.snapshots.set(runId, snapshot(runId, 'interrupted', [
          member(1, 'cancelled'),
          member(2, 'completed'),
        ]))
      },
    })
    await vi.waitFor(() => {
      expect(seeded.session.events.at(-1)?.type).toBe('tool-workflow/run-end')
    })
    expect(seeded.session.events.slice(4).map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/agent-end', { runId: 'recovered', seq: 1, outcome: 'cancelled' }],
      ['tool-workflow/run-end', { runId: 'recovered', stopReason: 'interrupted' }],
    ])
  })

  it('does not interrupt an open record when a same-process recorder reload sees a live run', async () => {
    const runId = SupervisedWorkflowRunId('live')
    const value = await setup({
      existingAgent: true,
      seed(session) { session.append('tool-workflow/run-start', { runId, name: 'audit' }) },
      prepareSupervisor(supervisor) {
        supervisor.snapshots.set(runId, snapshot(runId, 'running'))
      },
    })
    await vi.waitFor(() => { expect(value.supervisor.snapshot).toHaveBeenCalledOnce() })
    expect(value.session.events.map(event => event.type)).toEqual(['tool-workflow/run-start'])

    value.ctx.emit('workflows/run-end', info(runId), { stopReason: 'completed', agentsStarted: 0 })
    expect(value.session.events.map(event => event.type)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/run-end',
    ])
  })

  it.each([
    ['completed', 'completed'],
    ['failed', 'error'],
    ['cancelled', 'cancelled'],
  ] as const)('repairs mixed member outcomes before a recovered %s terminal', async (status, stopReason) => {
    const runId = SupervisedWorkflowRunId(`recovered-${status}`)
    const value = await setup({
      existingAgent: true,
      seed(session) {
        session.append('tool-workflow/run-start', { runId, name: 'audit' })
        for (const seq of [3, 1, 2]) {
          session.append('tool-workflow/agent-start', {
            runId, seq, label: `member-${seq}`, childId: SessionId(`child-${seq}`),
          })
        }
        session.append('tool-workflow/agent-end', { runId, seq: 2, outcome: 'failed' })
      },
      prepareSupervisor(supervisor) {
        supervisor.snapshots.set(runId, snapshot(runId, status, [
          member(1, 'completed'), member(2, 'failed'), member(3, 'cancelled'),
        ]))
      },
    })
    await vi.waitFor(() => { expect(value.session.events.at(-1)?.type).toBe('tool-workflow/run-end') })

    expect(value.session.events.slice(5).map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/agent-end', { runId, seq: 1, outcome: 'completed' }],
      ['tool-workflow/agent-end', { runId, seq: 3, outcome: 'cancelled' }],
      ['tool-workflow/run-end', { runId, stopReason }],
    ])
  })

  it('atomically repairs a live reload gap before replaying buffered lifecycle', async () => {
    const runId = SupervisedWorkflowRunId('reload-gap')
    let resolveSnapshot!: (value: WorkflowRunRecordingSnapshot) => void
    const pendingSnapshot = new Promise<WorkflowRunRecordingSnapshot>((resolve) => {
      resolveSnapshot = resolve
    })
    const value = await setup({
      existingAgent: true,
      seed(session) { session.append('tool-workflow/run-start', { runId, name: 'audit' }) },
      prepareSupervisor(supervisor) {
        supervisor.snapshot.mockImplementationOnce(async () => pendingSnapshot)
      },
    })
    await vi.waitFor(() => { expect(value.supervisor.snapshot).toHaveBeenCalledOnce() })

    value.ctx.emit('workflows/member-end', info(runId), member(1, 'completed'))
    value.ctx.emit('workflows/member-start', info(runId), member(3, 'running'))
    value.ctx.emit('workflows/member-end', info(runId), member(3, 'failed'))
    value.ctx.emit('workflows/member-start', info(runId), member(5, 'running'))
    value.ctx.emit('workflows/member-end', info(runId), member(5, 'completed'))
    value.ctx.emit('workflows/member-end', info(runId), member(2, 'completed'))
    value.ctx.emit('workflows/member-end', info(runId), member(4, 'cancelled'))
    value.ctx.emit('workflows/run-end', info(runId), { stopReason: 'completed', agentsStarted: 5 })
    expect(value.session.events).toHaveLength(1)

    resolveSnapshot(snapshot(runId, 'running', [
      member(1, 'running'), member(2, 'completed'), member(3, 'running'),
    ]))
    await vi.waitFor(() => { expect(value.session.events.at(-1)?.type).toBe('tool-workflow/run-end') })
    expect(value.session.events.map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/run-start', { runId, name: 'audit' }],
      ['tool-workflow/agent-start', { runId, seq: 1, label: 'member-1', childId: 'child-1' }],
      ['tool-workflow/agent-start', { runId, seq: 2, label: 'member-2', childId: 'child-2' }],
      ['tool-workflow/agent-start', { runId, seq: 3, label: 'member-3', childId: 'child-3' }],
      ['tool-workflow/agent-end', { runId, seq: 2, outcome: 'completed' }],
      ['tool-workflow/agent-end', { runId, seq: 1, outcome: 'completed' }],
      ['tool-workflow/agent-end', { runId, seq: 3, outcome: 'failed' }],
      ['tool-workflow/agent-start', { runId, seq: 5, label: 'member-5', childId: 'child-5' }],
      ['tool-workflow/agent-end', { runId, seq: 5, outcome: 'completed' }],
      ['tool-workflow/agent-start', { runId, seq: 4, label: 'member-4', childId: 'child-4' }],
      ['tool-workflow/agent-end', { runId, seq: 4, outcome: 'cancelled' }],
      ['tool-workflow/run-end', { runId, stopReason: 'completed' }],
    ])
  })

  it('does not duplicate an already complete durable trace', async () => {
    const runId = SupervisedWorkflowRunId('complete')
    const value = await setup({
      existingAgent: true,
      seed(session) {
        session.append('tool-workflow/run-start', { runId, name: 'audit' })
        session.append('tool-workflow/run-end', { runId, stopReason: 'completed' })
      },
    })
    await Promise.resolve()
    expect(value.supervisor.recover).not.toHaveBeenCalled()
    expect(value.supervisor.snapshot).not.toHaveBeenCalled()
    expect(value.session.events.map(event => event.type)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/run-end',
    ])
  })

  it('ignores irrelevant and malformed persisted events while seeding open prefixes', async () => {
    const runId = SupervisedWorkflowRunId('valid')
    const value = await setup({
      existingAgent: true,
      seed(session) {
        appendRaw(session, 'diagnostic/noise', {})
        appendRaw(session, 'tool-workflow/malformed-null', null)
        appendRaw(session, 'tool-workflow/malformed-id', {})
        appendRaw(session, 'tool-workflow/agent-start', { runId: 'ghost', seq: 'bad' })
        appendRaw(session, 'tool-workflow/agent-end', { runId: 'ghost', seq: 'bad' })
        appendRaw(session, 'tool-workflow/agent-start', { runId: 'ghost', seq: 9 })
        appendRaw(session, 'tool-workflow/run-start', { runId: 'closed', name: 'closed' })
        appendRaw(session, 'tool-workflow/run-end', { runId: 'closed', stopReason: 'completed' })
        appendRaw(session, 'tool-workflow/run-start', { runId, name: 'audit' })
        appendRaw(session, 'tool-workflow/unknown', { runId })
      },
      prepareSupervisor(supervisor) {
        supervisor.snapshots.set(runId, snapshot(runId, 'running'))
      },
    })
    await vi.waitFor(() => { expect(value.supervisor.snapshot).toHaveBeenCalledOnce() })
    value.ctx.emit('agent/created', { agent: value.agent })
    expect(value.session.events.at(-1)?.type).toBe('tool-workflow/unknown')
  })

  it('closes a prefix as interrupted only when successful recovery confirms the row is absent', async () => {
    const runId = SupervisedWorkflowRunId('absent')
    const value = await setup({
      existingAgent: true,
      seed(session) {
        session.append('tool-workflow/run-start', { runId, name: 'audit' })
        session.append('tool-workflow/agent-start', {
          runId, seq: 1, label: 'member-1', childId: SessionId('child-1'),
        })
        session.append('tool-workflow/agent-start', {
          runId, seq: 2, label: 'member-2', childId: SessionId('child-2'),
        })
      },
      prepareSupervisor(supervisor) { supervisor.snapshots.set(runId, undefined) },
    })
    await vi.waitFor(() => { expect(value.session.events.at(-1)?.type).toBe('tool-workflow/run-end') })
    expect(value.session.events.slice(3).map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/agent-end', { runId, seq: 1, outcome: 'cancelled' }],
      ['tool-workflow/agent-end', { runId, seq: 2, outcome: 'cancelled' }],
      ['tool-workflow/run-end', { runId, stopReason: 'interrupted' }],
    ])
  })

  it('cancels Session-only open members before a recovered terminal', async () => {
    const runId = SupervisedWorkflowRunId('manifest-gap')
    const value = await setup({
      existingAgent: true,
      seed(session) {
        session.append('tool-workflow/run-start', { runId, name: 'audit' })
        for (const seq of [2, 1]) {
          session.append('tool-workflow/agent-start', {
            runId, seq, label: `member-${seq}`, childId: SessionId(`child-${seq}`),
          })
        }
      },
      prepareSupervisor(supervisor) {
        supervisor.snapshots.set(runId, snapshot(runId, 'interrupted'))
      },
    })
    await vi.waitFor(() => { expect(value.session.events.at(-1)?.type).toBe('tool-workflow/run-end') })
    expect(value.session.events.slice(3).map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/agent-end', { runId, seq: 1, outcome: 'cancelled' }],
      ['tool-workflow/agent-end', { runId, seq: 2, outcome: 'cancelled' }],
      ['tool-workflow/run-end', { runId, stopReason: 'interrupted' }],
    ])
  })

  it('contains transient snapshot and recovery failures without fabricating a terminal', async () => {
    const runId = SupervisedWorkflowRunId('transient')
    const secondRunId = SupervisedWorkflowRunId('recoverable')
    const snapshotFailure = await setup({
      existingAgent: true,
      seed(session) {
        session.append('tool-workflow/run-start', { runId, name: 'audit' })
        session.append('tool-workflow/run-start', { runId: secondRunId, name: 'audit-2' })
      },
      prepareSupervisor(supervisor) {
        supervisor.snapshots.set(secondRunId, snapshot(secondRunId, 'completed'))
        supervisor.snapshot.mockRejectedValueOnce(new Error('temporary snapshot failure'))
      },
    })
    await vi.waitFor(() => {
      expect(snapshotFailure.session.events.at(-1)?.data).toEqual({
        runId: secondRunId, stopReason: 'completed',
      })
    })
    snapshotFailure.ctx.emit('workflows/run-end', info(runId), {
      stopReason: 'completed', agentsStarted: 0,
    })
    expect(snapshotFailure.session.events.map(event => event.type)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/run-start',
      'tool-workflow/run-end', 'tool-workflow/run-end',
    ])

    const recoveryFailure = await setup({
      existingAgent: true,
      seed(session) { session.append('tool-workflow/run-start', { runId, name: 'audit' }) },
      prepareSupervisor(supervisor) {
        supervisor.recover.mockRejectedValueOnce(new Error('temporary recovery failure'))
      },
    })
    await vi.waitFor(() => { expect(recoveryFailure.supervisor.recover).toHaveBeenCalledOnce() })
    recoveryFailure.ctx.emit('workflows/run-end', info(runId), {
      stopReason: 'cancelled', agentsStarted: 0,
    })
    expect(recoveryFailure.session.events.at(-1)?.data).toEqual({ runId, stopReason: 'cancelled' })
  })

  it('recovers agents created after the recorder and aborts pending recovery on disposal', async () => {
    const runId = SupervisedWorkflowRunId('created-later')
    const created = await setup({
      seed(session) { session.append('tool-workflow/run-start', { runId, name: 'audit' }) },
      prepareSupervisor(supervisor) {
        supervisor.snapshots.set(runId, snapshot(runId, 'completed'))
      },
    })
    created.ctx.agents.register(created.agent)
    await vi.waitFor(() => { expect(created.session.events.at(-1)?.type).toBe('tool-workflow/run-end') })

    let recoverySignal: AbortSignal | undefined
    const disposing = await setup({
      existingAgent: true,
      seed(session) { session.append('tool-workflow/run-start', { runId, name: 'audit' }) },
      prepareSupervisor(supervisor) {
        supervisor.recover.mockImplementationOnce(async (_agent, signal) => {
          recoverySignal = signal
          await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => { resolve() }) })
          signal?.throwIfAborted()
        })
      },
    })
    await vi.waitFor(() => { expect(recoverySignal).toBeDefined() })
    await disposing.plugin.dispose()
    expect(recoverySignal?.aborted).toBe(true)

    let snapshotSignal: AbortSignal | undefined
    const snapshotDisposing = await setup({
      existingAgent: true,
      seed(session) { session.append('tool-workflow/run-start', { runId, name: 'audit' }) },
      prepareSupervisor(supervisor) {
        supervisor.snapshot.mockImplementationOnce(async (_agent, _runId, signal) => {
          snapshotSignal = signal
          await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => { resolve() }) })
          signal?.throwIfAborted()
          return undefined
        })
      },
    })
    await vi.waitFor(() => { expect(snapshotSignal).toBeDefined() })
    await snapshotDisposing.plugin.dispose()
    expect(snapshotSignal?.aborted).toBe(true)
  })

  it('contains append failures while repairing recovered prefixes', async () => {
    const runId = SupervisedWorkflowRunId('repair-failure')
    const cases = [
      {
        seed(session: Session) { session.append('tool-workflow/run-start', { runId, name: 'audit' }) },
        snapshot: snapshot(runId, 'running', [member(1, 'running')]),
      },
      {
        seed(session: Session) {
          session.append('tool-workflow/run-start', { runId, name: 'audit' })
          session.append('tool-workflow/agent-start', {
            runId, seq: 1, label: 'member-1', childId: SessionId('child-1'),
          })
        },
        snapshot: snapshot(runId, 'completed', [member(1, 'completed')]),
      },
      {
        seed(session: Session) {
          session.append('tool-workflow/run-start', { runId, name: 'audit' })
          session.append('tool-workflow/agent-start', {
            runId, seq: 1, label: 'member-1', childId: SessionId('child-1'),
          })
        },
        snapshot: snapshot(runId, 'interrupted'),
      },
    ]
    for (const candidate of cases) {
      const value = await setup({
        existingAgent: true,
        seed(session) { candidate.seed(session) },
        prepareSupervisor(supervisor, _ctx, session) {
          supervisor.snapshots.set(runId, candidate.snapshot)
          failAppend(session, 1, new Error('repair append failed'))
        },
      })
      await vi.waitFor(() => { expect(value.supervisor.snapshot).toHaveBeenCalledOnce() })
      expect(value.session.events.at(-1)?.type).not.toBe('tool-workflow/run-end')
    }

    const missing = await setup({
      existingAgent: true,
      seed(session) {
        session.append('tool-workflow/run-start', { runId, name: 'audit' })
        session.append('tool-workflow/agent-start', {
          runId, seq: 1, label: 'member-1', childId: SessionId('child-1'),
        })
      },
      prepareSupervisor(supervisor, _ctx, session) {
        supervisor.snapshots.set(runId, undefined)
        failAppend(session, 1, new Error('missing append failed'))
      },
    })
    await vi.waitFor(() => { expect(missing.supervisor.snapshot).toHaveBeenCalledOnce() })
    expect(missing.session.events.at(-1)?.type).toBe('tool-workflow/agent-start')

    let resolveSnapshot!: (value: WorkflowRunRecordingSnapshot) => void
    const pendingSnapshot = new Promise<WorkflowRunRecordingSnapshot>((resolve) => {
      resolveSnapshot = resolve
    })
    const buffered = await setup({
      existingAgent: true,
      seed(session) { session.append('tool-workflow/run-start', { runId, name: 'audit' }) },
      prepareSupervisor(supervisor, _ctx, session) {
        supervisor.snapshot.mockImplementationOnce(async () => pendingSnapshot)
        failAppend(session, 1, new Error('buffer replay append failed'))
      },
    })
    await vi.waitFor(() => { expect(buffered.supervisor.snapshot).toHaveBeenCalledOnce() })
    buffered.ctx.emit('workflows/member-start', info(runId), member(1, 'running'))
    resolveSnapshot(snapshot(runId, 'running'))
    await Promise.resolve()
    await Promise.resolve()
    expect(buffered.session.events.map(event => event.type)).toEqual(['tool-workflow/run-start'])

    let resolveEndSnapshot!: (value: WorkflowRunRecordingSnapshot) => void
    const pendingEndSnapshot = new Promise<WorkflowRunRecordingSnapshot>((resolve) => {
      resolveEndSnapshot = resolve
    })
    const bufferedEnd = await setup({
      existingAgent: true,
      seed(session) { session.append('tool-workflow/run-start', { runId, name: 'audit' }) },
      prepareSupervisor(supervisor, _ctx, session) {
        supervisor.snapshot.mockImplementationOnce(async () => pendingEndSnapshot)
        failAppend(session, 1, new Error('buffered end repair append failed'))
      },
    })
    await vi.waitFor(() => { expect(bufferedEnd.supervisor.snapshot).toHaveBeenCalledOnce() })
    bufferedEnd.ctx.emit('workflows/member-end', info(runId), member(1, 'completed'))
    resolveEndSnapshot(snapshot(runId, 'running'))
    await Promise.resolve()
    await Promise.resolve()
    expect(bufferedEnd.session.events.map(event => event.type)).toEqual(['tool-workflow/run-start'])
  })
})
