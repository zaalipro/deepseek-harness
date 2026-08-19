/**
 * Workflow definition-registry vocabulary: the saved-workflow scope tags,
 * summary and full-definition shapes, and lookup options. Types only.
 *
 * @module @deepseek-ai/dsh-workflow-registry/types
 */

import type { WorkflowMeta, WorkflowPhase } from '@deepseek-ai/dsh-workflow/types'

/** Which discovery root supplied a saved workflow definition. */
export type WorkflowScope = 'bundled' | 'project' | 'user'

/** Discovery-root precedence: the first scope containing a name wins. */
export const WORKFLOW_SCOPE_PRECEDENCE: readonly WorkflowScope[] = ['bundled', 'project', 'user']

/** Browser-safe saved-definition metadata returned by the workflowDefinitions Remote. */
export interface WorkflowDefinitionSummaryView {
  /** Kebab-case discovery key, equal to `meta.name`. */
  readonly name: string
  /** One-line description of what the workflow does. */
  readonly description: string
  /** Optional guidance on when this workflow applies. */
  readonly whenToUse?: string
  /** Which discovery root supplied this definition. */
  readonly scope: WorkflowScope
}

/** Invocation-neutral Host listing metadata for one saved workflow definition. */
export interface WorkflowDefinitionSummary extends WorkflowDefinitionSummaryView {
  /** Optional phase declarations matched by `phase()` calls. */
  readonly phases?: readonly WorkflowPhase[]
  /** Absolute path of the discovered `.workflow.json` file. */
  readonly path: string
}

/** One full saved workflow definition: listing metadata plus the script body. */
export interface WorkflowDefinition extends WorkflowDefinitionSummary {
  /** The plain-JS script body (top-level await allowed; `complete(value)` or `return`). */
  readonly script: string
}

/** Caller context for cwd-sensitive and abortable registry reads. */
export interface WorkflowLookupOptions {
  /** Workspace selector: the project root is the nearest ancestor with a `.git`. */
  readonly cwd?: string
  /** Abort discovery for the current caller. */
  readonly signal?: AbortSignal
}

/** Writable definition scopes; bundled definitions are immutable. */
export type WorkflowSaveScope = Exclude<WorkflowScope, 'bundled'>

/** One validated envelope candidate supplied to {@code WorkflowRegistry.save}. */
export interface WorkflowDefinitionEnvelope {
  /** Plain metadata beside the script body. */
  readonly meta: WorkflowMeta
  /** Plain-JavaScript workflow body. */
  readonly script: string
}

/** Workspace, scope, and cancellation for an atomic definition save. */
export interface WorkflowSaveOptions extends WorkflowLookupOptions {
  /** Destination definition scope. */
  readonly scope: WorkflowSaveScope
}

/** One catalog observation plus whether discovery completed within a stable revision. */
export interface WorkflowCatalogSnapshot {
  /** Sorted invocation-neutral summaries collected in this observation. */
  readonly definitions: readonly WorkflowDefinitionSummary[]
  /** Whether every root completed without a concurrent catalog revision. */
  readonly complete: boolean
}
