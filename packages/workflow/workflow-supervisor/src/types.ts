/**
 * Browser-safe workflow-run supervisor vocabulary: the run status union, the
 * dashboard wire view, and the launch/control inputs. Types only.
 *
 * @module @deepseek-ai/dsh-workflow-supervisor/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkflowGateInfo, WorkflowPhase } from '@deepseek-ai/dsh-workflow/types'
import type { WorkflowScope } from '@deepseek-ai/dsh-workflow-registry/types'

export type { WorkflowPhase } from '@deepseek-ai/dsh-workflow/types'

/** Stable identity of one logical supervised run across engine attempts. */
export type SupervisedWorkflowRunId = Branded<'SupervisedWorkflowRunId'>

/** Stable identity of one actual child launch within a logical run. */
export type WorkflowMemberId = Branded<'WorkflowMemberId'>

/** Stable identity of one human-input gate occurrence. */
export type WorkflowGateId = Branded<'WorkflowGateId'>

/** Immutable logical-run identity included with durable lifecycle events. */
export interface SupervisedWorkflowRunInfo {
  readonly id: SupervisedWorkflowRunId
  readonly displayName: string
  readonly name: string
}

/** Terminal reason for one logical supervised run. */
export type SupervisedWorkflowStopReason =
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'interrupted'

/** Terminal logical-run facts that exclude the potentially large result value. */
export interface SupervisedWorkflowResultInfo {
  readonly stopReason: SupervisedWorkflowStopReason
  readonly error?: string
  readonly agentsStarted: number
}

/** Opaque cursor for one bounded workflow-run page. */
export type WorkflowRunCursor = Branded<'WorkflowRunCursor'>

/** Process-local epoch fencing a list baseline from another supervisor instance. */
export type WorkflowRunFeedEpoch = Branded<'WorkflowRunFeedEpoch'>

/** Dashboard lifecycle status for one supervised run. */
export type WorkflowRunStatus =
  | 'running'
  | 'pausing'
  | 'stopping'
  | 'needs-input'
  | 'paused'
  | 'budget-limited'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** Human control accepted by the workflow-run Remote. */
export type WorkflowRunAction = 'pause' | 'resume' | 'stop' | 'save'

/** Why one member's script-visible result can or cannot be inspected. */
export type WorkflowRunOutcomeState = 'pending' | 'available' | 'not-produced' | 'evicted'

/** Bounded counts kept in a run-list row instead of the complete member roster. */
export interface WorkflowRunMemberCounts {
  readonly total: number
  readonly running: number
  readonly completed: number
  readonly failed: number
  readonly cancelled: number
}

/** One bounded run row used by list responses and change notifications. */
export interface WorkflowRunHead {
  readonly runId: SupervisedWorkflowRunId
  readonly displayName: string
  readonly name: string
  readonly description: string
  readonly status: WorkflowRunStatus
  readonly phase?: string
  readonly budget: { readonly total: number; readonly spent: number; readonly remaining: number }
  readonly memberCounts: WorkflowRunMemberCounts
  readonly startedAt: number
  readonly settledAt?: number
  readonly allowedActions: readonly WorkflowRunAction[]
  /** Compare-and-set token for controls and cache invalidation. */
  readonly revision: number
  readonly detailRevision: number
  readonly membersRevision: number
  readonly logsRevision: number
  readonly resultRevision: number
  readonly artifactsRevision: number
}

/** Bounded page of run-list rows for one exact Session. */
export interface WorkflowRunListPage {
  readonly epoch: WorkflowRunFeedEpoch
  readonly sessionRevision: number
  readonly items: readonly WorkflowRunHead[]
  readonly nextCursor?: WorkflowRunCursor
  readonly total: number
}

/** Request for a bounded run-list page. */
export interface WorkflowRunListRequest {
  readonly cursor?: WorkflowRunCursor
  readonly limit?: number
}

/** Run metadata loaded only after the user selects a list row. */
export interface WorkflowRunDetail {
  readonly run: WorkflowRunHead
  readonly phases?: readonly WorkflowPhase[]
  readonly gate?: WorkflowGateInfo
  readonly error?: string
  readonly scriptPath?: string
}

/** Request addressing one run owned by the resolved Agent. */
export interface WorkflowRunRequest {
  readonly runId: SupervisedWorkflowRunId
}

/** One member summary; the script-visible result remains on-demand. */
export interface WorkflowRunMemberHead {
  readonly memberId: WorkflowMemberId
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly startedAt?: number
  readonly settledAt?: number
  readonly outcome: WorkflowRunOutcomeState
}

/** Member lifecycle payload emitted only to the owning process. */
export interface SupervisedWorkflowMemberLifecycleInfo extends WorkflowRunMemberHead {
  /** Direct child Session that executed this logical workflow call. */
  readonly childSessionId: SessionId
}

/** Bounded page of one run's member summaries. */
export interface WorkflowRunMemberPage {
  readonly items: readonly WorkflowRunMemberHead[]
  readonly nextCursor?: WorkflowRunCursor
  readonly total: number
  readonly revision: number
}

/** Request for a bounded member page. */
export interface WorkflowRunMembersRequest extends WorkflowRunRequest {
  readonly cursor?: WorkflowRunCursor
  readonly limit?: number
}

/** A complete JSON value or an explicitly truncated serialized preview. */
export type WorkflowRunAvailableValue =
  | {
    readonly state: 'available'
    readonly content: { readonly kind: 'value'; readonly value: JsonValue }
    readonly totalBytes: number
    readonly truncated: false
  }
  | {
    readonly state: 'available'
    readonly content: { readonly kind: 'preview'; readonly text: string }
    readonly totalBytes: number
    readonly truncated: true
  }

/** On-demand script-visible value with absence distinct from JSON `null`. */
export type WorkflowRunValueView =
  | { readonly state: 'pending' }
  | { readonly state: 'not-produced' }
  | { readonly state: 'evicted' }
  | WorkflowRunAvailableValue

/** One selected member's result and durable child-session address. */
export interface WorkflowRunMemberDetail {
  readonly member: WorkflowRunMemberHead
  readonly childSessionId: SessionId
  readonly outcome: WorkflowRunValueView
}

/** Request addressing one logical member of one run. */
export interface WorkflowRunMemberRequest extends WorkflowRunRequest {
  readonly memberId: WorkflowMemberId
}

/** One retained workflow log line. */
export interface WorkflowRunLogLine {
  readonly index: number
  readonly text: string
}

/** Bounded page of retained workflow log lines. */
export interface WorkflowRunLogPage {
  readonly items: readonly WorkflowRunLogLine[]
  readonly nextCursor?: WorkflowRunCursor
  /** Lines removed from the retrievable retention window. */
  readonly evicted: number
  readonly total: number
  readonly revision: number
}

/** Request for a bounded workflow log page. */
export interface WorkflowRunLogsRequest extends WorkflowRunRequest {
  readonly cursor?: WorkflowRunCursor
  readonly limit?: number
}

/** Result response loaded independently from run-list rows. */
export interface WorkflowRunResultView {
  readonly value: WorkflowRunValueView
  readonly error?: string
  readonly revision: number
}

/** One scratch artifact discoverable without reading its contents. */
export interface WorkflowRunArtifactView {
  readonly name: string
  readonly bytes: number
}

/** One UTF-8-safe content page of a selected scratch artifact. */
export interface WorkflowRunArtifactChunk {
  readonly artifact: WorkflowRunArtifactView
  readonly text: string
  readonly offsetBytes: number
  readonly returnedBytes: number
  readonly totalBytes: number
  readonly revision: number
  readonly nextCursor?: WorkflowRunCursor
}

/** Bounded page of one run's scratch artifacts. */
export interface WorkflowRunArtifactPage {
  readonly items: readonly WorkflowRunArtifactView[]
  readonly nextCursor?: WorkflowRunCursor
  /** Regular files excluded from the retrievable metadata roster. */
  readonly omitted: number
  readonly total: number
  readonly revision: number
}

/** Request for a bounded scratch-artifact page. */
export interface WorkflowRunArtifactsRequest extends WorkflowRunRequest {
  readonly cursor?: WorkflowRunCursor
  readonly limit?: number
}

/** Request addressing one single-component scratch artifact. */
export interface WorkflowRunArtifactRequest extends WorkflowRunRequest {
  readonly name: string
  readonly cursor?: WorkflowRunCursor
  readonly maxBytes?: number
  readonly expectedRevision?: number
}

/** Compare-and-set dashboard control request. */
export interface WorkflowRunControlRequest extends WorkflowRunRequest {
  readonly action: WorkflowRunAction
  readonly expectedRevision?: number
}

/** Authoritative row returned after one dashboard control settles. */
export interface WorkflowRunControlResult {
  readonly run: WorkflowRunHead
}

/** One bounded incremental change forwarded to browser controllers. */
export type WorkflowRunChange =
  | {
    /** The carrier dropped per-Session changes and every baseline is stale. */
    readonly kind: 'invalidate-all'
  }
  | {
    readonly kind: 'upsert'
    readonly sessionId: SessionId
    readonly epoch: WorkflowRunFeedEpoch
    readonly sessionRevision: number
    readonly head: WorkflowRunHead
  }
  | {
    readonly kind: 'remove'
    readonly sessionId: SessionId
    readonly epoch: WorkflowRunFeedEpoch
    readonly sessionRevision: number
    readonly runId: SupervisedWorkflowRunId
  }
  | {
    readonly kind: 'invalidate'
    readonly sessionId: SessionId
    readonly epoch: WorkflowRunFeedEpoch
    readonly sessionRevision: number
  }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One bounded supervisor change for one owning Session.
     * @mode emit
     * @param change - revisioned row update, removal, or baseline invalidation.
     */
    'workflows/run-change'(change: WorkflowRunChange): void
  }
}

/** A successful launch result keyed by the display handle (never an internal id). */
export interface WorkflowLaunched {
  readonly displayName: string
  readonly runId: SupervisedWorkflowRunId
  readonly scriptPath?: string
  readonly status: 'started'
}

/** A validate-only smoke-check outcome. */
export type WorkflowValidation =
  | { readonly ok: true; readonly result?: unknown }
  | { readonly ok: false; readonly error: string }

/** Which scope a save writes into. */
export type WorkflowSaveScope = Extract<WorkflowScope, 'project' | 'user'>
