/**
 * Per-run worker-side vm hooks, child RPC, concurrency/caps, cancellation, and result serialization; it
 * never touches Cordis. Script values leaving the realm are materialized as plain JSON before
 * messaging. Values entering the trusted model-written realm are passed directly; `args` alone is
 * cloned so script mutation cannot alter initialization data. See `./realm.ts` for the trust model.
 *
 * Fatal workflow errors—bad hook arguments, unsupported schemas/options, caps, start failures, and
 * cancellation—propagate through combinators. Only child failures and ordinary stage errors become
 * per-item nulls. Every returned promise has a rejection consumer so dropped script promises cannot
 * kill the worker. A cancelled script that never settles emits nothing; the host force-settles the
 * run within grace and terminates the thread.
 * @module @deepseek-ai/dsh-workflow-worker-thread/runtime
 */

import * as vm from 'node:vm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assertObjectJsonSchema, JsonSchemaError } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { isFatalWorkflowError, WorkflowError } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowGateInfo,
  WorkflowGateKind,
  WorkflowJournalEntry,
  WorkflowMeta,
  WorkflowResult,
} from '@deepseek-ai/dsh-workflow'
import { materializeFromRealm, MaterializeError, renderThrown } from './realm.ts'
import type { ChildHandle, ChildPort, WorkerLimits } from './types.ts'

/** The observers the execution reports progress through (the session posts them to the host). */
export interface ExecutionObserver {
  phase(title: string): void
  log(message: string): void
  agentStart(info: WorkflowAgentInfo): void
  agentEnd(info: WorkflowAgentEndInfo): void
  gate(gate: WorkflowGateInfo): void
  agentResult(seq: number, result: unknown): void
}

/** The `agent()` options the script may pass; everything else rejects loud. */
const SUPPORTED_AGENT_OPTIONS = new Set(['label', 'phase', 'schema', 'provider', 'model'])
/** Deferred Claude Code options we name explicitly in the rejection message. */
const DEFERRED_AGENT_OPTIONS = new Set(['effort', 'isolation', 'agentType'])

/** Flatten a child's final output blocks to text (the non-schema `agent()` result). */
function outputText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** A short display label derived from the prompt when the script passes none. */
function defaultLabel(prompt: string): string {
  const newline = prompt.indexOf('\n')
  const line = newline === -1 ? prompt : prompt.slice(0, newline)
  return line.length <= 48 ? line : `${line.slice(0, 47)}…`
}

/**
 * One live script execution inside the worker. Constructed per run by the
 * session; `drive()` is called exactly once and NEVER rejects — every failure
 * becomes a {@link WorkflowResult} with a non-`completed` stop reason. The
 * host owns cancellation and cleanup of any dropped child work.
 */
export class WorkflowExecution {
  /** 1-based count of live `agent()` calls launched (the `agentsStarted` result field + budget spend). */
  private started = 0
  /** 1-based count of every `agent()` invocation, journal-replayed or live (journal alignment). */
  private callSeq = 0
  private activeSlots = 0
  private readonly slotWaiters: { resolve(): void; reject(error: unknown): void }[] = []
  private cancelReason: string | undefined
  private cancelError: WorkflowError | undefined
  private currentPhase: string | undefined
  /** A `complete(value)` terminal, set before the sentinel throw. */
  private completed: { value: unknown } | undefined
  /** Resolver for the gate the script is currently parked on. */
  private gateResume: (() => void) | undefined
  private readonly journal: ReadonlyMap<number, WorkflowJournalEntry>
  private readonly context: vm.Context
  private readonly compiled: vm.Script

  constructor(
    meta: WorkflowMeta,
    body: string,
    args: unknown,
    private readonly limits: WorkerLimits,
    private readonly observer: ExecutionObserver,
    private readonly children: ChildPort,
    journal: readonly WorkflowJournalEntry[] | undefined,
    private readonly validateOnly = false,
  ) {
    // Compile FIRST: a body syntax error must throw out of the constructor
    // before any realm state exists. The host pre-parses the identical
    // wrapper, so under one Node version this throw is unreachable in
    // production — the session still maps it to an error result defensively.
    // lineOffset compensates for the wrapper line, so stack traces carry the
    // script's own line numbers.
    try {
      this.compiled = new vm.Script(`(async () => {\n${body}\n})()`, {
        filename: `workflow:${meta.name}`,
        lineOffset: -1,
      })
    } catch (error: unknown) {
      throw new WorkflowError(`workflow script does not parse: ${String(error)}`, 'SCRIPT_PARSE', { cause: error })
    }

    this.journal = new Map((journal ?? []).map(entry => [entry.seq, entry]))
    this.context = vm.createContext({}, { name: `workflow:${meta.name}` })

    const globals: Record<string, unknown> = {
      agent: (prompt: unknown, opts?: unknown) => this.contain(this.agent(prompt, opts)),
      parallel: (items: unknown) => this.contain(this.parallel(items)),
      pipeline: (items: unknown, ...stages: unknown[]) => this.contain(this.pipeline(items, stages)),
      phase: (title: unknown) => { this.phase(title) },
      log: (message: unknown) => { this.log(message) },
      complete: (value: unknown) => { this.complete(value) },
      pause: (kind: unknown, message?: unknown) => this.contain(this.gate(kind, message, false)),
      await_user: (kind: unknown, message?: unknown) => this.contain(this.gate(kind, message, true)),
      budget: () => this.budget(),
      write_scratch_file: (name: unknown, content: unknown) => this.contain(this.writeScratch(name, content)),
      read_scratch_file: (name: unknown) => this.contain(this.readScratch(name)),
      // workerData already performed the real cross-thread structured clone.
      args,
    }
    for (const [key, value] of Object.entries(globals)) {
      // Data properties on the contextified global; frozen shape not required —
      // a script overwriting its own hooks only sabotages itself.
      ;(this.context as Record<string, unknown>)[key] = typeof value === 'function' ? Object.freeze(value) : value
    }
  }

  /** Release the gate the script is parked on, if any. */
  resume(): void {
    this.gateResume?.()
  }

  /**
   * Whether the run has been cancelled. A METHOD, not an inline property
   * read: `cancel()` mutates `cancelReason` concurrently (the session's
   * message handler), and an inline read after an `await` gets narrowed by
   * control flow into an always-false comparison.
   */
  private isCancelled(): boolean {
    return this.cancelReason !== undefined
  }

  /**
   * Shared hook entry guard: after {@link cancel}, EVERY hook throws
   * `CANCELLED` at its next call — cancellation is the next HOOK boundary,
   * not just the next `agent()`, so a script that caught one cancelled
   * rejection cannot keep emitting progress through `phase`/`log` or enter a
   * combinator.
   */
  private throwIfCancelled(): void {
    if (this.isCancelled()) throw this.cancelledError()
  }

  /**
   * Cancel the run: waiting `agent()` slots reject and every future hook call
   * throws `CANCELLED` — the script dies at its next await. A script that
   * never settles anyway (parked on a promise no hook owns) is the HOST's
   * problem: its grace timer force-settles the run and terminates the
   * worker. Idempotent; the first reason wins.
   * @param reason - human-readable cause carried on the CANCELLED error. The
   * host independently aborts the required signal shared by every child.
   */
  cancel(reason: string): void {
    if (this.cancelReason !== undefined) return
    this.cancelReason = reason
    this.cancelError = new WorkflowError(`workflow run cancelled: ${this.cancelReason}`, 'CANCELLED')
    for (const waiter of this.slotWaiters.splice(0)) waiter.reject(this.cancelledError())
  }

  /**
   * Run the script to settlement. Resolves — never rejects — with the run's
   * {@link WorkflowResult}: the materialized return value on `completed`, the
   * failure message on `error`, and `cancelled` when the script died of
   * cancellation. This method only chooses the result; the session publishes
   * it and the host owns terminal child cancellation.
   * @returns the settled outcome — this promise NEVER rejects (the seam's
   * `result`-never-rejects contract); every failure maps to a variant.
   */
  async drive(): Promise<WorkflowResult> {
    try {
      // Cancelled before the body ever ran (an already-aborted start signal,
      // relayed by the host before its `go`): the script must not execute at
      // all, let alone report `completed`.
      if (this.isCancelled()) throw this.cancelledError()
      const scriptPromise = this.compiled.runInContext(this.context, { timeout: this.limits.syncTimeoutMs }) as Promise<unknown>
      const raw: unknown = await this.contain(Promise.resolve(scriptPromise))
      // `complete()` wins even when the script caught its sentinel and later
      // returned another value.
      if (this.completed !== undefined) return this.completedResult()
      // Cancelled while the body ran: a script that settled without touching
      // another hook (or without any) must still report `cancelled` — the
      // holder asked for cancellation and `completed` would be a lie.
      if (this.isCancelled()) throw this.cancelledError()
      const value = raw === undefined ? null : this.materializeResult(raw)
      return { value, stopReason: 'completed', agentsStarted: this.started }
    } catch (error: unknown) {
      if (this.completed !== undefined) return this.completedResult()
      // Any failure after cancel() reports `cancelled` with the canonical
      // reason — the reject path mirrors the resolve path's post-settle check.
      if (this.isCancelled()) {
        return { value: null, stopReason: 'cancelled', error: this.cancelledError().message, agentsStarted: this.started }
      }
      if (error === COMPLETE_SENTINEL) return this.completedResult()
      // renderThrown is total (thrown values of any realm), so this arm
      // cannot throw — drive() resolving is the `result` never-rejects contract
      // contract.
      return { value: null, stopReason: 'error', error: renderThrown(error), agentsStarted: this.started }
    }
  }

  /** Materialize and report the `complete(value)` terminal. */
  private completedResult(): WorkflowResult {
    const value = this.completed === undefined ? null : this.materializeResult(this.completed.value)
    return { value, stopReason: 'completed', agentsStarted: this.started }
  }

  /**
   * Attach a no-op rejection consumer WITHOUT changing what the caller
   * receives: if the script drops the promise (no await), cancellation cannot
   * become an unhandled rejection (which would kill the worker thread); if
   * the script does await it, it still observes the rejection.
   */
  private contain<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => { /* consumed: see method contract — a dropped hook promise must not surface an unhandled rejection */ })
    return promise
  }

  private cancelledError(): WorkflowError {
    // cancel() arms cancelError before any caller can observe isCancelled()
    // === true; the fallback guards the type, not a reachable path.
    /* v8 ignore next */
    return this.cancelError ?? new WorkflowError('workflow run cancelled', 'CANCELLED')
  }

  /** Materialize the script's return value; violations become RESULT_UNSERIALIZABLE. */
  private materializeResult(raw: unknown): unknown {
    try {
      return materializeFromRealm(raw, 'workflow result')
    } catch (error: unknown) {
      /* v8 ignore next -- defensive rethrow arm: materializeFromRealm only throws MaterializeError */
      if (!(error instanceof MaterializeError)) throw error
      throw new WorkflowError(
        `the workflow's return value is not plain JSON data — ${error.message}. Return only JSON-serializable objects/arrays/scalars.`,
        'RESULT_UNSERIALIZABLE',
        { cause: error },
      )
    }
  }

  /**
   * Acquire one concurrency slot (FIFO). Cancellation rejects QUEUED waiters
   * (see {@link cancel}); the callers guard their own entry and post-acquire
   * windows, so no cancelled-precheck is duplicated here.
   */
  private acquireSlot(): Promise<void> {
    if (this.activeSlots < this.limits.maxConcurrentAgents) {
      this.activeSlots += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      this.slotWaiters.push({
        resolve: () => {
          this.activeSlots += 1
          resolve()
        },
        reject,
      })
    })
  }

  private releaseSlot(): void {
    this.activeSlots -= 1
    const next = this.slotWaiters.shift()
    if (next) next.resolve()
  }

  /** The `agent(prompt, opts)` hook. */
  private async agent(rawPrompt: unknown, rawOpts: unknown): Promise<unknown> {
    this.throwIfCancelled()
    if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
      throw new WorkflowError('agent() requires a non-empty prompt string', 'INVALID_ARGUMENT')
    }
    const opts = this.readAgentOptions(rawOpts)
    this.callSeq += 1
    const callSeq = this.callSeq
    // Journal replay: a committed result from the original run returns without
    // spending budget or launching a child (schema-correction and journal
    // replays are free by contract).
    const replay = this.journal.get(callSeq)
    if (replay !== undefined) return replay.result
    // Smoke-check mode: canned success instead of launching a child.
    if (this.validateOnly) return opts.schema !== undefined ? {} : ''
    if (this.started >= this.limits.maxTotalAgents) {
      throw new WorkflowError(
        `this run reached its total agent cap (${this.limits.maxTotalAgents}) — a runaway-loop backstop; raise the applicable maxTotalAgents limit if the scale is intentional`,
        'AGENT_CAP',
      )
    }
    this.started += 1
    const seq = this.started
    const label = opts.label ?? defaultLabel(rawPrompt)
    const phase = opts.phase ?? this.currentPhase

    await this.acquireSlot()
    try {
      // Re-check after the acquire: the await yields at least one microtask
      // tick even when a slot is free, and a queued waiter resumes a tick
      // after its release — a cancel() landing in either window must not
      // reach the host (which would refuse anyway, but the refusal reads as
      // a start failure rather than the cancellation it is).
      this.throwIfCancelled()
      let run: ChildHandle
      try {
        run = await this.children.startAgent({
          prompt: rawPrompt,
          ...opts.schema !== undefined ? { schema: opts.schema } : {},
          ...opts.provider !== undefined ? { provider: opts.provider } : {},
          ...opts.model !== undefined ? { model: opts.model } : {},
        })
      } catch (error: unknown) {
        // The host refuses starts once the run is cancelled — a refusal that
        // races our own cancel state must read as the cancellation it is,
        // not as a broken contract.
        if (this.isCancelled()) throw this.cancelledError()
        throw new WorkflowError(`agent() could not start a child: ${renderThrown(error)}`, 'AGENT_START', { cause: error })
      }
      // The start round-trip yields to the event loop, so a cancel CAN land
      // between the host starting the child and this continuation running —
      // wind the fresh child down instead of leaving it live behind a dead
      // script.
      if (this.isCancelled()) {
        await run.dispose()
        throw this.cancelledError()
      }
      const info: WorkflowAgentInfo = { seq, label, ...phase !== undefined ? { phase } : {}, childId: SessionId(run.id) }
      this.observer.agentStart(info)
      try {
        let result
        try {
          result = await run.result
        } catch (error: unknown) {
          // A rejected child result is an INFRASTRUCTURE fault relayed by the
          // host — distinct from a child that failed and resolved. Pair the
          // lifecycle before propagating, and propagate FATAL: an ordinary
          // throw would dissolve to a per-item null inside the combinators,
          // and a broken provider must not read as a failed child.
          if (this.isCancelled()) {
            this.observer.agentEnd({ ...info, outcome: 'cancelled' })
            throw this.cancelledError()
          }
          this.observer.agentEnd({ ...info, outcome: 'failed' })
          throw new WorkflowError(`child agent run failed: ${renderThrown(error)}`, 'AGENT_RESULT', { cause: error })
        }
        if (result.stopReason === 'completed') {
          if (opts.schema !== undefined) {
            // The provider honored outputSchema (capability-gated at start), so
            // a completed run without a structured value is a child failure.
            if (result.structured === undefined) {
              this.observer.agentEnd({ ...info, outcome: 'failed' })
              this.observer.agentResult(callSeq, null)
              return null
            }
            this.observer.agentEnd({ ...info, outcome: 'completed' })
            this.observer.agentResult(callSeq, result.structured)
            return result.structured
          }
          const text = outputText(result.output)
          this.observer.agentEnd({ ...info, outcome: 'completed' })
          this.observer.agentResult(callSeq, text)
          return text
        }
        // A cancelled RUN kills the script; a child that failed for its own
        // reasons resolves null (scripts .filter(Boolean) per the CC contract).
        if (this.isCancelled()) {
          this.observer.agentEnd({ ...info, outcome: 'cancelled' })
          throw this.cancelledError()
        }
        this.observer.agentEnd({ ...info, outcome: 'failed' })
        this.observer.agentResult(callSeq, null)
        return null
      } finally {
        await run.dispose()
      }
    } finally {
      this.releaseSlot()
    }
  }

  /** Materialize + validate the `agent()` options bag from the realm. */
  private readAgentOptions(rawOpts: unknown): {
    label?: string
    phase?: string
    provider?: string
    model?: string
    schema?: ObjectJsonSchema
  } {
    if (rawOpts === undefined) return {}
    let opts: unknown
    try {
      opts = materializeFromRealm(rawOpts, 'agent() options')
    } catch (error: unknown) {
      /* v8 ignore next -- defensive rethrow arm: materializeFromRealm only throws MaterializeError */
      if (!(error instanceof MaterializeError)) throw error
      throw new WorkflowError(`agent() options must be plain JSON data — ${error.message}`, 'INVALID_ARGUMENT', { cause: error })
    }
    if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
      throw new WorkflowError('agent() options must be an object', 'INVALID_ARGUMENT')
    }
    const record = opts as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (SUPPORTED_AGENT_OPTIONS.has(key)) continue
      if (DEFERRED_AGENT_OPTIONS.has(key)) {
        throw new WorkflowError(`agent() option "${key}" is deferred and not supported by this engine (supported: label, phase, schema, provider, model)`, 'UNSUPPORTED_OPTION')
      }
      throw new WorkflowError(`agent() option "${key}" is not recognized (supported: label, phase, schema, provider, model)`, 'UNSUPPORTED_OPTION')
    }
    for (const key of ['label', 'phase', 'provider', 'model'] as const) {
      if (record[key] !== undefined && typeof record[key] !== 'string') {
        throw new WorkflowError(`agent() option "${key}" must be a string`, 'INVALID_ARGUMENT')
      }
    }
    let schema: ObjectJsonSchema | undefined
    if (record.schema !== undefined) {
      try {
        assertObjectJsonSchema(record.schema)
        schema = record.schema
      } catch (error: unknown) {
        /* v8 ignore next -- defensive rethrow arm: assertObjectJsonSchema only throws JsonSchemaError */
        if (!(error instanceof JsonSchemaError)) throw error
        throw new WorkflowError(`agent() schema is outside the supported subset — ${error.message}`, 'UNSUPPORTED_SCHEMA', { cause: error })
      }
    }
    return {
      ...record.label !== undefined ? { label: record.label as string } : {},
      ...record.phase !== undefined ? { phase: record.phase as string } : {},
      ...record.provider !== undefined ? { provider: record.provider as string } : {},
      ...record.model !== undefined ? { model: record.model as string } : {},
      ...schema !== undefined ? { schema } : {},
    }
  }

  /** The `parallel(items)` hook: thunks or job maps; each slot caught → `null`; fatal errors propagate. */
  private async parallel(rawItems: unknown): Promise<unknown[]> {
    this.throwIfCancelled()
    if (!Array.isArray(rawItems)) {
      throw new WorkflowError('parallel() requires an array of zero-argument functions or job maps', 'INVALID_ARGUMENT')
    }
    this.assertItemCap(rawItems.length, 'parallel()')
    const thunks = rawItems.map((item, index) => this.jobThunk(item, index))
    return Promise.all(thunks.map(async (thunk) => {
      try {
        return await thunk()
      } catch (error: unknown) {
        // Hook failures are WorkflowErrors built OUTSIDE the script's realm;
        // fatality is recognized by `instanceof` against this realm's class —
        // a script-built object can never pass it, so fatality cannot be
        // forged (nor accidentally dissolved).
        if (isFatalWorkflowError(error)) throw error
        return null
      }
    }))
  }

  /** Accept one `parallel()` item as a zero-arg thunk or a Grok job map `{ prompt, ...opts }`. */
  private jobThunk(item: unknown, index: number): () => unknown {
    if (typeof item === 'function') return item as () => unknown
    let job: unknown
    try {
      job = materializeFromRealm(item, `parallel() item ${index}`)
    } catch (error: unknown) {
      /* v8 ignore next -- defensive rethrow arm: materializeFromRealm only throws MaterializeError */
      if (!(error instanceof MaterializeError)) throw error
      throw new WorkflowError(`parallel() item ${index} must be a function or plain job map — ${error.message}`, 'INVALID_ARGUMENT', { cause: error })
    }
    if (typeof job !== 'object' || job === null || Array.isArray(job)) {
      throw new WorkflowError(`parallel() item ${index} is not a function or job map`, 'INVALID_ARGUMENT')
    }
    const record = job as Record<string, unknown>
    const prompt = record.prompt
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new WorkflowError(`parallel() job ${index} requires a non-empty "prompt" string`, 'INVALID_ARGUMENT')
    }
    const opts: Record<string, unknown> = {}
    for (const key of Object.keys(record)) {
      if (key === 'prompt') continue
      opts[key] = record[key]
    }
    return () => this.agent(prompt, opts)
  }

  /** The `pipeline(items, ...stages)` hook: per-item stage chains, NO cross-stage barrier. */
  private async pipeline(rawItems: unknown, rawStages: unknown[]): Promise<unknown[]> {
    this.throwIfCancelled()
    if (!Array.isArray(rawItems)) {
      throw new WorkflowError('pipeline() requires an items array', 'INVALID_ARGUMENT')
    }
    this.assertItemCap(rawItems.length, 'pipeline()')
    if (rawStages.length === 0) {
      throw new WorkflowError('pipeline() requires at least one stage function', 'INVALID_ARGUMENT')
    }
    const stages = rawStages.map((stage, index) => {
      if (typeof stage !== 'function') {
        throw new WorkflowError(`pipeline() stage ${index} is not a function`, 'INVALID_ARGUMENT')
      }
      return stage as (previous: unknown, item: unknown, index: number) => unknown
    })
    return Promise.all(rawItems.map(async (item: unknown, index) => {
      let value: unknown = item
      try {
        for (const stage of stages) {
          value = await stage(value, item, index)
        }
        return value
      } catch (error: unknown) {
        // An ordinary stage throw drops the ITEM to null and skips its
        // remaining stages; a fatal WorkflowError (see parallel()) kills the
        // whole script.
        if (isFatalWorkflowError(error)) throw error
        return null
      }
    }))
  }

  private assertItemCap(length: number, hook: string): void {
    if (length > this.limits.maxItemsPerCall) {
      throw new WorkflowError(
        `${hook} received ${length} items — over the per-call cap (${this.limits.maxItemsPerCall}); split the work or raise maxItemsPerCall in the engine config`,
        'ITEM_CAP',
      )
    }
  }

  /** The `phase(title)` hook: sets the current label for subsequent `agent()` calls and notifies observers. */
  private phase(title: unknown): void {
    this.throwIfCancelled()
    if (typeof title !== 'string' || title.length === 0) {
      throw new WorkflowError('phase() requires a non-empty title string', 'INVALID_ARGUMENT')
    }
    this.currentPhase = title
    this.observer.phase(title)
  }

  /** The `log(message)` hook: narration to observers. */
  private log(message: unknown): void {
    this.throwIfCancelled()
    if (typeof message !== 'string') {
      throw new WorkflowError('log() requires a message string', 'INVALID_ARGUMENT')
    }
    this.observer.log(message)
  }

  /** The `complete(value)` hook: terminate the run successfully with a JSON value. */
  private complete(value: unknown): never {
    this.throwIfCancelled()
    // The sentinel is recognized by drive() on every path — the script may
    // catch the throw, but drive() still reports the completed value.
    this.completed = { value }
    throw COMPLETE_SENTINEL
  }

  /** The `budget()` hook: this run's logical agent budget and its spend. */
  private budget(): { total: number; spent: number; reserved: 0; remaining: number } {
    this.throwIfCancelled()
    const total = this.limits.maxTotalAgents
    const spent = this.started
    return { total, spent, reserved: 0, remaining: total - spent }
  }

  /** The `pause()`/`await_user()` gate: park the run until a resume message releases it. */
  private async gate(rawKind: unknown, rawMessage: unknown, resumable: boolean): Promise<void> {
    this.throwIfCancelled()
    if (typeof rawKind !== 'string' || rawKind.length === 0) {
      throw new WorkflowError(`${resumable ? 'await_user' : 'pause'}() requires a non-empty kind string`, 'INVALID_ARGUMENT')
    }
    const kind = this.readGateKind(rawKind, resumable)
    const message = rawMessage === undefined ? '' : typeof rawMessage === 'string' ? rawMessage : undefined
    if (message === undefined) {
      throw new WorkflowError(`${resumable ? 'await_user' : 'pause'}() message must be a string`, 'INVALID_ARGUMENT')
    }
    if (this.validateOnly) {
      // Smoke-check mode: a gate is a successful stop, not a hang — narrate it
      // and continue past so the single canned-host path still settles.
      this.observer.log(`would ${resumable ? 'await_user' : 'pause'} (${kind}): ${message}`)
      return
    }
    while (true) {
      this.throwIfCancelled()
      const gate: WorkflowGateInfo = { kind, message, resumable }
      this.observer.gate(gate)
      await new Promise<void>((resolve) => { this.gateResume = resolve })
      this.gateResume = undefined
      // `pause` (non-resumable) re-fires the gate; `await_user` continues past it.
      if (resumable) return
    }
  }

  /** Normalize a gate kind with its `backoff`/`blocked` aliases. */
  private readGateKind(rawKind: string, resumable: boolean): WorkflowGateKind {
    switch (rawKind) {
      case 'user':
      case 'back_off':
      case 'backoff':
      case 'no_progress':
      case 'verification':
      case 'blocked':
      case 'infra':
        break
      default:
        throw new WorkflowError(`${resumable ? 'await_user' : 'pause'}() kind "${rawKind}" is not recognized (user, back_off, no_progress, verification, infra)`, 'INVALID_ARGUMENT')
    }
    const normalized = rawKind === 'backoff' ? 'back_off' : rawKind === 'blocked' ? 'verification' : rawKind
    return normalized as WorkflowGateKind
  }

  /** The `write_scratch_file(name, content)` hook: write one single-component scratch file. */
  private async writeScratch(rawName: unknown, rawContent: unknown): Promise<void> {
    this.throwIfCancelled()
    const name = this.readScratchName(rawName)
    if (typeof rawContent !== 'string') {
      throw new WorkflowError('write_scratch_file() content must be a string', 'INVALID_ARGUMENT')
    }
    await this.children.writeScratch(name, rawContent)
  }

  /** The `read_scratch_file(name)` hook: read one single-component scratch file. */
  private async readScratch(rawName: unknown): Promise<string | undefined> {
    this.throwIfCancelled()
    const name = this.readScratchName(rawName)
    return this.children.readScratch(name)
  }

  /** Validate a single-component scratch file name (no separators or traversal). */
  private readScratchName(rawName: unknown): string {
    if (typeof rawName !== 'string' || !SCRATCH_NAME.test(rawName)) {
      throw new WorkflowError('scratch file name must be a single component (letters, digits, . _ -)', 'INVALID_ARGUMENT')
    }
    return rawName
  }
}

/** Single-component scratch file name grammar. */
const SCRATCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Sentinel thrown by `complete()`; drive() recognizes it to terminate successfully. */
const COMPLETE_SENTINEL = { __workflowComplete: true }
