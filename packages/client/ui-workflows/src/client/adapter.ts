/** Stable slot adapter over the session-keyed workflow-runs controller. */

import type {
  ObservableSnapshot, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  WorkflowRunsOperations, WorkflowRunsSourceSnapshot,
} from './contract.ts'

/** Controller operations used by the dashboard without exposing React. */
export interface WorkflowRunsControllerFace extends Omit<WorkflowRunsOperations, 'observe'> {
  source(sessionId: SessionId): ObservableSnapshot<WorkflowRunsSourceSnapshot>
}

const EMPTY: WorkflowRunsSourceSnapshot = Object.freeze({
  phase: 'idle',
  runs: Object.freeze([]),
  total: 0,
})

/** Stable slot observable that owns at most one controller subscription. */
export class DashboardWorkflowRunsAdapter implements WorkflowRunsOperations {
  private snapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private observedSessionId: SessionId | undefined
  private observedSource: ObservableSnapshot<WorkflowRunsSourceSnapshot> | undefined
  private unsubscribe: (() => void) | undefined

  /** Stable snapshot source bound to the currently observed Session. */
  readonly source: ObservableSnapshot<WorkflowRunsSourceSnapshot> = {
    getSnapshot: () => this.snapshot,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /** @param controller - React-free workflow-run object layer. */
  constructor(private readonly controller: WorkflowRunsControllerFace) {}

  /**
   * Switch the stable slot source without leaking the previous Session subscription.
   * @param sessionId - Session to observe, or undefined to release observation.
   */
  observe(sessionId: SessionId | undefined): void {
    if (sessionId === this.observedSessionId) return
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.observedSessionId = sessionId
    this.observedSource = sessionId === undefined ? undefined : this.controller.source(sessionId)
    this.publish(this.observedSource?.getSnapshot() ?? EMPTY, true)
    const source = this.observedSource
    if (source === undefined) return
    this.unsubscribe = source.subscribe(() => {
      if (this.observedSource === source) this.publish(source.getSnapshot(), false)
    })
  }

  /**
   * Refresh the observed Session's first run page.
   * @param args - Controller refresh arguments.
   * @returns refresh settlement.
   */
  refresh(...args: Parameters<WorkflowRunsOperations['refresh']>): ReturnType<WorkflowRunsOperations['refresh']> {
    return this.controller.refresh(...args)
  }

  /**
   * Append another run-head page.
   * @param args - Controller pagination arguments.
   * @returns page-load settlement.
   */
  loadMore(...args: Parameters<WorkflowRunsOperations['loadMore']>): ReturnType<WorkflowRunsOperations['loadMore']> {
    return this.controller.loadMore(...args)
  }

  /**
   * Read bounded run detail.
   * @param args - Controller detail arguments.
   * @returns run detail.
   */
  detail(...args: Parameters<WorkflowRunsOperations['detail']>): ReturnType<WorkflowRunsOperations['detail']> {
    return this.controller.detail(...args)
  }

  /**
   * Read one member-head page.
   * @param args - Controller member-page arguments.
   * @returns member page.
   */
  members(...args: Parameters<WorkflowRunsOperations['members']>): ReturnType<WorkflowRunsOperations['members']> {
    return this.controller.members(...args)
  }

  /**
   * Read one member's retained outcome.
   * @param args - Controller member-detail arguments.
   * @returns member detail.
   */
  memberDetail(
    ...args: Parameters<WorkflowRunsOperations['memberDetail']>
  ): ReturnType<WorkflowRunsOperations['memberDetail']> {
    return this.controller.memberDetail(...args)
  }

  /**
   * Read one log page.
   * @param args - Controller log-page arguments.
   * @returns log page.
   */
  logs(...args: Parameters<WorkflowRunsOperations['logs']>): ReturnType<WorkflowRunsOperations['logs']> {
    return this.controller.logs(...args)
  }

  /**
   * Read the retained terminal result.
   * @param args - Controller result arguments.
   * @returns result view.
   */
  result(...args: Parameters<WorkflowRunsOperations['result']>): ReturnType<WorkflowRunsOperations['result']> {
    return this.controller.result(...args)
  }

  /**
   * Read one scratch-artifact metadata page.
   * @param args - Controller artifact-page arguments.
   * @returns artifact metadata page.
   */
  artifacts(...args: Parameters<WorkflowRunsOperations['artifacts']>): ReturnType<WorkflowRunsOperations['artifacts']> {
    return this.controller.artifacts(...args)
  }

  /**
   * Read one bounded scratch-artifact content chunk.
   * @param args - Controller artifact-content arguments.
   * @returns artifact content chunk.
   */
  artifact(...args: Parameters<WorkflowRunsOperations['artifact']>): ReturnType<WorkflowRunsOperations['artifact']> {
    return this.controller.artifact(...args)
  }

  /**
   * Request a run lifecycle action.
   * @param args - Controller action arguments.
   * @returns refreshed controlled run.
   */
  control(...args: Parameters<WorkflowRunsOperations['control']>): ReturnType<WorkflowRunsOperations['control']> {
    return this.controller.control(...args)
  }

  /**
   * Verify and open a direct child Session.
   * @param args - Parent and child Session ids.
   * @returns whether the child was available and opened.
   */
  resolveAndOpenChild(
    ...args: Parameters<WorkflowRunsOperations['resolveAndOpenChild']>
  ): ReturnType<WorkflowRunsOperations['resolveAndOpenChild']> {
    return this.controller.resolveAndOpenChild(...args)
  }

  /** Release the selected Session and every slot-hook subscriber. */
  dispose(): void {
    this.observe(undefined)
    this.listeners.clear()
  }

  private publish(snapshot: WorkflowRunsSourceSnapshot, force: boolean): void {
    if (!force && snapshot === this.snapshot) return
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error: unknown) {
        console.error('[ui-workflows] dashboard snapshot listener failed:', error)
      }
    }
  }
}
