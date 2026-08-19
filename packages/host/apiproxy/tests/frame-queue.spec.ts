import { describe, expect, it, vi } from 'vitest'
import { FrameQueue } from '../src/frame-queue.ts'

async function drain<T>(queue: FrameQueue<T>): Promise<T[]> {
  const abort = new AbortController()
  const values: T[] = []
  for await (const value of queue.iterate(abort.signal, () => {})) values.push(value)
  return values
}

describe('FrameQueue keyed lane', () => {
  it('preserves a long ordinary queue across consumed-prefix compaction', async () => {
    const queue = new FrameQueue<number>()
    const values = Array.from({ length: 1100 }, (_, index) => index)
    for (const value of values) queue.push(value)
    queue.end()

    await expect(drain(queue)).resolves.toEqual(values)
  })

  it('keeps only the latest unread value for each key', async () => {
    const queue = new FrameQueue<number>()
    queue.pushCoalesced('a', 1)
    queue.pushCoalesced('a', 2)
    queue.pushCoalesced('b', 3)
    queue.end()

    await expect(drain(queue)).resolves.toEqual([2, 3])
  })

  it('collapses over-cap keys into one global invalidation', async () => {
    const queue = new FrameQueue<number>()
    queue.pushCoalescedBounded('a', 1, 2, '*', 99)
    queue.pushCoalescedBounded('b', 2, 2, '*', 99)
    queue.pushCoalescedBounded('c', 3, 2, '*', 99)
    queue.pushCoalescedBounded('d', 4, 2, '*', 99)
    queue.end()

    await expect(drain(queue)).resolves.toEqual([99])
  })

  it('replaces a partially queued keyed lane explicitly', async () => {
    const queue = new FrameQueue<number>()
    queue.pushCoalesced('a', 1)
    queue.pushCoalesced('b', 2)
    queue.replaceCoalescedLane('*', 99)
    queue.end()

    await expect(drain(queue)).resolves.toEqual([99])
  })

  it('preserves ordinary values when keyed lanes overflow or are replaced', async () => {
    const overflow = new FrameQueue<number>()
    overflow.push(0)
    overflow.pushCoalescedBounded('a', 1, 1, '*', 99)
    overflow.pushCoalescedBounded('b', 2, 1, '*', 99)
    overflow.pushCoalescedBounded('c', 3, 1, '*', 100)
    overflow.end()
    await expect(drain(overflow)).resolves.toEqual([0, 100])

    const replaced = new FrameQueue<number>()
    replaced.push(0)
    replaced.pushCoalesced('a', 1)
    replaced.replaceCoalescedLane('*', 99)
    replaced.end()
    await expect(drain(replaced)).resolves.toEqual([0, 99])
  })

  it('ignores every producer method after completion', async () => {
    const queue = new FrameQueue<number>()
    queue.end()
    queue.push(1)
    queue.pushCoalesced('a', 2)
    queue.pushCoalescedBounded('b', 3, 1, '*', 99)
    queue.replaceCoalescedLane('*', 100)

    await expect(drain(queue)).resolves.toEqual([])
  })

  it('wakes a waiting reader when a producer appends', async () => {
    const queue = new FrameQueue<number>()
    const cleanup = vi.fn()
    const abort = new AbortController()
    const iterator = queue.iterate(abort.signal, cleanup)
    const waiting = iterator.next()

    queue.push(1)
    await expect(waiting).resolves.toEqual({ done: false, value: 1 })
    queue.end()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('ends a waiting reader on abort and drops later writes', async () => {
    const queue = new FrameQueue<number>()
    const cleanup = vi.fn()
    const abort = new AbortController()
    const iterator = queue.iterate(abort.signal, cleanup)
    const waiting = iterator.next()

    abort.abort()
    queue.push(1)
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('cleans up when a consumer returns before the queue ends', async () => {
    const queue = new FrameQueue<number>()
    const cleanup = vi.fn()
    const abort = new AbortController()
    queue.pushCoalesced('a', 1)
    queue.push(2)
    const iterator = queue.iterate(abort.signal, cleanup)

    await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 })
    await expect(iterator.return(undefined)).resolves.toEqual({ done: true, value: undefined })
    expect(cleanup).toHaveBeenCalledOnce()
    queue.end()
  })
})
