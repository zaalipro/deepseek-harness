/**
 * Exact-once, bounded delivery of one logical workflow run's terminal notice.
 * The supervisor calls this only after the active engine attempt has settled
 * and its handle has been disposed; attempt cancellations used for pause never
 * enter this module.
 *
 * @module @deepseek-ai/dsh-workflow-supervisor/completion-notice
 */

import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { WorkflowResult } from '@deepseek-ai/dsh-workflow'

/** Logical terminal state accepted by the completion-notice producer. */
export type WorkflowCompletionStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted'

/** Stable object owned by one logical supervised run, used for exact-once delivery. */
export type WorkflowCompletionToken = object

/** Inputs retained until the logical run reaches a terminal state. */
export interface WorkflowCompletionNoticeInput {
  /** One stable object reused across every attempt of the logical run. */
  readonly token: WorkflowCompletionToken
  /** Exact live Agent that launched the run; same-session replacements are not eligible. */
  readonly parent: Agent
  /** Session-unique human handle. */
  readonly displayName: string
  /** Logical terminal state, never an attempt-level pause cancellation. */
  readonly status: WorkflowCompletionStatus
  /** Active attempt's terminal engine result, when one exists. */
  readonly result?: WorkflowResult
  /** Absolute run directory; only the fixed `scratch/report.md` child is probed. */
  readonly scratchDir?: string
}

/** Delivery budgets resolved by the supervisor's plugin Config. */
export interface WorkflowCompletionNoticeOptions {
  /** Maximum UTF-8 bytes in the model-visible notice body. */
  readonly maxBytes: number
  /** Maximum completion cohorts that may open owner turns before human input is consumed. */
  readonly maxConsecutiveWakes: number
}

interface WorkflowCompletionReservation {
  readonly parent: Agent
  readonly batch: number
}

interface WorkflowCompletionWakeState {
  openBatch: number
  wokenThrough: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const REPORT_REFERENCE = 'Scratch report: scratch/report.md.'
const OPEN_DASHBOARD = 'Open /workflows to inspect the run.'
const TRUNCATED = '[notice truncated]'

/** Render a thrown delivery failure without invoking it more than once. */
function renderThrown(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/** Keep a UTF-8-safe prefix within an exact byte budget. */
function retainHead(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

/** Count encoded bytes without depending on Node Buffer in browser-safe helpers. */
function byteLength(text: string): number {
  return encoder.encode(text).byteLength
}

/**
 * Serialize the JSON value promised by {@link WorkflowResult}. The defensive
 * fallback keeps notification failure contained if a nonconforming engine is
 * mounted behind the workflow capability.
 */
function renderResult(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return '[result could not be serialized]'
  }
}

/** Human-readable terminal clause for the notice heading. */
function statusClause(status: WorkflowCompletionStatus): string {
  switch (status) {
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': return 'was stopped'
    case 'interrupted': return 'was interrupted'
  }
}

/** Optional terminal detail following the heading. */
function detailText(input: Pick<WorkflowCompletionNoticeInput, 'status' | 'result'>): string {
  if (input.status === 'completed') {
    return `\nResult:\n${renderResult(input.result?.value ?? null)}`
  }
  const error = input.result?.error
  return error === undefined || error.length === 0 ? '' : `\nReason: ${error}`
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Fit caller text while preserving the recovery footer. The whole returned
 * string, including the display handle and failure detail, is bounded in UTF-8
 * bytes and never cuts a code point.
 */
function fitNotice(content: string, footer: string, maxBytes: number): string {
  const complete = `${content}\n${footer}`
  if (byteLength(complete) <= maxBytes) return complete

  const fixed = `\n${TRUNCATED}\n${footer}`
  const fixedBytes = byteLength(fixed)
  // Config validation keeps the normal product budget above this footer. This
  // arm also makes the exported renderer total for direct callers.
  if (fixedBytes >= maxBytes) return retainHead(fixed, maxBytes)
  return `${retainHead(content, maxBytes - fixedBytes)}${fixed}`
}

/**
 * Render one terminal notice, preferring bounded scratch-report content over
 * the engine result when the conventional report exists.
 * @param input - logical run identity and terminal result.
 * @param maxBytes - positive UTF-8 byte ceiling for the complete text.
 * @param report - bounded UTF-8 contents of a regular `scratch/report.md`.
 * @returns bounded model-visible notice text.
 */
export function renderWorkflowCompletionNotice(
  input: Pick<WorkflowCompletionNoticeInput, 'displayName' | 'status' | 'result'>,
  maxBytes: number,
  report: string | undefined,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('workflow completion notice maxBytes must be a positive safe integer')
  }
  const heading = `workflow "${input.displayName}" ${statusClause(input.status)}.`
  const footer = report === undefined ? OPEN_DASHBOARD : `${REPORT_REFERENCE}\n${OPEN_DASHBOARD}`
  const detail = report === undefined ? detailText(input) : `\nScratch report:\n${report}`
  return fitNotice(`${heading}${detail}`, footer, maxBytes)
}

/** Read a bounded conventional report without following or racing its final path. */
async function readScratchReport(scratchDir: string | undefined, maxBytes: number): Promise<string | undefined> {
  if (scratchDir === undefined) return undefined
  const path = join(scratchDir, 'scratch', 'report.md')
  try {
    const pathInfo = await lstat(path, { bigint: true })
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) return undefined
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat({ bigint: true })
      if (!info.isFile() || !sameFile(pathInfo, info)) return undefined
      const oversized = info.size > BigInt(maxBytes)
      const capacity = oversized ? maxBytes : Number(info.size)
      const bytes = new Uint8Array(capacity)
      let bytesRead = 0
      while (bytesRead < capacity) {
        const read = await handle.read(bytes, bytesRead, capacity - bytesRead, bytesRead)
        if (read.bytesRead === 0) break
        bytesRead += read.bytesRead
      }
      const after = await handle.stat({ bigint: true })
      if (!sameFile(info, after) || info.size !== after.size || info.mtimeNs !== after.mtimeNs) return undefined
      if (!oversized && bytesRead !== Number(info.size)) return undefined
      if (!oversized) return decoder.decode(bytes.subarray(0, bytesRead))
      for (let retained = bytesRead; retained >= Math.max(0, bytesRead - 3); retained -= 1) {
        try {
          return decoder.decode(bytes.subarray(0, retained))
        } catch {
          // An oversized valid report may end this bounded read mid-code-point.
        }
      }
      return undefined
    } finally {
      await handle.close()
    }
  } catch {
    // Absence, malformed UTF-8, links, replacement, and access failure all
    // omit the optional report without suppressing the terminal notice.
    return undefined
  }
}

/**
 * Session-scoped notifier. A token is claimed before filesystem probing or
 * delivery, so concurrent terminal callbacks, owner disposal, and routing
 * errors still produce at most one delivery attempt.
 */
export class WorkflowCompletionNotifier {
  private readonly delivered = new WeakSet<WorkflowCompletionToken>()
  private readonly reservations = new WeakMap<WorkflowCompletionToken, WorkflowCompletionReservation>()
  private readonly wakeStates = new WeakMap<Agent, WorkflowCompletionWakeState>()
  private readonly spentWakes = new WeakMap<Agent, number>()

  /**
   * @param ctx - supervisor plugin context used for inbox observations and warnings.
   * @param options - resolved output and wake budgets.
   */
  constructor(
    private readonly ctx: Context,
    private readonly options: WorkflowCompletionNoticeOptions,
  ) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new Error('workflow completion notice maxBytes must be a positive safe integer')
    }
    if (!Number.isSafeInteger(options.maxConsecutiveWakes) || options.maxConsecutiveWakes < 1) {
      throw new Error('workflow completion notice maxConsecutiveWakes must be a positive safe integer')
    }
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (message.source.kind === 'user') this.spentWakes.delete(agent)
    })
  }

  /**
   * Join a logical terminal run to the owner's currently open completion
   * cohort before durable publication or report probing can reorder delivery.
   * @param token - stable logical-run token.
   * @param parent - exact Agent that owns any turn opened for the cohort.
   */
  reserve(token: WorkflowCompletionToken, parent: Agent): void {
    const existing = this.reservations.get(token)
    if (existing !== undefined) {
      if (existing.parent !== parent) throw new Error('workflow completion token changed owner')
      return
    }
    const state = this.wakeState(parent)
    this.reservations.set(token, { parent, batch: state.openBatch })
  }

  /**
   * Attempt one logical terminal delivery. Repeated calls with the same token
   * are ignored, including after a contained delivery failure.
   * @param input - logical run, exact owner, terminal result, and scratch root.
   * @returns `true` when this call owned the one delivery attempt; `false` for a duplicate.
   */
  async notify(input: WorkflowCompletionNoticeInput): Promise<boolean> {
    if (this.delivered.has(input.token)) return false
    this.delivered.add(input.token)
    this.reserve(input.token, input.parent)
    const reservation = this.reservations.get(input.token)
    if (reservation === undefined || reservation.parent !== input.parent) {
      throw new Error('workflow completion reservation is inconsistent')
    }

    const text = renderWorkflowCompletionNotice(
      input,
      this.options.maxBytes,
      await readScratchReport(input.scratchDir, this.options.maxBytes),
    )
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'workflow-supervisor',
        form: 'notice',
        summary: boundContextSummary(`workflow ${input.displayName} ${statusClause(input.status)}`),
      },
    })

    try {
      const state = this.wakeState(input.parent)
      const spent = this.spentWakes.get(input.parent) ?? 0
      if (reservation.batch > state.wokenThrough && spent < this.options.maxConsecutiveWakes) {
        state.wokenThrough = reservation.batch
        if (state.openBatch === reservation.batch) state.openBatch += 1
        this.spentWakes.set(input.parent, spent + 1)
        input.parent.followup(message)
      } else {
        input.parent.inject(message)
      }
    } catch (error) {
      this.ctx.logger.warn(`workflow-supervisor: completion notice delivery failed: ${renderThrown(error)}`)
    }
    return true
  }

  private wakeState(parent: Agent): WorkflowCompletionWakeState {
    const existing = this.wakeStates.get(parent)
    if (existing !== undefined) return existing
    const created = { openBatch: 0, wokenThrough: -1 }
    this.wakeStates.set(parent, created)
    return created
  }
}
