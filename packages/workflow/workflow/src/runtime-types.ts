/**
 * Host-only workflow request and live-run handles. The browser-safe durable
 * vocabulary remains in `./types` so Client programs never import Agent or
 * host Cordis context declarations.
 *
 * @module @deepseek-ai/dsh-workflow
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  WorkflowMeta, WorkflowResult, WorkflowRunId,
} from './types.ts'

/**
 * One committed host-call result replayed on a same-process resume. Control
 * flow must derive from `args` + host results, so the 1-based call sequence
 * identifies every replayed call deterministically across re-executions.
 */
export interface WorkflowJournalEntry {
  /** 1-based `agent()` call sequence; a replayed call returns this result without launching a child. */
  readonly seq: number
  /** The committed script-visible result (text, structured object, or `null` for a failed child). */
  readonly result: unknown
}

/**
 * What a caller asks for when starting a workflow run. `meta` and `args` are
 * plain JSON data by the seam contract. `parent` is required because every
 * `agent()` spawned by the script is attributed to that live Agent.
 */
export interface WorkflowStartRequest {
  /** The plain-JS script body (top-level await allowed; ends with `return <json-value>`). */
  script: string
  /** The workflow's identity block, as plain JSON data (shape-validated by the engine). */
  meta: WorkflowMeta
  /** Optional input exposed verbatim to the script as the `args` global. */
  args?: unknown
  /** Optional engine-wide child-provider override for this run. */
  subagentProvider?: string
  /** Optional per-run total-child ceiling. */
  maxTotalAgents?: number
  /** Committed host-call results to replay instead of relaunching children; omitted for a fresh start. */
  journal?: readonly WorkflowJournalEntry[]
  /** Absolute run directory owning per-run scratch files; omitted when scratch is unavailable. */
  scratchDir?: string
  /** Smoke-check mode: canned `agent()` results, no children, no journal persistence. */
  validateOnly?: boolean
  /** The agent on whose behalf the run executes (parent of every child). */
  parent: Agent
  /** Cancels the run when aborted. */
  signal?: AbortSignal
}

/**
 * Holder-owned live workflow. `result` never rejects; consumers may cancel,
 * resume a parked gate, and must call idempotent `dispose()` to await script
 * and child quiescence.
 */
export interface WorkflowRun {
  readonly id: WorkflowRunId
  /** The validated meta block available before the script body runs. */
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>
  /** Cancel the run and its children. */
  cancel(reason?: string): void
  /** Resume a parked `pause()`/`await_user()` gate; a no-op when not parked. */
  resume(): void
  /** Cancel if needed and await bounded settlement and cleanup. */
  dispose(): Promise<void>
}
