import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WorkflowEngineDefault, {
  isFatalWorkflowError,
  WorkflowError,
  WorkflowRunId,
  WorkflowEngine,
  WORKFLOW_DISPLAY_NAME_MAX_LENGTH,
  isWorkflowDisplayName,
  isWorkflowName,
  validateMeta,
} from '../src/index.ts'
import type { WorkflowRun, WorkflowRunInfo, WorkflowStartRequest } from '../src/index.ts'

/** A minimal concrete subclass exposing the protected emit helper for tests. */
class StubEngine extends WorkflowEngine {
  start(request: WorkflowStartRequest): WorkflowRun {
    void request
    throw new Error('not under test')
  }

  emit(name: Parameters<WorkflowEngine['emitWorkflowEvent']>[0], ...args: unknown[]): void {
    this.emitWorkflowEvent(name, ...args)
  }
}

const INFO: WorkflowRunInfo = { id: WorkflowRunId('run-1'), meta: { name: 'w', description: 'd' } }

describe('dsh-workflow (interface)', () => {
  it('WorkflowRunId brands a string (identity at runtime)', () => {
    expect(WorkflowRunId('abc')).toBe('abc')
  })

  it('uses one cross-platform workflow-name grammar at engine admission', () => {
    expect(isWorkflowName('review-changes')).toBe(true)
    for (const name of ['', '2-review', 'pause', 'workflows', 'con', '../outside', 'Review', `a${'b'.repeat(64)}`]) {
      expect(isWorkflowName(name)).toBe(false)
      expect(() => validateMeta({ name, description: 'd' })).toThrow(/meta\.name/)
    }
    expect(isWorkflowName('review-2')).toBe(true)
    expect(isWorkflowDisplayName('review')).toBe(true)
    expect(isWorkflowDisplayName('review-changes-2')).toBe(true)
    expect(isWorkflowDisplayName('not a handle')).toBe(false)
    expect(isWorkflowDisplayName('2-review-2')).toBe(false)
    expect(isWorkflowDisplayName(`${'a'.repeat(64)}-${Number.MAX_SAFE_INTEGER}`)).toBe(true)
    expect(isWorkflowDisplayName(`${'a'.repeat(64)}-9007199254740992`)).toBe(false)
    expect(isWorkflowDisplayName('x'.repeat(WORKFLOW_DISPLAY_NAME_MAX_LENGTH + 1))).toBe(false)
  })

  it('validates and normalizes complete and minimal workflow metadata', () => {
    const minimal = { name: 'review', description: 'Review a change' }
    const normalizedMinimal = validateMeta(minimal)
    expect(normalizedMinimal).toEqual(minimal)
    expect(normalizedMinimal).not.toBe(minimal)

    const complete = {
      name: 'review-changes',
      description: 'Review a change',
      whenToUse: 'Before merge',
      phases: [
        { title: 'Review' },
        {
          title: 'Verify',
          detail: 'Challenge every finding',
          provider: 'local',
          model: 'reviewer',
        },
      ],
    }
    const normalizedComplete = validateMeta(complete)
    expect(normalizedComplete).toEqual(complete)
    expect(normalizedComplete).not.toBe(complete)
    expect(normalizedComplete.phases).not.toBe(complete.phases)
    expect(normalizedComplete.phases?.[1]).not.toBe(complete.phases[1])
  })

  it('reports every malformed workflow metadata field', () => {
    const invalidValues: Array<[unknown, RegExp]> = [
      [undefined, /meta must be an object/],
      [null, /meta must be an object/],
      [[], /meta must be an object/],
      [{ name: 1, description: 'd' }, /meta\.name/],
      [{ name: 'review', description: 1 }, /meta\.description/],
      [{ name: 'review', description: '' }, /meta\.description/],
      [{ name: 'review', description: 'd', whenToUse: 1 }, /meta\.whenToUse/],
      [{ name: 'review', description: 'd', extra: true }, /meta\.extra/],
      [{ name: 'review', description: 'd', phases: 'Review' }, /meta\.phases must be an array/],
      [{ name: 'review', description: 'd', phases: [1] }, /meta\.phases\[0\] must be an object/],
      [{ name: 'review', description: 'd', phases: [null] }, /meta\.phases\[0\] must be an object/],
      [{ name: 'review', description: 'd', phases: [[]] }, /meta\.phases\[0\] must be an object/],
      [{ name: 'review', description: 'd', phases: [{ title: 1 }] }, /meta\.phases\[0\]\.title/],
      [{ name: 'review', description: 'd', phases: [{ title: '' }] }, /meta\.phases\[0\]\.title/],
      [{ name: 'review', description: 'd', phases: [{ title: 'Review', extra: true }] }, /meta\.phases\[0\]\.extra/],
      [{ name: 'review', description: 'd', phases: [{ title: 'Review', detail: 1 }] }, /meta\.phases\[0\]\.detail/],
      [{ name: 'review', description: 'd', phases: [{ title: 'Review', provider: 1 }] }, /meta\.phases\[0\]\.provider/],
      [{ name: 'review', description: 'd', phases: [{ title: 'Review', model: 1 }] }, /meta\.phases\[0\]\.model/],
    ]

    for (const [value, message] of invalidValues) {
      expect(() => validateMeta(value)).toThrow(message)
    }
  })

  it('WorkflowError carries code + fatal (default true) and reads as a HarnessError', () => {
    const error = new WorkflowError('cap hit', 'AGENT_CAP')
    expect(error.code).toBe('AGENT_CAP')
    expect(error.fatal).toBe(true)
    expect(error.name).toBe('WorkflowError')
    const soft = new WorkflowError('advisory', 'ITEM_CAP', { fatal: false })
    expect(soft.fatal).toBe(false)
  })

  it('isFatalWorkflowError: true only for a fatal WorkflowError', () => {
    expect(isFatalWorkflowError(new WorkflowError('x', 'CANCELLED'))).toBe(true)
    expect(isFatalWorkflowError(new WorkflowError('x', 'CANCELLED', { fatal: false }))).toBe(false)
    expect(isFatalWorkflowError(new Error('plain'))).toBe(false)
    expect(isFatalWorkflowError('string')).toBe(false)
  })

  it('registers as ctx.workflowEngine and unregisters when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubEngine)
    expect(ctx.get('workflowEngine')).toBeInstanceOf(StubEngine)
    await fiber.dispose()
    expect(ctx.get('workflowEngine')).toBeUndefined()
  })

  it('emitWorkflowEvent dispatches to every listener with the payload tuple', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const seen: unknown[][] = []
    ctx.on('workflow/log', (info, message) => { seen.push([info, message]) })
    ctx.on('workflow/agent-start', (info, agent) => { seen.push([info, agent]) })
    const engine = ctx.workflowEngine as StubEngine
    engine.emit('workflow/start', INFO)
    engine.emit('workflow/log', INFO, 'hello')
    engine.emit('workflow/agent-start', INFO, { seq: 1, label: 'l', childId: 'c' })
    engine.emit('workflow/agent-end', INFO, { seq: 1, label: 'l', childId: 'c', outcome: 'completed' })
    engine.emit('workflow/end', INFO, { stopReason: 'completed', agentsStarted: 1 })
    expect(seen).toEqual([
      [INFO, 'hello'],
      [INFO, { seq: 1, label: 'l', childId: 'c' }],
    ])
  })

  it('contains an asynchronously rejected listener without starving peers', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const seen: string[] = []
    // Runtime listeners may return thenables even though the declaration's observable result is void.
    // oxlint-disable-next-line typescript/no-misused-promises -- exercises rejected-listener containment
    ctx.on('workflow/agent-start', async () => { throw new Error('async observer failed') })
    ctx.on('workflow/agent-start', (_info, agent) => { seen.push(agent.label) })
    const engine = ctx.workflowEngine as StubEngine
    const payload = { seq: 1, label: 'original', childId: 'c' }
    engine.emit('workflow/start', INFO)
    engine.emit('workflow/agent-start', INFO, payload)
    await Promise.resolve()
    engine.emit('workflow/agent-end', INFO, { ...payload, outcome: 'completed' })
    engine.emit('workflow/end', INFO, { stopReason: 'completed', agentsStarted: 1 })
    expect(seen).toEqual(['original'])
    expect(String(warn.mock.calls[0]![0])).toContain('listener rejected')
  })

  it('gives each listener an independent JSON snapshot', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const seen: string[] = []
    ctx.on('workflow/journal-commit', (_info, entry) => {
      if (entry.kind !== 'agent') throw new Error('expected an agent journal entry')
      const mutable = entry.result as { nested: { label: string } }
      mutable.nested.label = 'mutated'
    })
    ctx.on('workflow/journal-commit', (_info, entry) => {
      if (entry.kind !== 'agent') throw new Error('expected an agent journal entry')
      seen.push((entry.result as { nested: { label: string } }).nested.label)
    })
    const original = { nested: { label: 'original' } }

    const engine = ctx.workflowEngine as StubEngine
    engine.emit('workflow/start', INFO)
    engine.emit('workflow/journal-commit', INFO, {
      kind: 'agent',
      ordinal: 1,
      seq: 1,
      callId: 'root/agent:1',
      fingerprint: '0'.repeat(64),
      result: original,
    })
    engine.emit('workflow/end', INFO, { stopReason: 'completed', agentsStarted: 0 })

    expect(seen).toEqual(['original'])
    expect(original).toEqual({ nested: { label: 'original' } })
  })

  it('contains an invalid runtime payload as a provider failure', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const listener = vi.fn()
    ctx.on('workflow/journal-commit', listener)

    const engine = ctx.workflowEngine as StubEngine
    engine.emit('workflow/journal-commit', INFO, undefined)

    expect(listener).not.toHaveBeenCalled()
    expect(String(warn.mock.calls[0]![0])).toContain('payload is not losslessly JSON-serializable')
  })

  it('contains a throwing listener PER LISTENER: later listeners still run, nothing propagates', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const reached: string[] = []
    ctx.on('workflow/phase', () => { throw new Error('bad listener') })
    ctx.on('workflow/phase', (_info, title) => { reached.push(title) })
    const engine = ctx.workflowEngine as StubEngine
    engine.emit('workflow/start', INFO)
    expect(() => { engine.emit('workflow/phase', INFO, 'Scan') }).not.toThrow()
    engine.emit('workflow/end', INFO, { stopReason: 'completed', agentsStarted: 0 })
    expect(reached).toEqual(['Scan'])
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain('workflow/phase listener threw')
  })

  it('containment is total: a listener throwing a value whose coercion throws neither propagates nor starves later listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const reached: string[] = []
    ctx.on('workflow/phase', () => {
      throw { toString: () => { throw new Error('coercion trap') } }
    })
    ctx.on('workflow/phase', (_info, title) => { reached.push(title) })
    const engine = ctx.workflowEngine as StubEngine
    engine.emit('workflow/start', INFO)
    expect(() => { engine.emit('workflow/phase', INFO, 'Scan') }).not.toThrow()
    engine.emit('workflow/end', INFO, { stopReason: 'completed', agentsStarted: 0 })
    expect(reached).toEqual(['Scan'])
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain('[unrenderable thrown value]')
  })

  it('has the expected exports (default = the abstract service class)', () => {
    expect(WorkflowEngineDefault).toBe(WorkflowEngine)
  })
})
