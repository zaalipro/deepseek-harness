/** Browser dashboard adapter over the React-free workflow-runs controller. */

import type {
  SessionId,
  WorkflowRunAction,
  WorkflowRunArtifactPage,
  WorkflowRunArtifactChunk,
  WorkflowRunControlResult,
  WorkflowRunCursor,
  WorkflowRunDetail,
  WorkflowRunHead,
  WorkflowRunLogPage,
  WorkflowMemberId,
  WorkflowRunMemberDetail,
  WorkflowRunMemberPage,
  WorkflowRunResultView,
  SupervisedWorkflowRunId,
} from '@deepseek-ai/dsh-api-remotes/client'

/** Current list-baseline lifecycle for one session. */
export interface WorkflowRunsSourceSnapshot {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error' | 'reconnecting'
  readonly runs: readonly WorkflowRunHead[]
  readonly error?: string
  readonly nextCursor?: WorkflowRunCursor
  readonly total: number
}

/**
 * Minimal business face consumed by the dashboard. The runtime controller can
 * implement it directly; keeping the face here lets component tests provide a
 * deterministic source without mounting transport or Cordis.
 */
export interface WorkflowRunsOperations {
  /** Switch the stable dashboard source to one Session, or release it. */
  observe(sessionId: SessionId | undefined): void
  /** Refresh the first bounded page for one session. */
  refresh(sessionId: SessionId): Promise<void>
  /** Append the next retained run page, when the source advertises one. */
  loadMore(sessionId: SessionId): Promise<void>
  /** Load selected-run metadata. */
  detail(sessionId: SessionId, runId: SupervisedWorkflowRunId, signal?: AbortSignal): Promise<WorkflowRunDetail>
  /** Load a bounded member page. */
  members(
    sessionId: SessionId,
    runId: SupervisedWorkflowRunId,
    cursor?: WorkflowRunCursor,
    signal?: AbortSignal,
  ): Promise<WorkflowRunMemberPage>
  /** Load one member and its committed script-visible outcome. */
  memberDetail(
    sessionId: SessionId,
    runId: SupervisedWorkflowRunId,
    memberId: WorkflowMemberId,
    signal?: AbortSignal,
  ): Promise<WorkflowRunMemberDetail>
  /** Load a bounded log page. */
  logs(
    sessionId: SessionId,
    runId: SupervisedWorkflowRunId,
    cursor?: WorkflowRunCursor,
    signal?: AbortSignal,
  ): Promise<WorkflowRunLogPage>
  /** Load the bounded final result view. */
  result(sessionId: SessionId, runId: SupervisedWorkflowRunId, signal?: AbortSignal): Promise<WorkflowRunResultView>
  /** Load a bounded scratch-artifact page. */
  artifacts(
    sessionId: SessionId,
    runId: SupervisedWorkflowRunId,
    cursor?: WorkflowRunCursor,
    signal?: AbortSignal,
  ): Promise<WorkflowRunArtifactPage>
  /** Load one selected scratch artifact's bounded text. */
  artifact(
    sessionId: SessionId,
    runId: SupervisedWorkflowRunId,
    name: string,
    cursor?: WorkflowRunCursor,
    expectedRevision?: number,
    signal?: AbortSignal,
  ): Promise<WorkflowRunArtifactChunk>
  /** Execute one revision-checked human control. */
  control(
    sessionId: SessionId,
    runId: SupervisedWorkflowRunId,
    action: WorkflowRunAction,
    expectedRevision?: number,
    signal?: AbortSignal,
  ): Promise<WorkflowRunControlResult>
  /** Resolve a direct child through the catalog and open its conversation. */
  resolveAndOpenChild(parentSessionId: SessionId, childSessionId: SessionId): Promise<boolean>
}
