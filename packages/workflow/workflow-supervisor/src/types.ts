/**
 * Browser-safe workflow-run supervisor vocabulary: the run status union, the
 * dashboard wire view, and the launch/control inputs. Types only.
 *
 * @module @deepseek-ai/dsh-workflow-supervisor/types
 */

import type { WorkflowGateInfo, WorkflowPhase, WorkflowRunId } from '@deepseek-ai/dsh-workflow/types'
import type { WorkflowScope } from '@deepseek-ai/dsh-workflow-registry/types'

/** Dashboard lifecycle status for one supervised run. */
export type WorkflowRunStatus =
  | 'running'
  | 'needs-input'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** One live member row on the dashboard roster. */
export interface WorkflowRunMemberView {
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
}

/** The wire view of one supervised run (all plain JSON). */
export interface WorkflowRunView {
  /** Internal run id (model-facing resume key; never displayed in command UX). */
  readonly runId: WorkflowRunId
  /** Session-unique display handle humans pass to pause/resume/stop/save. */
  readonly displayName: string
  /** The definition name (`meta.name`); a numbered handle keeps its base name here. */
  readonly name: string
  readonly description: string
  readonly status: WorkflowRunStatus
  /** The live phase title (`phase()` calls); a typo only desyncs the rail. */
  readonly phase?: string
  /** Declared phase rail from `meta.phases`. */
  readonly phases?: readonly WorkflowPhase[]
  readonly budget: { readonly total: number; readonly spent: number; readonly remaining: number }
  readonly members: readonly WorkflowRunMemberView[]
  readonly logs: readonly string[]
  readonly result?: unknown
  readonly error?: string
  readonly gate?: WorkflowGateInfo
  /** Supplied by a bundled/built-in scope; Save is hidden for these. */
  readonly builtin: boolean
  /** A numbered duplicate handle (`review-changes-2`); Save is hidden for these. */
  readonly numberedHandle: boolean
  readonly scriptPath?: string
  readonly startedAt: number
  readonly settledAt?: number
}

/** A successful launch result keyed by the display handle (never an internal id). */
export interface WorkflowLaunched {
  readonly displayName: string
  readonly runId: WorkflowRunId
  readonly scriptPath?: string
  readonly status: 'started'
}

/** A validate-only smoke-check outcome. */
export type WorkflowValidation =
  | { readonly ok: true; readonly result?: unknown }
  | { readonly ok: false; readonly error: string }

/** Which scope a save writes into. */
export type WorkflowSaveScope = Extract<WorkflowScope, 'project' | 'user'>
