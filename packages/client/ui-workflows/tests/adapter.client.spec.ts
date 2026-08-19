import { describe, expect, it, vi } from 'vitest'
import type {
  ObservableSnapshot, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  SupervisedWorkflowRunId, WorkflowMemberId,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  DashboardWorkflowRunsAdapter, type WorkflowRunsControllerFace,
} from '../src/client/adapter.ts'
import type { WorkflowRunsSourceSnapshot } from '../src/client/contract.ts'

const SESSION_A = 'session-a' as SessionId
const SESSION_B = 'session-b' as SessionId
const RUN_ID = 'run-a' as SupervisedWorkflowRunId
const MEMBER_ID = 'member-a' as WorkflowMemberId

function source(initial: WorkflowRunsSourceSnapshot): {
  readonly observable: ObservableSnapshot<WorkflowRunsSourceSnapshot>
  readonly listeners: Set<() => void>
  publish(snapshot: WorkflowRunsSourceSnapshot): void
} {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    observable: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    listeners,
    publish: (next) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function controller(
  sources: ReadonlyMap<SessionId, ObservableSnapshot<WorkflowRunsSourceSnapshot>>,
): WorkflowRunsControllerFace {
  return {
    source: vi.fn((sessionId: SessionId) => {
      const value = sources.get(sessionId)
      if (value === undefined) throw new Error(`missing source: ${sessionId}`)
      return value
    }),
    refresh: vi.fn(async () => undefined),
    loadMore: vi.fn(async () => undefined),
    detail: vi.fn(async () => ({}) as never),
    members: vi.fn(async () => ({}) as never),
    memberDetail: vi.fn(async () => ({}) as never),
    logs: vi.fn(async () => ({}) as never),
    result: vi.fn(async () => ({}) as never),
    artifacts: vi.fn(async () => ({}) as never),
    artifact: vi.fn(async () => ({}) as never),
    control: vi.fn(async () => ({}) as never),
    resolveAndOpenChild: vi.fn(async () => true),
  }
}

describe('DashboardWorkflowRunsAdapter', () => {
  it('switches one stable observable between Sessions and releases stale sources', () => {
    const a = source({ phase: 'ready', runs: [], total: 1 })
    const b = source({ phase: 'loading', runs: [], total: 2 })
    const face = controller(new Map([
      [SESSION_A, a.observable],
      [SESSION_B, b.observable],
    ]))
    const adapter = new DashboardWorkflowRunsAdapter(face)
    const observed: WorkflowRunsSourceSnapshot[] = []
    const unsubscribe = adapter.source.subscribe(() => { observed.push(adapter.source.getSnapshot()) })

    adapter.observe(SESSION_A)
    expect(adapter.source.getSnapshot()).toEqual({ phase: 'ready', runs: [], total: 1 })
    expect(a.listeners).toHaveLength(1)

    const aUpdate: WorkflowRunsSourceSnapshot = { phase: 'ready', runs: [], total: 3 }
    a.publish(aUpdate)
    expect(adapter.source.getSnapshot()).toBe(aUpdate)
    const notificationCount = observed.length
    a.publish(aUpdate)
    expect(observed).toHaveLength(notificationCount)

    adapter.observe(SESSION_A)
    expect(a.listeners).toHaveLength(1)
    const staleListener = [...a.listeners][0]
    adapter.observe(SESSION_B)
    expect(a.listeners).toHaveLength(0)
    expect(b.listeners).toHaveLength(1)

    a.publish({ phase: 'error', runs: [], total: 9, error: 'stale' })
    staleListener?.()
    expect(adapter.source.getSnapshot()).toEqual({ phase: 'loading', runs: [], total: 2 })

    adapter.observe(undefined)
    expect(b.listeners).toHaveLength(0)
    expect(adapter.source.getSnapshot()).toEqual({ phase: 'idle', runs: [], total: 0 })
    expect(observed).toHaveLength(4)

    unsubscribe()
    adapter.dispose()
  })

  it('delegates on-demand reads, controls, and navigation unchanged', async () => {
    const face = controller(new Map())
    const adapter = new DashboardWorkflowRunsAdapter(face)
    const signal = new AbortController().signal

    await adapter.refresh(SESSION_A)
    await adapter.loadMore(SESSION_A)
    await adapter.detail(SESSION_A, RUN_ID, signal)
    await adapter.members(SESSION_A, RUN_ID, 'members' as never, signal)
    await adapter.memberDetail(SESSION_A, RUN_ID, MEMBER_ID, signal)
    await adapter.logs(SESSION_A, RUN_ID, 'logs' as never, signal)
    await adapter.result(SESSION_A, RUN_ID, signal)
    await adapter.artifacts(SESSION_A, RUN_ID, 'artifacts' as never, signal)
    await adapter.artifact(SESSION_A, RUN_ID, 'report.md', 'artifact' as never, 8, signal)
    await adapter.control(SESSION_A, RUN_ID, 'pause', 7, signal)
    await adapter.resolveAndOpenChild(SESSION_A, SESSION_B)

    expect(face.refresh).toHaveBeenCalledWith(SESSION_A)
    expect(face.loadMore).toHaveBeenCalledWith(SESSION_A)
    expect(face.detail).toHaveBeenCalledWith(SESSION_A, RUN_ID, signal)
    expect(face.members).toHaveBeenCalledWith(SESSION_A, RUN_ID, 'members', signal)
    expect(face.memberDetail).toHaveBeenCalledWith(SESSION_A, RUN_ID, MEMBER_ID, signal)
    expect(face.logs).toHaveBeenCalledWith(SESSION_A, RUN_ID, 'logs', signal)
    expect(face.result).toHaveBeenCalledWith(SESSION_A, RUN_ID, signal)
    expect(face.artifacts).toHaveBeenCalledWith(SESSION_A, RUN_ID, 'artifacts', signal)
    expect(face.artifact).toHaveBeenCalledWith(SESSION_A, RUN_ID, 'report.md', 'artifact', 8, signal)
    expect(face.control).toHaveBeenCalledWith(SESSION_A, RUN_ID, 'pause', 7, signal)
    expect(face.resolveAndOpenChild).toHaveBeenCalledWith(SESSION_A, SESSION_B)
  })

  it('contains a subscriber failure and still notifies later subscribers', () => {
    const value = source({ phase: 'ready', runs: [], total: 1 })
    const adapter = new DashboardWorkflowRunsAdapter(controller(new Map([
      [SESSION_A, value.observable],
    ])))
    const failure = new Error('broken subscriber')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const later = vi.fn()
    adapter.source.subscribe(() => { throw failure })
    adapter.source.subscribe(later)

    adapter.observe(SESSION_A)

    expect(later).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledExactlyOnceWith(
      '[ui-workflows] dashboard snapshot listener failed:', failure,
    )
    adapter.dispose()
  })
})
