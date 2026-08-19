import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { workflowRunValueView } from '../src/value-view.ts'

describe('workflowRunValueView', () => {
  it.each<JsonValue>([
    null,
    'done',
    { findings: [{ file: 'a.ts', real: true }] },
  ])('returns a detached complete JSON value including %j', (value) => {
    const view = workflowRunValueView(value, 1_024)
    expect(view).toMatchObject({
      state: 'available',
      content: { kind: 'value', value },
      truncated: false,
    })
    expect(view.totalBytes).toBe(new TextEncoder().encode(JSON.stringify(value, null, 2)).byteLength)
    if (typeof value === 'object' && value !== null) {
      expect((view.content as { value: JsonValue }).value).not.toBe(value)
    }
  })

  it('returns a UTF-8-safe serialized preview with the complete byte count', () => {
    const value = { report: '😀😀😀' }
    const serialized = JSON.stringify(value, null, 2)
    const view = workflowRunValueView(value, 18)
    expect(view).toEqual({
      state: 'available',
      content: { kind: 'preview', text: '{\n  "report": "' },
      totalBytes: new TextEncoder().encode(serialized).byteLength,
      truncated: true,
    })
    expect(view.content.kind === 'preview' && view.content.text).not.toContain('\ufffd')
  })

  it('keeps hostile object keys as detached data properties', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true}}') as JsonValue
    const view = workflowRunValueView(value, 1_024)
    expect(view.truncated).toBe(false)
    if (view.content.kind !== 'value') throw new Error('expected complete value')
    expect(Object.getOwnPropertyDescriptor(view.content.value as object, '__proto__')?.value)
      .toEqual({ polluted: true })
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid byte cap %s',
    (maxBytes) => {
      expect(() => workflowRunValueView(null, maxBytes)).toThrow(/positive safe integer/)
    },
  )

  it('rejects a runtime value outside the declared JSON type', () => {
    expect(() => workflowRunValueView(undefined as never, 32))
      .toThrow(/not losslessly JSON-serializable/)
  })
})
