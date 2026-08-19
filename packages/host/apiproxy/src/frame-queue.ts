/**
 * Bounded-retention queue primitives for streamed Host frames.
 *
 * @module @deepseek-ai/dsh-host-apiproxy/frame-queue
 */

/** Consumed prefix length that justifies copying the unread queue suffix. */
const FRAME_QUEUE_COMPACT_MIN_HEAD = 1024

type FrameQueueEntry<F> =
  | { readonly kind: 'value'; readonly value: F }
  | { readonly kind: 'coalesced'; readonly key: string }

/** Async frame queue with an optional latest-only lane for invalidation-style events. */
export class FrameQueue<F> {
  private buffer: FrameQueueEntry<F>[] = []
  private head = 0
  private readonly coalesced = new Map<string, F>()
  private waiter: (() => void) | undefined
  private done = false

  /**
   * Append one ordinary FIFO item.
   * @param item - ordinary item that must not coalesce.
   */
  push(item: F): void {
    if (this.done) return
    this.buffer.push({ kind: 'value', value: item })
    this.waiter?.()
  }

  /**
   * Keep only the latest unread item for one key at that key's first marker.
   * @param key - coalescing identity.
   * @param item - latest value for that identity.
   */
  pushCoalesced(key: string, item: F): void {
    if (this.done) return
    if (!this.coalesced.has(key)) this.buffer.push({ kind: 'coalesced', key })
    this.coalesced.set(key, item)
    this.waiter?.()
  }

  /**
   * Collapse an over-cap keyed lane into one global invalidation item.
   * @param key - coalescing identity.
   * @param item - latest value for that identity.
   * @param maxKeys - maximum simultaneous keyed values.
   * @param overflowKey - identity of the lane-wide invalidation.
   * @param overflowItem - invalidation value replacing keyed values.
   */
  pushCoalescedBounded(
    key: string,
    item: F,
    maxKeys: number,
    overflowKey: string,
    overflowItem: F,
  ): void {
    if (this.done) return
    if (this.coalesced.has(overflowKey)) {
      this.coalesced.set(overflowKey, overflowItem)
      this.waiter?.()
      return
    }
    if (this.coalesced.has(key) || this.coalesced.size < maxKeys) {
      this.pushCoalesced(key, item)
      return
    }
    this.coalesced.clear()
    this.buffer = this.buffer.slice(this.head).filter(entry => entry.kind !== 'coalesced')
    this.head = 0
    this.pushCoalesced(overflowKey, overflowItem)
  }

  /**
   * Replace every unread keyed item with one lane-wide invalidation.
   * @param key - identity of the lane-wide invalidation.
   * @param item - invalidation value replacing keyed values.
   */
  replaceCoalescedLane(key: string, item: F): void {
    if (this.done) return
    this.coalesced.clear()
    this.buffer = this.buffer.slice(this.head).filter(entry => entry.kind !== 'coalesced')
    this.head = 0
    this.pushCoalesced(key, item)
  }

  /** Mark the queue complete after buffered items drain. */
  end(): void {
    this.done = true
    this.waiter?.()
  }

  /**
   * Consume queued values until completion or abort.
   * @param signal - reader lifetime.
   * @param cleanup - invoked exactly once as iteration ends.
   * @returns asynchronous FIFO value stream.
   */
  async *iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<F> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        while (this.head < this.buffer.length) {
          const entry = this.buffer[this.head] as FrameQueueEntry<F>
          this.head += 1
          // A producer can append between generator yields forever. Compact a
          // sufficiently large consumed prefix before yielding so those
          // already-delivered frames do not remain retained until an idle gap.
          if (this.head >= FRAME_QUEUE_COMPACT_MIN_HEAD
            && this.head * 2 >= this.buffer.length) {
            this.buffer = this.buffer.slice(this.head)
            this.head = 0
          }
          if (entry.kind === 'value') {
            yield entry.value
            continue
          }
          const item = this.coalesced.get(entry.key) as F
          this.coalesced.delete(entry.key)
          yield item
        }
        this.buffer = []
        this.head = 0
        if (this.done || signal.aborted) return
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.buffer = []
      this.head = 0
      this.coalesced.clear()
      cleanup()
    }
  }
}
