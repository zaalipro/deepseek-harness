import { describe, expect, it, vi } from 'vitest'
import type {
  SessionId,
  SupervisedWorkflowRunId,
  WorkflowMemberId,
  WorkflowRunChange,
  WorkflowRunArtifactChunk,
  WorkflowRunArtifactPage,
  WorkflowRunCursor,
  WorkflowRunDetail,
  WorkflowRunFeedEpoch,
  WorkflowRunHead,
  WorkflowRunListPage,
  WorkflowRunLogPage,
  WorkflowRunMemberPage,
  WorkflowRunResultView,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  WorkflowRunsController,
  WorkflowRunsRemoteError,
  type WorkflowRunsRemote,
} from '../src/client/workflow-runs/controller.ts'
import { deferred } from './fake-api.client.ts'

const SESSION = 'session-workflows' as SessionId
const EPOCH = 'workflow-epoch' as WorkflowRunFeedEpoch

function head(id: string, revision: number, status: WorkflowRunHead['status'] = 'running'): WorkflowRunHead {
  return {
    runId: id as SupervisedWorkflowRunId,
    displayName: id,
    name: id,
    description: `${id} description`,
    status,
    budget: { total: 8, spent: 1, remaining: 7 },
    memberCounts: { total: 1, running: status === 'running' ? 1 : 0, completed: 0, failed: 0, cancelled: 0 },
    startedAt: 1,
    allowedActions: status === 'running' ? ['pause', 'stop'] : [],
    revision,
    detailRevision: revision,
    membersRevision: revision,
    logsRevision: revision,
    resultRevision: revision,
    artifactsRevision: revision,
  }
}

function page(items: readonly WorkflowRunHead[], sessionRevision: number): WorkflowRunListPage {
  return { epoch: EPOCH, sessionRevision, items, total: items.length }
}

function success<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value }
}

function remote(list: WorkflowRunsRemote['list']): WorkflowRunsRemote {
  const unexpected = () => Promise.reject(new Error('unexpected workflow-runs call'))
  return {
    list,
    detail: unexpected,
    members: unexpected,
    memberDetail: unexpected,
    logs: unexpected,
    result: unexpected,
    artifacts: unexpected,
    artifact: unexpected,
    control: unexpected,
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('WorkflowRunsController', () => {
  it('loads lazily and applies one bounded monotonic row change', async () => {
    const list = vi.fn(() => Promise.resolve(success(page([head('review', 1)], 1))))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)

    expect(source.getSnapshot()).toEqual({ phase: 'idle', runs: [], total: 0 })
    expect(list).not.toHaveBeenCalled()
    const unsubscribe = source.subscribe(() => {})
    expect(source.getSnapshot().phase).toBe('loading')
    await flush()
    expect(source.getSnapshot()).toEqual({ phase: 'ready', runs: [head('review', 1)], total: 1 })

    const changed = head('review', 2, 'completed')
    controller.handleChange({
      kind: 'upsert', sessionId: SESSION, epoch: EPOCH, sessionRevision: 2, head: changed,
    })
    expect(source.getSnapshot()).toEqual({ phase: 'ready', runs: [changed], total: 1 })
    unsubscribe()
  })

  it('contains a failing observer so later observers still receive changes', async () => {
    const controller = new WorkflowRunsController(
      remote(() => Promise.resolve(success(page([], 0)))),
      () => Promise.resolve(false),
    )
    const source = controller.source(SESSION)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let notifications = 0
    source.subscribe(() => { throw new Error('broken renderer') })
    source.subscribe(() => { notifications += 1 })

    await flush()

    expect(notifications).toBeGreaterThan(0)
    expect(consoleError).toHaveBeenCalledWith(
      '[workflow-runs] snapshot listener failed:',
      expect.objectContaining({ message: 'broken renderer' }),
    )
    consoleError.mockRestore()
  })

  it('rebaselines when changes race a baseline with a revision gap', async () => {
    const first = deferred<ReturnType<typeof success<WorkflowRunListPage>>>()
    const list = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(success(page([head('a', 3), head('b', 2)], 3)))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})

    controller.handleChange({
      kind: 'upsert', sessionId: SESSION, epoch: EPOCH, sessionRevision: 2, head: head('b', 2),
    })
    controller.handleChange({
      kind: 'upsert', sessionId: SESSION, epoch: EPOCH, sessionRevision: 3, head: head('a', 3),
    })
    first.resolve(success(page([], 1)))
    await flush()

    expect(list).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot().runs.map(run => run.displayName)).toEqual(['a', 'b'])
  })

  it('fences a removed Session from a late baseline response', async () => {
    const pending = deferred<ReturnType<typeof success<WorkflowRunListPage>>>()
    const controller = new WorkflowRunsController(remote(() => pending.promise), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    let notifications = 0
    source.subscribe(() => { notifications += 1 })
    controller.removeSession(SESSION)
    pending.resolve(success(page([head('late', 1)], 1)))
    await flush()

    expect(source.getSnapshot()).toEqual({ phase: 'idle', runs: [], total: 0 })
    expect(notifications).toBeGreaterThan(0)
    expect(controller.source(SESSION)).not.toBe(source)
  })

  it('starts a new baseline immediately after reconnect and ignores the old response', async () => {
    const old = deferred<ReturnType<typeof success<WorkflowRunListPage>>>()
    const list = vi.fn()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(success(page([head('new', 1)], 1)))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})

    controller.handleDisconnected()
    expect(source.getSnapshot().phase).toBe('reconnecting')
    controller.handleConnected()
    old.resolve(success(page([head('old', 1)], 1)))
    await flush()

    expect(list).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot().runs[0]?.displayName).toBe('new')
  })

  it('ignores a failed baseline from a prior connection generation', async () => {
    const old = deferred<ReturnType<typeof success<WorkflowRunListPage>>>()
    const list = vi.fn()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(success(page([], 0)))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})

    controller.handleDisconnected()
    old.reject(new Error('old connection failed'))
    await flush()

    expect(source.getSnapshot().phase).toBe('reconnecting')
    expect(list).toHaveBeenCalledOnce()
  })

  it('does not issue reads while disconnected and exposes reconnecting to late observers', async () => {
    const list = vi.fn(() => Promise.resolve(success(page([], 0))))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    controller.handleDisconnected()
    const source = controller.source(SESSION)
    source.subscribe(() => {})

    expect(source.getSnapshot()).toEqual({ phase: 'reconnecting', runs: [], total: 0 })
    await controller.refresh(SESSION)
    expect(list).not.toHaveBeenCalled()

    controller.handleConnected()
    await flush()
    expect(list).toHaveBeenCalledOnce()
    expect(source.getSnapshot()).toEqual({ phase: 'ready', runs: [], total: 0 })
  })

  it('loads member outcomes on demand, opens catalog-fenced children, and merges controls', async () => {
    const run = head('review', 1)
    const memberId = 'member-1' as WorkflowMemberId
    const openChild = vi.fn(() => Promise.resolve(true))
    const base = remote(() => Promise.resolve(success(page([run], 1))))
    const controller = new WorkflowRunsController({
      ...base,
      memberDetail: () => Promise.resolve(success({
        member: {
          memberId, seq: 1, label: 'reviewer', status: 'completed', outcome: 'available',
        },
        childSessionId: 'child-1' as SessionId,
        outcome: {
          state: 'available', content: { kind: 'value', value: null }, totalBytes: 4, truncated: false,
        },
      })),
      control: () => Promise.resolve(success({ run: head('review', 2, 'paused') })),
    }, openChild)
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()

    const detail = await controller.memberDetail(SESSION, run.runId, memberId)
    expect(detail.outcome).toMatchObject({ state: 'available', content: { value: null } })
    await expect(controller.resolveAndOpenChild(SESSION, 'child-1' as SessionId)).resolves.toBe(true)
    expect(openChild).toHaveBeenCalledWith(SESSION, 'child-1')

    const controlled = await controller.control(SESSION, run.runId, 'pause', 1)
    expect(controlled.run.status).toBe('paused')
    expect(source.getSnapshot().runs[0]?.revision).toBe(2)
  })

  it('turns carrier failures into a stable feature error and publishes list errors', async () => {
    const controller = new WorkflowRunsController(remote(() => Promise.resolve({
      ok: false,
      error: { code: 'session-not-found', message: 'gone', details: {} },
    })), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()
    expect(source.getSnapshot()).toEqual({ phase: 'error', runs: [], total: 0, error: 'gone' })

    const failed = remote(() => Promise.resolve(success(page([], 0))))
    failed.detail = () => Promise.resolve({
      ok: false,
      error: { code: 'run-not-found', message: 'missing', details: {} },
    })
    const detailController = new WorkflowRunsController(failed, () => Promise.resolve(false))
    await expect(detailController.detail(SESSION, 'missing' as SupervisedWorkflowRunId))
      .rejects.toEqual(expect.objectContaining<Partial<WorkflowRunsRemoteError>>({
        name: 'WorkflowRunsRemoteError', code: 'run-not-found', message: 'missing',
      }))
  })

  it('rebaselines rather than applying a change to a failed baseline', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'remote-unavailable', message: 'temporary outage', details: {} },
      })
      .mockResolvedValueOnce(success(page([head('recovered', 2)], 2)))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()
    expect(source.getSnapshot().phase).toBe('error')

    controller.handleChange({
      kind: 'upsert', sessionId: SESSION, epoch: EPOCH, sessionRevision: 2,
      head: head('recovered', 2),
    })
    await flush()

    expect(list).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot()).toEqual({
      phase: 'ready', runs: [head('recovered', 2)], total: 1,
    })
  })

  it('preserves caller cancellation instead of converting it to a transport error', async () => {
    const aborted = new DOMException('selection changed', 'AbortError')
    const failed = remote(() => Promise.resolve(success(page([], 0))))
    failed.detail = () => Promise.reject(aborted)
    const controller = new WorkflowRunsController(failed, () => Promise.resolve(false))

    await expect(controller.detail(SESSION, 'review' as SupervisedWorkflowRunId))
      .rejects.toBe(aborted)
  })

  it('pages retained rows without replacing the bounded first page', async () => {
    const cursor = 'next-page' as WorkflowRunCursor
    const list = vi.fn()
      .mockResolvedValueOnce(success({
        ...page([head('new', 1)], 1), nextCursor: cursor, total: 2,
      }))
      .mockResolvedValueOnce(success({
        ...page([head('old', 1, 'completed')], 1), total: 2,
      }))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()

    expect(source.getSnapshot()).toMatchObject({ nextCursor: cursor, total: 2 })
    await controller.loadMore(SESSION)
    expect(source.getSnapshot()).toEqual({
      phase: 'ready', runs: [head('new', 1), head('old', 1, 'completed')], total: 2,
    })
    expect(list).toHaveBeenLastCalledWith(SESSION, { cursor }, expect.any(AbortSignal))
  })

  it('rebaselines a revision-bound retained-page cursor when a row changes', async () => {
    const oldCursor = 'old-page' as WorkflowRunCursor
    const newCursor = 'new-page' as WorkflowRunCursor
    const changed = head('review', 2, 'completed')
    const list = vi.fn()
      .mockResolvedValueOnce(success({
        ...page([head('review', 1)], 1), nextCursor: oldCursor, total: 2,
      }))
      .mockResolvedValueOnce(success({
        ...page([changed], 2), nextCursor: newCursor, total: 2,
      }))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()

    controller.handleChange({
      kind: 'upsert', sessionId: SESSION, epoch: EPOCH, sessionRevision: 2, head: changed,
    })
    await flush()

    expect(source.getSnapshot()).toEqual({
      phase: 'ready', runs: [changed], nextCursor: newCursor, total: 2,
    })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('does not let a delayed control response overwrite a newer change', async () => {
    const controlled = deferred<ReturnType<typeof success<{ run: WorkflowRunHead }>>>()
    const base = remote(() => Promise.resolve(success(page([head('review', 1)], 1))))
    const controller = new WorkflowRunsController({
      ...base,
      control: () => controlled.promise,
    }, () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()

    const pending = controller.control(SESSION, 'review' as SupervisedWorkflowRunId, 'pause', 1)
    const newest = head('review', 2, 'completed')
    controller.handleChange({
      kind: 'upsert', sessionId: SESSION, epoch: EPOCH, sessionRevision: 2, head: newest,
    })
    controlled.resolve(success({ run: head('review', 1, 'paused') }))
    await pending

    expect(source.getSnapshot().runs).toEqual([newest])
  })

  it('does not let a delayed change overwrite a newer control response', async () => {
    const base = remote(() => Promise.resolve(success(page([head('review', 1)], 1))))
    const controller = new WorkflowRunsController({
      ...base,
      control: () => Promise.resolve(success({ run: head('review', 3, 'paused') })),
    }, () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()

    await controller.control(SESSION, 'review' as SupervisedWorkflowRunId, 'pause', 1)
    controller.handleChange({
      kind: 'upsert', sessionId: SESSION, epoch: EPOCH, sessionRevision: 2,
      head: head('review', 2, 'running'),
    })

    expect(source.getSnapshot().runs).toEqual([head('review', 3, 'paused')])
  })

  it('replaces a revision-bound page cursor after a successful control', async () => {
    const oldCursor = 'old-page' as WorkflowRunCursor
    const newCursor = 'new-page' as WorkflowRunCursor
    const controlled = head('review', 2, 'paused')
    const list = vi.fn()
      .mockResolvedValueOnce(success({
        ...page([head('review', 1)], 1), nextCursor: oldCursor, total: 2,
      }))
      .mockResolvedValueOnce(success({
        ...page([controlled], 2), nextCursor: newCursor, total: 2,
      }))
    const base = remote(list)
    const controller = new WorkflowRunsController({
      ...base,
      control: () => Promise.resolve(success({ run: controlled })),
    }, () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()

    await controller.control(SESSION, controlled.runId, 'pause', 1)
    await flush()

    expect(list).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot()).toEqual({
      phase: 'ready', runs: [controlled], nextCursor: newCursor, total: 2,
    })
  })

  it('drops rows when the last observer leaves and rebaselines on return', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce(success(page([head('first', 1)], 1)))
      .mockResolvedValueOnce(success(page([head('second', 2)], 2)))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    const unsubscribe = source.subscribe(() => {})
    await flush()
    unsubscribe()
    expect(source.getSnapshot()).toEqual({ phase: 'idle', runs: [], total: 0 })

    controller.handleChange({
      kind: 'upsert', sessionId: SESSION, epoch: EPOCH, sessionRevision: 2, head: head('second', 2),
    })
    expect(list).toHaveBeenCalledTimes(1)
    source.subscribe(() => {})
    await flush()
    expect(list).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot().runs[0]?.displayName).toBe('second')
  })

  it('uses invalidate and remove changes without exposing full payloads', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce(success(page([head('review', 1)], 1)))
      .mockResolvedValueOnce(success(page([], 3)))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()

    const remove: WorkflowRunChange = {
      kind: 'remove', sessionId: SESSION, epoch: EPOCH, sessionRevision: 2,
      runId: 'review' as SupervisedWorkflowRunId,
    }
    controller.handleChange(remove)
    expect(source.getSnapshot().runs).toEqual([])
    controller.handleChange({ kind: 'invalidate', sessionId: SESSION, epoch: EPOCH, sessionRevision: 3 })
    await flush()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('rebaselines observed Sessions after a carrier-wide workflow invalidation', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce(success(page([head('before', 1)], 1)))
      .mockResolvedValueOnce(success(page([head('after', 2)], 2)))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()

    controller.handleChange({ kind: 'invalidate-all' })
    await flush()

    expect(list).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot().runs[0]?.displayName).toBe('after')
  })

  it('forwards bounded detail collection requests with and without optional cursors', async () => {
    const run = head('review', 1)
    const runId = run.runId
    const cursor = 'page-2' as WorkflowRunCursor
    const signal = new AbortController().signal
    const detail: WorkflowRunDetail = { run }
    const members: WorkflowRunMemberPage = { items: [], total: 0, revision: 1 }
    const logs: WorkflowRunLogPage = { items: [], evicted: 0, total: 0, revision: 1 }
    const result: WorkflowRunResultView = { value: { state: 'not-produced' }, revision: 1 }
    const artifacts: WorkflowRunArtifactPage = { items: [], omitted: 0, total: 0, revision: 1 }
    const artifact: WorkflowRunArtifactChunk = {
      artifact: { name: 'report.md', bytes: 0 }, text: '', offsetBytes: 0,
      returnedBytes: 0, totalBytes: 0, revision: 1,
    }
    const base = remote(() => Promise.resolve(success(page([], 0))))
    const methods = {
      detail: vi.fn(() => Promise.resolve(success(detail))),
      members: vi.fn(() => Promise.resolve(success(members))),
      logs: vi.fn(() => Promise.resolve(success(logs))),
      result: vi.fn(() => Promise.resolve(success(result))),
      artifacts: vi.fn(() => Promise.resolve(success(artifacts))),
      artifact: vi.fn(() => Promise.resolve(success(artifact))),
    }
    const controller = new WorkflowRunsController({ ...base, ...methods }, () => Promise.resolve(false))

    await expect(controller.detail(SESSION, runId, signal)).resolves.toBe(detail)
    await expect(controller.members(SESSION, runId, undefined, signal)).resolves.toBe(members)
    await expect(controller.members(SESSION, runId, cursor, signal)).resolves.toBe(members)
    await expect(controller.logs(SESSION, runId, undefined, signal)).resolves.toBe(logs)
    await expect(controller.logs(SESSION, runId, cursor, signal)).resolves.toBe(logs)
    await expect(controller.result(SESSION, runId, signal)).resolves.toBe(result)
    await expect(controller.artifacts(SESSION, runId, undefined, signal)).resolves.toBe(artifacts)
    await expect(controller.artifacts(SESSION, runId, cursor, signal)).resolves.toBe(artifacts)
    await expect(controller.artifact(SESSION, runId, 'report.md', undefined, undefined, signal))
      .resolves.toBe(artifact)
    await expect(controller.artifact(SESSION, runId, 'report.md', cursor, 1, signal))
      .resolves.toBe(artifact)

    expect(methods.detail).toHaveBeenCalledWith(SESSION, { runId }, signal)
    expect(methods.members).toHaveBeenNthCalledWith(1, SESSION, { runId }, signal)
    expect(methods.members).toHaveBeenNthCalledWith(2, SESSION, { runId, cursor }, signal)
    expect(methods.logs).toHaveBeenNthCalledWith(1, SESSION, { runId }, signal)
    expect(methods.logs).toHaveBeenNthCalledWith(2, SESSION, { runId, cursor }, signal)
    expect(methods.result).toHaveBeenCalledWith(SESSION, { runId }, signal)
    expect(methods.artifacts).toHaveBeenNthCalledWith(1, SESSION, { runId }, signal)
    expect(methods.artifacts).toHaveBeenNthCalledWith(2, SESSION, { runId, cursor }, signal)
    expect(methods.artifact).toHaveBeenNthCalledWith(1, SESSION, { runId, name: 'report.md' }, signal)
    expect(methods.artifact).toHaveBeenNthCalledWith(
      2, SESSION, { runId, name: 'report.md', cursor, expectedRevision: 1 }, signal,
    )
  })

  it('normalizes transport throws without swallowing either AbortError form', async () => {
    const runId = 'review' as SupervisedWorkflowRunId
    const abortError = new Error('cancelled')
    abortError.name = 'AbortError'
    const cases: ReadonlyArray<{ thrown: unknown; expected: string }> = [
      { thrown: new DOMException('bad request', 'DataError'), expected: 'bad request' },
      { thrown: 'offline', expected: 'offline' },
      {
        thrown: { toString: () => { throw new Error('coercion failed') } },
        expected: '[unrenderable workflow-runs failure]',
      },
    ]
    for (const { thrown, expected } of cases) {
      const base = remote(() => Promise.resolve(success(page([], 0))))
      base.detail = async () => { throw thrown }
      const controller = new WorkflowRunsController(base, () => Promise.resolve(false))
      await expect(controller.detail(SESSION, runId)).rejects.toMatchObject({
        name: 'WorkflowRunsRemoteError', code: 'remote-unavailable', message: expected,
      })
    }

    const base = remote(() => Promise.resolve(success(page([], 0))))
    base.detail = () => Promise.reject(abortError)
    const controller = new WorkflowRunsController(base, () => Promise.resolve(false))
    await expect(controller.detail(SESSION, runId)).rejects.toBe(abortError)
  })

  it('inserts new rows and rebaselines epoch mismatches and missing removals', async () => {
    const inserted = head('inserted', 1)
    const list = vi.fn()
      .mockResolvedValueOnce(success(page([], 0)))
      .mockResolvedValueOnce(success(page([inserted], 2)))
      .mockResolvedValueOnce(success(page([inserted], 3)))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()

    controller.handleChange({
      kind: 'upsert', sessionId: SESSION, epoch: EPOCH, sessionRevision: 1, head: inserted,
    })
    expect(source.getSnapshot()).toEqual({ phase: 'ready', runs: [inserted], total: 1 })
    controller.handleChange({
      kind: 'remove', sessionId: SESSION, epoch: 'other' as WorkflowRunFeedEpoch,
      sessionRevision: 2, runId: inserted.runId,
    })
    await flush()
    controller.handleChange({
      kind: 'remove', sessionId: SESSION, epoch: EPOCH, sessionRevision: 3,
      runId: 'absent' as SupervisedWorkflowRunId,
    })
    await flush()

    expect(list).toHaveBeenCalledTimes(3)
    expect(source.getSnapshot().runs).toEqual([inserted])
  })

  it('coalesces concurrent baseline and page reads', async () => {
    const baseline = deferred<ReturnType<typeof success<WorkflowRunListPage>>>()
    const pageRead = deferred<ReturnType<typeof success<WorkflowRunListPage>>>()
    const cursor = 'more' as WorkflowRunCursor
    const list = vi.fn()
      .mockImplementationOnce(() => baseline.promise)
      .mockImplementationOnce(() => pageRead.promise)
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})

    const firstRefresh = controller.refresh(SESSION)
    const secondRefresh = controller.refresh(SESSION)
    expect(secondRefresh).toBe(firstRefresh)
    baseline.resolve(success({ ...page([head('new', 1)], 1), nextCursor: cursor, total: 2 }))
    await firstRefresh

    const firstPage = controller.loadMore(SESSION)
    const secondPage = controller.loadMore(SESSION)
    expect(list).toHaveBeenCalledTimes(2)
    pageRead.resolve(success(page([head('old', 1, 'completed')], 1)))
    await Promise.all([firstPage, secondPage])
    expect(source.getSnapshot().runs).toHaveLength(2)
  })

  it('short-circuits pagination while disconnected or without a ready cursor', async () => {
    const cursor = 'more' as WorkflowRunCursor
    const list = vi.fn(() => Promise.resolve(success({ ...page([], 1), nextCursor: cursor, total: 1 })))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))

    await controller.loadMore(SESSION)
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()
    controller.handleDisconnected()
    await controller.refresh(SESSION)
    await controller.loadMore(SESSION)

    expect(list).toHaveBeenCalledOnce()
  })

  it('uses caller cancellation for pagination and ignores the cancelled response', async () => {
    const cursor = 'more' as WorkflowRunCursor
    const next = deferred<ReturnType<typeof success<WorkflowRunListPage>>>()
    const list = vi.fn()
      .mockResolvedValueOnce(success({ ...page([head('new', 1)], 1), nextCursor: cursor, total: 2 }))
      .mockImplementationOnce(() => next.promise)
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()
    const abort = new AbortController()

    const pending = controller.loadMore(SESSION, abort.signal)
    abort.abort()
    next.reject(new DOMException('cancelled', 'AbortError'))
    await expect(pending).resolves.toBeUndefined()
    expect(source.getSnapshot().runs).toEqual([head('new', 1)])
  })

  it('ignores a retained page when caller cancellation wins as it resolves', async () => {
    const cursor = 'more' as WorkflowRunCursor
    const abort = new AbortController()
    const list = vi.fn()
      .mockResolvedValueOnce(success({ ...page([head('new', 1)], 1), nextCursor: cursor, total: 2 }))
      .mockImplementationOnce(() => {
        abort.abort()
        return Promise.resolve(success(page([head('old', 1, 'completed')], 1)))
      })
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()

    await controller.loadMore(SESSION, abort.signal)
    expect(source.getSnapshot().runs).toEqual([head('new', 1)])
  })

  it('rebaselines stale retained pages, omits duplicate rows, and preserves continuation', async () => {
    const cursor = 'page-2' as WorkflowRunCursor
    const cursor3 = 'page-3' as WorkflowRunCursor
    const current = head('current', 1)
    const old = head('old', 1, 'completed')
    const list = vi.fn()
      .mockResolvedValueOnce(success({ ...page([current], 1), nextCursor: cursor, total: 3 }))
      .mockResolvedValueOnce(success({
        ...page([current, old], 1), nextCursor: cursor3, total: 3,
      }))
      .mockResolvedValueOnce(success({ ...page([current], 2), nextCursor: cursor, total: 3 }))
      .mockResolvedValueOnce(success({ ...page([old], 1), total: 3 }))
      .mockResolvedValueOnce(success({ ...page([current], 2), total: 2 }))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()

    await controller.loadMore(SESSION)
    expect(source.getSnapshot()).toEqual({
      phase: 'ready', runs: [current, old], nextCursor: cursor3, total: 3,
    })
    await controller.refresh(SESSION)
    await controller.loadMore(SESSION)
    await flush()

    expect(list).toHaveBeenCalledTimes(5)
    expect(source.getSnapshot()).toEqual({ phase: 'ready', runs: [current], total: 2 })
  })

  it('surfaces live retained-page failures', async () => {
    const cursor = 'more' as WorkflowRunCursor
    const list = vi.fn()
      .mockResolvedValueOnce(success({ ...page([], 1), nextCursor: cursor, total: 1 }))
      .mockRejectedValueOnce(new Error('page unavailable'))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()

    await expect(controller.loadMore(SESSION)).rejects.toMatchObject({
      name: 'WorkflowRunsRemoteError', code: 'remote-unavailable', message: 'page unavailable',
    })
  })

  it('retains a prior cursor when a rebaseline fails', async () => {
    const cursor = 'more' as WorkflowRunCursor
    const list = vi.fn()
      .mockResolvedValueOnce(success({ ...page([head('review', 1)], 1), nextCursor: cursor, total: 2 }))
      .mockRejectedValueOnce(new Error('refresh unavailable'))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})
    await flush()

    controller.handleChange({
      kind: 'invalidate', sessionId: SESSION, epoch: EPOCH, sessionRevision: 2,
    })
    await flush()
    expect(source.getSnapshot()).toEqual({
      phase: 'error', runs: [head('review', 1)], nextCursor: cursor,
      total: 2, error: 'refresh unavailable',
    })
  })

  it('buffers only the newest racing change and applies an adjacent revision', async () => {
    const baseline = deferred<ReturnType<typeof success<WorkflowRunListPage>>>()
    const older = head('older', 2)
    const newest = head('newest', 3)
    const list = vi.fn(() => baseline.promise)
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    source.subscribe(() => {})

    controller.handleChange({
      kind: 'upsert', sessionId: SESSION, epoch: EPOCH, sessionRevision: 3, head: newest,
    })
    controller.handleChange({
      kind: 'upsert', sessionId: SESSION, epoch: EPOCH, sessionRevision: 2, head: older,
    })
    baseline.resolve(success(page([], 2)))
    await flush()
    expect(source.getSnapshot()).toEqual({ phase: 'ready', runs: [newest], total: 1 })
    expect(list).toHaveBeenCalledOnce()
  })

  it('handles global invalidation for unobserved, disconnected, and loading sources', async () => {
    const loading = deferred<ReturnType<typeof success<WorkflowRunListPage>>>()
    const list = vi.fn()
      .mockImplementationOnce(() => loading.promise)
      .mockResolvedValue(success(page([], 0)))
    const controller = new WorkflowRunsController(remote(list), () => Promise.resolve(false))
    controller.source('unobserved' as SessionId)
    const source = controller.source(SESSION)
    source.subscribe(() => {})

    controller.handleChange({ kind: 'invalidate-all' })
    loading.resolve(success(page([], 0)))
    await flush()
    controller.handleDisconnected()
    controller.handleChange({ kind: 'invalidate-all' })
    controller.handleConnected()
    await flush()

    expect(list).toHaveBeenCalledTimes(3)
    expect(source.getSnapshot().phase).toBe('ready')
  })

  it('keeps disconnected resets and controls fenced from stale rows', async () => {
    const cursor = 'more' as WorkflowRunCursor
    const controlled = head('review', 2, 'paused')
    const base = remote(() => Promise.resolve(success({
      ...page([head('review', 1)], 1), nextCursor: cursor, total: 2,
    })))
    const controller = new WorkflowRunsController({
      ...base,
      control: () => Promise.resolve(success({ run: controlled })),
    }, () => Promise.resolve(false))
    const source = controller.source(SESSION)
    const unsubscribe = source.subscribe(() => {})
    await flush()
    controller.handleDisconnected()
    expect(source.getSnapshot()).toEqual({
      phase: 'reconnecting', runs: [head('review', 1)], nextCursor: cursor, total: 2,
    })

    const result = await controller.control(SESSION, controlled.runId, 'pause')
    expect(result.run).toBe(controlled)
    expect(source.getSnapshot().runs).toEqual([head('review', 1)])
    unsubscribe()
    controller.handleConnected()
    expect(source.getSnapshot()).toEqual({ phase: 'idle', runs: [], total: 0 })
  })

  it('ignores changes for unknown Sessions and safely removes absent Sessions', () => {
    const controller = new WorkflowRunsController(
      remote(() => Promise.resolve(success(page([], 0)))),
      () => Promise.resolve(false),
    )
    controller.handleChange({
      kind: 'invalidate', sessionId: SESSION, epoch: EPOCH, sessionRevision: 1,
    })
    expect(() => { controller.removeSession(SESSION) }).not.toThrow()
  })

  it('keeps a source live until its last observer leaves and disposes every source', async () => {
    const pending = deferred<ReturnType<typeof success<WorkflowRunListPage>>>()
    const controller = new WorkflowRunsController(remote(() => pending.promise), () => Promise.resolve(false))
    const source = controller.source(SESSION)
    const first = source.subscribe(() => {})
    const second = source.subscribe(() => {})
    first()
    expect(source.getSnapshot().phase).toBe('loading')

    controller.dispose()
    pending.resolve(success(page([head('late', 1)], 1)))
    await flush()
    expect(source.getSnapshot().phase).toBe('loading')
    expect(() => { second() }).not.toThrow()
    expect(controller.source(SESSION)).not.toBe(source)
  })
})
