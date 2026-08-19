import { describe, expect, it, vi } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import { HostToWorkerType, WorkerToHostType } from '../src/protocol.ts'
import type { HostToWorkerMessage, WorkerToHostMessage } from '../src/protocol.ts'
import { requireParentPort, runWorkerSession } from '../src/session.ts'
import type { ChildResult, WorkerInit } from '../src/types.ts'

/** Default limits for in-process sessions (concurrency pinned; auto is machine-derived). */
function limits(overrides?: Partial<WorkerInit['limits']>): WorkerInit['limits'] {
  return { maxConcurrentAgents: 8, maxTotalAgents: 1024, maxItemsPerCall: 4096, syncTimeoutMs: 5000, ...overrides }
}

/** Wrap a body in the minimal valid meta header (the session receives it pre-extracted). */
function init(body: string, args?: unknown, limitOverrides?: Partial<WorkerInit['limits']>): WorkerInit {
  return {
    meta: { name: 'test-flow', description: 'a test workflow' },
    body,
    ...args !== undefined ? { args } : {},
    limits: limits(limitOverrides),
  }
}

/** One scripted host over the other end of a MessageChannel. */
interface FakeHost {
  port: MessagePort
  messages: WorkerToHostMessage[]
  /** Messages of one type, as they arrive. */
  ofType<T extends WorkerToHostMessage['type']>(type: T): Extract<WorkerToHostMessage, { type: T }>[]
  send(message: HostToWorkerMessage): void
  /** Resolves with the terminal result message. */
  result(): Promise<Extract<WorkerToHostMessage, { type: 'result' }>['result']>
  close(): void
}

interface FakeHostOptions {
  /** Auto-respond to child-start: reply started + settled per child index. Omit a reply to leave the child pending. */
  reply?: (request: { prompt: string; schema?: unknown; provider?: string; model?: string }, index: number) => ChildResult | undefined
  /** Reject the start instead (child-start-error) when returning a string. */
  refuse?: (index: number) => string | undefined
  /** Auto-send `go` on `ready` (default true). */
  go?: boolean
  /** Manual mode: do NOT auto-answer child-start at all (the test scripts the replies). */
  manual?: boolean
  /** Shared scratch backing so a resumed attempt can observe external mutation. */
  scratch?: Map<string, string>
}

/**
 * Drive runWorkerSession IN-PROCESS over a MessageChannel: this is where the
 * worker-side files earn their coverage — code inside a real Worker is
 * invisible to main-process coverage. The fake host mirrors the real host's
 * protocol discipline (one started/start-error per start; settled/disposed
 * follow).
 */
function fakeHost(options?: FakeHostOptions): FakeHost {
  const channel = new MessageChannel()
  const messages: WorkerToHostMessage[] = []
  const scratch = options?.scratch ?? new Map<string, string>()
  const resultGate = Promise.withResolvers<Extract<WorkerToHostMessage, { type: 'result' }>['result']>()
  let childIndex = 0
  channel.port1.on('message', (message: WorkerToHostMessage) => {
    messages.push(message)
    switch (message.type) {
      case WorkerToHostType.Ready:
        if (options?.go !== false) channel.port1.postMessage({ type: HostToWorkerType.Go } satisfies HostToWorkerMessage)
        break
      case WorkerToHostType.ChildStart: {
        if (options?.manual) break
        const index = childIndex
        childIndex += 1
        const refusal = options?.refuse?.(index)
        if (refusal !== undefined) {
          channel.port1.postMessage(
            { type: HostToWorkerType.ChildStartError, callId: message.callId, rendered: refusal } satisfies HostToWorkerMessage,
          )
          break
        }
        channel.port1.postMessage({ type: HostToWorkerType.ChildStarted, callId: message.callId, childId: `child-${index}` } satisfies HostToWorkerMessage)
        const reply = options?.reply?.(message.request, index)
        if (reply !== undefined) {
          channel.port1.postMessage(
            { type: HostToWorkerType.ChildSettled, callId: message.callId, result: reply } satisfies HostToWorkerMessage,
          )
        }
        break
      }
      case WorkerToHostType.ChildDispose:
        channel.port1.postMessage({ type: HostToWorkerType.ChildDisposed, callId: message.callId } satisfies HostToWorkerMessage)
        break
      case WorkerToHostType.ScratchWrite:
        scratch.set(message.name, message.content)
        channel.port1.postMessage({ type: HostToWorkerType.ScratchWritten, callId: message.callId } satisfies HostToWorkerMessage)
        break
      case WorkerToHostType.ScratchRead: {
        const content = scratch.get(message.name)
        channel.port1.postMessage({
          type: HostToWorkerType.ScratchReadResult,
          callId: message.callId,
          ...(content === undefined ? {} : { content }),
        } satisfies HostToWorkerMessage)
        break
      }
      case WorkerToHostType.Result:
        resultGate.resolve(message.result)
        break
      default:
        break
    }
  })
  return {
    port: channel.port2,
    messages,
    ofType: type => messages.filter((message): message is never => message.type === type),
    send: (message) => { channel.port1.postMessage(message) },
    result: () => resultGate.promise,
    close: () => { channel.port1.close() },
  }
}

/** A completed text child result. */
function text(reply: string): ChildResult {
  return { output: [{ type: 'text', text: reply }], stopReason: 'completed' }
}

describe('runWorkerSession over an in-process MessageChannel', () => {
  it('runs a script end to end: ready/go handshake, phases, log, agents, result', async () => {
    const host = fakeHost({ reply: (_request, index) => text(`answer-${index}`) })
    const session = runWorkerSession(host.port, init(`
      phase('Scan')
      log('starting with ' + args.files.length + ' files')
      const answers = await pipeline(args.files, (prev, item) => agent('read ' + item))
      return { answers }
    `, { files: ['a.ts', 'b.ts'] }))
    const result = await host.result()
    await session
    expect(result.stopReason).toBe('completed')
    expect(result.agentsStarted).toBe(2)
    expect(result.value).toEqual({ answers: ['answer-0', 'answer-1'] })
    expect(host.messages[0]!.type).toBe('ready')
    expect(host.ofType(WorkerToHostType.Phase).map(m => m.title)).toEqual(['Scan'])
    expect(host.ofType(WorkerToHostType.Log).map(m => m.message)).toEqual(['starting with 2 files'])
    expect(host.ofType(WorkerToHostType.AgentStart).map(m => m.info.childId)).toEqual(['child-0', 'child-1'])
    expect(host.ofType(WorkerToHostType.AgentEnd).every(m => m.info.outcome === 'completed')).toBe(true)
    host.close()
  })

  it('agent({schema}) forwards the schema on the start request and returns the structured value', async () => {
    const host = fakeHost({ reply: () => ({ output: [], structured: { files: ['x.ts'] }, stopReason: 'completed' }) })
    void runWorkerSession(host.port, init(`
      const found = await agent('list files', { schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } } }, model: 'deepseek-v4-pro' })
      return { first: found.files[0] }
    `))
    const result = await host.result()
    expect(result.value).toEqual({ first: 'x.ts' })
    const start = host.ofType(WorkerToHostType.ChildStart)[0]!
    expect(start.request.schema).toEqual({ type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } } })
    expect(start.request.model).toBe('deepseek-v4-pro')
    host.close()
  })

  it('agent({provider}) forwards a provider without inventing a model', async () => {
    const host = fakeHost({ reply: () => text('ok') })
    void runWorkerSession(host.port, init("return await agent('route me', { provider: 'openai' })"))
    const result = await host.result()
    expect(result.value).toBe('ok')
    const start = host.ofType(WorkerToHostType.ChildStart)[0]!
    expect(start.request.provider).toBe('openai')
    expect(start.request.model).toBeUndefined()
    host.close()
  })

  it('a schema child completing WITHOUT a structured value resolves null with a failed outcome', async () => {
    const host = fakeHost({ reply: () => text('prose, no structure') })
    void runWorkerSession(host.port, init("return await agent('p', { schema: { type: 'object' } })"))
    const result = await host.result()
    expect(result.value).toBeNull()
    expect(host.ofType(WorkerToHostType.AgentEnd)[0]!.info.outcome).toBe('failed')
    host.close()
  })

  it('a child settling non-completed resolves null (scripts filter), never throwing into the script', async () => {
    const host = fakeHost({ reply: (_request, index) => index === 0 ? { output: [], stopReason: 'error' } : text('ok') })
    void runWorkerSession(host.port, init("return await parallel([() => agent('one'), () => agent('two')])"))
    const result = await host.result()
    expect(result.value).toEqual([null, 'ok'])
    expect(host.ofType(WorkerToHostType.AgentEnd).map(m => m.info.outcome)).toEqual(expect.arrayContaining(['failed', 'completed']))
    host.close()
  })

  it('a start refusal (child-start-error) is a fatal AGENT_START that kills the script through a combinator', async () => {
    const host = fakeHost({ refuse: () => 'no provider here' })
    void runWorkerSession(host.port, init("return await pipeline([1], () => agent('p'))"))
    const result = await host.result()
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('agent() could not start a child')
    expect(result.error).toContain('no provider here')
    host.close()
  })

  it('a child-failed message (infrastructure rejection) is fatal AGENT_RESULT with the paired failed outcome', async () => {
    const host = fakeHost()
    void runWorkerSession(host.port, init(`
      try { await agent('p'); return 'unreachable' } catch (e) { return { name: e.name, code: e.code, fatal: e.fatal } }
    `))
    await vi.waitFor(() => { expect(host.ofType(WorkerToHostType.ChildStart).length).toBe(1) })
    const callId = host.ofType(WorkerToHostType.ChildStart)[0]!.callId
    host.send({ type: HostToWorkerType.ChildStarted, callId, childId: 'child-0' })
    host.send({ type: HostToWorkerType.ChildFailed, callId, rendered: 'backend exploded' })
    const result = await host.result()
    expect(result.value).toMatchObject({ name: 'WorkflowError', code: 'AGENT_RESULT', fatal: true })
    expect(host.ofType(WorkerToHostType.AgentEnd)[0]!.info.outcome).toBe('failed')
    host.close()
  })

  it('cancel before go: the body never runs at all and the result is cancelled (a second cancel is a no-op)', async () => {
    const host = fakeHost({ go: false })
    const session = runWorkerSession(host.port, init("log('ran')\nreturn 123"))
    await vi.waitFor(() => { expect(host.messages.some(m => m.type === WorkerToHostType.Ready)).toBe(true) })
    host.send({ type: HostToWorkerType.Cancel, reason: 'aborted before start' })
    // Idempotence: the first reason wins; a duplicate cancel changes nothing.
    host.send({ type: HostToWorkerType.Cancel, reason: 'a later reason that must lose' })
    const result = await host.result()
    await session
    expect(result.stopReason).toBe('cancelled')
    expect(result.error).toContain('aborted before start')
    expect(result.error).not.toContain('must lose')
    expect(result.value).toBeNull()
    expect(host.ofType(WorkerToHostType.Log)).toEqual([])
    host.close()
  })

  it('a script with no return value resolves value: null', async () => {
    const host = fakeHost({ reply: () => text('ok') })
    void runWorkerSession(host.port, init("await agent('p')"))
    const result = await host.result()
    expect(result.stopReason).toBe('completed')
    expect(result.value).toBeNull()
    host.close()
  })

  it('cancel mid-run: hooks throw at entry and the run reports cancelled', async () => {
    const host = fakeHost()
    void runWorkerSession(host.port, init(`
      phase('before')
      try { await agent('x') } catch (e) {}
      try { phase('after') } catch (e) {}
      try { log('after') } catch (e) {}
      try { await parallel([() => 'ran']) } catch (e) {}
      try { await pipeline(['item'], p => p) } catch (e) {}
      return 'survived by catching'
    `))
    await vi.waitFor(() => { expect(host.ofType(WorkerToHostType.ChildStart).length).toBe(1) })
    const callId = host.ofType(WorkerToHostType.ChildStart)[0]!.callId
    host.send({ type: HostToWorkerType.ChildStarted, callId, childId: 'child-0' })
    host.send({ type: HostToWorkerType.Cancel, reason: 'stop everything' })
    // The real host settles the aborted child; mirror it.
    host.send({ type: HostToWorkerType.ChildSettled, callId, result: { output: [], stopReason: 'aborted' } })
    const result = await host.result()
    expect(result.stopReason).toBe('cancelled')
    expect(result.error).toContain('stop everything')
    expect(host.ofType(WorkerToHostType.AgentEnd)[0]!.info.outcome).toBe('cancelled')
    // No post-cancel narration left the runtime (the hooks threw at entry).
    expect(host.ofType(WorkerToHostType.Phase).map(m => m.title)).toEqual(['before'])
    expect(host.ofType(WorkerToHostType.Log)).toEqual([])
    host.close()
  })

  it('cancellation between a queued waiter and its slot: the waiter rejects without a child-start', async () => {
    const host = fakeHost({ go: true })
    void runWorkerSession(host.port, init(
      "return await parallel([() => agent('a'), () => agent('b')])",
      undefined,
      { maxConcurrentAgents: 1 },
    ))
    await vi.waitFor(() => { expect(host.ofType(WorkerToHostType.ChildStart).length).toBe(1) })
    host.send({ type: HostToWorkerType.Cancel, reason: 'raced' })
    const result = await host.result()
    expect(result.stopReason).toBe('cancelled')
    // Only the first agent ever reached the host.
    expect(host.ofType(WorkerToHostType.ChildStart).length).toBe(1)
    host.close()
  })

  it('a stray (never-awaited) agent is reaped after settlement: cancel + dispose RPCs flow, no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const host = fakeHost()
      void runWorkerSession(host.port, init(`
        agent('stray, never awaited')
        return 'done without awaiting'
      `))
      const result = await host.result()
      expect(result.stopReason).toBe('completed')
      await vi.waitFor(() => { expect(host.ofType(WorkerToHostType.ChildStart).length).toBe(1) })
      const callId = host.ofType(WorkerToHostType.ChildStart)[0]!.callId
      host.send({ type: HostToWorkerType.ChildStarted, callId, childId: 'child-0' })
      host.send({ type: HostToWorkerType.ChildSettled, callId, result: { output: [], stopReason: 'aborted' } })
      await vi.waitFor(() => { expect(host.ofType(WorkerToHostType.ChildDispose).map(m => m.callId)).toContain(callId) })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
      host.close()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('an unparseable body settles an error result instead of dying without one (host pre-parse skew guard)', async () => {
    const host = fakeHost()
    await runWorkerSession(host.port, init('return ((('))
    const result = await host.result()
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('does not parse')
    expect(result.agentsStarted).toBe(0)
    host.close()
  })

  it('a synchronous spin in the initial slice dies by the in-worker vm timeout', async () => {
    const host = fakeHost()
    void runWorkerSession(host.port, init('while (true) {}', undefined, { syncTimeoutMs: 50 }))
    const result = await host.result()
    expect(result.stopReason).toBe('error')
    expect(result.error?.toLowerCase()).toContain('timed out')
    host.close()
  })

  it('a non-JSON return value fails loud as RESULT_UNSERIALIZABLE', async () => {
    const host = fakeHost()
    void runWorkerSession(host.port, init('return { value: Object.create({ inherited: true }) }'))
    const result = await host.result()
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('not plain JSON data')
    host.close()
  })

  it('tolerates replies for unknown callIds (a teardown race): nothing crashes, the run completes', async () => {
    const host = fakeHost({ reply: () => text('fine') })
    void runWorkerSession(host.port, init("return await agent('p')"))
    host.send({ type: HostToWorkerType.ChildStarted, callId: 999, childId: 'ghost' })
    host.send({ type: HostToWorkerType.ChildStartError, callId: 999, rendered: 'ghost' })
    host.send({ type: HostToWorkerType.ChildSettled, callId: 999, result: text('ghost') })
    host.send({ type: HostToWorkerType.ChildFailed, callId: 999, rendered: 'ghost' })
    host.send({ type: HostToWorkerType.ChildDisposed, callId: 999 })
    host.send({ type: HostToWorkerType.ScratchWritten, callId: 999 })
    host.send({ type: HostToWorkerType.ScratchReadResult, callId: 999, content: 'ghost' })
    const result = await host.result()
    expect(result.stopReason).toBe('completed')
    expect(result.value).toBe('fine')
    host.close()
  })

  it('caps and malformed hook arguments reject loud (the runtime runs unchanged inside the session)', async () => {
    const cases: [string, string][] = [
      ['return await agent(42)', 'non-empty prompt string'],
      ["return await agent('')", 'non-empty prompt string'],
      ["return await agent('p', 'opts')", 'options must be an object'],
      ["return await agent('p', { label: 3 })", '"label" must be a string'],
      ["return await agent('p', { get label() { throw new Error('read failed') } })", 'options must be plain JSON data'],
      ["return await agent('p', { bogus: true })", '"bogus" is not recognized'],
      ["return await agent('p', { effort: 'high' })", '"effort" is deferred and not supported by this engine (supported: label, phase, schema, provider, model)'],
      ["return await agent('p', { schema: { type: 'object', oneOf: [] } })", 'outside the supported subset'],
      ['return await parallel([() => 1, () => 2, () => 3])', 'over the per-call cap (2)'],
      ['return await pipeline([1, 2, 3], (x) => x)', 'maxItemsPerCall'],
      ["return await parallel('no')", 'parallel() requires an array'],
      ['return await parallel([3])', 'item 0 is not a function'],
      ["return await pipeline('no', () => 1)", 'pipeline() requires an items array'],
      ['return await pipeline([1])', 'at least one stage'],
      ["return await pipeline([1], 'x')", 'stage 0 is not a function'],
      ["phase('')", 'phase() requires a non-empty title string'],
      ['log(3)', 'log() requires a message string'],
    ]
    for (const [body, expected] of cases) {
      const host = fakeHost({ reply: () => text('ok') })
      void runWorkerSession(host.port, init(body, undefined, { maxItemsPerCall: 2 }))
      const result = await host.result()
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain(expected)
      host.close()
    }
  })

  it('combinator semantics: thunk/stage throws null the item; a forged fatal-shaped object stays null; real fatals propagate', async () => {
    const host = fakeHost({ reply: () => text('fine') })
    void runWorkerSession(host.port, init(`
      const viaParallel = await parallel([
        () => { throw new Error('boom') },
        () => agent('fine'),
        () => 'plain value',
        () => { throw { name: 'WorkflowError', fatal: true, message: 'forged fatal' } },
      ])
      const viaPipeline = await pipeline([10, 20],
        (prev, item, index) => { if (item === 10) throw new Error('ordinary failure'); return 'kept-' + item + '-' + index },
      )
      return { viaParallel, viaPipeline }
    `))
    const result = await host.result()
    expect(result.stopReason).toBe('completed')
    expect(result.value).toEqual({
      viaParallel: [null, 'fine', 'plain value', null],
      viaPipeline: [null, 'kept-20-1'],
    })
    host.close()
  })

  it('trips the total-agent cap with a message naming the config knob', async () => {
    const host = fakeHost({ reply: () => text('ok') })
    void runWorkerSession(host.port, init("await agent('1'); await agent('2'); await agent('3')", undefined, { maxTotalAgents: 2 }))
    const result = await host.result()
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('total agent cap (2)')
    expect(result.error).toContain('applicable maxTotalAgents limit')
    expect(result.agentsStarted).toBe(2)
    host.close()
  })

  it('queued agents proceed through the concurrency semaphore in FIFO order', async () => {
    const host = fakeHost({ reply: request => text(`ok:${request.prompt}`) })
    void runWorkerSession(host.port, init(
      "return await parallel([1, 2, 3].map((n) => () => agent('job ' + n)))",
      undefined,
      { maxConcurrentAgents: 1 },
    ))
    const result = await host.result()
    expect(result.value).toEqual(['ok:job 1', 'ok:job 2', 'ok:job 3'])
    host.close()
  })

  it('labels default from the prompt first line, truncated; explicit label/phase options win', async () => {
    const host = fakeHost({ reply: () => text('ok') })
    void runWorkerSession(host.port, init(`
      phase('Find')
      await agent('a prompt that is quite long and will surely get truncated down to a display label\\n'
        + 'with a second line the label must not include')
      await agent('short', { label: 'named', phase: 'Custom' })
      return null
    `))
    await host.result()
    const starts = host.ofType(WorkerToHostType.AgentStart).map(m => m.info)
    expect(starts[0]).toMatchObject({ seq: 1, phase: 'Find' })
    expect(starts[0]!.label.length).toBeLessThanOrEqual(48)
    expect(starts[0]!.label).not.toContain('second line')
    expect(starts[1]).toMatchObject({ seq: 2, label: 'named', phase: 'Custom' })
    host.close()
  })

  it('non-text output blocks are filtered out of the text result', async () => {
    const host = fakeHost({
      reply: () => ({
        output: [
          { type: 'text', text: 'first ' },
          { type: 'tool_call', id: 'c1', name: 'x', arguments: {} } as never,
          { type: 'text', text: 'second' },
        ],
        stopReason: 'completed',
      }),
    })
    void runWorkerSession(host.port, init("return await agent('p')"))
    const result = await host.result()
    expect(result.value).toBe('first second')
    host.close()
  })

  it('a cancel landing DURING the start round-trip disposes the fresh child and dies cancelled', async () => {
    const host = fakeHost({ manual: true })
    void runWorkerSession(host.port, init("return await agent('p')"))
    await vi.waitFor(() => { expect(host.ofType(WorkerToHostType.ChildStart).length).toBe(1) })
    const callId = host.ofType(WorkerToHostType.ChildStart)[0]!.callId
    // Simulate a teardown race by delivering cancellation before a stale start reply.
    host.send({ type: HostToWorkerType.Cancel, reason: 'raced the start' })
    host.send({ type: HostToWorkerType.ChildStarted, callId, childId: 'child-0' })
    const result = await host.result()
    expect(result.stopReason).toBe('cancelled')
    await vi.waitFor(() => {
      expect(host.ofType(WorkerToHostType.ChildDispose).map(m => m.callId)).toContain(callId)
    })
    // The unpublished child is disposed without a lifecycle announcement.
    expect(host.ofType(WorkerToHostType.AgentStart)).toEqual([])
    host.close()
  })

  it('a start refusal arriving after a cancel reads as the cancellation, not a broken seam', async () => {
    const host = fakeHost({ manual: true })
    void runWorkerSession(host.port, init(`
      try { await agent('p'); return 'unreachable' } catch (e) { return { code: e.code } }
    `))
    await vi.waitFor(() => { expect(host.ofType(WorkerToHostType.ChildStart).length).toBe(1) })
    const callId = host.ofType(WorkerToHostType.ChildStart)[0]!.callId
    host.send({ type: HostToWorkerType.Cancel, reason: 'stopping' })
    host.send({ type: HostToWorkerType.ChildStartError, callId, rendered: 'workflow run cancelled: stopping' })
    const result = await host.result()
    // The run reports cancelled (the script died of CANCELLED, not AGENT_START).
    expect(result.stopReason).toBe('cancelled')
    host.close()
  })

  it('a child result rejection while cancelled pairs a cancelled agent-end, and the run reports cancelled', async () => {
    const host = fakeHost({ manual: true })
    void runWorkerSession(host.port, init("return await agent('doomed')"))
    await vi.waitFor(() => { expect(host.ofType(WorkerToHostType.ChildStart).length).toBe(1) })
    const callId = host.ofType(WorkerToHostType.ChildStart)[0]!.callId
    host.send({ type: HostToWorkerType.ChildStarted, callId, childId: 'child-0' })
    await vi.waitFor(() => { expect(host.ofType(WorkerToHostType.AgentStart).length).toBe(1) })
    host.send({ type: HostToWorkerType.Cancel, reason: 'user aborted' })
    host.send({ type: HostToWorkerType.ChildFailed, callId, rendered: 'backend crashed on abort' })
    const result = await host.result()
    expect(result.stopReason).toBe('cancelled')
    expect(host.ofType(WorkerToHostType.AgentEnd)[0]!.info.outcome).toBe('cancelled')
    host.close()
  })

  it('a resolved child result observed after cancellation pairs a cancelled agent end', async () => {
    const host = fakeHost({ manual: true })
    void runWorkerSession(host.port, init("return await agent('doomed')"))
    await vi.waitFor(() => { expect(host.ofType(WorkerToHostType.ChildStart)).toHaveLength(1) })
    const callId = host.ofType(WorkerToHostType.ChildStart)[0]!.callId
    host.send({ type: HostToWorkerType.ChildStarted, callId, childId: 'child-0' })
    await vi.waitFor(() => { expect(host.ofType(WorkerToHostType.AgentStart)).toHaveLength(1) })
    host.send({ type: HostToWorkerType.Cancel, reason: 'cancel after announcement' })
    host.send({ type: HostToWorkerType.ChildSettled, callId, result: { output: [], stopReason: 'aborted' } })

    await expect(host.result()).resolves.toMatchObject({ stopReason: 'cancelled', errorCode: 'CANCELLED' })
    expect(host.ofType(WorkerToHostType.AgentEnd)[0]!.info.outcome).toBe('cancelled')
    host.close()
  })

  it('writes and reads scratch content through correlated session RPCs, including a missing file', async () => {
    const host = fakeHost()
    void runWorkerSession(host.port, init(`
      await write_scratch_file('report.md', 'saved')
      return {
        saved: await read_scratch_file('report.md'),
        missing: (await read_scratch_file('missing')) ?? null,
      }
    `))

    await expect(host.result()).resolves.toMatchObject({
      value: { saved: 'saved', missing: null },
      stopReason: 'completed',
    })
    expect(host.ofType(WorkerToHostType.ScratchWrite)).toHaveLength(1)
    expect(host.ofType(WorkerToHostType.ScratchRead)).toHaveLength(2)
    host.close()
  })

  it.each([
    ["await write_scratch_file('../escape', 'x')", 'single component'],
    ["await write_scratch_file('report', 1)", 'content must be a string'],
    ["await read_scratch_file('')", 'single component'],
    ['await read_scratch_file(1)', 'single component'],
  ])('rejects malformed scratch hook input: %s', async (body, diagnostic) => {
    const host = fakeHost()
    void runWorkerSession(host.port, init(body))
    const result = await host.result()
    expect(result).toMatchObject({ stopReason: 'error', errorCode: 'INVALID_ARGUMENT' })
    expect(result.error).toContain(diagnostic)
    host.close()
  })

  it('smoke validation uses canned agent and gate results without child RPCs', async () => {
    const host = fakeHost()
    void runWorkerSession(host.port, {
      ...init(`
        const plain = await agent('plain')
        const structured = await agent('structured', { schema: { type: 'object' } })
        await pause('backoff', 'retry later')
        await await_user('blocked', 'confirm')
        return { plain, structured }
      `),
      validateOnly: true,
    })

    await expect(host.result()).resolves.toMatchObject({
      value: 'would pause (back_off): retry later',
      stopReason: 'completed',
      agentsStarted: 2,
    })
    expect(host.ofType(WorkerToHostType.ChildStart)).toEqual([])
    expect(host.ofType(WorkerToHostType.Log).map(message => message.message)).toEqual([
      'would pause (back_off): retry later',
    ])
    host.close()
  })

  it('synthesizes schema-conforming validate-only results for the supported vocabulary', async () => {
    const host = fakeHost()
    void runWorkerSession(host.port, {
      ...init(`
        return await agent('structured', { schema: {
          type: 'object',
          required: ['findings', 'nested', 'numericChoice'],
          properties: {
            findings: { type: 'array', maxItems: 8, items: {
              type: 'object', required: ['file'], properties: { file: { type: 'string' } },
            } },
            nested: {
              type: 'object',
              required: ['enabled', 'mode', 'count', 'ratio', 'nil', 'choice', 'flags'],
              properties: {
                enabled: { type: 'boolean' },
                mode: { type: 'string', enum: ['strict', 'loose'] },
                count: { type: 'integer', const: 1 },
                ratio: { type: 'number' },
                nil: { type: 'null' },
                choice: { oneOf: [{ type: 'string', const: 'x' }, { type: 'boolean' }] },
                flags: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'boolean' } },
              },
            },
            numericChoice: { oneOf: [{ type: 'number' }, { type: 'integer' }] },
          },
        } })
      `),
      validateOnly: true,
    })

    await expect(host.result()).resolves.toEqual({
      value: {
        findings: [],
        nested: {
          enabled: false,
          mode: 'strict',
          count: 1,
          ratio: 0,
          nil: null,
          choice: 'x',
          flags: [false, false],
        },
        numericChoice: 0.5,
      },
      stopReason: 'completed',
      agentsStarted: 1,
    })
    expect(host.ofType(WorkerToHostType.ChildStart)).toEqual([])
    expect(host.ofType(WorkerToHostType.JournalCommit)).toEqual([])
    host.close()
  })

  it('makes a validate-only gate an uncatchable successful terminal', async () => {
    const host = fakeHost()
    void runWorkerSession(host.port, {
      ...init(`
        try { await await_user('user', 'confirm') } catch {}
        log('must not execute')
        return 'must not execute'
      `),
      validateOnly: true,
    })

    await expect(host.result()).resolves.toEqual({
      value: 'would await_user (user): confirm',
      stopReason: 'completed',
      agentsStarted: 0,
    })
    expect(host.ofType(WorkerToHostType.Log).map(frame => frame.message)).toEqual([
      'would await_user (user): confirm',
    ])
    host.close()
  })

  it('fails loudly when validate-only cannot synthesize an exact-one value', async () => {
    const host = fakeHost()
    void runWorkerSession(host.port, {
      ...init(`return await agent('impossible', { schema: {
        type: 'object',
        required: ['value'],
        properties: { value: { oneOf: [{}, {}] } },
      } })`),
      validateOnly: true,
    })

    await expect(host.result()).resolves.toMatchObject({
      value: null,
      stopReason: 'error',
      errorCode: 'UNSUPPORTED_SCHEMA',
      error: expect.stringContaining('could not synthesize') as unknown,
      agentsStarted: 1,
    })
    host.close()
  })

  it('replays narration, agents, and scratch calls without repeating committed effects or results', async () => {
    const scratch = new Map<string, string>()
    const body = `
      phase('Review')
      log('one-time narration')
      const priorChild = await agent('committed child')
      await write_scratch_file('state.txt', 'original')
      const observed = await read_scratch_file('state.txt')
      await await_user('user', 'continue')
      const resumedChild = await agent('new child')
      return { observed, priorChild, resumedChild }
    `
    const first = fakeHost({ scratch, reply: () => text('first result') })
    void runWorkerSession(first.port, init(body))
    await vi.waitFor(() => { expect(first.ofType(WorkerToHostType.Gate)).toHaveLength(1) })
    first.send({ type: HostToWorkerType.Cancel, reason: 'pause attempt' })
    await expect(first.result()).resolves.toMatchObject({ stopReason: 'cancelled', agentsStarted: 1 })
    const journal = first.ofType(WorkerToHostType.JournalCommit).map(frame => frame.entry)
    expect(journal.map(entry => entry.kind)).toEqual(['phase', 'log', 'agent', 'scratch-write', 'scratch-read'])
    first.close()

    scratch.set('state.txt', 'external mutation')
    const resumed = fakeHost({ scratch, reply: () => text('second result') })
    void runWorkerSession(resumed.port, {
      ...init(body),
      journal,
      initialAgentSpend: 1,
      initialAgentSeq: 1,
    })
    await vi.waitFor(() => { expect(resumed.ofType(WorkerToHostType.Gate)).toHaveLength(1) })
    expect(resumed.ofType(WorkerToHostType.Phase)).toEqual([])
    expect(resumed.ofType(WorkerToHostType.Log)).toEqual([])
    expect(resumed.ofType(WorkerToHostType.ScratchWrite)).toEqual([])
    expect(resumed.ofType(WorkerToHostType.ScratchRead)).toEqual([])
    expect(resumed.ofType(WorkerToHostType.AgentStart)).toEqual([])
    resumed.send({ type: HostToWorkerType.Resume })

    await expect(resumed.result()).resolves.toEqual({
      value: { observed: 'original', priorChild: 'first result', resumedChild: 'second result' },
      stopReason: 'completed',
      agentsStarted: 2,
    })
    expect(resumed.ofType(WorkerToHostType.AgentStart)).toHaveLength(1)
    expect(resumed.ofType(WorkerToHostType.AgentStart)[0]?.info.phase).toBe('Review')
    expect(scratch.get('state.txt')).toBe('external mutation')
    resumed.close()
  })

  it('does not count non-agent journal entries as logical-agent spend', async () => {
    const body = `
      phase('Only phase')
      log('Only log')
      await write_scratch_file('state.txt', 'value')
      return await read_scratch_file('state.txt')
    `
    const first = fakeHost()
    void runWorkerSession(first.port, init(body))
    await expect(first.result()).resolves.toMatchObject({ value: 'value', agentsStarted: 0 })
    const journal = first.ofType(WorkerToHostType.JournalCommit).map(frame => frame.entry)
    expect(journal.map(entry => entry.kind)).toEqual(['phase', 'log', 'scratch-write', 'scratch-read'])
    first.close()

    const replay = fakeHost()
    void runWorkerSession(replay.port, { ...init(body), journal })
    await expect(replay.result()).resolves.toEqual({ value: 'value', stopReason: 'completed', agentsStarted: 0 })
    expect(replay.ofType(WorkerToHostType.Phase)).toEqual([])
    expect(replay.ofType(WorkerToHostType.Log)).toEqual([])
    expect(replay.ofType(WorkerToHostType.ScratchWrite)).toEqual([])
    expect(replay.ofType(WorkerToHostType.ScratchRead)).toEqual([])
    replay.close()
  })

  it('replay skips an await_user gate that was satisfied before a later pause', async () => {
    const body = `
      await await_user('user', 'first gate')
      await pause('infra', 'later gate')
    `
    const first = fakeHost()
    void runWorkerSession(first.port, init(body))
    await vi.waitFor(() => { expect(first.ofType(WorkerToHostType.Gate)).toHaveLength(1) })
    first.send({ type: HostToWorkerType.Resume })
    await vi.waitFor(() => { expect(first.ofType(WorkerToHostType.Gate)).toHaveLength(2) })
    first.send({ type: HostToWorkerType.Cancel, reason: 'pause attempt' })
    await expect(first.result()).resolves.toMatchObject({ stopReason: 'cancelled' })
    const journal = first.ofType(WorkerToHostType.JournalCommit).map(frame => frame.entry)
    expect(journal.map(entry => entry.kind)).toEqual(['await-user'])
    first.close()

    const replay = fakeHost()
    void runWorkerSession(replay.port, { ...init(body), journal })
    await vi.waitFor(() => { expect(replay.ofType(WorkerToHostType.Gate)).toHaveLength(1) })
    expect(replay.ofType(WorkerToHostType.Gate)[0]?.gate).toEqual({
      kind: 'infra',
      message: 'later gate',
      resumable: false,
    })
    replay.send({ type: HostToWorkerType.Cancel, reason: 'stop replay' })
    await expect(replay.result()).resolves.toMatchObject({ stopReason: 'cancelled' })
    replay.close()
  })

  it('rejects a resumed path that skips a committed journal call', async () => {
    const host = fakeHost()
    void runWorkerSession(host.port, {
      ...init("return 'changed branch'"),
      journal: [{
        kind: 'log',
        ordinal: 1,
        callId: 'root/log:1',
        fingerprint: '0'.repeat(64),
        message: 'skipped',
      }],
    })

    await expect(host.result()).resolves.toMatchObject({
      value: null,
      stopReason: 'error',
      errorCode: 'JOURNAL_DIVERGENCE',
      agentsStarted: 0,
    })
    host.close()
  })

  it('await_user resumes past its gate while pause re-fires until cancellation', async () => {
    const resumable = fakeHost()
    void runWorkerSession(resumable.port, init("await await_user('user', 'continue?'); return 'continued'"))
    await vi.waitFor(() => { expect(resumable.ofType(WorkerToHostType.Gate)).toHaveLength(1) })
    resumable.send({ type: HostToWorkerType.Resume })
    await expect(resumable.result()).resolves.toMatchObject({ value: 'continued', stopReason: 'completed' })
    resumable.close()

    const repeating = fakeHost()
    void runWorkerSession(repeating.port, init("await pause('infra', 'still blocked'); return 'unreachable'"))
    await vi.waitFor(() => { expect(repeating.ofType(WorkerToHostType.Gate)).toHaveLength(1) })
    repeating.send({ type: HostToWorkerType.Resume })
    await vi.waitFor(() => { expect(repeating.ofType(WorkerToHostType.Gate)).toHaveLength(2) })
    repeating.send({ type: HostToWorkerType.Cancel, reason: 'stop repeating gate' })
    await expect(repeating.result()).resolves.toMatchObject({ stopReason: 'cancelled' })
    repeating.close()
  })

  it.each([
    ["await await_user('', '')", 'await_user() requires a non-empty kind string'],
    ["await pause(1, '')", 'pause() requires a non-empty kind string'],
    ["await await_user('unknown')", 'await_user() kind "unknown" is not recognized'],
    ["await pause('unknown')", 'pause() kind "unknown" is not recognized'],
    ["await await_user('user', 1)", 'await_user() message must be a string'],
    ["await pause('user', 1)", 'pause() message must be a string'],
  ])('rejects an invalid human gate: %s', async (body, diagnostic) => {
    const host = fakeHost()
    void runWorkerSession(host.port, init(body))
    const result = await host.result()
    expect(result).toMatchObject({ stopReason: 'error', errorCode: 'INVALID_ARGUMENT' })
    expect(result.error).toContain(diagnostic)
    host.close()
  })

  it('rejects concurrent gates inside one script', async () => {
    const host = fakeHost()
    void runWorkerSession(host.port, init(`
      await Promise.all([
        await_user('user', 'first'),
        await_user('verification', 'second'),
      ])
    `))
    await expect(host.result()).resolves.toMatchObject({
      stopReason: 'error',
      errorCode: 'INVALID_ARGUMENT',
      error: expect.stringContaining('only one pause()/await_user() gate') as unknown,
    })
    host.close()
  })

  it.each([
    [
      "return await parallel([() => 'thunk', { prompt: 'job' }])",
      'cannot mix function thunks and declarative job maps',
    ],
    [
      "return await parallel([{ get prompt() { throw new Error('getter failed') } }])",
      'must be a function or plain job map',
    ],
    ["return await parallel([{ prompt: '' }])", 'requires a non-empty "prompt" string'],
  ])('rejects an invalid declarative parallel panel: %s', async (body, diagnostic) => {
    const host = fakeHost({ reply: () => text('unexpected') })
    void runWorkerSession(host.port, init(body))
    const result = await host.result()
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain(diagnostic)
    expect(host.ofType(WorkerToHostType.ChildStart)).toEqual([])
    host.close()
  })

  it('rejects a declarative panel whose replay fingerprint changed before launching children', async () => {
    const first = fakeHost({ reply: () => text('first') })
    void runWorkerSession(first.port, init("return await parallel([{ prompt: 'original' }])"))
    await first.result()
    const entry = first.ofType(WorkerToHostType.JournalCommit)[0]!.entry
    first.close()

    const replay = fakeHost()
    void runWorkerSession(replay.port, {
      ...init("return await parallel([{ prompt: 'changed' }])"),
      journal: [entry],
      initialAgentSpend: 1,
      initialAgentSeq: 1,
    })
    await expect(replay.result()).resolves.toMatchObject({
      stopReason: 'error',
      errorCode: 'JOURNAL_DIVERGENCE',
    })
    expect(replay.ofType(WorkerToHostType.ChildStart)).toEqual([])
    replay.close()
  })

  it('numbers journal commits by reverse parallel settlement order and replays both without children', async () => {
    const body = 'return await parallel([{ prompt: \'first\' }, { prompt: \'second\' }])'
    const first = fakeHost({ manual: true })
    void runWorkerSession(first.port, init(body))
    await vi.waitFor(() => { expect(first.ofType(WorkerToHostType.ChildStart)).toHaveLength(2) })
    const starts = first.ofType(WorkerToHostType.ChildStart)
    first.send({ type: HostToWorkerType.ChildStarted, callId: starts[0]!.callId, childId: 'child-first' })
    first.send({ type: HostToWorkerType.ChildStarted, callId: starts[1]!.callId, childId: 'child-second' })
    await vi.waitFor(() => { expect(first.ofType(WorkerToHostType.AgentStart)).toHaveLength(2) })
    first.send({
      type: HostToWorkerType.ChildSettled,
      callId: starts[1]!.callId,
      result: text('second result'),
    })
    await vi.waitFor(() => { expect(first.ofType(WorkerToHostType.JournalCommit)).toHaveLength(1) })
    first.send({
      type: HostToWorkerType.ChildSettled,
      callId: starts[0]!.callId,
      result: text('first result'),
    })

    await expect(first.result()).resolves.toEqual({
      value: ['first result', 'second result'],
      stopReason: 'completed',
      agentsStarted: 2,
    })
    const journal = first.ofType(WorkerToHostType.JournalCommit).map(frame => frame.entry)
    expect(journal.map(entry => ({ ordinal: entry.ordinal, seq: entry.kind === 'agent' ? entry.seq : null })))
      .toEqual([{ ordinal: 1, seq: 2 }, { ordinal: 2, seq: 1 }])
    first.close()

    const replay = fakeHost()
    void runWorkerSession(replay.port, {
      ...init(body),
      journal,
      initialAgentSpend: 2,
      initialAgentSeq: 2,
    })
    await expect(replay.result()).resolves.toEqual({
      value: ['first result', 'second result'],
      stopReason: 'completed',
      agentsStarted: 2,
    })
    expect(replay.ofType(WorkerToHostType.ChildStart)).toEqual([])
    expect(replay.ofType(WorkerToHostType.JournalCommit)).toEqual([])
    replay.close()
  })

  const invalidJournals: NonNullable<WorkerInit['journal']>[] = [
    [{ kind: 'log', ordinal: 2, callId: 'gap', fingerprint: '0'.repeat(64), message: 'gap' }],
    [{ kind: 'agent', ordinal: 1, seq: 0, callId: 'a', fingerprint: '0'.repeat(64), result: null }],
    [{ kind: 'agent', ordinal: 1, seq: 1, callId: '', fingerprint: '0'.repeat(64), result: null }],
    [
      { kind: 'agent', ordinal: 1, seq: 1, callId: 'a', fingerprint: '0'.repeat(64), result: null },
      { kind: 'agent', ordinal: 2, seq: 2, callId: 'a', fingerprint: '0'.repeat(64), result: null },
    ],
    [
      { kind: 'agent', ordinal: 1, seq: 1, callId: 'a', fingerprint: '0'.repeat(64), result: null },
      { kind: 'agent', ordinal: 2, seq: 1, callId: 'b', fingerprint: '0'.repeat(64), result: null },
    ],
    [{ kind: 'agent', ordinal: 1, seq: 1, callId: 'a', fingerprint: 'invalid', result: null }],
    [
      { kind: 'log', ordinal: 2, callId: 'a', fingerprint: '0'.repeat(64), message: 'a' },
      { kind: 'log', ordinal: 1, callId: 'b', fingerprint: '0'.repeat(64), message: 'b' },
    ],
  ]
  it.each(invalidJournals.map(journal => ({ journal })))(
    'maps an ambiguous journal to a constructor error result: $journal',
    async ({ journal }) => {
      const host = fakeHost()
      await runWorkerSession(host.port, { ...init("return 'unreachable'"), journal })
      await expect(host.result()).resolves.toMatchObject({
        value: null,
        stopReason: 'error',
        error: expect.stringMatching(/journal/) as unknown,
      })
      host.close()
    },
  )

  it('maps a non-WorkflowError constructor failure without inventing an error code', async () => {
    const host = fakeHost()
    const entry = {
      kind: 'agent' as const,
      ordinal: 1,
      get seq(): number { throw new Error('journal getter exploded') },
      callId: 'a',
      fingerprint: '0'.repeat(64),
      result: null,
    }
    await runWorkerSession(host.port, { ...init("return 'unreachable'"), journal: [entry] })
    await expect(host.result()).resolves.toMatchObject({
      value: null,
      stopReason: 'error',
      error: expect.stringContaining('Error: journal getter exploded') as unknown,
      agentsStarted: 1,
    })
    host.close()
  })

})

describe('the worker bootstrap', () => {
  it('requireParentPort narrows a real port and throws on the main thread', () => {
    const channel = new MessageChannel()
    expect(requireParentPort(channel.port1)).toBe(channel.port1)
    channel.port1.close()
    expect(() => requireParentPort(null)).toThrow(/inside a worker thread/)
  })

  it('the entry module itself throws when loaded on the main thread (no parentPort)', async () => {
    // This import EXECUTES ../src/worker.ts on the main thread, which is what
    // covers the bootstrap file: requireParentPort throws before
    // runWorkerSession is reached.
    await expect(import('../src/worker.ts')).rejects.toThrow(/inside a worker thread/)
  })
})
