/**
 * Browser-safe durable event payloads for Session-attributed workflow runs.
 *
 * The `tool-workflow/*` event names remain the durable Session vocabulary used
 * by the existing Chat projection, but both human commands and root workflow
 * tool calls may create the record.
 *
 * @module @deepseek-ai/dsh-workflow-run-recorder/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  SupervisedWorkflowRunId,
  SupervisedWorkflowStopReason,
  WorkflowRunMemberHead,
} from '@deepseek-ai/dsh-workflow-supervisor/types'

/** Terminal member outcome carried by one logical member-end event. */
export type WorkflowRunRecordAgentOutcome = Exclude<WorkflowRunMemberHead['status'], 'running'>

/** Opens one durable top-level workflow run record. */
export interface WorkflowRunRecordStartData {
  readonly runId: SupervisedWorkflowRunId
  readonly name: string
}

/** Records one workflow member after its child Session is published. */
export interface WorkflowRunRecordAgentStartData {
  readonly runId: SupervisedWorkflowRunId
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly childId: SessionId
}

/** Settles one previously started workflow member. */
export interface WorkflowRunRecordAgentEndData {
  readonly runId: SupervisedWorkflowRunId
  readonly seq: number
  readonly outcome: WorkflowRunRecordAgentOutcome
}

/** Settles one workflow run after its live resources reach quiescence. */
export interface WorkflowRunRecordEndData {
  readonly runId: SupervisedWorkflowRunId
  readonly stopReason: SupervisedWorkflowStopReason
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one top-level workflow record.
     * @param data - stable run identity and display name.
     */
    'tool-workflow/run-start': WorkflowRunRecordStartData
    /**
     * Records one published workflow member.
     * @param data - logical run identity, member sequence, display identity, and child Session.
     */
    'tool-workflow/agent-start': WorkflowRunRecordAgentStartData
    /**
     * Records one member settlement.
     * @param data - logical run identity, paired member sequence, and terminal outcome.
     */
    'tool-workflow/agent-end': WorkflowRunRecordAgentEndData
    /**
     * Closes one workflow record after cleanup.
     * @param data - stable run identity and terminal reason.
     */
    'tool-workflow/run-end': WorkflowRunRecordEndData
  }
}
