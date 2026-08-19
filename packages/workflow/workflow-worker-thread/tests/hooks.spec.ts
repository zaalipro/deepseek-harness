import { describe, expect, it } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import { HostToWorkerType, WorkerToHostType } from '../src/protocol.ts'
import type { HostToWorkerMessage, WorkerToHostMessage } from '../src/protocol.ts'
import { runWorkerSession } from '../src/session.ts'
import type { ChildResult, WorkerInit } from '../src/types.ts'

/** A completed text child result. */
function text(reply: string): ChildResult {
  return { output: [{ type: 'text', text: reply }], stopReason: 'completed' }
}

function init(body: string, overrides?: { args?: unknown; journal?: WorkerInit['journal']; limits?: Partial<WorkerInit['limits']> }): WorkerInit {
  return {
    meta: { name: 'test-flow', description: 'a test workflow' },
    body,
    limits: { maxConcurrentAgents: 8, maxTotalAgents: 1000, maxItemsPerCall: 4096, syncTimeoutMs: 5000, ...overrides?.limits },
    ...overrides?.args !== undefined ? { args: overrides.args } : {},
    ...overrides?.journal !== undefined ? { journal: overrides.journal } : {},
  }
}

/**
 * Drive one session with a scripted host port. Port1 is the host side the test
 * sends messages on and reads worker messages from.
 */
interface Harness {
  host: MessagePort
  worker: MessagePort
  messages: WorkerToHostMessage[]
  ofType<T extends WorkerToHostMessage['type']>(type: T): Extract<WorkerToHostMessage, { type: T }>[]
  result: Promise<Extract<WorkerToHostMessage, { type: 'result' }>['result']>
}

function harness(options?: {
  reply?: (prompt: string, index: number) => ChildResult | undefined
  go?: boolean
}): Harness {
  const channel = new MessageChannel()
  const messages: WorkerToHostMessage[] = []
  const resultGate = Promise.withResolvers<Extract<WorkerToHostMessage, { type: 'result' }>['result']>()
  let childIndex = 0
  channel.port1.on('message', (message: WorkerToHostMessage) => {
    messages.push(message)
    switch (message.type) {
      case WorkerToHostType.Ready:
        if (options?.go !== false) channel.port1.postMessage({ type: HostToWorkerType.Go } satisfies HostToWorkerMessage)
        break
      case WorkerToHostType.ChildStart: {
        const index = childIndex++
        channel.port1.postMessage({ type: HostToWorkerType.ChildStarted, callId: message.callId, childId: `child-${index}` } satisfies HostToWorkerMessage)
        const reply = options?.reply?.(message.request.prompt, index)
        if (reply !== undefined) {
          channel.port1.postMessage({
            type: HostToWorkerType.ChildSettled,
            callId: message.callId,
            result: reply,
          } satisfies HostToWorkerMessage)
        }
        break
      }
      case WorkerToHostType.ChildDispose:
        channel.port1.postMessage({ type: HostToWorkerType.ChildDisposed, callId: message.callId } satisfies HostToWorkerMessage)
        break
      case WorkerToHostType.ScratchWrite:
      case WorkerToHostType.ScratchRead:
        // No scratch dir in these in-process sessions; the real host acks via
        // the post. Send the matching ack so the script can continue.
        channel.port1.postMessage(
          message.type === WorkerToHostType.ScratchWrite
            ? { type: HostToWorkerType.ScratchWritten, callId: message.callId } satisfies HostToWorkerMessage
            : { type: HostToWorkerType.ScratchReadResult, callId: message.callId } satisfies HostToWorkerMessage,
        )
        break
      case WorkerToHostType.Result:
        resultGate.resolve(message.result)
        break
      default:
        break
    }
  })
  return {
    host: channel.port1,
    worker: channel.port2,
    messages,
    ofType: type => messages.filter((message): message is never => message.type === type),
    result: resultGate.promise,
  }
}

describe('workflow script hooks', () => {
  it('complete(value) ends the run with that value even when caught, and budget() reports spend', async () => {
    const h = harness({ reply: (_p, i) => text(`reply-${i}`) })
    void runWorkerSession(h.worker, init(`
      const first = budget()
      await agent('one')
      const second = budget()
      try { complete({ done: true, spent: second.spent }) } catch (e) {}
      return 'ignored'
    `))
    const result = await h.result
    expect(result.stopReason).toBe('completed')
    expect(result.value).toEqual({ done: true, spent: 1 })
    expect(result.agentsStarted).toBe(1)
  })

  it('budget() starts at the total cap with zero reserved', async () => {
    const h = harness()
    void runWorkerSession(h.worker, init('complete(budget())', {
      limits: { maxTotalAgents: 128 },
    }))
    const result = await h.result
    expect(result.value).toEqual({ total: 128, spent: 0, reserved: 0, remaining: 128 })
  })

  it('parallel(map-array) launches one agent per job map and guards failed slots as null', async () => {
    const h = harness({ reply: (_p, i) => i === 0 ? text('ok') : { output: [], stopReason: 'failed' } })
    void runWorkerSession(h.worker, init(`
      const results = await parallel([
        { prompt: 'a' },
        { prompt: 'b', label: 'bee' },
      ])
      complete({ results })
    `))
    const result = await h.result
    expect(result.value).toEqual({ results: ['ok', null] })
  })

  it('journal replay returns committed results without launching the replayed children', async () => {
    const h = harness({ reply: (_p, i) => text(`live-${i}`) })
    void runWorkerSession(h.worker, init(`
      const one = await agent('one')
      const two = await agent('two')
      complete({ one, two })
    `, {
      journal: [{ seq: 1, result: 'committed' }],
    }))
    const result = await h.result
    expect(result.value).toEqual({ one: 'committed', two: 'live-0' })
    // Only the second agent() launched a live child.
    expect(h.ofType(WorkerToHostType.ChildStart).length).toBe(1)
    expect(result.agentsStarted).toBe(1)
  })

  it('await_user parks and resume continues past the gate', async () => {
    const h = harness({ go: false })
    const session = runWorkerSession(h.worker, init(`
      await await_user('verification', 'please confirm')
      complete('continued')
    `))
    // Release the startup gate, then await the park.
    await Promise.resolve()
    h.host.postMessage({ type: HostToWorkerType.Go } satisfies HostToWorkerMessage)
    await Promise.resolve()
    // Wait until the gate arrives, then resume.
    await waitFor(() => h.ofType(WorkerToHostType.Gate).length === 1)
    expect(h.ofType(WorkerToHostType.Gate).at(0)?.gate.resumable).toBe(true)
    h.host.postMessage({ type: HostToWorkerType.Resume } satisfies HostToWorkerMessage)
    const result = await h.result
    expect(result.value).toBe('continued')
    void session
  })

  it('pause re-fires on every resume', async () => {
    const h = harness({ go: false })
    void runWorkerSession(h.worker, init('await pause(\'user\', \'missing args\')'))
    h.host.postMessage({ type: HostToWorkerType.Go } satisfies HostToWorkerMessage)
    await waitFor(() => h.ofType(WorkerToHostType.Gate).length === 1)
    expect(h.ofType(WorkerToHostType.Gate).at(0)?.gate.resumable).toBe(false)
    h.host.postMessage({ type: HostToWorkerType.Resume } satisfies HostToWorkerMessage)
    // Re-fires: a second gate arrives and the run never settles.
    await waitFor(() => h.ofType(WorkerToHostType.Gate).length === 2)
  })
})

/** Poll until `predicate` holds or the 2s bound expires. */
async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > 2000) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
