import { describe, expect, it } from 'vitest'
import type { WorkflowJournalEntry, WorkflowResult } from '@deepseek-ai/dsh-workflow'
import { WorkflowExecution } from '../src/runtime.ts'
import type { ExecutionObserver } from '../src/runtime.ts'
import type { ChildPort, WorkerLimits } from '../src/types.ts'

/** Runtime evidence retained by the direct worker-side execution harness. */
interface ExecutionEvidence {
  readonly result: WorkflowResult
  readonly journal: WorkflowJournalEntry[]
  readonly phases: string[]
  readonly logs: string[]
}

/** Execute one body without crossing the worker protocol, so runtime paths remain visible to coverage. */
async function execute(
  body: string,
  options?: {
    readonly journal?: readonly WorkflowJournalEntry[]
    readonly maxItemsPerCall?: number
    readonly validateOnly?: boolean
  },
): Promise<ExecutionEvidence> {
  const journal: WorkflowJournalEntry[] = []
  const phases: string[] = []
  const logs: string[] = []
  const observer: ExecutionObserver = {
    phase: (title) => { phases.push(title) },
    log: (message) => { logs.push(message) },
    agentStart: () => { throw new Error('validate-only and journal-only regressions must not start children') },
    agentEnd: () => { throw new Error('validate-only and journal-only regressions must not settle children') },
    gate: () => { throw new Error('these regressions must not park on a live gate') },
    journalCommit: (entry) => { journal.push(entry) },
  }
  const children: ChildPort = {
    startAgent: async () => { throw new Error('validate-only and journal-only regressions must not start children') },
    writeScratch: async () => { throw new Error('these regressions must not write scratch files') },
    readScratch: async () => { throw new Error('these regressions must not read scratch files') },
  }
  const limits: WorkerLimits = {
    maxConcurrentAgents: 2,
    maxTotalAgents: 32,
    maxItemsPerCall: options?.maxItemsPerCall ?? 16,
    syncTimeoutMs: 5_000,
  }
  const execution = new WorkflowExecution(
    { name: 'runtime-edge', description: 'exercise worker runtime edge behavior' },
    body,
    undefined,
    limits,
    observer,
    children,
    options?.journal,
    options?.validateOnly,
  )
  return { result: await execution.drive(), journal, phases, logs }
}

describe('validate-only canned schema exploration', () => {
  it('finds an exact-one value when candidate collection reaches its work cap', async () => {
    const run = await execute(`
      return await agent('choose', { schema: {
        type: 'object',
        required: ['choice'],
        properties: {
          choice: { oneOf: [
            { type: 'string', const: 'fixed' },
            { type: 'boolean' },
          ] },
        },
      } })
    `, { maxItemsPerCall: 2, validateOnly: true })

    expect(run.result).toEqual({
      value: { choice: 'fixed' },
      stopReason: 'completed',
      agentsStarted: 1,
    })
    expect(run.journal).toEqual([])
  })

  it('bounds required and optional object alternatives before returning an unsupported-schema error', async () => {
    const run = await execute(`
      return await agent('combinatorial object', { schema: {
        type: 'object',
        required: ['first', 'second'],
        properties: {
          first: { type: 'string' },
          second: { type: 'string' },
          optional: { type: 'string' },
        },
      } })
    `, { maxItemsPerCall: 2, validateOnly: true })

    expect(run.result).toMatchObject({
      value: null,
      stopReason: 'error',
      errorCode: 'UNSUPPORTED_SCHEMA',
      error: expect.stringContaining('could not synthesize') as unknown,
      agentsStarted: 1,
    })
  })

  it('omits an optional property when its exact-one schema has no constructible value', async () => {
    const run = await execute(`
      return await agent('optional impossible value', { schema: {
        type: 'object',
        properties: {
          impossible: { oneOf: [{}, {}] },
        },
      } })
    `, { validateOnly: true })

    expect(run.result).toEqual({ value: {}, stopReason: 'completed', agentsStarted: 1 })
  })

  it('keeps optional property candidates available without making the property required', async () => {
    const run = await execute(`
      return await agent('optional value', { schema: {
        type: 'object',
        properties: {
          note: { type: 'string' },
        },
      } })
    `, { validateOnly: true })

    expect(run.result).toEqual({ value: {}, stopReason: 'completed', agentsStarted: 1 })
  })

  it('synthesizes arrays without item schemas and respects a zero maximum', async () => {
    const run = await execute(`
      return await agent('array edges', { schema: {
        type: 'object',
        required: ['free', 'emptyOnly'],
        properties: {
          free: { type: 'array', minItems: 1 },
          emptyOnly: { type: 'array', maxItems: 0, items: { type: 'string' } },
        },
      } })
    `, { maxItemsPerCall: 4, validateOnly: true })

    expect(run.result).toEqual({
      value: { free: [null], emptyOnly: [] },
      stopReason: 'completed',
      agentsStarted: 1,
    })
  })

  it.each([
    {
      name: 'an array minimum above the smoke-host cap',
      property: "{ type: 'array', minItems: 3, maxItems: 3, items: { type: 'boolean' } }",
    },
    {
      name: 'a nested canned value above the smoke-host node cap',
      property: "{ type: 'object', required: ['leaf'], properties: { leaf: { type: 'string' } } }",
    },
  ])('rejects $name instead of silently returning nonconforming data', async ({ property }) => {
    const run = await execute(`
      return await agent('bounded canned value', { schema: {
        type: 'object',
        required: ['value'],
        properties: { value: ${property} },
      } })
    `, { maxItemsPerCall: 2, validateOnly: true })

    expect(run.result).toMatchObject({
      value: null,
      stopReason: 'error',
      errorCode: 'UNSUPPORTED_SCHEMA',
      agentsStarted: 1,
    })
  })

  it('reports preview narration without persisting validate-only journal entries', async () => {
    const run = await execute(`
      phase('Preview')
      log('checked one canned path')
      return 'valid'
    `, { validateOnly: true })

    expect(run.result).toEqual({ value: 'valid', stopReason: 'completed', agentsStarted: 0 })
    expect(run.phases).toEqual(['Preview'])
    expect(run.logs).toEqual(['checked one canned path'])
    expect(run.journal).toEqual([])
  })

  it('inherits the active phase into declarative panel jobs', async () => {
    const run = await execute(`
      phase('Review')
      return await parallel([{ prompt: 'inspect the active phase' }])
    `, { validateOnly: true })

    expect(run.result).toEqual({ value: [''], stopReason: 'completed', agentsStarted: 1 })
    expect(run.phases).toEqual(['Review'])
  })

  it.each([
    ['backoff', 'back_off'],
    ['blocked', 'verification'],
    ['user', 'user'],
  ])('normalizes the %s gate kind with an omitted message', async (kind, normalized) => {
    const run = await execute(`await await_user(${JSON.stringify(kind)})`, { validateOnly: true })

    expect(run.result).toEqual({
      value: `would await_user (${normalized}): `,
      stopReason: 'completed',
      agentsStarted: 0,
    })
  })

  it('maps complete() with no value to JSON null', async () => {
    const run = await execute('complete()')

    expect(run.result).toEqual({ value: null, stopReason: 'completed', agentsStarted: 0 })
  })
})

describe('terminal journal divergence', () => {
  it('rejects complete() when the resumed path skips a committed call', async () => {
    const original = await execute("log('committed'); return 'first attempt'")
    expect(original.journal).toHaveLength(1)

    const resumed = await execute("complete('terminal value')", { journal: original.journal })

    expect(resumed.result).toMatchObject({
      value: null,
      stopReason: 'error',
      errorCode: 'JOURNAL_DIVERGENCE',
      error: expect.stringContaining('did not replay committed call root/log:1') as unknown,
      agentsStarted: 0,
    })
  })

  it('rejects a changed request at the same journal call identity before repeating the effect', async () => {
    const original = await execute("log('original request'); return null")
    const resumed = await execute("log('changed request'); return null", { journal: original.journal })

    expect(resumed.result).toMatchObject({
      value: null,
      stopReason: 'error',
      errorCode: 'JOURNAL_DIVERGENCE',
      error: expect.stringContaining('does not match the committed request') as unknown,
    })
    expect(resumed.logs).toEqual([])
    expect(resumed.journal).toEqual([])
  })
})
