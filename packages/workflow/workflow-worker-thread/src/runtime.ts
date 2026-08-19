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

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import * as vm from 'node:vm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type JsonValue } from '@deepseek-ai/dsh-session'
import { assertObjectJsonSchema, JsonSchemaError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
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
  journalCommit(entry: WorkflowJournalEntry): void
}

/** One new journal entry before the runtime assigns its commit ordinal. */
type PendingJournalEntry = WorkflowJournalEntry extends infer Entry
  ? Entry extends WorkflowJournalEntry ? Omit<Entry, 'ordinal'> : never
  : never

/** Deterministic position of one concurrently executing combinator branch. */
interface CallScope {
  readonly path: string
  nextNode: number
  currentPhase?: string
  reservation?: AgentReservation
}

/** One atomically admitted declarative job; exactly one direct `agent()` consumes it. */
interface AgentReservation {
  available: boolean
}

/** Validated options used for one child request and its replay fingerprint. */
interface AgentOptions {
  label?: string
  phase?: string
  provider?: string
  model?: string
  schema?: ObjectJsonSchema
}

/** One validated parallel item plus whether its single child is statically known. */
interface ParallelItem {
  readonly run: () => unknown
  readonly kind: 'thunk' | 'job'
  readonly reservesAgent: boolean
}

/**
 * Build a callable/constructable global that fails before exposing ambient
 * process state. The vm is not a security boundary, but ordinary authored
 * workflows must not accidentally make resumed control flow depend on the
 * clock, randomness, garbage collection, or timer-like atomics.
 */
function unavailableNondeterministicGlobal(name: string): unknown {
  const fail = (): never => {
    throw new WorkflowError(
      `${name} is unavailable in workflow scripts because runs must derive control flow from args and committed host results`,
      'INVALID_ARGUMENT',
    )
  }
  /* v8 ignore next -- every call/construct/property operation is intercepted by the Proxy traps below */
  const target = Object.freeze(function unavailableWorkflowGlobal(): never { return fail() })
  return Object.freeze(new Proxy(target, {
    apply: fail,
    construct: fail,
    get: fail,
    set: fail,
  }))
}

/** Clone the deterministic Math surface while replacing its random source. */
function deterministicMath(): Math {
  const descriptors = Object.getOwnPropertyDescriptors(Math)
  descriptors.random = {
    ...descriptors.random,
    value: Object.freeze((): never => {
      throw new WorkflowError(
        'Math.random() is unavailable in workflow scripts because runs must derive control flow from args and committed host results',
        'INVALID_ARGUMENT',
      )
    }),
  }
  return Object.freeze(Object.defineProperties(Object.create(Reflect.getPrototypeOf(Math)) as Math, descriptors))
}

/** Define one JSON object key without giving `__proto__` assignment semantics. */
function defineJsonProperty(target: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  })
}

/** Copy one generated JSON object while retaining every key as data. */
function copyJsonObject(source: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  const copy: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(source)) defineJsonProperty(copy, key, value)
  return copy
}

/** Deterministic unconstrained candidates used to disambiguate exact-one unions. */
const ANY_JSON_CANDIDATES: readonly JsonValue[] = [null, false, true, 0, 0.5, '', 'value', [], {}]

/** Count serialized JSON nodes up to a configured smoke-host work limit. */
function jsonNodeCount(value: JsonValue, limit: number): number {
  let count = 0
  const pending: JsonValue[] = [value]
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    count += 1
    if (count > limit) return count
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child)
    } else if (typeof current === 'object' && current !== null) {
      for (const child of Object.values(current)) pending.push(child)
    }
  }
  return count
}

/**
 * Produce deterministic candidates for one already-validated schema node.
 * Returned candidates satisfy the node; an empty list means the supported
 * exact-one vocabulary has no value this smoke host can construct.
 */
function cannedSchemaCandidates(schema: JsonSchemaNode, maxArrayItems: number): JsonValue[] {
  let candidates: JsonValue[]
  if (schema.oneOf !== undefined) {
    candidates = []
    for (const branch of schema.oneOf) {
      for (const candidate of cannedSchemaCandidates(branch, maxArrayItems)) {
        if (candidates.length >= maxArrayItems) break
        candidates.push(candidate)
      }
      if (candidates.length >= maxArrayItems) break
    }
    for (const candidate of ANY_JSON_CANDIDATES) {
      if (candidates.length >= maxArrayItems) break
      candidates.push(candidate)
    }
  } else if (Object.hasOwn(schema, 'const')) {
    candidates = [schema.const as JsonValue]
  } else if (schema.enum !== undefined) {
    candidates = [...schema.enum]
  } else {
    switch (schema.type) {
      case 'object': {
        const properties = schema.properties ?? {}
        const required = schema.required ?? []
        const base: Record<string, JsonValue> = {}
        const requiredCandidates = new Map<string, JsonValue[]>()
        for (const key of required) {
          const values = cannedSchemaCandidates(properties[key] as JsonSchemaNode, maxArrayItems)
          if (values.length === 0) return []
          requiredCandidates.set(key, values)
          defineJsonProperty(base, key, values[0] as JsonValue)
        }
        candidates = [base]
        for (const [key, values] of requiredCandidates) {
          for (const value of values.slice(1)) {
            if (candidates.length >= maxArrayItems) break
            const alternate = copyJsonObject(base)
            defineJsonProperty(alternate, key, value)
            candidates.push(alternate)
          }
        }
        const optional = Object.entries(properties).filter(([key]) => !requiredCandidates.has(key))
        const withAllOptional = copyJsonObject(base)
        let hasAllOptional = false
        for (const [key, childSchema] of optional) {
          const values = cannedSchemaCandidates(childSchema, maxArrayItems)
          for (const value of values) {
            if (candidates.length >= maxArrayItems) break
            const alternate = copyJsonObject(base)
            defineJsonProperty(alternate, key, value)
            candidates.push(alternate)
          }
          if (values[0] !== undefined) {
            defineJsonProperty(withAllOptional, key, values[0])
            hasAllOptional = true
          }
        }
        if (hasAllOptional) candidates.push(withAllOptional)
        break
      }
      case 'array': {
        const minimum = schema.minItems ?? 0
        if (minimum > maxArrayItems) return []
        const mayContainItem = schema.maxItems === undefined || schema.maxItems > 0
        const itemCandidates = schema.items === undefined ? [null] : cannedSchemaCandidates(schema.items, maxArrayItems)
        candidates = minimum === 0 ? [[]] : []
        for (const value of itemCandidates) {
          if (minimum > 0 && 1 + minimum * jsonNodeCount(value, maxArrayItems) <= maxArrayItems) {
            candidates.push(Array.from({ length: minimum }, () => value))
          }
          else if (mayContainItem) candidates.push([value])
        }
        break
      }
      case 'string': candidates = ['', 'value']; break
      case 'number': candidates = [0, 0.5, 1, -1]; break
      case 'integer': candidates = [0, 1, -1]; break
      case 'boolean': candidates = [false, true]; break
      case 'null': candidates = [null]; break
      case undefined: candidates = [...ANY_JSON_CANDIDATES]; break
      /* v8 ignore next -- assertObjectJsonSchema validated the closed schema vocabulary recursively. */
      default: return []
    }
  }
  return candidates
    .filter(candidate => jsonNodeCount(candidate, maxArrayItems) <= maxArrayItems)
    .filter(candidate => validateJsonSchemaValue(schema, candidate).length === 0)
    .slice(0, maxArrayItems)
}

/** Synthesize one schema-conforming structured result for `validate_only`. */
function cannedSchemaValue(schema: ObjectJsonSchema, maxArrayItems: number): JsonValue {
  const candidate = cannedSchemaCandidates(schema, maxArrayItems)[0]
  if (candidate !== undefined) return candidate
  throw new WorkflowError(
    'validate_only could not synthesize a canned result that conforms to the agent() schema',
    'UNSUPPORTED_SCHEMA',
  )
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
  /** Cumulative logical-agent spend, including earlier attempts and current reservations. */
  private started: number
  /** Last member sequence issued; unlike spend, it never decreases when a reservation is refunded. */
  private nextAgentSeq: number
  private activeSlots = 0
  private readonly slotWaiters: { resolve(): void; reject(error: unknown): void }[] = []
  private cancelReason: string | undefined
  private cancelError: WorkflowError | undefined
  /** A `complete(value)` terminal, materialized before the sentinel throw. */
  private completed: { value: JsonValue } | undefined
  /** An invalid `complete(value)` terminal; script catches cannot turn it into success. */
  private completionError: WorkflowError | undefined
  private readonly completionGate = Promise.withResolvers<void>()
  /** Resolver for the gate the script is currently parked on. */
  private gateResume: (() => void) | undefined
  private readonly journal: ReadonlyMap<string, WorkflowJournalEntry>
  /** Replay entries actually consumed along this attempt's control-flow path. */
  private readonly replayedJournalCallIds = new Set<string>()
  /** Last host-call commit ordinal retained or issued by this attempt. */
  private nextJournalOrdinal: number
  private readonly callScopes = new AsyncLocalStorage<CallScope>()
  private readonly rootScope: CallScope = { path: 'root', nextNode: 0 }
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
    initialAgentSpend = 0,
    initialAgentSeq = initialAgentSpend,
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

    const committedAgents = (journal ?? []).filter(entry => entry.kind === 'agent')
    this.started = Math.max(initialAgentSpend, committedAgents.length)
    let journalMaximum = 0
    let ordinalMaximum = 0
    for (const entry of committedAgents) journalMaximum = Math.max(journalMaximum, entry.seq)
    for (const entry of journal ?? []) ordinalMaximum = Math.max(ordinalMaximum, entry.ordinal)
    this.nextAgentSeq = Math.max(initialAgentSeq, this.started, journalMaximum)
    this.nextJournalOrdinal = ordinalMaximum
    this.journal = indexJournal(journal)
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
      Date: unavailableNondeterministicGlobal('Date'),
      Math: deterministicMath(),
      Atomics: unavailableNondeterministicGlobal('Atomics'),
      SharedArrayBuffer: unavailableNondeterministicGlobal('SharedArrayBuffer'),
      WeakRef: unavailableNondeterministicGlobal('WeakRef'),
      FinalizationRegistry: unavailableNondeterministicGlobal('FinalizationRegistry'),
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
    if (this.completed !== undefined || this.completionError !== undefined) throw COMPLETE_SENTINEL
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
    this.gateResume?.()
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
      const scriptPromise = this.callScopes.run(
        this.rootScope,
        () => this.compiled.runInContext(this.context, { timeout: this.limits.syncTimeoutMs }) as Promise<unknown>,
      )
      const scriptResult = this.contain(Promise.resolve(scriptPromise)).then(value => ({ kind: 'script' as const, value }))
      const completed = this.completionGate.promise.then(() => ({ kind: 'complete' as const }))
      const settled = await Promise.race([scriptResult, completed])
      if (settled.kind === 'complete') return this.completedResult()
      const raw: unknown = settled.value
      // `complete()` wins even when the script caught its sentinel and later
      // returned another value.
      /* v8 ignore next -- complete() resolves completionGate before a caught sentinel can settle scriptPromise */
      if (this.completed !== undefined || this.completionError !== undefined) return this.completedResult()
      // Cancelled while the body ran: a script that settled without touching
      // another hook (or without any) must still report `cancelled` — the
      // holder asked for cancellation and `completed` would be a lie.
      if (this.isCancelled()) throw this.cancelledError()
      const value = raw === undefined ? null : this.materializeResult(raw)
      const missingReplay = this.unreplayedJournalError()
      if (missingReplay !== undefined) throw missingReplay
      return { value, stopReason: 'completed', agentsStarted: this.started }
    } catch (error: unknown) {
      /* v8 ignore next -- completionGate wins the race whenever complete() has claimed a terminal */
      if (this.completed !== undefined || this.completionError !== undefined) return this.completedResult()
      // Any failure after cancel() reports `cancelled` with the canonical
      // reason — the reject path mirrors the resolve path's post-settle check.
      if (this.isCancelled()) {
        return {
          value: null,
          stopReason: 'cancelled',
          error: this.cancelledError().message,
          errorCode: 'CANCELLED',
          agentsStarted: this.started,
        }
      }
      /* v8 ignore next -- the out-of-band completionGate always wins before the sentinel reaches drive() */
      if (error === COMPLETE_SENTINEL) return this.completedResult()
      // renderThrown is total (thrown values of any realm), so this arm
      // cannot throw — drive() resolving is the `result` never-rejects contract
      // contract.
      return {
        value: null,
        stopReason: 'error',
        error: renderThrown(error),
        ...error instanceof WorkflowError ? { errorCode: error.code } : {},
        agentsStarted: this.started,
      }
    }
  }

  /** Materialize and report the `complete(value)` terminal. */
  private completedResult(): WorkflowResult {
    if (this.completionError !== undefined) {
      return {
        value: null,
        stopReason: 'error',
        error: this.completionError.message,
        errorCode: this.completionError.code,
        agentsStarted: this.started,
      }
    }
    const missingReplay = this.unreplayedJournalError()
    if (missingReplay !== undefined) {
      return {
        value: null,
        stopReason: 'error',
        error: missingReplay.message,
        errorCode: missingReplay.code,
        agentsStarted: this.started,
      }
    }
    const value = (this.completed as { value: JsonValue }).value
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
  private materializeResult(raw: unknown): JsonValue {
    try {
      return materializeFromRealm(raw, 'workflow result') as JsonValue
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

  /** Claim the next deterministic node under the current combinator branch. */
  private claimCallId(kind: 'agent' | 'parallel' | 'pipeline' | 'phase' | 'log' | 'scratch-read' | 'scratch-write' | 'await-user'): string {
    const scope = this.currentScope()
    scope.nextNode += 1
    return `${scope.path}/${kind}:${scope.nextNode}`
  }

  /** Resolve and verify one committed replay entry for the current call. */
  private replayEntry<K extends WorkflowJournalEntry['kind']>(
    callId: string,
    kind: K,
    fingerprint: string,
  ): Extract<WorkflowJournalEntry, { kind: K }> | undefined {
    const replay = this.journal.get(callId)
    if (replay === undefined) return undefined
    if (replay.kind !== kind || replay.fingerprint !== fingerprint) {
      throw new WorkflowError(
        `workflow journal diverged at ${callId}: the replayed ${kind} request does not match the committed request`,
        'JOURNAL_DIVERGENCE',
      )
    }
    this.replayedJournalCallIds.add(callId)
    return replay as Extract<WorkflowJournalEntry, { kind: K }>
  }

  /** Detect a resumed path that skipped a previously committed host call. */
  private unreplayedJournalError(): WorkflowError | undefined {
    for (const callId of this.journal.keys()) {
      if (!this.replayedJournalCallIds.has(callId)) {
        return new WorkflowError(
          `workflow journal diverged: the resumed path did not replay committed call ${callId}`,
          'JOURNAL_DIVERGENCE',
        )
      }
    }
    return undefined
  }

  /** Append one completed host call unless this is a non-persistent smoke check. */
  private commitJournal(entry: PendingJournalEntry): void {
    if (this.validateOnly) return
    this.nextJournalOrdinal += 1
    this.observer.journalCommit({ ...entry, ordinal: this.nextJournalOrdinal })
  }

  /** Atomically admit one direct-agent reservation for every new panel item. */
  private reservePanel(scopes: CallScope[]): void {
    const reservations = scopes.flatMap(scope => scope.reservation === undefined ? [] : [scope.reservation])
    if (this.started + reservations.length > this.limits.maxTotalAgents) {
      throw this.agentCapError(reservations.length)
    }
    this.started += reservations.length
  }

  /** Consume a panel reservation or admit one standalone/nested agent call. */
  private spendAgentBudget(): number {
    const reservation = this.callScopes.getStore()?.reservation
    if (reservation !== undefined && reservation.available) {
      reservation.available = false
      this.nextAgentSeq += 1
      return this.nextAgentSeq
    }
    if (this.started >= this.limits.maxTotalAgents) throw this.agentCapError(1)
    this.started += 1
    this.nextAgentSeq += 1
    return this.nextAgentSeq
  }

  /** Build the fatal error for a budget admission that would exceed the cap. */
  private agentCapError(requested: number): WorkflowError {
    return new WorkflowError(
      `this run cannot admit ${requested} agent${requested === 1 ? '' : 's'}: ${this.started} of ${this.limits.maxTotalAgents} logical-agent budget is already spent and the total agent cap (${this.limits.maxTotalAgents}) would be exceeded — raise the applicable maxTotalAgents limit if the scale is intentional`,
      'AGENT_CAP',
    )
  }

  /** The `agent(prompt, opts)` hook. */
  private async agent(rawPrompt: unknown, rawOpts: unknown): Promise<unknown> {
    this.throwIfCancelled()
    if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
      throw new WorkflowError('agent() requires a non-empty prompt string', 'INVALID_ARGUMENT')
    }
    const opts = this.readAgentOptions(rawOpts)
    const label = opts.label ?? defaultLabel(rawPrompt)
    const phase = opts.phase ?? this.currentScope().currentPhase
    const callId = this.claimCallId('agent')
    // Replay compares the effective observer/request vocabulary, not only the
    // explicit options. A changed current phase or derived label is therefore
    // a deterministic divergence rather than a silently misattributed result.
    const fingerprint = fingerprintHostCall('agent', {
      prompt: rawPrompt,
      options: { ...opts, label, ...phase === undefined ? {} : { phase } },
    })
    // Journal replay: a committed result from the original run returns without
    // spending budget or launching a child (schema-correction and journal
    // replays are free by contract).
    const replay = this.replayEntry(callId, 'agent', fingerprint)
    if (replay !== undefined) {
      return replay.result
    }
    const seq = this.spendAgentBudget()
    // Smoke-check mode: canned success instead of launching a child.
    if (this.validateOnly) {
      return opts.schema !== undefined ? cannedSchemaValue(opts.schema, this.limits.maxItemsPerCall) : ''
    }

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
        if (this.isCancelled()) {
          this.observer.agentEnd({ ...info, outcome: 'cancelled' })
          throw this.cancelledError()
        }
        if (result.stopReason === 'completed') {
          if (opts.schema !== undefined) {
            // The provider honored outputSchema (capability-gated at start), so
            // a completed run without a structured value is a child failure.
            if (result.structured === undefined) {
              this.commitJournal({ kind: 'agent', seq, callId, fingerprint, result: null })
              this.observer.agentEnd({ ...info, outcome: 'failed' })
              return null
            }
            const structured = result.structured as JsonValue
            this.commitJournal({ kind: 'agent', seq, callId, fingerprint, result: structured })
            this.observer.agentEnd({ ...info, outcome: 'completed' })
            return result.structured
          }
          const text = outputText(result.output)
          this.commitJournal({ kind: 'agent', seq, callId, fingerprint, result: text })
          this.observer.agentEnd({ ...info, outcome: 'completed' })
          return text
        }
        // A child that failed for its own reasons resolves null (scripts
        // filter null slots); cancellation was checked immediately above.
        this.commitJournal({ kind: 'agent', seq, callId, fingerprint, result: null })
        this.observer.agentEnd({ ...info, outcome: 'failed' })
        return null
      } finally {
        await run.dispose()
      }
    } finally {
      this.releaseSlot()
    }
  }

  /** Materialize + validate the `agent()` options bag from the realm. */
  private readAgentOptions(rawOpts: unknown): AgentOptions {
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

  /**
   * The `parallel(items)` hook. Declarative job maps preflight and reserve as
   * one atomic panel; arbitrary thunks admit their unknowable agent calls at
   * execution time. Every item is a barrier slot; ordinary failures become
   * `null` and fatal workflow errors propagate.
   */
  private async parallel(rawItems: unknown): Promise<unknown[]> {
    this.throwIfCancelled()
    if (!Array.isArray(rawItems)) {
      throw new WorkflowError('parallel() requires an array of zero-argument functions or job maps', 'INVALID_ARGUMENT')
    }
    this.assertItemCap(rawItems.length, 'parallel()')
    const panelPath = this.claimCallId('parallel')
    const items = rawItems.map((item, index) => this.parallelItem(
      item,
      index,
      `${panelPath}/item:${index}/agent:1`,
    ))
    if (items.some(item => item.kind === 'job') && items.some(item => item.kind === 'thunk')) {
      throw new WorkflowError(
        'parallel() cannot mix function thunks and declarative job maps in one panel',
        'INVALID_ARGUMENT',
      )
    }
    const inheritedPhase = this.currentScope().currentPhase
    const branches = items.map((item, index) => ({
      item,
      scope: {
        path: `${panelPath}/item:${index}`,
        nextNode: 0,
        ...inheritedPhase === undefined ? {} : { currentPhase: inheritedPhase },
        // A declarative job map has exactly one direct agent call, so the whole
        // known panel can be admitted atomically. Arbitrary thunks may contain
        // zero, many, or nested panels and therefore admit their calls when run.
        ...item.reservesAgent
          ? { reservation: { available: true } }
          : {},
      } satisfies CallScope,
    }))
    this.reservePanel(branches.map(branch => branch.scope))
    return Promise.all(branches.map(({ item, scope }) => this.callScopes.run(scope, async () => {
      try {
        return await item.run()
      } catch (error: unknown) {
        // Hook failures are WorkflowErrors built OUTSIDE the script's realm;
        // fatality is recognized by `instanceof` against this realm's class —
        // a script-built object can never pass it, so fatality cannot be
        // forged (nor accidentally dissolved).
        if (isFatalWorkflowError(error)) throw error
        return null
      }
    })))
  }

  /** Accept one `parallel()` item as a zero-arg thunk or a Grok job map `{ prompt, ...opts }`. */
  private parallelItem(item: unknown, index: number, callId: string): ParallelItem {
    if (typeof item === 'function') return { run: item as () => unknown, kind: 'thunk', reservesAgent: false }
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
    const rawOpts: Record<string, unknown> = {}
    for (const key of Object.keys(record)) {
      if (key === 'prompt') continue
      rawOpts[key] = record[key]
    }
    // Validate the entire declarative panel before any branch launches. Capture
    // its inherited phase now so concurrent thunk narration cannot change a
    // job map's effective request between preflight and execution.
    const opts = this.readAgentOptions(rawOpts)
    const label = opts.label ?? defaultLabel(prompt)
    const phase = opts.phase ?? this.currentScope().currentPhase
    const effectiveOptions: AgentOptions = { ...opts, label, ...phase === undefined ? {} : { phase } }
    const replay = this.replayEntry(
      callId,
      'agent',
      fingerprintHostCall('agent', { prompt, options: effectiveOptions }),
    )
    return {
      run: () => this.agent(prompt, effectiveOptions),
      kind: 'job',
      reservesAgent: replay === undefined,
    }
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
    const pipelinePath = this.claimCallId('pipeline')
    const inheritedPhase = this.currentScope().currentPhase
    return Promise.all(rawItems.map((item: unknown, index) => this.callScopes.run({
      path: `${pipelinePath}/item:${index}`,
      nextNode: 0,
      ...inheritedPhase === undefined ? {} : { currentPhase: inheritedPhase },
    }, async () => {
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
    })))
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
    const callId = this.claimCallId('phase')
    const fingerprint = fingerprintHostCall('phase', { title })
    const replay = this.replayEntry(callId, 'phase', fingerprint)
    this.currentScope().currentPhase = title
    if (replay !== undefined) return
    this.observer.phase(title)
    this.commitJournal({ kind: 'phase', callId, fingerprint, title })
  }

  /** The `log(message)` hook: narration to observers. */
  private log(message: unknown): void {
    this.throwIfCancelled()
    if (typeof message !== 'string') {
      throw new WorkflowError('log() requires a message string', 'INVALID_ARGUMENT')
    }
    const callId = this.claimCallId('log')
    const fingerprint = fingerprintHostCall('log', { message })
    if (this.replayEntry(callId, 'log', fingerprint) !== undefined) return
    this.observer.log(message)
    this.commitJournal({ kind: 'log', callId, fingerprint, message })
  }

  /** Resolve the deterministic call scope for a root hook or combinator branch. */
  private currentScope(): CallScope {
    return this.callScopes.getStore() as CallScope
  }

  /** The `complete(value)` hook: terminate the run successfully with a JSON value. */
  private complete(value: unknown): never {
    this.throwIfCancelled()
    try {
      this.completed = { value: value === undefined ? null : this.materializeResult(value) }
    } catch (error: unknown) {
      /* v8 ignore next -- materializeResult totalizes every failure as WorkflowError. */
      if (!(error instanceof WorkflowError)) {
        throw new Error('materializing a workflow result threw outside the documented error type', { cause: error })
      }
      this.completionError = error
    }
    // Resolve out of band before throwing: drive() races this terminal against
    // the script promise, so a caught sentinel cannot keep the run alive.
    this.completionGate.resolve()
    throw COMPLETE_SENTINEL
  }

  /** The `budget()` hook: this run's logical agent budget and its spend. */
  private budget(): { total: number; spent: number; reserved: 0; remaining: number } {
    this.throwIfCancelled()
    const total = this.limits.maxTotalAgents
    const spent = this.started
    return { total, spent, reserved: 0, remaining: Math.max(0, total - spent) }
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
      // Smoke-check mode: a gate is a successful terminal, not a hang. Claim
      // completion out of band so a script catch cannot execute past it.
      const diagnostic = `would ${resumable ? 'await_user' : 'pause'} (${kind}): ${message}`
      this.observer.log(diagnostic)
      this.complete(diagnostic)
    }
    const callId = resumable ? this.claimCallId('await-user') : undefined
    const fingerprint = resumable ? fingerprintHostCall('await-user', { kind, message }) : undefined
    if (callId !== undefined && fingerprint !== undefined
      && this.replayEntry(callId, 'await-user', fingerprint) !== undefined) return
    if (this.gateResume !== undefined) {
      throw new WorkflowError('workflow scripts may park on only one pause()/await_user() gate at a time', 'INVALID_ARGUMENT')
    }
    while (true) {
      this.throwIfCancelled()
      const gate: WorkflowGateInfo = { kind, message, resumable }
      this.observer.gate(gate)
      await new Promise<void>((resolve) => { this.gateResume = resolve })
      this.gateResume = undefined
      this.throwIfCancelled()
      // `pause` (non-resumable) re-fires the gate; `await_user` continues past it.
      if (resumable) {
        this.commitJournal(
          { kind: 'await-user', callId: callId as string, fingerprint: fingerprint as string },
        )
        return
      }
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
    return normalized
  }

  /** The `write_scratch_file(name, content)` hook: write one single-component scratch file. */
  private async writeScratch(rawName: unknown, rawContent: unknown): Promise<void> {
    this.throwIfCancelled()
    const name = this.readScratchName(rawName)
    if (typeof rawContent !== 'string') {
      throw new WorkflowError('write_scratch_file() content must be a string', 'INVALID_ARGUMENT')
    }
    const callId = this.claimCallId('scratch-write')
    const fingerprint = fingerprintHostCall('scratch-write', { name, content: rawContent })
    if (this.replayEntry(callId, 'scratch-write', fingerprint) !== undefined) return
    await this.children.writeScratch(name, rawContent)
    this.commitJournal({ kind: 'scratch-write', callId, fingerprint })
  }

  /** The `read_scratch_file(name)` hook: read one single-component scratch file. */
  private async readScratch(rawName: unknown): Promise<string | undefined> {
    this.throwIfCancelled()
    const name = this.readScratchName(rawName)
    const callId = this.claimCallId('scratch-read')
    const fingerprint = fingerprintHostCall('scratch-read', { name })
    const replay = this.replayEntry(callId, 'scratch-read', fingerprint)
    if (replay !== undefined) {
      return replay.content
    }
    const content = await this.children.readScratch(name)
    this.commitJournal({
      kind: 'scratch-read',
      callId,
      fingerprint,
      ...content === undefined ? {} : { content },
    })
    return content
  }

  /** Validate a single-component scratch file name (no separators or traversal). */
  private readScratchName(rawName: unknown): string {
    if (typeof rawName !== 'string' || !SCRATCH_NAME.test(rawName)) {
      throw new WorkflowError('scratch file name must be a single component (letters, digits, . _ -)', 'INVALID_ARGUMENT')
    }
    return rawName
  }
}

/** Index a journal while rejecting ambiguous replay identities. */
function indexJournal(entries: readonly WorkflowJournalEntry[] | undefined): ReadonlyMap<string, WorkflowJournalEntry> {
  const byCallId = new Map<string, WorkflowJournalEntry>()
  const agentSequences = new Set<number>()
  let priorOrdinal = 0
  for (const entry of entries ?? []) {
    if (!Number.isSafeInteger(entry.ordinal) || entry.ordinal !== priorOrdinal + 1) {
      throw new WorkflowError('workflow journal entry ordinal must be the next positive safe integer', 'JOURNAL_DIVERGENCE')
    }
    priorOrdinal = entry.ordinal
    if (entry.callId.length === 0 || byCallId.has(entry.callId)) {
      throw new WorkflowError(`workflow journal repeats or omits call identity ${JSON.stringify(entry.callId)}`, 'JOURNAL_DIVERGENCE')
    }
    if (entry.kind === 'agent' && (!Number.isSafeInteger(entry.seq) || entry.seq < 1)) {
      throw new WorkflowError('workflow journal agent seq must be a positive safe integer', 'JOURNAL_DIVERGENCE')
    }
    if (entry.kind === 'agent' && agentSequences.has(entry.seq)) {
      throw new WorkflowError(`workflow journal repeats agent sequence ${entry.seq}`, 'JOURNAL_DIVERGENCE')
    }
    if (!/^[a-f0-9]{64}$/u.test(entry.fingerprint)) {
      throw new WorkflowError('workflow journal fingerprint must be a lowercase SHA-256 digest', 'JOURNAL_DIVERGENCE')
    }
    byCallId.set(entry.callId, entry)
    if (entry.kind === 'agent') agentSequences.add(entry.seq)
  }
  return byCallId
}

/** SHA-256 one canonical effective host request for journal replay validation. */
function fingerprintHostCall(kind: WorkflowJournalEntry['kind'], request: unknown): string {
  return createHash('sha256').update(canonicalJson({ kind, request })).digest('hex')
}

/** Serialize JSON-like data with recursively sorted object keys. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    // Object keys are unique, so equality is not a possible comparator input.
    .sort(([left], [right]) => left < right ? -1 : 1)
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`
}

/** Single-component scratch file name grammar. */
const SCRATCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Sentinel thrown by `complete()`; drive() recognizes it to terminate successfully. */
const COMPLETE_SENTINEL = new Error('workflow completed')
