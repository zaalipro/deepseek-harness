import { describe, expect, it } from 'vitest'
import { parseWorkflowCommand } from '../src/index.ts'

describe('parseWorkflowCommand', () => {
  it('parses a bare launch', () => {
    expect(parseWorkflowCommand('review-changes')).toEqual({ kind: 'launch', name: 'review-changes', args: {} })
  })

  it('parses a launch with a JSON object argument', () => {
    expect(parseWorkflowCommand('review-changes {"target":"origin/main...HEAD"}')).toEqual({
      kind: 'launch',
      name: 'review-changes',
      args: { target: 'origin/main...HEAD' },
    })
  })

  it('rejects non-object arguments (wrap arrays/scalars in a field)', () => {
    expect(parseWorkflowCommand('review-changes [1,2]').kind).toBe('malformed')
    expect(parseWorkflowCommand('review-changes 42').kind).toBe('malformed')
    expect(parseWorkflowCommand('review-changes {bad').kind).toBe('malformed')
  })

  it('parses the four control verbs with their display name', () => {
    for (const action of ['pause', 'resume', 'stop', 'save'] as const) {
      expect(parseWorkflowCommand(`${action} review-changes-2`)).toEqual({ kind: 'control', action, displayName: 'review-changes-2' })
    }
  })

  it('accepts a generated handle whose suffix extends a maximum-length definition name', () => {
    const displayName = `${'a'.repeat(64)}-2`
    expect(parseWorkflowCommand(`stop ${displayName}`)).toEqual({
      kind: 'control', action: 'stop', displayName,
    })
  })

  it('rejects missing or trailing control operands', () => {
    expect(parseWorkflowCommand('stop').kind).toBe('malformed')
    expect(parseWorkflowCommand('stop audit typo').kind).toBe('malformed')
  })

  it('rejects invalid and control-reserved definition names', () => {
    expect(parseWorkflowCommand('2-a').kind).toBe('malformed')
    expect(parseWorkflowCommand('pause {}').kind).toBe('malformed')
  })

  it('parses an empty input as an empty launch (popup decoration)', () => {
    expect(parseWorkflowCommand('')).toEqual({ kind: 'empty' })
    expect(parseWorkflowCommand('   ')).toEqual({ kind: 'empty' })
  })
})
