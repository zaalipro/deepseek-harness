/**
 * Host side of one workflow run. The first worker result, unexpected death, or
 * cancellation-grace expiry owns settlement and closes message admission.
 * Pending starts share one abort signal; published children share idempotent
 * cleanup, and quiescence waits for both while synthesizing any missing end events.
 * @module @deepseek-ai/dsh-workflow-worker-thread/host
 */

import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { WorkflowError } from '@deepseek-ai/dsh-workflow'
import type { WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowMeta, WorkflowResult, WorkflowRun, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import { renderThrown } from './realm.ts'
import type { ExecutionObserver } from './runtime.ts'
import {
  decodeWorkerToHostMessage,
  HostToWorkerType,
  WorkerToHostType,
  WorkflowProtocolError,
} from './protocol.ts'
import type { HostToWorkerPayloads, WorkerToHostMessage } from './protocol.ts'
import type { ChildResult, ChildStartRequest, WorkerHostLimits, WorkerInit } from './types.ts'

/** Single-component scratch file name grammar (mirrors the worker-side validation). */
const SCRATCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** One published child and its shared quiescent-disposal transaction. */
interface ChildRecord {
  readonly run: SubagentRun
  resultState: 'pending' | 'settled' | 'failed'
  disposal?: Promise<void>
}

/** Identity and accounted size of one retained scratch file. */
interface ScratchFileState {
  readonly device: number
  readonly inode: number
  size: number
}

/** Host accounting for the run's private scratch directory. */
interface ScratchState {
  readonly dir: string
  readonly device: number
  readonly inode: number
  readonly files: Map<string, ScratchFileState>
  totalBytes: number
}

/**
 * Build the credential-free environment inherited by a workflow worker.
 * Windows receives only its absolute temp directory; source workers may also
 * receive the tsx paths-map pin used by the source launcher.
 * @param platform - host platform, overridable for tests.
 * @param tsconfigPath - optional source-launcher tsconfig pin.
 * @returns the environment passed to the Worker constructor.
 */
export function workerSpawnEnv(
  platform: NodeJS.Platform = process.platform,
  tsconfigPath?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (platform === 'win32') {
    const tmp = tmpdir()
    env.TMP = tmp
    env.TEMP = tmp
  }
  if (tsconfigPath !== undefined) env.TSX_TSCONFIG_PATH = tsconfigPath
  return env
}

/** Resolve the built worker or source-mode tsx bootstrap for one isolated run. */
function resolveWorkerSpawn(init: WorkerInit): { entry: string | URL; options: WorkerOptions } {
  /* v8 ignore next 3 -- built-output arm is exercised by the built-worker e2e */
  if (!import.meta.url.endsWith('.ts')) {
    return {
      entry: fileURLToPath(new URL('./worker.cjs', import.meta.url)),
      options: { workerData: init, env: workerSpawnEnv(), execArgv: [] },
    }
  }
  const workerEntry = new URL('./worker.ts', import.meta.url)
  const tsxEsmApiEntry = import.meta.resolve('tsx/esm/api')
  const tsxCjsApiEntry = import.meta.resolve('tsx/cjs/api')
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(tsxEsmApiEntry)}`,
    `import { register as registerCjs } from ${JSON.stringify(tsxCjsApiEntry)}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(workerEntry.href)})`,
  ].join('\n')
  return {
    entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),
    options: {
      workerData: init,
      env: workerSpawnEnv(undefined, process.env.TSX_TSCONFIG_PATH),
      execArgv: [],
    },
  }
}

/**
 * One live worker-engine run — the seam's {@link WorkflowRun}, returned by
 * `start()` directly. Owns the Worker, the child registry, and the result
 * settlement; `result` never rejects. `meta` is trusted same-process data
 * borrowed as immutable by the handle and lifecycle events. The holder-bound
 * SubagentRuntime handle is captured before the
 * engine returns this run, so unloading the engine removes only the ability to
 * start another workflow; this run can still start and clean up its children.
 */
export class WorkerRun implements WorkflowRun {
  /** Settles exactly once with the run's outcome; never rejects. */
  readonly result: Promise<WorkflowResult>
  private settleResolve!: (result: WorkflowResult) => void
  private settled = false
  /** A Result/death/grace outcome atomically won before teardown callbacks. */
  private terminalClaimed = false
  /** The first death signal closes worker-message admission and owns failure-time cleanup. */
  private workerDeathObserved = false
  private cancelReason: string | undefined
  private graceTimer: NodeJS.Timeout | undefined
  private readonly worker: Worker
  /** Set on `exit`: the thread is gone, so posting has nowhere to go. */
  private workerGone = false
  /** The startup handshake is single-use; effect frames are forbidden before it. */
  private workerReady = false
  /** Accepted `child-start` messages — the terminate-path `agentsStarted` (see module doc). */
  private hostStarted = 0
  /** Published children by callId; an entry leaves only after disposal settles. */
  private readonly children = new Map<number, ChildRecord>()
  /** Provider starts that have not yet fulfilled or rejected. */
  private readonly pendingStarts = new Set<Promise<void>>()
  /** Accepted child calls still starting or published; the host concurrency authority. */
  private readonly activeChildCallIds = new Set<number>()
  /** Every worker-minted RPC id is single-use across child starts and scratch calls. */
  private readonly claimedCallIds = new Set<number>()
  /** Call ids whose first frame was a child start (dispose must reference one). */
  private readonly childCallIds = new Set<number>()
  /** Child call ids whose single disposal request was already accepted. */
  private readonly disposedChildCallIds = new Set<number>()
  /** Child calls whose published handle completed host-side disposal. */
  private readonly reapedChildCallIds = new Set<number>()
  /** Child ids already projected into one observer agent-start event. */
  private readonly announcedChildren = new Set<string>()
  /** Host-published child record paired to each announced member sequence. */
  private readonly agentChildren = new Map<number, ChildRecord>()
  /** Member sequences are single-use even after their paired end. */
  private readonly announcedAgentSeqs = new Set<number>()
  /** Member sequences that already committed their one journal result. */
  private readonly committedAgentSeqs = new Set<number>()
  /** Stable host-call identities retained across attempts or committed here. */
  private readonly committedJournalCallIds = new Set<string>()
  /** Last committed host-call ordinal, including replay entries supplied at start. */
  private lastJournalOrdinal = 0
  /** Exact UTF-8 JSON-array bytes retained across this logical run's journal. */
  private journalBytes: number
  /** Entries represented by {@link journalBytes}; determines the next comma byte. */
  private journalEntries: number
  /** Started-but-not-ended agents by seq — the pairing ledger the HOST guarantees (see {@link endAgent}). */
  private readonly liveAgents = new Map<number, WorkflowAgentInfo>()
  /** Scratch operations admitted before cancellation/settlement and not yet quiescent. */
  private readonly pendingScratch = new Set<Promise<void>>()
  /** Scratch RPCs admitted over this attempt, including reads and overwrites. */
  private scratchOperations = 0
  /** Serialize scratch reads/writes so quota accounting and publication are one transaction. */
  private scratchTail: Promise<void> = Promise.resolve()
  /** Lazily verifies the existing scratch directory and computes resume accounting. */
  private scratchState: Promise<ScratchState | undefined> | undefined
  /** Scratch I/O has its own cancellation: normal script settlement drains it instead of aborting it. */
  private readonly scratchController = new AbortController()
  /** First scratch failure, retained while a worker Result waits for admitted effects. */
  private scratchFailure: string | undefined
  /** A worker Result won and is waiting for admitted scratch effects. */
  private drainingWorkerResult = false
  private readonly quiescenceWaiters: (() => void)[] = []
  /** The per-run abort fanout every child start request carries. */
  private readonly controller = new AbortController()
  /** External start signal and the exact callback installed on it, retained only until first settle/teardown. */
  private inputSignal: AbortSignal | undefined
  private inputSignalAbort: (() => void) | undefined
  private disposed: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly subagents: SubagentRuntime,
    readonly id: WorkflowRunId,
    readonly meta: WorkflowMeta,
    private readonly parent: Agent,
    private readonly init: WorkerInit,
    private readonly provider: string,
    private readonly disposeGraceMs: number,
    private readonly observer: ExecutionObserver,
    signal: AbortSignal | undefined,
    private readonly scratchDir: string | undefined,
    private readonly hostLimits: WorkerHostLimits,
  ) {
    this.result = new Promise<WorkflowResult>((resolve) => { this.settleResolve = resolve })
    const initialJournal = JSON.stringify(init.journal ?? [])
    this.journalBytes = Buffer.byteLength(initialJournal, 'utf8')
    this.journalEntries = init.journal?.length ?? 0
    for (const entry of init.journal ?? []) {
      this.committedJournalCallIds.add(entry.callId)
      this.lastJournalOrdinal = entry.ordinal
    }
    if (this.journalBytes > hostLimits.maxJournalBytes) {
      throw new WorkflowError(
        `workflow journal exceeds the ${hostLimits.maxJournalBytes}-byte limit before this attempt starts`,
        'INVALID_ARGUMENT',
      )
    }
    // workerData rides the structured clone: args are plain JSON by the seam
    // contract, so the clone is total and doubles as the caller-isolation
    // copy (a clone failure throws loud out of start()).
    const { entry, options } = resolveWorkerSpawn(init)
    this.worker = new Worker(entry, options)
    this.worker.on('message', (message: unknown) => { this.onRawMessage(message) })
    this.worker.on('error', (error) => { this.onWorkerDeath(`workflow worker failed: ${renderThrown(error)}`, false) })
    /* v8 ignore next -- messageerror: not constructible from the engine's own protocol (every payload is JSON data) */
    this.worker.on('messageerror', (error) => { this.onWorkerDeath(`workflow worker message failed to deserialize: ${renderThrown(error)}`, false) })
    this.worker.on('exit', (code) => {
      this.workerGone = true
      this.onWorkerDeath(`workflow worker exited before the run settled (exit code ${code})`, true)
    })
    if (signal?.aborted) {
      this.cancel('workflow start signal already aborted')
    } else if (signal !== undefined) {
      const onAbort = (): void => {
        this.detachInputSignal()
        this.cancel('workflow signal aborted')
      }
      this.inputSignal = signal
      this.inputSignalAbort = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  /**
   * Cancel the run: the worker is told (its hooks start throwing and the
   * script dies at its next await), the required signal shared by every child
   * start is aborted, and the grace timer
   * arms: a run still unsettled `disposeGraceMs` later force-settles
   * `cancelled` and its worker is TERMINATED. Idempotent; the first reason
   * wins.
   * @param reason - human-readable cause (default `'workflow cancelled'`).
   */
  cancel(reason?: string): void {
    // A settled run has nothing left to cancel, and a terminal source claimed
    // before its cleanup callbacks must exclude cancellation reentered by one
    // of those callbacks. Without the settled guard the
    // ordinary consumer path (await result, then dispose -> cancel) would arm
    // a grace timer nothing ever clears, pinning the run and its Worker
    // closure until the grace expires - a bounded leak per completed run.
    if (this.settled || (this.terminalClaimed && !this.drainingWorkerResult) || this.cancelReason !== undefined) return
    this.cancelReason = reason ?? 'workflow cancelled'
    this.post(HostToWorkerType.Cancel, { reason: this.cancelReason })
    this.abortChildren(this.cancelReason)
    if (!this.scratchController.signal.aborted) this.scratchController.abort(this.cancelReason)
    this.graceTimer = setTimeout(() => {
      // Cancellation already owns the race through cancelReason; close the
      // terminal boundary explicitly before observer teardown callbacks.
      this.terminalClaimed = true
      // The worker may no longer speak (it is about to be terminated): pair
      // every stranded start before the run settles, so ends precede
      // workflow/end.
      this.endStrandedAgents()
      this.settleResult(this.cancelledResult(this.observedAgentSpend()))
      void this.worker.terminate()
    }, this.disposeGraceMs)
    // unref'd: an armed grace timer must never hold the process open.
    this.graceTimer.unref()
  }

  /**
   * Release a parked script gate. A no-op once the run settled or a cancel is
   * already in flight (the cancel path owns the terminal state then).
   */
  resume(): void {
    if (this.settled || this.terminalClaimed || this.cancelReason !== undefined) return
    this.post(HostToWorkerType.Resume, {})
  }

  /**
   * Cancel + bounded settle + termination. Host-drives every registered
   * child's disposal IMMEDIATELY — a wedged worker can relay no dispose RPC,
   * and deferring child teardown to the post-terminate reap would spend the
   * whole grace waiting for a quiescence that cannot start, then return with
   * the disposals still in flight — so child disposal overlaps the same
   * grace the worker gets to settle (the worker's own dispose RPCs join the
   * shared per-child disposal). Waits (at most the grace) for the result and
   * child quiescence, then terminates the worker unconditionally — the
   * thread never outlives its run — and reaps whatever children remain
   * (their disposal is contained, not awaited past the grace, the same
   * abandonment the seam documents for a slow-disposing child). Idempotent;
   * safe on every path.
   * @returns resolves when the run's resources are released or abandoned.
   */
  dispose(): Promise<void> {
    if (this.disposed !== undefined) return this.disposed
    // Claim the public transaction BEFORE its body invokes child/provider
    // disposal. A raw provider callback can reenter handle.dispose(); it must
    // join this promise rather than start a second traversal.
    const claimed = Promise.withResolvers<undefined>()
    this.disposed = claimed.promise
    void (async () => {
      this.detachInputSignal()
      this.cancel('workflow disposed')
      // cancel() deliberately becomes a no-op after terminal settlement, but
      // disposal still owns every registered child. Reap independently so an
      // already-settled workflow cannot wait on child quiescence before it has
      // started the surviving children's disposals. On an unsettled run this
      // joins the cancel path through the per-call cancellation/disposal gates.
      this.reapChildren('workflow disposed')
      await Promise.race([
        (async () => {
          await this.result
          await this.runQuiescence()
        })(),
        sleep(this.disposeGraceMs),
      ])
      await this.worker.terminate()
      this.reapChildren('workflow disposed')
    })().then(
      () => { claimed.resolve(undefined) },
      /* v8 ignore next -- result/quiescence never reject and Worker.terminate is the only external promise */
      (error: unknown) => { claimed.reject(error) },
    )
    return this.disposed
  }

  /** Post one message to the worker (payload looked up from the tag's map entry), tolerating a thread that is already gone. */
  private post<T extends HostToWorkerType>(type: T, payload: HostToWorkerPayloads[T]): void {
    if (this.workerGone || this.workerDeathObserved) return
    try {
      this.worker.postMessage({ type, ...payload })
    } catch (error: unknown) {
      // Only a teardown race can land here (every engine message is JSON
      // data, so serialization cannot fail); there is nothing left to
      // deliver to — log and move on.
      /* v8 ignore next -- postMessage teardown race (a throw between exit and its event): not constructible in-process */
      this.ctx.logger.warn(`workflow-worker-thread: postMessage failed: ${renderThrown(error)}`)
    }
  }

  /** Decode one untrusted worker frame and contain protocol failures to this run. */
  private onRawMessage(raw: unknown): void {
    if (this.workerDeathObserved || this.terminalClaimed) return
    try {
      this.onMessage(decodeWorkerToHostMessage(raw, this.hostLimits.maxProtocolMessageBytes))
    } catch (error: unknown) {
      const detail = error instanceof WorkflowProtocolError ? error.message : renderThrown(error)
      this.onWorkerDeath(`workflow worker protocol violation: ${detail}`, false)
      void this.worker.terminate()
    }
  }

  private onMessage(message: WorkerToHostMessage): void {
    // Node may emit `error`, then deliver an already-queued `message`, then
    // emit `exit`. The first death signal is the host's logical delivery
    // barrier: nothing arriving afterward may create a child, narrate after
    // workflow/end, or compete with the chosen outcome.
    if (!this.workerReady && message.type !== WorkerToHostType.Ready) {
      throw new WorkflowProtocolError(`${message.type} arrived before ready`)
    }
    switch (message.type) {
      case WorkerToHostType.Ready:
        if (this.workerReady) throw new WorkflowProtocolError('ready arrived more than once')
        this.workerReady = true
        this.post(HostToWorkerType.Go, {})
        break
      case WorkerToHostType.Phase:
        // Post-cancel narration is suppressed host-side: worker-side the
        // hooks throw once the cancel message is PROCESSED, but narration
        // already in flight (or emitted while the cancel crossed the
        // boundary) must not reach observers — nothing is emitted after
        // cancel() returns.
        this.assertEventText(message.title, 'phase title')
        if (this.cancelReason === undefined && !this.terminalClaimed) this.observer.phase(message.title)
        break
      case WorkerToHostType.Log:
        this.assertEventText(message.message, 'log message')
        if (this.cancelReason === undefined && !this.terminalClaimed) this.observer.log(message.message)
        break
      case WorkerToHostType.AgentStart:
        this.onAgentStart(message.info)
        break
      case WorkerToHostType.AgentEnd:
        // NOT suppressed on cancel: cancelled children report their paired
        // agent-end with outcome 'cancelled'. The gate (with the termination
        // paths' synthesis) is what makes the one-pair-per-started-child
        // contract hold on every stop path.
        this.onAgentEnd(message.info)
        break
      case WorkerToHostType.Gate:
        this.assertEventText(message.gate.message, 'gate message')
        if (this.cancelReason === undefined && !this.terminalClaimed) this.observer.gate(message.gate)
        break
      case WorkerToHostType.JournalCommit:
        this.onJournalCommit(message.entry)
        break
      case WorkerToHostType.ScratchWrite:
        void this.onScratchWrite(message.callId, message.name, message.content)
        break
      case WorkerToHostType.ScratchRead:
        void this.onScratchRead(message.callId, message.name)
        break
      case WorkerToHostType.ChildStart:
        this.onChildStart(message.callId, message.request)
        break
      case WorkerToHostType.ChildDispose:
        this.onChildDispose(message.callId)
        break
      case WorkerToHostType.Result:
        this.onResult(message.result)
        break
    }
  }

  /** Why a ready provider result may no longer be admitted to the worker. */
  private childAdmissionFailure(): { reason: string; rendered: string } | undefined {
    if (this.cancelReason !== undefined) {
      return { reason: this.cancelReason, rendered: `workflow run cancelled: ${this.cancelReason}` }
    }
    if (this.workerDeathObserved) {
      return { reason: 'workflow worker gone', rendered: 'workflow worker is no longer available' }
    }
    if (this.terminalClaimed) {
      return { reason: 'workflow settled', rendered: 'workflow run already settled' }
    }
    return undefined
  }

  /** Reserve a worker RPC id exactly once across every side-effecting family. */
  private claimCallId(callId: number, operation: string): void {
    if (this.claimedCallIds.has(callId)) {
      throw new WorkflowProtocolError(`${operation} reused callId ${callId}`)
    }
    this.claimedCallIds.add(callId)
  }

  /** Bound observer text before retaining or dispatching worker-controlled content. */
  private assertEventText(value: string, label: string): void {
    if (Buffer.byteLength(value, 'utf8') > this.hostLimits.maxEventTextBytes) {
      throw new WorkflowProtocolError(`${label} exceeds the ${this.hostLimits.maxEventTextBytes}-byte limit`)
    }
  }

  /** Admit one lifecycle start only for a child the host actually published. */
  private onAgentStart(info: WorkflowAgentInfo): void {
    if (this.cancelReason !== undefined || this.terminalClaimed) return
    this.assertEventText(info.label, 'agent label')
    if (info.phase !== undefined) this.assertEventText(info.phase, 'agent phase')
    const priorSequence = this.init.initialAgentSeq ?? 0
    if (info.seq <= priorSequence) {
      throw new WorkflowProtocolError(`agent-start seq ${info.seq} does not advance prior seq ${priorSequence}`)
    }
    if (info.seq > priorSequence + this.hostStarted) {
      throw new WorkflowProtocolError(`agent-start seq ${info.seq} exceeds the host-observed sequence range`)
    }
    if (this.announcedAgentSeqs.has(info.seq)) {
      throw new WorkflowProtocolError(`agent-start reused seq ${info.seq}`)
    }
    if (this.announcedChildren.has(info.childId)) {
      throw new WorkflowProtocolError(`agent-start reused child id ${JSON.stringify(info.childId)}`)
    }
    const published = [...this.children.values()].find(record => record.run.id === info.childId)
    if (!published) {
      throw new WorkflowProtocolError(`agent-start references unpublished child ${JSON.stringify(info.childId)}`)
    }
    this.announcedChildren.add(info.childId)
    this.announcedAgentSeqs.add(info.seq)
    this.agentChildren.set(info.seq, published)
    this.liveAgents.set(info.seq, info)
    this.observer.agentStart(info)
  }

  /** Require one end to match the exact start snapshot before forwarding it. */
  private onAgentEnd(info: WorkflowAgentEndInfo): void {
    const start = this.liveAgents.get(info.seq)
    if (start === undefined) {
      if (this.cancelReason !== undefined || this.terminalClaimed) return
      throw new WorkflowProtocolError(`agent-end references unknown seq ${info.seq}`)
    }
    if (start.label !== info.label || start.phase !== info.phase || start.childId !== info.childId) {
      throw new WorkflowProtocolError(`agent-end metadata does not match agent-start seq ${info.seq}`)
    }
    // Result and cancel use the same port but the child's promise callback can
    // already have posted its completed end when the host accepts cancel.
    // Cancellation owns that race and the journal frame is suppressed, so
    // normalize the still-live pair instead of misclassifying it as corrupt.
    if (this.cancelReason !== undefined) {
      this.endAgent({ ...start, outcome: 'cancelled' })
      return
    }
    const child = this.agentChildren.get(info.seq)
    if (child === undefined) {
      throw new WorkflowProtocolError(`agent-end seq ${info.seq} lost its host child correlation`)
    }
    const committed = this.committedAgentSeqs.has(info.seq)
    if (info.outcome === 'cancelled') {
      throw new WorkflowProtocolError(`agent-end seq ${info.seq} reported cancellation before the run was cancelled`)
    }
    if (info.outcome === 'completed' && (!committed || child.resultState !== 'settled')) {
      throw new WorkflowProtocolError(`agent-end seq ${info.seq} settled without a committed result`)
    }
    if (info.outcome === 'failed'
      && !((committed && child.resultState === 'settled') || (!committed && child.resultState === 'failed'))) {
      throw new WorkflowProtocolError(`agent-end seq ${info.seq} does not match the host-observed child result`)
    }
    this.endAgent(info)
  }

  /** Commit one completed host call in monotonic order and at most once. */
  private onJournalCommit(entry: Parameters<ExecutionObserver['journalCommit']>[0]): void {
    if (this.cancelReason !== undefined || this.terminalClaimed) return
    if (entry.ordinal !== this.lastJournalOrdinal + 1) {
      throw new WorkflowProtocolError(`journal-commit ordinal ${entry.ordinal} does not follow ${this.lastJournalOrdinal}`)
    }
    if (this.committedJournalCallIds.has(entry.callId)) {
      throw new WorkflowProtocolError(`journal-commit reused call identity ${JSON.stringify(entry.callId)}`)
    }
    if (entry.kind === 'agent') {
      if (!this.liveAgents.has(entry.seq)) {
        throw new WorkflowProtocolError(`agent journal commit references unknown live seq ${entry.seq}`)
      }
      if (this.agentChildren.get(entry.seq)?.resultState !== 'settled') {
        throw new WorkflowProtocolError(`agent journal commit seq ${entry.seq} arrived before a host-observed child result`)
      }
      if (this.committedAgentSeqs.has(entry.seq)) {
        throw new WorkflowProtocolError(`agent journal commit reused seq ${entry.seq}`)
      }
    }
    this.assertEventText(entry.callId, 'journal call identity')
    const encodedEntry = JSON.stringify(entry)
    const entryBytes = Buffer.byteLength(encodedEntry, 'utf8')
    const addedBytes = entryBytes + (this.journalEntries === 0 ? 0 : 1)
    if (addedBytes > this.hostLimits.maxJournalBytes - this.journalBytes) {
      throw new WorkflowProtocolError(
        `journal-commit exceeds the ${this.hostLimits.maxJournalBytes}-byte journal limit`,
      )
    }
    if (entry.kind === 'agent') this.committedAgentSeqs.add(entry.seq)
    this.committedJournalCallIds.add(entry.callId)
    this.lastJournalOrdinal = entry.ordinal
    this.journalBytes += addedBytes
    this.journalEntries += 1
    this.observer.journalCommit(entry)
  }

  private onChildStart(callId: number, request: ChildStartRequest): void {
    this.claimCallId(callId, 'child-start')
    this.childCallIds.add(callId)
    if (Buffer.byteLength(request.prompt, 'utf8') > this.hostLimits.maxChildPromptBytes) {
      throw new WorkflowProtocolError(`child-start prompt exceeds the ${this.hostLimits.maxChildPromptBytes}-byte limit`)
    }
    const alreadySpent = this.init.initialAgentSpend ?? 0
    if (alreadySpent + this.hostStarted >= this.init.limits.maxTotalAgents) {
      throw new WorkflowProtocolError('child-start exceeds the host-enforced total agent cap')
    }
    if (this.activeChildCallIds.size >= this.init.limits.maxConcurrentAgents) {
      throw new WorkflowProtocolError('child-start exceeds the host-enforced concurrent agent cap')
    }
    const initialFailure = this.childAdmissionFailure()
    if (initialFailure !== undefined) {
      // Refuse after a terminal boundary: a child must never start on an
      // already-aborted signal (a provider subscribing only to future abort
      // events would never observe it).
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: initialFailure.rendered })
      return
    }
    this.hostStarted += 1
    this.activeChildCallIds.add(callId)
    const task = this.startChild(callId, request)
    this.pendingStarts.add(task)
    void task.then(
      () => { this.finishPendingStart(task, callId) },
      /* v8 ignore next -- startChild contains provider and cleanup failures */
      () => { this.finishPendingStart(task, callId) },
    )
  }

  /** Await one provider-owned startup transaction and publish only while admitted. */
  private async startChild(callId: number, request: ChildStartRequest): Promise<void> {
    let run: SubagentRun
    try {
      run = await this.subagents.start(this.provider, {
        prompt: [{ type: 'text', text: request.prompt }],
        parent: this.parent,
        signal: this.controller.signal,
        ...request.schema !== undefined ? { outputSchema: request.schema } : {},
        ...request.provider !== undefined || request.model !== undefined
          ? {
            agentOptions: {
              ...request.provider !== undefined ? { provider: request.provider } : {},
              ...request.model !== undefined ? { model: request.model } : {},
            },
          }
          : {},
      })
    } catch (error: unknown) {
      const failure = this.childAdmissionFailure()
      this.post(HostToWorkerType.ChildStartError, {
        callId,
        rendered: failure?.rendered ?? renderThrown(error),
      })
      return
    }
    const failure = this.childAdmissionFailure()
    if (failure !== undefined) {
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: failure.rendered })
      try {
        await run.dispose()
      } catch (error: unknown) {
        this.ctx.logger.warn(`workflow-worker-thread: refused child dispose failed: ${renderThrown(error)}`)
      }
      return
    }

    const record: ChildRecord = { run, resultState: 'pending' }
    this.children.set(callId, record)
    // Attach result forwarding before publishing the child handle. Because the
    // callback itself runs in a later microtask, ChildStarted is still posted
    // first even for an already-settled scripted provider.
    const forwardResult = run.result.then<() => void, () => void>(
      (result) => {
        try {
          const snapshot = snapshotJsonValue<ChildResult>({
            output: result.output,
            ...result.structured !== undefined ? { structured: result.structured } : {},
            stopReason: result.stopReason,
          })
          if (snapshot === undefined) throw new TypeError('child result is not losslessly JSON-serializable')
          record.resultState = 'settled'
          return () => { this.post(HostToWorkerType.ChildSettled, { callId, result: snapshot }) }
        } catch (error: unknown) {
          record.resultState = 'failed'
          const rendered = `workflow child result could not cross the worker boundary: ${renderThrown(error)}`
          return () => { this.post(HostToWorkerType.ChildFailed, { callId, rendered }) }
        }
      },
      (error: unknown) => {
        record.resultState = 'failed'
        const rendered = renderThrown(error)
        return () => { this.post(HostToWorkerType.ChildFailed, { callId, rendered }) }
      },
    )
    this.post(HostToWorkerType.ChildStarted, { callId, childId: run.id })
    void forwardResult.then((forward) => { forward() })
  }

  private onChildDispose(callId: number): void {
    if (!this.childCallIds.has(callId)) {
      throw new WorkflowProtocolError(`child-dispose references unknown callId ${callId}`)
    }
    if (this.disposedChildCallIds.has(callId)) {
      throw new WorkflowProtocolError(`child-dispose repeated callId ${callId}`)
    }
    this.disposedChildCallIds.add(callId)
    const record = this.children.get(callId)
    if (record === undefined) {
      if (!this.reapedChildCallIds.has(callId)) {
        throw new WorkflowProtocolError(`child-dispose references child ${callId} before host-side disposal`)
      }
      // A dispose() drive or death reap beat the RPC, so the worker-side
      // wrapper is still owed its acknowledgement.
      this.post(HostToWorkerType.ChildDisposed, { callId })
      return
    }
    // disposeChild never rejects (containment is inside), so the ack always follows.
    void this.disposeChild(callId, record).then(() => { this.post(HostToWorkerType.ChildDisposed, { callId }) })
  }

  /**
   * Start (or join) one registered child's disposal; the registry entry
   * leaves when it settles. Memoized per callId: the worker's dispose RPC,
   * the dispose() host drive, and the reap can all land on the same child —
   * the child's `dispose()` runs once and every caller awaits that one
   * settlement. A rejection is contained (the subagent seam's dispose() is
   * not supposed to reject, but a backend that does anyway must not break
   * quiescence): logged, and the child still leaves the registry.
   * @param callId - the child's registry key.
   * @param record - the registered child (the caller looked it up).
   * @returns resolves when the disposal settled either way; never rejects.
   */
  private disposeChild(callId: number, record: ChildRecord): Promise<void> {
    if (record.disposal !== undefined) return record.disposal
    record.disposal = Promise.resolve()
      .then(() => record.run.dispose())
      .catch((error: unknown) => {
        this.ctx.logger.warn(`workflow-worker-thread: child dispose failed: ${renderThrown(error)}`)
      })
      .then(() => { this.finishChild(callId) })
    return record.disposal
  }

  /** Drop a child record and release quiescence waiters when all work ends. */
  private finishChild(callId: number): void {
    this.children.delete(callId)
    this.reapedChildCallIds.add(callId)
    this.activeChildCallIds.delete(callId)
    this.notifyRunQuiescence()
  }

  /** Retire one provider startup transaction. */
  private finishPendingStart(task: Promise<void>, callId: number): void {
    this.pendingStarts.delete(task)
    if (!this.children.has(callId)) this.activeChildCallIds.delete(callId)
    this.notifyRunQuiescence()
  }

  /** Release waiters only after provider, child, and scratch work ends. */
  private notifyRunQuiescence(): void {
    if (this.children.size !== 0 || this.pendingStarts.size !== 0 || this.pendingScratch.size !== 0) return
    for (const waiter of this.quiescenceWaiters.splice(0)) waiter()
  }

  /** Resolves once every pending start, child, and admitted scratch operation is quiescent. */
  private runQuiescence(): Promise<void> {
    if (this.children.size === 0 && this.pendingStarts.size === 0 && this.pendingScratch.size === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => { this.quiescenceWaiters.push(resolve) })
  }

  /** Abort + dispose every registered child (worker death / final teardown); disposal is contained, not awaited. */
  private reapChildren(reason: string): void {
    this.abortChildren(this.cancelReason ?? reason)
    for (const [callId, record] of [...this.children]) {
      void this.disposeChild(callId, record)
    }
  }

  /** Abort the one canonical signal shared by pending and published children. */
  private abortChildren(reason: string): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason)
  }

  private onResult(result: WorkflowResult): void {
    // onRawMessage excludes a late duplicate or a Result queued behind another
    // terminal source before dispatch reaches this method.
    // First-wins is decided when the Result message reaches the host. If no
    // external cancellation was already in flight, this result won. Reaping a
    // stray child below may synchronously reenter cancel() through provider
    // callbacks, but that internal post-result cleanup must not retroactively
    // rewrite the worker result that arrived first.
    const cancellationWasRequested = this.cancelReason !== undefined
    const observedSpend = this.observedAgentSpend()
    if (result.agentsStarted < observedSpend) {
      throw new WorkflowProtocolError(
        `result agentsStarted ${result.agentsStarted} is below the host-observed spend ${observedSpend}`,
      )
    }
    if (result.agentsStarted > this.init.limits.maxTotalAgents) {
      throw new WorkflowProtocolError(
        `result agentsStarted ${result.agentsStarted} exceeds the ${this.init.limits.maxTotalAgents}-agent cap`,
      )
    }
    // Claim before settlement cleanup invokes provider disposal. Once Result
    // won, a later cancellation cannot rewrite it.
    this.terminalClaimed = true
    // Abort pending starts and begin disposing published children before the
    // workflow becomes externally settled. Scratch operations already
    // admitted are effects: drain them before publishing the outcome.
    this.reapChildren('workflow settled')
    this.endStrandedAgents()
    this.drainingWorkerResult = true
    void this.settleAfterScratch(result, cancellationWasRequested)
  }

  /** Drain admitted scratch effects before publishing the worker-selected outcome. */
  private async settleAfterScratch(result: WorkflowResult, cancellationWasRequested: boolean): Promise<void> {
    await this.scratchQuiescence()
    /* v8 ignore next -- scratch quiescence resolves before any competing settle can pass the terminal claim */
    if (this.settled) return
    if (cancellationWasRequested || this.cancelReason !== undefined) {
      this.settleResult(result.stopReason === 'cancelled'
        ? result
        : this.cancelledResult(result.agentsStarted))
      return
    }
    /* v8 ignore start -- deterministic tests cannot order Result ahead of
     * scratch-failure termination; onScratchFailure covers I/O failure. */
    if (this.scratchFailure !== undefined) {
      this.settleResult({
        value: null,
        stopReason: 'error',
        error: this.scratchFailure,
        agentsStarted: result.agentsStarted,
      })
      return
    }
    /* v8 ignore stop */
    this.settleResult(result)
  }

  /** Serve one quota-checked, atomic scratch write. */
  private onScratchWrite(callId: number, name: string, content: string): Promise<void> {
    this.claimScratchCall(callId, name, 'scratch-write')
    return this.trackScratch(async () => {
      this.scratchController.signal.throwIfAborted()
      const state = await this.getScratchState()
      if (state === undefined) {
        this.post(HostToWorkerType.ScratchWritten, { callId })
        return
      }
      await this.writeScratch(state, name, content)
      this.post(HostToWorkerType.ScratchWritten, { callId })
    })
  }

  /** Serve one no-follow, bounded scratch read. */
  private onScratchRead(callId: number, name: string): Promise<void> {
    this.claimScratchCall(callId, name, 'scratch-read')
    return this.trackScratch(async () => {
      this.scratchController.signal.throwIfAborted()
      const state = await this.getScratchState()
      if (state === undefined) {
        this.post(HostToWorkerType.ScratchReadResult, { callId })
        return
      }
      const content = await this.readScratch(state, name)
      this.post(HostToWorkerType.ScratchReadResult, {
        callId,
        ...(content === undefined ? {} : { content }),
      })
    })
  }

  /** Validate one scratch RPC before queueing any filesystem work. */
  private claimScratchCall(callId: number, name: string, operation: string): void {
    if (!SCRATCH_NAME.test(name)) {
      throw new WorkflowProtocolError(`${operation} name must be one safe path component`)
    }
    if (this.cancelReason !== undefined || this.workerDeathObserved || this.terminalClaimed) {
      throw new WorkflowProtocolError(`${operation} arrived after the run stopped admitting effects`)
    }
    if (this.scratchOperations >= this.hostLimits.scratch.maxOperations) {
      throw new WorkflowProtocolError(
        `${operation} exceeds the ${this.hostLimits.scratch.maxOperations}-operation scratch limit`,
      )
    }
    if (this.pendingScratch.size >= this.hostLimits.scratch.maxPendingOperations) {
      throw new WorkflowProtocolError(
        `${operation} exceeds the ${this.hostLimits.scratch.maxPendingOperations}-operation pending scratch limit`,
      )
    }
    this.claimCallId(callId, operation)
    this.scratchOperations += 1
  }

  /** Serialize, retain, and contain one admitted scratch operation. */
  private trackScratch(operation: () => Promise<void>): Promise<void> {
    const execution = this.scratchTail.then(operation)
    this.scratchTail = execution.catch(() => { /* the tracked operation reports the failure */ })
    const tracked = execution.then(
      () => {},
      (error: unknown) => { this.onScratchFailure(error) },
    )
    this.pendingScratch.add(tracked)
    void tracked.then(() => {
      this.pendingScratch.delete(tracked)
      this.notifyRunQuiescence()
    })
    return tracked
  }

  /** Resolve once every scratch operation admitted before the terminal frame is quiescent. */
  private scratchQuiescence(): Promise<void> {
    if (this.pendingScratch.size === 0) return Promise.resolve()
    return Promise.all([...this.pendingScratch]).then(() => {})
  }

  /** Turn a scratch quota, integrity, or I/O failure into a run-local terminal error. */
  private onScratchFailure(error: unknown): void {
    // Cancellation aborts admitted file operations intentionally. Their
    // rejection only retires quiescence; the cancellation outcome already
    // owns settlement and must not be rewritten as a scratch/worker error.
    if (this.cancelReason !== undefined) return
    if (this.scratchFailure !== undefined) return
    this.scratchFailure = `workflow scratch operation failed: ${renderThrown(error)}`
    if (!this.scratchController.signal.aborted) this.scratchController.abort(this.scratchFailure)
    this.onWorkerDeath(this.scratchFailure, false)
    void this.worker.terminate()
  }

  /** Initialize scratch storage at first use, never merely because a run started. */
  private getScratchState(): Promise<ScratchState | undefined> {
    const existing = this.scratchState
    if (existing !== undefined) return existing
    const created = this.initializeScratch()
    this.scratchState = created
    return created
  }

  /** Verify/create the owner-private scratch directory and account retained files on resume. */
  private async initializeScratch(): Promise<ScratchState | undefined> {
    if (this.scratchDir === undefined) return undefined
    const dir = join(this.scratchDir, 'scratch')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const directory = await lstat(dir)
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('scratch path is not a real directory')
    }
    await chmod(dir, 0o700)
    const files = new Map<string, ScratchFileState>()
    let totalBytes = 0
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!SCRATCH_NAME.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`scratch directory contains an unsupported entry ${JSON.stringify(entry.name)}`)
      }
      const file = await this.scratchFileState(join(dir, entry.name))
      if (file.size > this.hostLimits.scratch.maxFileBytes) {
        throw new Error(`scratch file ${JSON.stringify(entry.name)} exceeds the per-file quota`)
      }
      files.set(entry.name, file)
      totalBytes += file.size
    }
    if (files.size > this.hostLimits.scratch.maxFiles) {
      throw new Error(`scratch directory exceeds the ${this.hostLimits.scratch.maxFiles}-file quota`)
    }
    if (totalBytes > this.hostLimits.scratch.maxTotalBytes) {
      throw new Error(`scratch directory exceeds the ${this.hostLimits.scratch.maxTotalBytes}-byte quota`)
    }
    return { dir, device: directory.dev, inode: directory.ino, files, totalBytes }
  }

  /** Inspect one singly linked scratch path without following a final symlink. */
  private async scratchFileState(path: string): Promise<ScratchFileState> {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`scratch path ${JSON.stringify(path)} is not a regular file`)
    }
    if (before.nlink !== 1) {
      throw new Error(`scratch path ${JSON.stringify(path)} has multiple hard links`)
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      /* v8 ignore next -- a non-file descriptor requires a path replacement between lstat() and open(). */
      if (!info.isFile()) throw new Error(`scratch path ${JSON.stringify(path)} is not a regular file`)
      /* v8 ignore next -- inode mismatch requires a path replacement between lstat() and open(). */
      if (info.dev !== before.dev || info.ino !== before.ino) {
        /* v8 ignore next */
        throw new Error(`scratch path ${JSON.stringify(path)} changed while opening`)
      }
      /* v8 ignore next -- link-count change requires an external hard-link race after lstat(). */
      if (info.nlink !== 1) {
        /* v8 ignore next */
        throw new Error(`scratch path ${JSON.stringify(path)} gained a hard link while opening`)
      }
      /* v8 ignore next -- Node fs.Stat.size is always a non-negative safe integer for an opened local file. */
      if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error('scratch file size is invalid')
      await handle.chmod(0o600)
      return { device: info.dev, inode: info.ino, size: info.size }
    } finally {
      await handle.close()
    }
  }

  /** Atomically publish one owner-only scratch file after quota admission. */
  private async writeScratch(state: ScratchState, name: string, content: string): Promise<void> {
    this.scratchController.signal.throwIfAborted()
    await this.assertScratchDirectory(state)
    const bytes = Buffer.from(content, 'utf8')
    const limits = this.hostLimits.scratch
    if (bytes.length > limits.maxFileBytes) {
      throw new Error(`scratch file ${JSON.stringify(name)} exceeds the ${limits.maxFileBytes}-byte per-file quota`)
    }
    const previous = state.files.get(name)
    if (previous === undefined && state.files.size >= limits.maxFiles) {
      throw new Error(`scratch write exceeds the ${limits.maxFiles}-file quota`)
    }
    const nextTotal = state.totalBytes - (previous?.size ?? 0) + bytes.length
    if (nextTotal > limits.maxTotalBytes) {
      throw new Error(`scratch write exceeds the ${limits.maxTotalBytes}-byte total quota`)
    }
    const target = join(state.dir, name)
    const temporary = join(state.dir, `.${randomBytes(12).toString('hex')}.tmp`)
    const backup = join(state.dir, `.${randomBytes(12).toString('hex')}.bak`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let staged: ScratchFileState | undefined
    let previousMoved = false
    let published = false
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.chmod(0o600)
      await handle.writeFile(bytes, { signal: this.scratchController.signal })
      await handle.sync()
      const stagedInfo = await handle.stat()
      /* v8 ignore next -- the owner-held wx descriptor cannot change file type; link-count mutation needs an external race. */
      if (!stagedInfo.isFile() || stagedInfo.nlink !== 1) {
        /* v8 ignore next */
        throw new Error('scratch temporary path changed while writing')
      }
      staged = { device: stagedInfo.dev, inode: stagedInfo.ino, size: bytes.length }
      await handle.close()
      handle = undefined
      this.scratchController.signal.throwIfAborted()
      await this.assertScratchDirectory(state)
      if (previous !== undefined) {
        await this.assertScratchFileIdentity(target, previous)
        await rename(target, backup)
        previousMoved = true
        await this.assertScratchFileIdentity(backup, previous)
        this.scratchController.signal.throwIfAborted()
      }
      await link(temporary, target)
      published = true
      await this.assertScratchFileIdentity(target, staged, true)
      await rm(temporary)
      await this.assertScratchFileIdentity(target, staged)
      state.files.set(name, staged)
      state.totalBytes = nextTotal
      if (previousMoved && previous !== undefined) {
        await this.assertScratchFileIdentity(backup, previous)
        await rm(backup)
        previousMoved = false
      }
    } catch (error: unknown) {
      if (previousMoved && !published) {
        // `link` is an atomic no-clobber restore. Keep the unique backup even
        // when it succeeds: a concurrent actor may replace either name after
        // the link, so deleting one here could delete data not owned by this
        // transaction.
        await link(backup, target).catch(() => {})
      }
      throw error
    } finally {
      /* v8 ignore next -- reaching cleanup with an open handle requires an injected fs write/sync failure. */
      if (handle !== undefined) await handle.close().catch(() => {})
      /* v8 ignore next -- cleanup failures are deliberately swallowed after the primary transaction failure. */
      if (!published) await rm(temporary, { force: true }).catch(() => {})
    }
  }

  /** Read one expected regular file through an owner-held no-follow descriptor. */
  private async readScratch(state: ScratchState, name: string): Promise<string | undefined> {
    const expected = state.files.get(name)
    if (expected === undefined) return undefined
    this.scratchController.signal.throwIfAborted()
    await this.assertScratchDirectory(state)
    const path = join(state.dir, name)
    let before: Awaited<ReturnType<typeof lstat>>
    try {
      before = await lstat(path)
    } catch (error: unknown) {
      /* v8 ignore next -- safe component + verified directory leaves ENOENT as the only ordinary lstat failure. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state.files.delete(name)
      state.totalBytes -= expected.size
      return undefined
    }
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`scratch path ${JSON.stringify(name)} is not a regular file`)
    }
    if (before.nlink !== 1) {
      throw new Error(`scratch path ${JSON.stringify(name)} has multiple hard links`)
    }
    if (before.dev !== expected.device || before.ino !== expected.inode) {
      throw new Error(`scratch path ${JSON.stringify(name)} changed after initialization`)
    }
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error: unknown) {
      /* v8 ignore next -- after successful lstat, a non-ENOENT open failure requires an external permission/type race. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      /* v8 ignore start -- disappearance between lstat() and open() is a real filesystem race that deterministic tests cannot order. */
      state.files.delete(name)
      state.totalBytes -= expected.size
      return undefined
      /* v8 ignore stop */
    }
    try {
      const info = await handle.stat()
      /* v8 ignore next -- a non-file descriptor requires a path replacement between lstat() and open(). */
      if (!info.isFile()) throw new Error(`scratch path ${JSON.stringify(name)} is not a regular file`)
      /* v8 ignore next -- inode mismatch requires a path replacement between lstat() and open(). */
      if (info.dev !== before.dev || info.ino !== before.ino) {
        /* v8 ignore next */
        throw new Error(`scratch path ${JSON.stringify(name)} changed while opening`)
      }
      /* v8 ignore next -- link-count change requires an external hard-link race after open(). */
      if (info.nlink !== 1) {
        /* v8 ignore next */
        throw new Error(`scratch path ${JSON.stringify(name)} gained a hard link while opening`)
      }
      if (info.size > this.hostLimits.scratch.maxFileBytes) {
        throw new Error(`scratch file ${JSON.stringify(name)} exceeds the per-file quota`)
      }
      const bytes = await handle.readFile({ signal: this.scratchController.signal })
      /* v8 ignore next -- growth after descriptor stat and before read completion is an external filesystem race. */
      if (bytes.length > this.hostLimits.scratch.maxFileBytes) {
        /* v8 ignore next */
        throw new Error(`scratch file ${JSON.stringify(name)} grew beyond the per-file quota while reading`)
      }
      const nextTotal = state.totalBytes - expected.size + bytes.length
      if (nextTotal > this.hostLimits.scratch.maxTotalBytes) {
        throw new Error('scratch directory grew beyond the total quota while reading')
      }
      expected.size = bytes.length
      state.totalBytes = nextTotal
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } finally {
      await handle.close()
    }
  }

  /** Reject a scratch path whose current inode is not the transaction-owned file. */
  private async assertScratchFileIdentity(
    path: string,
    expected: ScratchFileState,
    allowStagingLink = false,
  ): Promise<void> {
    const current = await lstat(path)
    if (!current.isFile()
      || current.isSymbolicLink()
      || current.dev !== expected.device
      || current.ino !== expected.inode
      || current.nlink !== (allowStagingLink ? 2 : 1)) {
      throw new Error(`scratch file ${JSON.stringify(path)} changed during publication`)
    }
  }

  /** Reject a scratch directory that was replaced after lazy initialization. */
  private async assertScratchDirectory(state: ScratchState): Promise<void> {
    const current = await lstat(state.dir)
    if (!current.isDirectory()
      || current.isSymbolicLink()
      || current.dev !== state.device
      || current.ino !== state.inode) {
      throw new Error('scratch directory changed after initialization')
    }
  }

  /** Process an error/messageerror/exit signal; `exit` also performs the final disposal sweep. */
  private onWorkerDeath(message: string, isExit: boolean): void {
    if (!this.workerDeathObserved) {
      // Close message admission BEFORE cleanup callbacks: Node can deliver a
      // message queued before the crash after its `error` event. Treating the
      // first death signal as a logical barrier prevents that late message
      // from creating work or narrating after workflow/end.
      this.workerDeathObserved = true
      const outcomeWasClaimed = this.terminalClaimed
      const cancellationWasRequested = this.cancelReason !== undefined
      // A valid Result may race physical worker exit while admitted unawaited
      // scratch effects drain. Preserve those effects; every other death
      // source aborts scratch publication before selecting its outcome.
      if (!outcomeWasClaimed && !this.scratchController.signal.aborted) {
        this.scratchController.abort('workflow worker gone')
      }
      // When death is itself the terminal source, claim BEFORE child reap or
      // synthesized observer callbacks. Either can reenter cancel(); a death
      // that arrived first remains an error, while a cancellation already
      // accepted before death remains cancelled. If Result/grace already won,
      // preserve it while still performing prompt failure-time cleanup.
      if (!outcomeWasClaimed) this.terminalClaimed = true
      if (this.children.size > 0 || this.pendingStarts.size > 0) this.reapChildren('workflow worker gone')
      this.endStrandedAgents()
      if (!outcomeWasClaimed) {
        if (cancellationWasRequested) {
          this.settleResult(this.cancelledResult(this.observedAgentSpend()))
        } else {
          this.settleResult({
            value: null,
            stopReason: 'error',
            error: message,
            agentsStarted: this.observedAgentSpend(),
          })
        }
      }
    }
    if (!isExit) return
    // `error` is not Node's physical delivery barrier: a queued message may
    // precede `exit`. Admission is already closed, so this final sweep only
    // joins/starts disposal for registry survivors; it deliberately does not
    // repeat explicit provider cancellation.
    for (const [callId, record] of [...this.children]) void this.disposeChild(callId, record)
    this.endStrandedAgents()
  }

  /**
   * The single agent-end emission gate: forwards `end` iff its start is still
   * unpaired in the ledger, so every forwarded `workflow/agent-start` gets
   * EXACTLY one `workflow/agent-end` — the worker's own report where it can
   * speak, a host-synthesized one where it cannot ({@link endStrandedAgents}).
   * @param end - the settlement to emit (worker-reported or synthesized).
   */
  private endAgent(end: WorkflowAgentEndInfo): void {
    /* v8 ignore next -- a real end still in flight across the grace force-settle: not orderable in-process */
    if (!this.liveAgents.delete(end.seq)) return
    this.observer.agentEnd(end)
  }

  /**
   * Synthesize the missing `agent-end` for every started-but-unpaired agent,
   * outcome `'cancelled'`: the reap cancels every child, and a real
   * settlement racing the force-settle loses to that already-started external
   * cancellation. The atomic terminal boundaries in {@link onResult} and
   * {@link onWorkerDeath} deliberately exclude teardown callbacks as contenders.
   * Called where the worker can no longer speak (the grace force-settle,
   * worker death, physical exit). When grace/death is the terminal source it
   * runs before settleResult, so already-known pairs precede `workflow/end`;
   * after an earlier Result, exit cleanup may close a survivor afterward.
   * The ledger preserves exactly-once pairing in both orders.
   */
  private endStrandedAgents(): void {
    for (const info of [...this.liveAgents.values()]) {
      this.endAgent({ ...info, outcome: 'cancelled' })
    }
  }

  private cancelledResult(agentsStarted: number): WorkflowResult {
    // cancel() is the only writer of cancelReason and every caller checks it
    // first; the fallback guards the type, not a reachable path.
    /* v8 ignore next */
    const reason = this.cancelReason ?? 'workflow cancelled'
    return {
      value: null,
      stopReason: 'cancelled',
      error: `workflow run cancelled: ${reason}`,
      errorCode: 'CANCELLED',
      agentsStarted,
    }
  }

  /** Cumulative logical-agent spend the host can prove across resume attempts. */
  private observedAgentSpend(): number {
    return (this.init.initialAgentSpend ?? 0) + this.hostStarted
  }

  /** Remove the exact abort callback installed on the caller's start signal. */
  private detachInputSignal(): void {
    const signal = this.inputSignal
    const onAbort = this.inputSignalAbort
    if (signal === undefined || onAbort === undefined) return
    this.inputSignal = undefined
    this.inputSignalAbort = undefined
    signal.removeEventListener('abort', onAbort)
  }

  /** First settle wins; disarms the grace timer and releases the caller signal. */
  private settleResult(result: WorkflowResult): void {
    // Every current terminal source claims ownership before calling here; keep
    // the fallback local so a future caller cannot resolve twice.
    /* v8 ignore next -- defensive fallback outside the claimed state machine */
    if (this.settled) return
    this.terminalClaimed = true
    this.settled = true
    this.detachInputSignal()
    clearTimeout(this.graceTimer)
    this.settleResolve(result)
  }
}

/** A plain timer sleep (the dispose grace); unref'd so it never holds the process open. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}
