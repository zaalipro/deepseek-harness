/**
 * Bounded JSON-value projection for workflow run and member inspectors.
 * @module @deepseek-ai/dsh-workflow-supervisor/value-view
 */

import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type { WorkflowRunAvailableValue } from './types.ts'

const encoder = new TextEncoder()

/**
 * Detach one committed JSON value and keep either the complete value or a
 * UTF-8-safe prefix of its formatted JSON representation.
 * @param value - committed workflow value at the worker boundary.
 * @param maxBytes - positive UTF-8 byte ceiling for an inspector response.
 * @returns a complete value or an explicitly truncated serialized preview.
 */
export function workflowRunValueView(
  value: JsonValue,
  maxBytes: number,
): WorkflowRunAvailableValue {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('workflow member outcome maxBytes must be a positive safe integer')
  }
  const snapshot = snapshotJsonValue<JsonValue>(value)
  if (snapshot === undefined) {
    throw new Error('workflow member outcome is not losslessly JSON-serializable')
  }
  const serialized = JSON.stringify(snapshot, null, 2)
  const totalBytes = encoder.encode(serialized).byteLength
  if (totalBytes <= maxBytes) {
    return {
      state: 'available',
      content: { kind: 'value', value: snapshot },
      totalBytes,
      truncated: false,
    }
  }
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(serialized)
  const preview = retainer.finish()
  return {
    state: 'available',
    content: { kind: 'preview', text: preview.text },
    totalBytes,
    truncated: true,
  }
}
