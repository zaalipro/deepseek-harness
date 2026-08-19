import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentRun,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import type { WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import { describe, expect, it } from 'vitest'
import WorkerThreadWorkflowEngine from '../src/index.ts'

const fingerprint = '0'.repeat(64)

/** A parent stand-in for requests that fail before a child can start. */
function fakeParent(): Agent {
  return { id: SessionId('journal-validation-parent'), options: {} } as unknown as Agent
}

/** Provider registration needed for start-request validation after journal decoding. */
class NeverStartProvider implements SubagentProvider {
  readonly name = 'stub'
  readonly capabilities: SubagentCapabilities = {
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: false,
  }
  readonly inheritsParentContext = false

  start(_request: SubagentStartRequest): Promise<SubagentRun> {
    return Promise.reject(new Error('journal validation unexpectedly reached the subagent provider'))
  }
}

/** Build an engine whose valid runs exercise the auto-concurrency config path. */
async function setup(): Promise<{ ctx: Context; parent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider(new NeverStartProvider())
  await ctx.plugin(WorkerThreadWorkflowEngine, {
    provider: 'stub',
    maxConcurrentAgents: 0,
    maxTotalAgents: 4,
  })
  return { ctx, parent: fakeParent() }
}

/** Common identity fields for one plain-data journal fixture. */
function entry(kind: string, ordinal = 1, callId = `root/${kind}:${ordinal}`): Record<string, unknown> {
  return { kind, ordinal, callId, fingerprint }
}

/** A valid phase entry, optionally changed to form one malformed case. */
function phase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...entry('phase'), title: 'Review', ...overrides }
}

/** A valid log entry, optionally changed to form one malformed case. */
function log(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...entry('log'), message: 'reviewing', ...overrides }
}

/** Start the fixed inert script and return its synchronous validation error. */
function captureStartError(
  ctx: Context,
  parent: Agent,
  overrides: Record<string, unknown>,
): unknown {
  try {
    ctx.workflowEngine.start({
      script: 'return null',
      meta: { name: 'journal-validation', description: 'validate replay input' },
      parent,
      ...overrides,
    })
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected workflow start validation to reject the request')
}

describe('worker engine start validation', () => {
  it('rejects every malformed generalized-journal variant before publishing a run', async () => {
    const { ctx, parent } = await setup()
    let starts = 0
    ctx.on('workflow/start', () => { starts += 1 })

    const validAgent = {
      ...entry('agent'),
      seq: 1,
      result: null,
    }
    const cases: readonly {
      label: string
      journal: unknown
      message: string
    }[] = [
      {
        label: 'non-array journal',
        journal: {},
        message: 'workflow journal must be lossless JSON data',
      },
      {
        label: 'primitive entry',
        journal: [1],
        message: 'workflow journal entries must be objects',
      },
      {
        label: 'null entry',
        journal: [null],
        message: 'workflow journal entries must be objects',
      },
      {
        label: 'array entry',
        journal: [[]],
        message: 'workflow journal entries must be objects',
      },
      {
        label: 'non-integer ordinal',
        journal: [phase({ ordinal: 1.5 })],
        message: 'workflow journal entry ordinal must be the next positive safe integer',
      },
      {
        label: 'ordinal gap',
        journal: [phase({ ordinal: 2 })],
        message: 'workflow journal entry ordinal must be the next positive safe integer',
      },
      {
        label: 'non-string call identity',
        journal: [phase({ callId: 1 })],
        message: 'workflow journal call identities must be non-empty and unique',
      },
      {
        label: 'empty call identity',
        journal: [phase({ callId: '' })],
        message: 'workflow journal call identities must be non-empty and unique',
      },
      {
        label: 'duplicate call identity',
        journal: [phase(), log({ ordinal: 2, callId: 'root/phase:1' })],
        message: 'workflow journal call identities must be non-empty and unique',
      },
      {
        label: 'non-string fingerprint',
        journal: [phase({ fingerprint: 1 })],
        message: 'workflow journal fingerprint must be a lowercase SHA-256 digest',
      },
      {
        label: 'malformed fingerprint',
        journal: [phase({ fingerprint: 'A'.repeat(64) })],
        message: 'workflow journal fingerprint must be a lowercase SHA-256 digest',
      },
      {
        label: 'agent extra field',
        journal: [{ ...validAgent, extra: true }],
        message: 'workflow agent journal fields are not recognized',
      },
      {
        label: 'agent missing result',
        journal: [{ ...entry('agent'), seq: 1 }],
        message: 'workflow agent journal fields are not recognized',
      },
      {
        label: 'agent non-integer sequence',
        journal: [{ ...validAgent, seq: 1.5 }],
        message: 'workflow journal agent seq must be a positive safe integer',
      },
      {
        label: 'agent non-positive sequence',
        journal: [{ ...validAgent, seq: 0 }],
        message: 'workflow journal agent seq must be a positive safe integer',
      },
      {
        label: 'duplicate agent sequence',
        journal: [
          validAgent,
          { ...validAgent, ordinal: 2, callId: 'root/agent:2' },
        ],
        message: 'workflow journal repeats agent sequence 1',
      },
      {
        label: 'phase extra field',
        journal: [phase({ extra: true })],
        message: 'workflow phase journal fields are not recognized',
      },
      {
        label: 'phase non-string title',
        journal: [phase({ title: 1 })],
        message: 'workflow phase journal title must be a non-empty string',
      },
      {
        label: 'phase empty title',
        journal: [phase({ title: '' })],
        message: 'workflow phase journal title must be a non-empty string',
      },
      {
        label: 'log extra field',
        journal: [log({ extra: true })],
        message: 'workflow log journal fields are not recognized',
      },
      {
        label: 'log non-string message',
        journal: [log({ message: 1 })],
        message: 'workflow log journal message must be a string',
      },
      {
        label: 'scratch-read extra field',
        journal: [{ ...entry('scratch-read'), extra: true }],
        message: 'workflow scratch-read journal fields are not recognized',
      },
      {
        label: 'scratch-read non-string content',
        journal: [{ ...entry('scratch-read'), content: 1 }],
        message: 'workflow scratch-read journal content must be a string',
      },
      {
        label: 'scratch-write extra field',
        journal: [{ ...entry('scratch-write'), extra: true }],
        message: 'workflow scratch-write journal fields are not recognized',
      },
      {
        label: 'await-user extra field',
        journal: [{ ...entry('await-user'), extra: true }],
        message: 'workflow await-user journal fields are not recognized',
      },
      {
        label: 'unknown kind',
        journal: [entry('unknown')],
        message: 'workflow journal entry kind is not recognized',
      },
    ]

    for (const testCase of cases) {
      const error = captureStartError(ctx, parent, { journal: testCase.journal })
      expect(error, testCase.label).toMatchObject({
        code: 'JOURNAL_DIVERGENCE',
        message: testCase.message,
      })
    }

    expect(starts).toBe(0)
    await ctx.fiber.dispose()
  })

  it('accepts every journal variant and derives default resume accounting from agent entries only', async () => {
    const { ctx, parent } = await setup()
    const journal = [
      { ...entry('agent', 1), seq: 7, result: null },
      { ...entry('phase', 2), title: 'Review' },
      { ...entry('log', 3), message: 'reviewing' },
      entry('scratch-read', 4),
      { ...entry('scratch-read', 5), content: 'retained' },
      entry('scratch-write', 6),
      entry('await-user', 7),
    ]
    const handle = ctx.workflowEngine.start({
      script: 'return null',
      meta: { name: 'valid-journal', description: 'accept generalized replay input' },
      parent,
      journal: journal as unknown as NonNullable<WorkflowStartRequest['journal']>,
    })

    await expect(handle.result).resolves.toMatchObject({
      stopReason: 'error',
      errorCode: 'JOURNAL_DIVERGENCE',
      agentsStarted: 1,
    })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('wraps a journal property read that throws during the lossless snapshot', async () => {
    const { ctx, parent } = await setup()
    const explosive = phase()
    Object.defineProperty(explosive, 'title', {
      enumerable: true,
      get: () => { throw new Error('journal getter exploded') },
    })

    const error = captureStartError(ctx, parent, { journal: [explosive] })

    expect(error).toMatchObject({
      code: 'JOURNAL_DIVERGENCE',
      message: 'workflow journal must be lossless JSON data',
      cause: expect.objectContaining({
        message: expect.stringContaining('journal getter exploded') as unknown,
      }) as unknown,
    })
    await ctx.fiber.dispose()
  })

  it('accepts explicit resume accounting within the remaining budget', async () => {
    const { ctx, parent } = await setup()
    const handle = ctx.workflowEngine.start({
      script: 'return { resumed: true }',
      meta: { name: 'resume-accounting', description: 'validate resume counters' },
      parent,
      journal: [],
      maxTotalAgents: 3,
      initialAgentSpend: 1,
      initialAgentSeq: 8,
    })

    await expect(handle.result).resolves.toMatchObject({
      value: { resumed: true },
      stopReason: 'completed',
      agentsStarted: 1,
    })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects invalid resume counters and a non-normalized provider before publication', async () => {
    const { ctx, parent } = await setup()
    let starts = 0
    ctx.on('workflow/start', () => { starts += 1 })
    const committed = [{ ...entry('agent'), seq: 4, result: null }]
    const cases: readonly {
      label: string
      overrides: Record<string, unknown>
      message: string
    }[] = [
      {
        label: 'non-normalized provider',
        overrides: { subagentProvider: ' stub ' },
        message: 'workflow subagentProvider must be a non-empty normalized string',
      },
      {
        label: 'non-integer spend',
        overrides: { journal: committed, initialAgentSpend: 1.5 },
        message: 'workflow initialAgentSpend must be a safe integer between the committed journal count (1) and maxTotalAgents (4)',
      },
      {
        label: 'spend below committed count',
        overrides: { journal: committed, initialAgentSpend: 0 },
        message: 'workflow initialAgentSpend must be a safe integer between the committed journal count (1) and maxTotalAgents (4)',
      },
      {
        label: 'spend above run total',
        overrides: { initialAgentSpend: 4, maxTotalAgents: 3 },
        message: 'workflow initialAgentSpend must be a safe integer between the committed journal count (0) and maxTotalAgents (3)',
      },
      {
        label: 'non-integer sequence seed',
        overrides: { journal: committed, initialAgentSeq: 4.5 },
        message: 'workflow initialAgentSeq must be a safe integer no less than prior spend or journal sequence (4) with room for the remaining logical-agent budget',
      },
      {
        label: 'sequence seed below journal maximum',
        overrides: { journal: committed, initialAgentSeq: 3 },
        message: 'workflow initialAgentSeq must be a safe integer no less than prior spend or journal sequence (4) with room for the remaining logical-agent budget',
      },
      {
        label: 'sequence seed leaves no safe-integer room',
        overrides: { journal: committed, initialAgentSeq: Number.MAX_SAFE_INTEGER },
        message: 'workflow initialAgentSeq must be a safe integer no less than prior spend or journal sequence (4) with room for the remaining logical-agent budget',
      },
    ]

    for (const testCase of cases) {
      const error = captureStartError(ctx, parent, testCase.overrides)
      expect(error, testCase.label).toMatchObject({ code: 'INVALID_ARGUMENT', message: testCase.message })
    }
    expect(starts).toBe(0)
    await ctx.fiber.dispose()
  })

  it('rejects inconsistent scratch quota relationships at plugin load', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)

    await expect(ctx.plugin(WorkerThreadWorkflowEngine, {
      scratchMaxFileBytes: 2,
      scratchMaxTotalBytes: 1,
    })).rejects.toThrow('workflow scratchMaxFileBytes cannot exceed scratchMaxTotalBytes')
    await expect(ctx.plugin(WorkerThreadWorkflowEngine, {
      scratchMaxOperations: 1,
      scratchMaxPendingOperations: 2,
    })).rejects.toThrow('workflow scratchMaxPendingOperations cannot exceed scratchMaxOperations')

    await ctx.fiber.dispose()
  })
})
