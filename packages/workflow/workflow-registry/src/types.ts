/**
 * Workflow definition-registry vocabulary: the saved-workflow scope tags,
 * summary and full-definition shapes, and lookup options. Types only.
 *
 * @module @deepseek-ai/dsh-workflow-registry/types
 */

import type { WorkflowPhase } from '@deepseek-ai/dsh-workflow/types'

/** Which discovery root supplied a saved workflow definition. */
export type WorkflowScope = 'bundled' | 'project' | 'user'

/** Discovery-root precedence: the first scope containing a name wins. */
export const WORKFLOW_SCOPE_PRECEDENCE: readonly WorkflowScope[] = ['bundled', 'project', 'user']

/** Discovery key for one saved workflow: kebab-case, no leading or trailing hyphen. */
export const WORKFLOW_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Whether a string is a valid saved-workflow name.
 * @param name - candidate workflow name to validate.
 * @returns whether the name matches the public workflow-name grammar.
 */
export function isWorkflowName(name: string): boolean {
  return WORKFLOW_NAME.test(name)
}

/** Invocation-neutral listing metadata for one saved workflow definition. */
export interface WorkflowDefinitionSummary {
  /** Kebab-case discovery key, equal to `meta.name`. */
  readonly name: string
  /** One-line description of what the workflow does. */
  readonly description: string
  /** Optional guidance on when this workflow applies (listing-only). */
  readonly whenToUse?: string
  /** Optional phase declarations matched by `phase()` calls. */
  readonly phases?: readonly WorkflowPhase[]
  /** Which discovery root supplied this definition. */
  readonly scope: WorkflowScope
  /** Absolute path of the `.workflow.json` file, when the scope has one. */
  readonly path?: string
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

/** One catalog observation plus whether discovery completed within a stable revision. */
export interface WorkflowCatalogSnapshot {
  /** Sorted invocation-neutral summaries collected in this observation. */
  readonly definitions: readonly WorkflowDefinitionSummary[]
  /** Whether every root completed without a concurrent catalog revision. */
  readonly complete: boolean
}
