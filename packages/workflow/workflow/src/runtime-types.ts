/**
 * Host-only workflow request and live-run handles. The browser-safe durable
 * vocabulary remains in `./types` so Client programs never import Agent or
 * host Cordis context declarations.
 *
 * @module @deepseek-ai/dsh-workflow
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type {
  WorkflowMeta, WorkflowResult, WorkflowRunId,
} from './types.ts'

/** Fields shared by every committed host call replayed on same-process resume. */
interface WorkflowJournalBase {
  /** Consecutive commit-publication position in the logical run's journal. */
  readonly ordinal: number
  /** Deterministic call identity derived from nested combinator and item positions. */
  readonly callId: string
  /** SHA-256 of the call kind plus its effective arguments. */
  readonly fingerprint: string
}

/**
 * One committed host call replayed on a same-process resume. Result-producing
 * calls return their retained value; committed effects are suppressed; phase
 * replay still restores the worker's current phase without emitting duplicate
 * observer narration.
 */
export type WorkflowJournalEntry = WorkflowJournalBase & (
  | {
    /** A settled `agent()` call. */
    readonly kind: 'agent'
    /** Monotonic member sequence assigned to the original launched child. */
    readonly seq: number
    /** The committed script-visible result (text, structured object, or `null` for a failed child). */
    readonly result: JsonValue
  }
  | {
    /** A committed `phase()` observer effect. */
    readonly kind: 'phase'
    /** The phase title restored on replay and emitted only on the first attempt. */
    readonly title: string
  }
  | {
    /** A committed `log()` observer effect. */
    readonly kind: 'log'
    /** The log line emitted only on the first attempt. */
    readonly message: string
  }
  | {
    /** A committed `read_scratch_file()` result. */
    readonly kind: 'scratch-read'
    /** File content; absent means the file did not exist. */
    readonly content?: string
  }
  | {
    /** A committed `write_scratch_file()` effect. */
    readonly kind: 'scratch-write'
  }
  | {
    /** A satisfied `await_user()` gate that must not re-fire on a later journal resume. */
    readonly kind: 'await-user'
  }
)

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
  /** Cumulative agent budget already spent by earlier attempts of the same logical run. */
  initialAgentSpend?: number
  /** Highest member sequence issued by earlier attempts; keeps retry members distinct. */
  initialAgentSeq?: number
  /** Committed host calls to replay instead of repeating results or effects; omitted for a fresh start. */
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
