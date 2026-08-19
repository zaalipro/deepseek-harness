import { MessageChannel } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeWorkerToHostMessage,
  HostToWorkerType,
  WorkerToHostType,
  WorkflowProtocolError,
} from '../src/protocol.ts'
import type { HostToWorkerMessage, WorkerToHostMessage } from '../src/protocol.ts'
import { runWorkerSession } from '../src/session.ts'
import type { ChildResult, WorkerInit } from '../src/types.ts'

/** Active message channels closed after each regression, including assertion failures. */
const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** Build the worker payload used by the contract regressions. */
function init(body: string, overrides?: Partial<WorkerInit>): WorkerInit {
  return {
    meta: { name: 'contract-regression', description: 'worker contract regression' },
    body,
    limits: {
      maxConcurrentAgents: 8,
      maxTotalAgents: 128,
      maxItemsPerCall: 128,
      syncTimeoutMs: 5_000,
    },
    ...overrides,
  }
}

/** A completed child response used only when a regression unexpectedly launches work. */
function text(value: string): ChildResult {
  return { output: [{ type: 'text', text: value }], stopReason: 'completed' }
}

/** In-process host that acknowledges every child and records the complete worker protocol. */
function harness(): {
  readonly worker: MessagePort
  readonly messages: WorkerToHostMessage[]
  readonly result: Promise<Extract<WorkerToHostMessage, { type: WorkerToHostType.Result }>['result']>
} {
  const channel = new MessageChannel()
  const messages: WorkerToHostMessage[] = []
  const result = Promise.withResolvers<Extract<WorkerToHostMessage, { type: WorkerToHostType.Result }>['result']>()
  cleanups.push(() => {
    channel.port1.close()
    channel.port2.close()
  })
  channel.port1.on('message', (message: WorkerToHostMessage) => {
    messages.push(message)
    switch (message.type) {
      case WorkerToHostType.Ready:
        channel.port1.postMessage({ type: HostToWorkerType.Go } satisfies HostToWorkerMessage)
        break
      case WorkerToHostType.ChildStart:
        channel.port1.postMessage({
          type: HostToWorkerType.ChildStarted,
          callId: message.callId,
          childId: `unexpected-${message.callId}`,
        } satisfies HostToWorkerMessage)
        channel.port1.postMessage({
          type: HostToWorkerType.ChildSettled,
          callId: message.callId,
          result: text('unexpected child result'),
        } satisfies HostToWorkerMessage)
        break
      case WorkerToHostType.ChildDispose:
        channel.port1.postMessage({
          type: HostToWorkerType.ChildDisposed,
          callId: message.callId,
        } satisfies HostToWorkerMessage)
        break
      case WorkerToHostType.Result:
        result.resolve(message.result)
        break
      default:
        break
    }
  })
  return { worker: channel.port2, messages, result: result.promise }
}

describe('terminal and budget regressions', () => {
  it('complete() settles immediately even when the script catches it and never settles', async () => {
    const host = harness()
    const session = runWorkerSession(host.worker, init(`
      try { complete({ report: 'ready' }) } catch {}
      await new Promise(() => {})
    `))

    const outcome = await Promise.race([
      host.result.then(result => ({ kind: 'result' as const, result })),
      new Promise<{ kind: 'timeout' }>(resolve => setTimeout(() => { resolve({ kind: 'timeout' }) }, 2_000)),
    ])

    expect(outcome).toEqual({
      kind: 'result',
      result: { value: { report: 'ready' }, stopReason: 'completed', agentsStarted: 0 },
    })
    await session
  })

  it('complete() prevents caught code from invoking any later host hook', async () => {
    const host = harness()
    const session = runWorkerSession(host.worker, init(`
      try { complete('first terminal wins') } catch {}
      log('must not escape')
      await agent('must not launch')
      return 'must not replace the terminal value'
    `))

    expect(await host.result).toEqual({
      value: 'first terminal wins',
      stopReason: 'completed',
      agentsStarted: 0,
    })
    await session
    expect(host.messages.filter(message => message.type === WorkerToHostType.Log)).toEqual([])
    expect(host.messages.filter(message => message.type === WorkerToHostType.ChildStart)).toEqual([])
  })

  it('an invalid complete() value resolves an error result and cannot be caught as script control flow', async () => {
    const host = harness()
    const session = runWorkerSession(host.worker, init(`
      try { complete({ invalid: Object.create({ inherited: true }) }) } catch {}
      log('must not escape')
      return 'must not recover'
    `))

    await expect(session).resolves.toBeUndefined()
    const result = await host.result
    expect(result.stopReason).toBe('error')
    expect(result.value).toBeNull()
    expect(result.error).toContain('not plain JSON data')
    expect(host.messages.filter(message => message.type === WorkerToHostType.Log)).toEqual([])
  })

  it('rejects an over-budget declarative parallel panel before launching any child', async () => {
    const host = harness()
    const session = runWorkerSession(host.worker, init(`
      await parallel([
        { prompt: 'first side effect' },
        { prompt: 'second side effect' },
      ])
      return 'unreachable'
    `, {
      limits: {
        maxConcurrentAgents: 8,
        maxTotalAgents: 1,
        maxItemsPerCall: 128,
        syncTimeoutMs: 5_000,
      },
    }))

    const result = await host.result
    await session
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('cannot admit 2 agents')
    expect(result.error).toContain('of 1 logical-agent budget')
    expect(result.agentsStarted).toBe(0)
    expect(host.messages.filter(message => message.type === WorkerToHostType.ChildStart)).toEqual([])
  })

  it('atomically rejects the new jobs in a partially replayed declarative panel', async () => {
    const firstHost = harness()
    const firstSession = runWorkerSession(firstHost.worker, init(`
      complete(await parallel([
        { prompt: 'replayed' },
        { prompt: 'previously live one' },
        { prompt: 'previously live two' },
      ]))
    `))
    await firstHost.result
    await firstSession
    const firstEntry = firstHost.messages.find(
      message => message.type === WorkerToHostType.JournalCommit && message.entry.kind === 'agent',
    )
    expect(firstEntry?.type).toBe(WorkerToHostType.JournalCommit)

    const replayHost = harness()
    const replaySession = runWorkerSession(replayHost.worker, init(`
      complete(await parallel([
        { prompt: 'replayed' },
        { prompt: 'new one' },
        { prompt: 'new two' },
      ]))
    `, {
      journal: [(firstEntry as Extract<WorkerToHostMessage, { type: WorkerToHostType.JournalCommit }>).entry],
      initialAgentSpend: 1,
      initialAgentSeq: 1,
      limits: {
        maxConcurrentAgents: 8,
        maxTotalAgents: 2,
        maxItemsPerCall: 128,
        syncTimeoutMs: 5_000,
      },
    }))

    const result = await replayHost.result
    await replaySession
    expect(result).toMatchObject({ stopReason: 'error', errorCode: 'AGENT_CAP', agentsStarted: 1 })
    expect(replayHost.messages.filter(message => message.type === WorkerToHostType.ChildStart)).toEqual([])
  })

  it('does not spend a phantom agent reservation for a thunk that enters a nested panel', async () => {
    const host = harness()
    const session = runWorkerSession(host.worker, init(`
      const result = await parallel([
        async () => parallel([
          async () => agent('the only real child'),
        ]),
      ])
      complete(result)
    `, {
      limits: {
        maxConcurrentAgents: 8,
        maxTotalAgents: 1,
        maxItemsPerCall: 128,
        syncTimeoutMs: 5_000,
      },
    }))

    expect(await host.result).toEqual({
      value: [['unexpected child result']],
      stopReason: 'completed',
      agentsStarted: 1,
    })
    await session
    expect(host.messages.filter(message => message.type === WorkerToHostType.ChildStart)).toHaveLength(1)
  })

  it('never reuses an agent sequence after refunding a pure thunk reservation', async () => {
    const host = harness()
    const session = runWorkerSession(host.worker, init(`
      await parallel([
        async () => 'pure branch',
        async () => agent('first real child'),
      ])
      complete(await agent('later real child'))
    `, {
      limits: {
        maxConcurrentAgents: 8,
        maxTotalAgents: 3,
        maxItemsPerCall: 128,
        syncTimeoutMs: 5_000,
      },
    }))

    expect(await host.result).toMatchObject({
      value: 'unexpected child result',
      stopReason: 'completed',
      agentsStarted: 2,
    })
    await session
    const starts = host.messages
      .filter((message): message is Extract<WorkerToHostMessage, { type: WorkerToHostType.AgentStart }> => (
        message.type === WorkerToHostType.AgentStart
      ))
    expect(starts.map(message => message.info.seq)).toEqual([1, 2])
    expect(new Set(starts.map(message => message.info.seq)).size).toBe(starts.length)
  })

  it('keeps resumed budget spend cumulative while journal replay remains free', async () => {
    const firstHost = harness()
    const firstSession = runWorkerSession(firstHost.worker, init(`
      complete(await agent('stable replay request'))
    `, {
      limits: {
        maxConcurrentAgents: 8,
        maxTotalAgents: 2,
        maxItemsPerCall: 128,
        syncTimeoutMs: 5_000,
      },
    }))
    await firstHost.result
    await firstSession
    const entry = firstHost.messages.find(message => message.type === WorkerToHostType.JournalCommit)?.entry
    expect(entry).toBeDefined()

    const resumedHost = harness()
    const session = runWorkerSession(resumedHost.worker, init(`
      const before = budget()
      const replayed = await agent('stable replay request')
      const afterReplay = budget()
      const live = await agent('new request')
      complete({ before, afterReplay, afterLive: budget(), replayed, live })
    `, {
      initialAgentSpend: 1,
      journal: [entry!],
      limits: {
        maxConcurrentAgents: 8,
        maxTotalAgents: 2,
        maxItemsPerCall: 128,
        syncTimeoutMs: 5_000,
      },
    }))

    const result = await resumedHost.result
    await session
    expect(result).toEqual({
      value: {
        before: { total: 2, spent: 1, reserved: 0, remaining: 1 },
        afterReplay: { total: 2, spent: 1, reserved: 0, remaining: 1 },
        afterLive: { total: 2, spent: 2, reserved: 0, remaining: 0 },
        replayed: 'unexpected child result',
        live: 'unexpected child result',
      },
      stopReason: 'completed',
      agentsStarted: 2,
    })
    expect(resumedHost.messages.filter(message => message.type === WorkerToHostType.ChildStart)).toHaveLength(1)
  })

  it('rejects a journal request fingerprint mismatch before launching a child', async () => {
    const firstHost = harness()
    const firstSession = runWorkerSession(firstHost.worker, init(`
      complete(await agent('original request', { label: 'stable' }))
    `))
    await firstHost.result
    await firstSession
    const entry = firstHost.messages.find(message => message.type === WorkerToHostType.JournalCommit)?.entry
    expect(entry).toBeDefined()

    const replayHost = harness()
    const session = runWorkerSession(replayHost.worker, init(`
      complete(await agent('changed request', { label: 'stable' }))
    `, {
      initialAgentSpend: 1,
      journal: [entry!],
    }))

    const result = await replayHost.result
    await session
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('journal')
    expect(result.error).toContain('does not match')
    expect(result.agentsStarted).toBe(1)
    expect(replayHost.messages.filter(message => message.type === WorkerToHostType.ChildStart)).toEqual([])
  })

  it('does not charge a phantom outer reservation for a nested thunk panel', async () => {
    const host = harness()
    const session = runWorkerSession(host.worker, init(`
      complete(await parallel([
        async () => parallel([async () => agent('only real child')]),
      ]))
    `, {
      limits: {
        maxConcurrentAgents: 8,
        maxTotalAgents: 1,
        maxItemsPerCall: 128,
        syncTimeoutMs: 5_000,
      },
    }))

    expect(await host.result).toEqual({
      value: [['unexpected child result']],
      stopReason: 'completed',
      agentsStarted: 1,
    })
    await session
    expect(host.messages.filter(message => message.type === WorkerToHostType.ChildStart)).toHaveLength(1)
  })

  it('keeps member sequences unique when a pure thunk precedes live calls', async () => {
    const host = harness()
    const session = runWorkerSession(host.worker, init(`
      const panel = await parallel([() => 'pure', () => agent('inside')])
      const later = await agent('later')
      complete({ panel, later })
    `, {
      limits: {
        maxConcurrentAgents: 8,
        maxTotalAgents: 2,
        maxItemsPerCall: 128,
        syncTimeoutMs: 5_000,
      },
    }))

    const result = await host.result
    await session
    expect(result.agentsStarted).toBe(2)
    expect(host.messages
      .filter(message => message.type === WorkerToHostType.AgentStart)
      .map(message => message.info.seq)).toEqual([1, 2])
  })

  it('includes an inherited phase in the replay fingerprint', async () => {
    const firstHost = harness()
    const firstSession = runWorkerSession(firstHost.worker, init(`
      phase('First')
      complete(await agent('stable prompt'))
    `))
    await firstHost.result
    await firstSession
    const entry = firstHost.messages.find(message => message.type === WorkerToHostType.JournalCommit)?.entry
    expect(entry).toBeDefined()

    const replayHost = harness()
    const replaySession = runWorkerSession(replayHost.worker, init(`
      phase('Changed')
      complete(await agent('stable prompt'))
    `, { journal: [entry!], initialAgentSpend: 1 }))
    const result = await replayHost.result
    await replaySession

    expect(result).toMatchObject({ stopReason: 'error', errorCode: 'JOURNAL_DIVERGENCE' })
    expect(replayHost.messages.filter(message => message.type === WorkerToHostType.ChildStart)).toEqual([])
  })

  it('continues member sequences independently from cumulative spend', async () => {
    const host = harness()
    const session = runWorkerSession(host.worker, init('complete(await agent(\'retry member\'))', {
      initialAgentSpend: 1,
      initialAgentSeq: 7,
      limits: {
        maxConcurrentAgents: 8,
        maxTotalAgents: 2,
        maxItemsPerCall: 128,
        syncTimeoutMs: 5_000,
      },
    }))

    const result = await host.result
    await session
    expect(result.agentsStarted).toBe(2)
    expect(host.messages.find(message => message.type === WorkerToHostType.AgentStart)?.info.seq).toBe(8)
  })
})

describe('untrusted worker protocol regressions', () => {
  it.each<WorkerToHostMessage>([
    { type: WorkerToHostType.Ready },
    { type: WorkerToHostType.Phase, title: 'Review' },
    { type: WorkerToHostType.Log, message: '' },
    {
      type: WorkerToHostType.AgentStart,
      info: { seq: 1, label: 'reviewer', phase: 'Review', childId: 'child-1' as never },
    },
    {
      type: WorkerToHostType.AgentEnd,
      info: { seq: 1, label: 'reviewer', childId: 'child-1' as never, outcome: 'failed' },
    },
    {
      type: WorkerToHostType.Gate,
      gate: { kind: 'user', message: 'Confirm', resumable: true },
    },
    {
      type: WorkerToHostType.JournalCommit,
      entry: {
        kind: 'agent', ordinal: 1, seq: 1, callId: 'root/agent:1', fingerprint: 'a'.repeat(64), result: null,
      },
    },
    {
      type: WorkerToHostType.ChildStart,
      callId: 1,
      request: {
        prompt: 'Inspect',
        schema: { type: 'object', properties: {} },
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    },
    { type: WorkerToHostType.ChildDispose, callId: 2 },
    { type: WorkerToHostType.ScratchWrite, callId: 3, name: 'report.md', content: '' },
    { type: WorkerToHostType.ScratchRead, callId: 4, name: 'report.md' },
    {
      type: WorkerToHostType.Result,
      result: { value: null, stopReason: 'cancelled', error: 'stopped', errorCode: 'CANCELLED', agentsStarted: 1 },
    },
  ])('accepts and detaches every worker message family: %j', (frame) => {
    expect(decodeWorkerToHostMessage(frame)).toEqual(frame)
  })

  it.each([
    undefined,
    null,
    {},
    { type: 'forged' },
    { type: WorkerToHostType.ChildStart, callId: 1, request: { prompt: '' } },
    { type: WorkerToHostType.ChildStart, callId: 1, request: { prompt: 'valid', surprise: true } },
    { type: WorkerToHostType.AgentStart, info: { seq: 0, label: 'bad', childId: 'child' } },
    { type: WorkerToHostType.Result, result: { value: null, stopReason: 'completed', agentsStarted: -1 } },
    {
      type: WorkerToHostType.Result,
      result: { value: null, stopReason: 'error', error: 'bad', errorCode: 'FORGED_CODE', agentsStarted: 0 },
    },
  ])('rejects a forged or malformed frame without dispatching it: %j', (frame) => {
    expect(() => decodeWorkerToHostMessage(frame)).toThrow(WorkflowProtocolError)
  })

  it.each([
    [{ type: WorkerToHostType.Ready, extra: true }, 'message.extra is not recognized'],
    [{ type: WorkerToHostType.Phase, title: '' }, 'message.title must be a non-empty string'],
    [{ type: WorkerToHostType.Log, message: 1 }, 'message.message must be a string'],
    [{ type: WorkerToHostType.AgentEnd, info: { seq: 1, label: 'x', childId: 'c', outcome: 'unknown' } }, 'outcome is not recognized'],
    [{ type: WorkerToHostType.Gate, gate: { kind: 'unknown', message: '', resumable: true } }, 'kind is not recognized'],
    [{ type: WorkerToHostType.Gate, gate: { kind: 'infra', message: '', resumable: 'yes' } }, 'resumable must be a boolean'],
    [{ type: WorkerToHostType.ChildStart, callId: 1, request: { prompt: 'x', schema: { type: 'array' } } }, 'schema is unsupported'],
    [{
      type: WorkerToHostType.JournalCommit,
      entry: { kind: 'agent', ordinal: 1, seq: 1, callId: 'x', fingerprint: 'A'.repeat(64), result: null },
    }, 'lowercase SHA-256'],
    [{ type: WorkerToHostType.Result, result: { value: null, stopReason: 'paused', agentsStarted: 0 } }, 'stopReason is not recognized'],
    [{ type: WorkerToHostType.Result, result: { value: null, stopReason: 'completed', error: 'bad', agentsStarted: 0 } }, 'forbidden for a completed result'],
    [{ type: WorkerToHostType.Result, result: { value: null, stopReason: 'error', agentsStarted: 0 } }, 'error is required'],
    [{ type: WorkerToHostType.Result, result: { value: null, stopReason: 'error', error: 'bad', errorCode: 1, agentsStarted: 0 } }, 'errorCode is not recognized'],
  ] as const)('rejects a field-level protocol violation: %j', (frame, diagnostic) => {
    expect(() => decodeWorkerToHostMessage(frame)).toThrow(diagnostic)
  })

  it.each(['user', 'back_off', 'no_progress', 'verification', 'infra'] as const)(
    'accepts the %s gate kind',
    (kind) => {
      expect(decodeWorkerToHostMessage({
        type: WorkerToHostType.Gate,
        gate: { kind, message: '', resumable: false },
      })).toEqual({ type: WorkerToHostType.Gate, gate: { kind, message: '', resumable: false } })
    },
  )

  it('contains a throwing getter and rejects non-JSON root values', () => {
    expect(() => decodeWorkerToHostMessage({
      get type() { throw new Error('getter exploded') },
    })).toThrow('message could not be read as JSON data')
    expect(() => decodeWorkerToHostMessage(() => {})).toThrow('message must be lossless JSON data')
  })

  it('rejects a message missing a required own field', () => {
    expect(() => decodeWorkerToHostMessage({ type: WorkerToHostType.Log })).toThrow(
      'message.message is required',
    )
  })

  it('rejects an otherwise valid frame over the protocol byte limit', () => {
    expect(() => decodeWorkerToHostMessage({
      type: WorkerToHostType.Log,
      message: 'oversized',
    }, 8)).toThrow('exceeds the 8-byte protocol limit')
  })

  it('returns a detached protocol value instead of an alias the caller can mutate', () => {
    const frame = {
      type: WorkerToHostType.JournalCommit,
      entry: {
        kind: 'agent',
        ordinal: 1,
        seq: 1,
        callId: 'root/agent:1',
        fingerprint: '0'.repeat(64),
        result: { nested: ['committed'] },
      },
    }
    const decoded = decodeWorkerToHostMessage(frame)
    frame.entry.result.nested[0] = 'mutated'

    expect(decoded).toEqual({
      type: WorkerToHostType.JournalCommit,
      entry: {
        kind: 'agent',
        ordinal: 1,
        seq: 1,
        callId: 'root/agent:1',
        fingerprint: '0'.repeat(64),
        result: { nested: ['committed'] },
      },
    })
  })

  it('rejects an exotic value inside an agent journal commit', () => {
    expect(() => decodeWorkerToHostMessage({
      type: WorkerToHostType.JournalCommit,
      entry: {
        kind: 'agent',
        ordinal: 1,
        seq: 1,
        callId: 'root/agent:1',
        fingerprint: '0'.repeat(64),
        result: new Map([['not', 'json']]),
      },
    })).toThrow('message must be lossless JSON data')
  })

  it('accepts a known machine-routable error code on an error result', () => {
    expect(decodeWorkerToHostMessage({
      type: WorkerToHostType.Result,
      result: {
        value: null,
        stopReason: 'error',
        error: 'logical-agent budget exhausted',
        errorCode: 'AGENT_CAP',
        agentsStarted: 2,
      },
    })).toEqual({
      type: WorkerToHostType.Result,
      result: {
        value: null,
        stopReason: 'error',
        error: 'logical-agent budget exhausted',
        errorCode: 'AGENT_CAP',
        agentsStarted: 2,
      },
    })
  })
})
