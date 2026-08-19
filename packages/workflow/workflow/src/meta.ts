/**
 * Meta validation checks caller-provided DATA against the {@link WorkflowMeta}
 * contract and rejects every violation by name. Meta arrives as schema-checked
 * JSON data, never evaluated script text; evaluating it on the host could run getters outside the
 * worker timeout that exists to isolate model-written code.
 * @module @deepseek-ai/dsh-workflow/meta
 */

import { WorkflowError } from './error.ts'
import type { WorkflowMeta, WorkflowPhase } from './types.ts'

/** Maximum number of UTF-16 code units in a workflow persistence key. */
export const WORKFLOW_NAME_MAX_LENGTH = 64

/** Maximum definition-name length plus `-` and a safe-integer launch ordinal. */
export const WORKFLOW_DISPLAY_NAME_MAX_LENGTH = WORKFLOW_NAME_MAX_LENGTH + 1 + String(Number.MAX_SAFE_INTEGER).length

/** Names owned by `/workflow` control verbs rather than saved definitions. */
const RESERVED_WORKFLOW_NAMES = new Set(['pause', 'resume', 'save', 'stop', 'workflows'])

/** Windows device basenames remain special even when a file has an extension. */
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u

/** Saved workflow keys start with a letter and otherwise use lowercase kebab-case. */
const WORKFLOW_NAME_PATTERN = /^[a-z](?:[a-z0-9]*)(?:-[a-z0-9]+)*$/u

/** `-N` with N >= 2 can identify a session-unique duplicate launch handle. */
const DISPLAY_ORDINAL_SUFFIX = /^(.*)-((?:[2-9]|[1-9][0-9]+))$/u

/**
 * Whether a string can safely serve as a workflow definition key, slash alias,
 * display-name base, and cross-platform filename stem.
 * @param name - candidate workflow name.
 * @returns whether the candidate satisfies the shared workflow-name rules.
 */
export function isWorkflowName(name: string): boolean {
  return name.length >= 1
    && name.length <= WORKFLOW_NAME_MAX_LENGTH
    && WORKFLOW_NAME_PATTERN.test(name)
    && !RESERVED_WORKFLOW_NAMES.has(name)
    && !WINDOWS_RESERVED_BASENAME.test(name)
}

/**
 * Whether a string is a definition name or a generated duplicate display
 * handle whose ordinal is a safe integer.
 * @param name - candidate human-facing run handle.
 * @returns whether commands may address the handle.
 */
export function isWorkflowDisplayName(name: string): boolean {
  if (name.length > WORKFLOW_DISPLAY_NAME_MAX_LENGTH) return false
  if (isWorkflowName(name)) return true
  const match = DISPLAY_ORDINAL_SUFFIX.exec(name)
  if (match === null) return false
  const base = match[1]
  const ordinal = match[2]
  return base !== undefined && ordinal !== undefined
    && isWorkflowName(base)
    && Number.isSafeInteger(Number(ordinal))
}

/** Collect shape violations for a meta value (plain JSON data by the seam contract). */
function validateMetaShape(meta: unknown): { meta?: WorkflowMeta; violations: string[] } {
  const violations: string[] = []
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { violations: ['meta must be an object'] }
  }
  const record = meta as Record<string, unknown>
  const known = new Set(['name', 'description', 'whenToUse', 'phases'])
  for (const key of Object.keys(record)) {
    if (!known.has(key)) violations.push(`meta.${key} is not a recognized field (name/description/whenToUse/phases)`)
  }
  if (typeof record.name !== 'string' || !isWorkflowName(record.name)) {
    violations.push(`meta.name must be 1-${WORKFLOW_NAME_MAX_LENGTH} characters, start with a lowercase letter, use only lowercase kebab-case, and not be a reserved command or Windows filename`)
  }
  if (typeof record.description !== 'string' || record.description.length === 0) violations.push('meta.description must be a non-empty string')
  if (record.whenToUse !== undefined && typeof record.whenToUse !== 'string') violations.push('meta.whenToUse must be a string')
  const phases: WorkflowPhase[] = []
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) {
      violations.push('meta.phases must be an array')
    } else {
      record.phases.forEach((phase, index) => {
        if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
          violations.push(`meta.phases[${index}] must be an object`)
          return
        }
        const entry = phase as Record<string, unknown>
        for (const key of Object.keys(entry)) {
          if (!['title', 'detail', 'provider', 'model'].includes(key)) violations.push(`meta.phases[${index}].${key} is not a recognized field`)
        }
        if (typeof entry.title !== 'string' || entry.title.length === 0) violations.push(`meta.phases[${index}].title must be a non-empty string`)
        if (entry.detail !== undefined && typeof entry.detail !== 'string') violations.push(`meta.phases[${index}].detail must be a string`)
        if (entry.provider !== undefined && typeof entry.provider !== 'string') violations.push(`meta.phases[${index}].provider must be a string`)
        if (entry.model !== undefined && typeof entry.model !== 'string') violations.push(`meta.phases[${index}].model must be a string`)
        if (violations.length === 0) {
          phases.push({
            title: entry.title as string,
            ...entry.detail !== undefined ? { detail: entry.detail as string } : {},
            ...entry.provider !== undefined ? { provider: entry.provider as string } : {},
            ...entry.model !== undefined ? { model: entry.model as string } : {},
          })
        }
      })
    }
  }
  if (violations.length > 0) return { violations }
  return {
    violations,
    meta: {
      name: record.name as string,
      description: record.description as string,
      ...record.whenToUse !== undefined ? { whenToUse: record.whenToUse as string } : {},
      ...record.phases !== undefined ? { phases } : {},
    },
  }
}

/**
 * Validate a caller-provided meta value against the {@link WorkflowMeta}
 * contract. Throws `META_INVALID` naming every violation (unknown fields,
 * missing/mistyped `name`/`description`, malformed `phases`); the returned
 * meta is a NORMALIZED copy built from the validated fields, so the engine
 * never aliases the caller's object.
 * @param value - the meta data from the start request (plain JSON by the seam contract).
 * @returns the validated, normalized meta block.
 */
export function validateMeta(value: unknown): WorkflowMeta {
  const { meta, violations } = validateMetaShape(value)
  if (meta === undefined) {
    throw new WorkflowError(`invalid meta: ${violations.join('; ')}`, 'META_INVALID')
  }
  return meta
}
