/**
 * React-free browser object layer for bounded workflow-run Remote reads.
 *
 * List rows arrive as a bounded baseline plus revisioned one-row changes. The
 * controller keeps those rows out of the global Session list snapshot, fences
 * reconnect and removal races, and leaves members, logs, outcomes, results,
 * and artifacts on-demand.
 *
 * @module @deepseek-ai/dsh-client-runtime/client/workflow-runs/controller
 */

import type {
  ClientRemote,
  SessionId,
  SupervisedWorkflowRunId,
  WorkflowMemberId,
  WorkflowRunAction,
  WorkflowRunArtifactPage,
  WorkflowRunArtifactChunk,
  WorkflowRunChange,
  WorkflowRunControlResult,
  WorkflowRunCursor,
  WorkflowRunDetail,
  WorkflowRunHead,
  WorkflowRunLogPage,
  WorkflowRunMemberDetail,
  WorkflowRunMemberPage,
  WorkflowRunResultView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot } from '../contract/store.ts'

/** List-baseline lifecycle and current bounded run heads for one Session. */
export interface WorkflowRunsSnapshot {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error' | 'reconnecting'
  readonly runs: readonly WorkflowRunHead[]
  readonly nextCursor?: WorkflowRunCursor
  readonly total: number
  readonly error?: string
}

/** Generated Remote namespace required by {@link WorkflowRunsController}. */
export type WorkflowRunsRemote = ClientRemote['workflowRuns']

/** Transport or Host-policy rejection from the workflow-runs Remote. */
export class WorkflowRunsRemoteError extends Error {
  override readonly name = 'WorkflowRunsRemoteError'

  /**
   * @param code - stable carrier or Host error code.
   * @param message - human-readable failure text.
   */
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

type SessionWorkflowRunChange = Exclude<WorkflowRunChange, { readonly kind: 'invalidate-all' }>

interface SourceRecord {
  snapshot: WorkflowRunsSnapshot
  readonly listeners: Set<() => void>
  readonly source: ObservableSnapshot<WorkflowRunsSnapshot>
  epoch: string | undefined
  sessionRevision: number
  requestGeneration: number
  inflight: Promise<void> | undefined
  listAbort: AbortController | undefined
  pageInflight: Promise<void> | undefined
  pageAbort: AbortController | undefined
  pendingChange: SessionWorkflowRunChange | undefined
  needsRefresh: boolean
  removed: boolean
}

const EMPTY: WorkflowRunsSnapshot = Object.freeze({
  phase: 'idle',
  runs: Object.freeze([]),
  total: 0,
})

const RECONNECTING: WorkflowRunsSnapshot = Object.freeze({
  phase: 'reconnecting',
  runs: Object.freeze([]),
  total: 0,
})

/** Render an arbitrary rejected value without trusting its coercion. */
function renderThrown(value: unknown): string {
  try {
    return value instanceof Error ? value.message : String(value)
  } catch {
    return '[unrenderable workflow-runs failure]'
  }
}

/** Unwrap the generated Remote envelope into a feature-owned exception. */
async function unwrap<T>(promise: Promise<RemoteResult<T>>): Promise<T> {
  let result: RemoteResult<T>
  try {
    result = await promise
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new WorkflowRunsRemoteError('remote-unavailable', renderThrown(error))
  }
  if (!result.ok) throw new WorkflowRunsRemoteError(result.error.code, result.error.message)
  return result.value
}

/** Publish a replacement only when the owning record is still live. */
function publish(record: SourceRecord, snapshot: WorkflowRunsSnapshot): void {
  record.snapshot = snapshot
  notify(record)
}

/** Notify every observer without letting one UI callback starve the rest. */
function notify(record: SourceRecord): void {
  for (const listener of [...record.listeners]) {
    try {
      listener()
    } catch (error: unknown) {
      console.error('[workflow-runs] snapshot listener failed:', error)
    }
  }
}

/** Apply one monotonic change to a ready baseline. */
function reduceChange(record: SourceRecord, change: SessionWorkflowRunChange): boolean {
  if (record.epoch !== String(change.epoch)) return false
  if (change.sessionRevision <= record.sessionRevision) return true
  if (change.sessionRevision !== record.sessionRevision + 1) return false
  // Run cursors are revision-bound. Applying a newer row beside an older
  // cursor would make the next page request fail as stale, so repull the first
  // page and its replacement cursor instead.
  if (record.snapshot.nextCursor !== undefined) return false
  record.sessionRevision = change.sessionRevision
  switch (change.kind) {
    case 'invalidate': return false
    case 'remove': {
      const present = record.snapshot.runs.some(run => run.runId === change.runId)
      if (!present) return false
      const runs = record.snapshot.runs.filter(run => run.runId !== change.runId)
      publish(record, {
        phase: 'ready',
        runs,
        total: Math.max(0, record.snapshot.total - 1),
      })
      return true
    }
    case 'upsert': {
      const index = record.snapshot.runs.findIndex(run => run.runId === change.head.runId)
      const runs = [...record.snapshot.runs]
      if (index === -1) runs.unshift(change.head)
      else {
        const current = runs[index]
        if (current !== undefined && change.head.revision >= current.revision) runs[index] = change.head
      }
      publish(record, {
        phase: 'ready',
        runs,
        total: index === -1 ? record.snapshot.total + 1 : record.snapshot.total,
      })
      return true
    }
    /* v8 ignore next -- the generated Remote schema rejects unknown discriminants. */
    default: return change satisfies never
  }
}

/**
 * Session-keyed workflow-run controller. Every list source is lazy; its first
 * subscriber starts one bounded baseline read. Detail collections remain
 * request-local and therefore cannot grow a cumulative global snapshot.
 */
export class WorkflowRunsController {
  private readonly records = new Map<SessionId, SourceRecord>()
  private connectionGeneration = 0
  private connected = true

  /**
   * @param remote - generated workflowRuns Remote namespace.
   * @param openChild - catalog-fenced child-conversation navigator.
   */
  constructor(
    private readonly remote: WorkflowRunsRemote,
    private readonly openChild: (parentSessionId: SessionId, childSessionId: SessionId) => Promise<boolean>,
  ) {}

  /**
   * Obtain the stable list source for one Session. The first subscription
   * triggers its bounded baseline read.
   * @param sessionId - owning root Session.
   * @returns stable observable for this controller lifetime.
   */
  source(sessionId: SessionId): ObservableSnapshot<WorkflowRunsSnapshot> {
    return this.record(sessionId).source
  }

  /**
   * Refresh one Session's first bounded page, coalescing concurrent callers.
   * @param sessionId - owning root Session.
   */
  refresh(sessionId: SessionId): Promise<void> {
    const record = this.record(sessionId)
    if (!this.connected) {
      record.needsRefresh = true
      publish(record, {
        phase: 'reconnecting',
        runs: record.snapshot.runs,
        ...record.snapshot.nextCursor === undefined ? {} : { nextCursor: record.snapshot.nextCursor },
        total: record.snapshot.total,
      })
      return Promise.resolve()
    }
    if (record.inflight !== undefined) return record.inflight
    record.needsRefresh = false
    const generation = this.connectionGeneration
    const requestGeneration = ++record.requestGeneration
    record.listAbort?.abort('workflow-runs list superseded')
    record.pageAbort?.abort('workflow-runs baseline superseded page')
    record.pageInflight = undefined
    record.pageAbort = undefined
    const abort = new AbortController()
    record.listAbort = abort
    publish(record, {
      phase: 'loading',
      runs: record.snapshot.runs,
      ...record.snapshot.nextCursor === undefined ? {} : { nextCursor: record.snapshot.nextCursor },
      total: record.snapshot.total,
    })
    const pending = this.load(sessionId, record, generation, requestGeneration, abort.signal)
    record.inflight = pending
    return pending.finally(() => {
      if (record.inflight === pending) {
        record.inflight = undefined
        if (record.needsRefresh && !record.removed && this.connected && record.listeners.size > 0) {
          record.needsRefresh = false
          void this.refresh(sessionId)
        }
      }
      if (record.listAbort === abort) record.listAbort = undefined
    })
  }

  /**
   * Append the next retained-run page when the current baseline has one.
   * @param sessionId - owning root Session.
   * @param signal - optional caller cancellation.
   */
  loadMore(sessionId: SessionId, signal?: AbortSignal): Promise<void> {
    const record = this.record(sessionId)
    if (record.pageInflight !== undefined) return record.pageInflight
    const cursor = record.snapshot.nextCursor
    if (cursor === undefined || !this.connected || record.snapshot.phase !== 'ready') {
      return Promise.resolve()
    }
    const connectionGeneration = this.connectionGeneration
    const requestGeneration = record.requestGeneration
    const epoch = record.epoch
    const sessionRevision = record.sessionRevision
    const abort = new AbortController()
    record.pageAbort?.abort('workflow-runs page superseded')
    record.pageAbort = abort
    const requestSignal = signal === undefined ? abort.signal : AbortSignal.any([signal, abort.signal])
    const pending = this.loadPage(
      sessionId,
      record,
      cursor,
      epoch,
      sessionRevision,
      connectionGeneration,
      requestGeneration,
      requestSignal,
    )
    record.pageInflight = pending
    return pending.finally(() => {
      if (record.pageInflight === pending) record.pageInflight = undefined
      if (record.pageAbort === abort) record.pageAbort = undefined
    })
  }

  /**
   * Load selected-run metadata.
   * @param sessionId - owning root Session.
   * @param runId - selected supervised run.
   * @param signal - optional caller cancellation.
   * @returns bounded run metadata.
   */
  detail(sessionId: SessionId, runId: SupervisedWorkflowRunId, signal?: AbortSignal): Promise<WorkflowRunDetail> {
    return unwrap(this.remote.detail(sessionId, { runId }, signal))
  }

  /**
   * Load one bounded member page.
   * @param sessionId - owning root Session.
   * @param runId - selected supervised run.
   * @param cursor - optional continuation cursor.
   * @param signal - optional caller cancellation.
   * @returns bounded member page.
   */
  members(
    sessionId: SessionId,
    runId: SupervisedWorkflowRunId,
    cursor?: WorkflowRunCursor,
    signal?: AbortSignal,
  ): Promise<WorkflowRunMemberPage> {
    return unwrap(this.remote.members(sessionId, { runId, ...cursor === undefined ? {} : { cursor } }, signal))
  }

  /**
   * Load one member's committed script-visible value.
   * @param sessionId - owning root Session.
   * @param runId - selected supervised run.
   * @param memberId - selected workflow member.
   * @param signal - optional caller cancellation.
   * @returns bounded member metadata and outcome.
   */
  memberDetail(
    sessionId: SessionId,
    runId: SupervisedWorkflowRunId,
    memberId: WorkflowMemberId,
    signal?: AbortSignal,
  ): Promise<WorkflowRunMemberDetail> {
    return unwrap(this.remote.memberDetail(sessionId, { runId, memberId }, signal))
  }

  /**
   * Load one bounded log page.
   * @param sessionId - owning root Session.
   * @param runId - selected supervised run.
   * @param cursor - optional continuation cursor.
   * @param signal - optional caller cancellation.
   * @returns bounded log page.
   */
  logs(
    sessionId: SessionId,
    runId: SupervisedWorkflowRunId,
    cursor?: WorkflowRunCursor,
    signal?: AbortSignal,
  ): Promise<WorkflowRunLogPage> {
    return unwrap(this.remote.logs(sessionId, { runId, ...cursor === undefined ? {} : { cursor } }, signal))
  }

  /**
   * Load the run's bounded final result view.
   * @param sessionId - owning root Session.
   * @param runId - selected supervised run.
   * @param signal - optional caller cancellation.
   * @returns retained final-result view.
   */
  result(
    sessionId: SessionId,
    runId: SupervisedWorkflowRunId,
    signal?: AbortSignal,
  ): Promise<WorkflowRunResultView> {
    return unwrap(this.remote.result(sessionId, { runId }, signal))
  }

  /**
   * Load one bounded scratch-artifact page.
   * @param sessionId - owning root Session.
   * @param runId - selected supervised run.
   * @param cursor - optional continuation cursor.
   * @param signal - optional caller cancellation.
   * @returns bounded artifact page.
   */
  artifacts(
    sessionId: SessionId,
    runId: SupervisedWorkflowRunId,
    cursor?: WorkflowRunCursor,
    signal?: AbortSignal,
  ): Promise<WorkflowRunArtifactPage> {
    return unwrap(this.remote.artifacts(sessionId, { runId, ...cursor === undefined ? {} : { cursor } }, signal))
  }

  /**
   * Load one bounded scratch-artifact text body.
   * @param sessionId - owning root Session.
   * @param runId - selected supervised run.
   * @param name - single-component scratch-file name.
   * @param cursor - optional text continuation cursor.
   * @param expectedRevision - optional artifact revision fence.
   * @param signal - optional caller cancellation.
   * @returns bounded artifact text chunk.
   */
  artifact(
    sessionId: SessionId,
    runId: SupervisedWorkflowRunId,
    name: string,
    cursor?: WorkflowRunCursor,
    expectedRevision?: number,
    signal?: AbortSignal,
  ): Promise<WorkflowRunArtifactChunk> {
    return unwrap(this.remote.artifact(sessionId, {
      runId,
      name,
      ...cursor === undefined ? {} : { cursor },
      ...expectedRevision === undefined ? {} : { expectedRevision },
    }, signal))
  }

  /**
   * Execute one revision-checked dashboard control and merge its authoritative
   * row into an already-loaded source.
   * @param sessionId - owning root Session.
   * @param runId - selected supervised run.
   * @param action - requested lifecycle action.
   * @param expectedRevision - optional selected-row revision fence.
   * @param signal - optional caller cancellation.
   * @returns authoritative post-control row.
   */
  async control(
    sessionId: SessionId,
    runId: SupervisedWorkflowRunId,
    action: WorkflowRunAction,
    expectedRevision?: number,
    signal?: AbortSignal,
  ): Promise<WorkflowRunControlResult> {
    const record = this.records.get(sessionId)
    const connectionGeneration = this.connectionGeneration
    const requestGeneration = record?.requestGeneration
    const result = await unwrap(this.remote.control(sessionId, {
      runId,
      action,
      ...expectedRevision === undefined ? {} : { expectedRevision },
    }, signal))
    if (record !== undefined && !record.removed
      && this.records.get(sessionId) === record
      && connectionGeneration === this.connectionGeneration
      && requestGeneration === record.requestGeneration
      && record.snapshot.phase === 'ready') {
      const index = record.snapshot.runs.findIndex(run => run.runId === result.run.runId)
      const current = record.snapshot.runs[index]
      if (index !== -1 && current !== undefined && result.run.revision >= current.revision) {
        const runs = [...record.snapshot.runs]
        runs[index] = result.run
        publish(record, {
          phase: 'ready',
          runs,
          ...record.snapshot.nextCursor === undefined ? {} : { nextCursor: record.snapshot.nextCursor },
          total: record.snapshot.total,
        })
      }
      // A successful control advances the Host collection revision. If this
      // source still carries a page cursor from before that write, replace it
      // before the next retained-page request can use it.
      if (record.snapshot.nextCursor !== undefined && record.listeners.size > 0 && this.connected) {
        void this.refresh(sessionId)
      }
    }
    return result
  }

  /**
   * Resolve and open an exact direct child through the Session catalog.
   * @param parentSessionId - expected direct parent.
   * @param childSessionId - referenced one-shot child.
   * @returns whether the refreshed catalog authorized and opened the child.
   */
  resolveAndOpenChild(parentSessionId: SessionId, childSessionId: SessionId): Promise<boolean> {
    return this.openChild(parentSessionId, childSessionId)
  }

  /**
   * Apply one forwarded bounded change. Changes racing a baseline are buffered
   * and replayed after it; a mismatched epoch forces a new baseline.
   * @param change - revisioned run-head change or invalidation.
   */
  handleChange(change: WorkflowRunChange): void {
    if (change.kind === 'invalidate-all') {
      for (const [sessionId, record] of this.records) {
        if (record.listeners.size === 0 || !this.connected) {
          record.needsRefresh = true
          continue
        }
        if (record.inflight !== undefined) {
          record.needsRefresh = true
          continue
        }
        void this.refresh(sessionId)
      }
      return
    }
    const record = this.records.get(change.sessionId)
    if (record === undefined || record.removed) return
    if (record.listeners.size === 0) {
      record.pendingChange = undefined
      record.needsRefresh = true
      return
    }
    if (record.inflight !== undefined || record.snapshot.phase !== 'ready') {
      if (record.pendingChange === undefined
        || change.sessionRevision > record.pendingChange.sessionRevision) {
        record.pendingChange = change
      }
      if (record.listeners.size > 0 && record.inflight === undefined && this.connected) {
        void this.refresh(change.sessionId)
      }
      return
    }
    if (!reduceChange(record, change)) void this.refresh(change.sessionId)
  }

  /** Mark every resident source stale while the carrier reconnects. */
  handleDisconnected(): void {
    this.connected = false
    this.connectionGeneration += 1
    for (const record of this.records.values()) {
      record.listAbort?.abort('workflow-runs connection reset')
      record.pageAbort?.abort('workflow-runs connection reset')
      record.requestGeneration += 1
      record.inflight = undefined
      record.listAbort = undefined
      record.pageInflight = undefined
      record.pageAbort = undefined
      publish(record, {
        phase: 'reconnecting',
        runs: record.snapshot.runs,
        ...record.snapshot.nextCursor === undefined ? {} : { nextCursor: record.snapshot.nextCursor },
        total: record.snapshot.total,
      })
    }
  }

  /** Rebaseline every observed source after a connection is established. */
  handleConnected(): void {
    this.connected = true
    for (const [sessionId, record] of this.records) {
      if (record.listeners.size > 0) void this.refresh(sessionId)
      else publish(record, { phase: 'idle', runs: [], total: 0 })
    }
  }

  /**
   * Purge one removed Session and fence every in-flight response that predates
   * the removal.
   * @param sessionId - removed Session identity.
   */
  removeSession(sessionId: SessionId): void {
    const record = this.records.get(sessionId)
    if (record === undefined) return
    record.removed = true
    record.requestGeneration += 1
    record.listAbort?.abort('workflow-runs session removed')
    record.pageAbort?.abort('workflow-runs session removed')
    record.snapshot = EMPTY
    notify(record)
    this.records.delete(sessionId)
  }

  /** Cancel list reads, silence sources, and release every retained row. */
  dispose(): void {
    for (const record of this.records.values()) {
      record.removed = true
      record.listAbort?.abort('workflow-runs controller disposed')
      record.pageAbort?.abort('workflow-runs controller disposed')
      record.listeners.clear()
    }
    this.records.clear()
  }

  private record(sessionId: SessionId): SourceRecord {
    const existing = this.records.get(sessionId)
    if (existing !== undefined) return existing
    const listeners = new Set<() => void>()
    const record: SourceRecord = {
      snapshot: this.connected ? EMPTY : RECONNECTING,
      listeners,
      source: {
        getSnapshot: () => record.snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          if (listeners.size === 1 && record.snapshot.phase === 'idle' && this.connected) {
            void this.refresh(sessionId)
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size !== 0) return
            record.requestGeneration += 1
            record.listAbort?.abort('workflow-runs source unobserved')
            record.pageAbort?.abort('workflow-runs source unobserved')
            record.inflight = undefined
            record.listAbort = undefined
            record.pageInflight = undefined
            record.pageAbort = undefined
            record.epoch = undefined
            record.pendingChange = undefined
            record.needsRefresh = true
            record.snapshot = this.connected ? EMPTY : RECONNECTING
          }
        },
      },
      epoch: undefined,
      sessionRevision: 0,
      requestGeneration: 0,
      inflight: undefined,
      listAbort: undefined,
      pageInflight: undefined,
      pageAbort: undefined,
      pendingChange: undefined,
      needsRefresh: false,
      removed: false,
    }
    this.records.set(sessionId, record)
    return record
  }

  private async load(
    sessionId: SessionId,
    record: SourceRecord,
    connectionGeneration: number,
    requestGeneration: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const page = await unwrap(this.remote.list(sessionId, {}, signal))
      if (record.removed || connectionGeneration !== this.connectionGeneration
        || requestGeneration !== record.requestGeneration) return
      record.epoch = String(page.epoch)
      record.sessionRevision = page.sessionRevision
      publish(record, {
        phase: 'ready',
        runs: page.items,
        ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
        total: page.total,
      })
      const change = record.pendingChange
      record.pendingChange = undefined
      if (change !== undefined && !reduceChange(record, change)) {
        record.needsRefresh = true
      }
    } catch (error: unknown) {
      if (record.removed || connectionGeneration !== this.connectionGeneration
        || requestGeneration !== record.requestGeneration) return
      publish(record, {
        phase: 'error',
        runs: record.snapshot.runs,
        ...record.snapshot.nextCursor === undefined ? {} : { nextCursor: record.snapshot.nextCursor },
        total: record.snapshot.total,
        error: renderThrown(error),
      })
    }
  }

  private async loadPage(
    sessionId: SessionId,
    record: SourceRecord,
    cursor: WorkflowRunCursor,
    epoch: string | undefined,
    sessionRevision: number,
    connectionGeneration: number,
    requestGeneration: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const page = await unwrap(this.remote.list(sessionId, { cursor }, signal))
      if (record.removed || this.records.get(sessionId) !== record
        || connectionGeneration !== this.connectionGeneration
        || requestGeneration !== record.requestGeneration || signal.aborted) return
      if (String(page.epoch) !== epoch || page.sessionRevision !== sessionRevision
        || record.sessionRevision !== sessionRevision) {
        await this.refresh(sessionId)
        return
      }
      const known = new Set(record.snapshot.runs.map(run => run.runId))
      const runs = [...record.snapshot.runs]
      for (const run of page.items) {
        if (!known.has(run.runId)) {
          known.add(run.runId)
          runs.push(run)
        }
      }
      publish(record, {
        phase: 'ready',
        runs,
        ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
        total: page.total,
      })
    } catch (error: unknown) {
      if (signal.aborted || record.removed || this.records.get(sessionId) !== record
        || connectionGeneration !== this.connectionGeneration) return
      throw error
    }
  }
}
