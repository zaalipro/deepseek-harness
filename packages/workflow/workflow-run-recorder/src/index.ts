/**
 * Source-neutral durable projection for explicitly attributed workflow
 * launches. Consumers wrap exactly one top-level `workflowSupervisor.start()`
 * call; unrelated and nested supervisor launches remain dashboard-only.
 *
 * @module @deepseek-ai/dsh-workflow-run-recorder
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import type {
  SupervisedWorkflowMemberLifecycleInfo,
  SupervisedWorkflowRunId,
  SupervisedWorkflowRunInfo,
  SupervisedWorkflowStopReason,
  WorkflowLaunched,
} from '@deepseek-ai/dsh-workflow-supervisor/types'
import type {
  WorkflowRunRecordAgentEndData,
  WorkflowRunRecordAgentStartData,
  WorkflowRunRecordEndData,
  WorkflowRunRecordStartData,
} from './types.ts'
// Declaration merge only: supplies the supervisor lifecycle event signatures.
import type {} from '@deepseek-ai/dsh-workflow-supervisor'

interface LaunchAttribution {
  readonly session: Session
  runId?: SupervisedWorkflowRunId
  readonly pending: Map<SupervisedWorkflowRunId, Array<() => void>>
}

interface ActiveRecord {
  readonly session: Session
  readonly startedMembers: Set<number>
  readonly openMembers: Set<number>
  readonly pending: PendingLifecycle[]
}

type PendingLifecycle =
  | {
    readonly kind: 'member-start'
    readonly member: SupervisedWorkflowMemberLifecycleInfo
  }
  | {
    readonly kind: 'member-end'
    readonly member: SupervisedWorkflowMemberLifecycleInfo
  }
  | {
    readonly kind: 'run-end'
    readonly stopReason: SupervisedWorkflowStopReason
  }

interface WorkflowRunRecordEventMap {
  'tool-workflow/run-start': WorkflowRunRecordStartData
  'tool-workflow/agent-start': WorkflowRunRecordAgentStartData
  'tool-workflow/agent-end': WorkflowRunRecordAgentEndData
  'tool-workflow/run-end': WorkflowRunRecordEndData
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowRunRecorder: WorkflowRunRecorder
  }
}

/** Render a contained recording failure without trusting the thrown value. */
function renderRecordingError(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/** Reject a runtime variant omitted from a closed-union switch. */
/* v8 ignore start -- PendingLifecycle is a closed same-module union. */
function assertNever(value: never): never {
  throw new Error(`unexpected pending workflow lifecycle ${String(value)}`)
}
/* v8 ignore stop */

/**
 * Records the logical lifecycle of launches that a Consumer explicitly
 * attributes to a parent Session.
 *
 * Recording is best-effort: the first failed append disables that run's later
 * events and logs a warning without changing workflow execution. Each launch
 * call claims at most one synchronously published run identity. Later member
 * and terminal events use that stable identity across pause/resume attempts.
 */
export class WorkflowRunRecorder extends Service {
  static inject = ['workflowSupervisor', 'agents']

  private readonly launching = new AsyncLocalStorage<LaunchAttribution>()
  private readonly active = new Map<SupervisedWorkflowRunId, ActiveRecord>()
  private readonly recoveryCandidates = new Set<SupervisedWorkflowRunId>()
  private readonly recoveries = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()

  /**
   * Create the singleton recorder and attach it to supervisor lifecycle events.
   * @param ctx - context carrying the workflow supervisor event producer.
   */
  constructor(ctx: Context) {
    super(ctx, 'workflowRunRecorder')
    ctx.on('workflows/run-start', (info) => { this.recordRunStart(info) })
    ctx.on('workflows/member-start', (info, member) => { this.recordMemberStart(info, member) })
    ctx.on('workflows/member-end', (info, member) => { this.recordMemberEnd(info, member) })
    ctx.on('workflows/run-end', (info, result) => { this.finish(info.id, result.stopReason) })
    ctx.on('agent/created', ({ agent }) => { this.recoverAgent(agent) })
    for (const agent of ctx.agents.list()) this.recoverAgent(agent)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('workflow run recorder disposed'))
      await Promise.allSettled(this.recoveries)
      this.active.clear()
      this.recoveryCandidates.clear()
      this.launching.disable()
    })
  }

  /**
   * Attribute the one logical run started by `start` to `session`.
   *
   * The callback owns execution and may reject unchanged. Lifecycle recording
   * failures are contained. Callers must use this only for an independently
   * presented top-level run; nested and internal launches call the supervisor
   * directly.
   *
   * @param session - exact parent Session that owns the durable Chat record.
   * @param start - one callback that starts and returns the attributed run.
   * @returns the supervisor's launch result unchanged.
   */
  launch(session: Session, start: () => Promise<WorkflowLaunched>): Promise<WorkflowLaunched> {
    const attribution: LaunchAttribution = { session, pending: new Map() }
    return this.launching.run(attribution, async () => {
      const launched = await start()
      if (attribution.runId === undefined) {
        attribution.runId = launched.runId
        const pending = attribution.pending.get(launched.runId)
        attribution.pending.clear()
        if (this.append(session, 'tool-workflow/run-start', {
          runId: launched.runId,
          name: launched.displayName,
        })) {
          this.active.set(launched.runId, this.emptyRecord(session))
        }
        for (const replay of pending ?? []) replay()
      } else if (attribution.runId !== launched.runId) {
        this.ctx.logger.warn(
          'workflow-run-recorder: disabled durable record because launch result changed the logical run id',
        )
        this.active.delete(attribution.runId)
        this.recoveryCandidates.delete(attribution.runId)
      }
      return launched
    })
  }

  /** Append one package-owned log-only event, containing storage failures. */
  private append<Type extends keyof WorkflowRunRecordEventMap>(
    session: Session,
    type: Type,
    data: SessionEventMap[Type],
  ): boolean {
    const appendRecord = session.append.bind(session) as <Event extends keyof WorkflowRunRecordEventMap>(
      event: Event,
      value: SessionEventMap[Event],
    ) => void
    try {
      appendRecord(type, data)
      return true
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `workflow-run-recorder: disabled durable record after ${type} append failed: ${renderRecordingError(error)}`,
      )
      return false
    }
  }

  /** Buffer lifecycle emitted inside a launch before its stable identity is published. */
  private bufferBeforePublication(runId: SupervisedWorkflowRunId, replay: () => void): boolean {
    const attribution = this.launching.getStore()
    if (attribution === undefined || attribution.runId !== undefined) return false
    const pending = attribution.pending.get(runId) ?? []
    pending.push(replay)
    attribution.pending.set(runId, pending)
    return true
  }

  /** Claim the first logical identity synchronously published by one attributed launch. */
  private recordRunStart(info: SupervisedWorkflowRunInfo): void {
    const attribution = this.launching.getStore()
    if (attribution === undefined || attribution.runId !== undefined) return
    attribution.runId = info.id
    const pending = attribution.pending.get(info.id) ?? []
    attribution.pending.clear()
    if (this.append(attribution.session, 'tool-workflow/run-start', {
      runId: info.id,
      name: info.displayName,
    })) {
      this.active.set(info.id, this.emptyRecord(attribution.session))
    }
    for (const replay of pending) replay()
  }

  /** Record one published logical member when its run remains recordable. */
  private recordMemberStart(
    info: SupervisedWorkflowRunInfo,
    member: SupervisedWorkflowMemberLifecycleInfo,
  ): void {
    const record = this.active.get(info.id)
    if (record === undefined) {
      this.bufferBeforePublication(info.id, () => { this.recordMemberStart(info, member) })
      return
    }
    if (this.recoveryCandidates.has(info.id)) {
      record.pending.push({ kind: 'member-start', member })
      return
    }
    this.appendMemberStart(info.id, record, member)
  }

  /** Append one member start and advance the recorder's accepted prefix. */
  private appendMemberStart(
    runId: SupervisedWorkflowRunId,
    record: ActiveRecord,
    member: SupervisedWorkflowMemberLifecycleInfo,
  ): boolean {
    if (record.startedMembers.has(member.seq)) {
      this.ctx.logger.warn(
        `workflow-run-recorder: disabled durable record after duplicate member start ${member.seq}`,
      )
      this.disable(runId)
      return false
    }
    const data: WorkflowRunRecordAgentStartData = {
      runId,
      seq: member.seq,
      label: member.label,
      ...member.phase === undefined ? {} : { phase: member.phase },
      childId: member.childSessionId,
    }
    if (!this.append(record.session, 'tool-workflow/agent-start', data)) {
      this.disable(runId)
      return false
    }
    record.startedMembers.add(member.seq)
    record.openMembers.add(member.seq)
    return true
  }

  /** Record one terminal logical member outcome, rejecting impossible live endings. */
  private recordMemberEnd(
    info: SupervisedWorkflowRunInfo,
    member: SupervisedWorkflowMemberLifecycleInfo,
  ): void {
    const record = this.active.get(info.id)
    if (record === undefined) {
      this.bufferBeforePublication(info.id, () => { this.recordMemberEnd(info, member) })
      return
    }
    if (this.recoveryCandidates.has(info.id)) {
      record.pending.push({ kind: 'member-end', member })
      return
    }
    this.appendMemberEnd(info.id, record, member)
  }

  /** Append one settled member and advance the recorder's accepted prefix. */
  private appendMemberEnd(
    runId: SupervisedWorkflowRunId,
    record: ActiveRecord,
    member: SupervisedWorkflowMemberLifecycleInfo,
  ): boolean {
    if (!record.startedMembers.has(member.seq) || !record.openMembers.has(member.seq)) {
      this.ctx.logger.warn(
        `workflow-run-recorder: disabled durable record after unpaired member end ${member.seq}`,
      )
      this.disable(runId)
      return false
    }
    if (member.status === 'running') {
      this.ctx.logger.warn(
        'workflow-run-recorder: disabled durable record because a logical member end remained running',
      )
      this.disable(runId)
      return false
    }
    const data: WorkflowRunRecordAgentEndData = {
      runId,
      seq: member.seq,
      outcome: member.status,
    }
    if (!this.append(record.session, 'tool-workflow/agent-end', data)) {
      this.disable(runId)
      return false
    }
    record.openMembers.delete(member.seq)
    return true
  }

  /** Close one recorded logical run after terminal supervisor cleanup. */
  private finish(runId: SupervisedWorkflowRunId, stopReason: SupervisedWorkflowStopReason): void {
    const record = this.active.get(runId)
    if (record === undefined) {
      this.bufferBeforePublication(runId, () => { this.finish(runId, stopReason) })
      return
    }
    if (this.recoveryCandidates.has(runId)) {
      record.pending.push({ kind: 'run-end', stopReason })
      return
    }
    if (record.openMembers.size > 0) {
      this.ctx.logger.warn(
        'workflow-run-recorder: disabled durable record because run-end left members open',
      )
      this.disable(runId)
      return
    }
    this.append(record.session, 'tool-workflow/run-end', { runId, stopReason })
    this.disable(runId)
  }

  /** Forget one record after terminal publication or the first append failure. */
  private disable(runId: SupervisedWorkflowRunId): void {
    this.active.delete(runId)
    this.recoveryCandidates.delete(runId)
  }

  /** Reconstruct open durable prefixes without changing their recorded state. */
  private seedSession(session: Session): void {
    const open = new Map<SupervisedWorkflowRunId, ActiveRecord>()
    for (const event of session.events) {
      if (!event.type.startsWith('tool-workflow/')) continue
      const data: unknown = event.data
      if (typeof data !== 'object' || data === null || Array.isArray(data)) continue
      const fields = data as Record<string, unknown>
      if (typeof fields.runId !== 'string' || fields.runId.length === 0) continue
      const runId = fields.runId as SupervisedWorkflowRunId
      if (event.type === 'tool-workflow/run-start') {
        open.set(runId, this.emptyRecord(session))
      } else if (event.type === 'tool-workflow/agent-start') {
        if (Number.isSafeInteger(fields.seq)) {
          open.get(runId)?.startedMembers.add(fields.seq as number)
          open.get(runId)?.openMembers.add(fields.seq as number)
        }
      } else if (event.type === 'tool-workflow/agent-end') {
        if (Number.isSafeInteger(fields.seq)) open.get(runId)?.openMembers.delete(fields.seq as number)
      } else if (event.type === 'tool-workflow/run-end') {
        open.delete(runId)
      }
    }
    for (const [runId, record] of open) {
      if (this.active.has(runId)) continue
      this.active.set(runId, record)
      this.recoveryCandidates.add(runId)
    }
  }

  /** Create the mutable state for one accepted run-start prefix. */
  private emptyRecord(session: Session): ActiveRecord {
    return { session, startedMembers: new Set(), openMembers: new Set(), pending: [] }
  }

  /** Recover one live owner's durable roster, then reconcile every terminal row. */
  private recoverAgent(agent: Agent): void {
    this.seedSession(agent.session)
    const candidates = [...this.recoveryCandidates]
      .filter(runId => this.active.get(runId)?.session === agent.session)
    if (candidates.length === 0) return
    const operation = (async (): Promise<void> => {
      await this.ctx.workflowSupervisor.recoverSession(agent, this.lifetime.signal)
      for (const runId of candidates) {
        try {
          const snapshot = await this.ctx.workflowSupervisor.recordingSnapshot(
            agent, runId, this.lifetime.signal,
          )
          if (snapshot === undefined) {
            this.finishMissing(runId, agent.session)
            continue
          }
          this.reconcileSnapshot(runId, snapshot.members, snapshot.result?.stopReason)
        } catch (error: unknown) {
          this.warnRecoveryFailure(error)
          if (!this.lifetime.signal.aborted) this.activateRecovered(runId)
        }
      }
    })().catch((error: unknown) => {
      this.warnRecoveryFailure(error)
      if (!this.lifetime.signal.aborted) {
        for (const runId of candidates) this.activateRecovered(runId)
      }
    })
    this.recoveries.add(operation)
    void operation.finally(() => { this.recoveries.delete(operation) })
  }

  /** Report a recovery read failure unless service disposal caused it. */
  private warnRecoveryFailure(error: unknown): void {
    if (this.lifetime.signal.aborted) return
    this.ctx.logger.warn(
      `workflow-run-recorder: could not reconcile durable workflow records: ${renderRecordingError(error)}`,
    )
  }

  /** Reconcile one atomic retained roster, then close or activate its record. */
  private reconcileSnapshot(
    runId: SupervisedWorkflowRunId,
    members: readonly SupervisedWorkflowMemberLifecycleInfo[],
    stopReason: SupervisedWorkflowStopReason | undefined,
  ): void {
    const record = this.active.get(runId) as ActiveRecord
    for (const member of members) {
      if (!record.startedMembers.has(member.seq)
        && !this.appendMemberStart(runId, record, member)) return
    }
    for (const member of members) {
      if (member.status !== 'running' && record.openMembers.has(member.seq)
        && !this.appendMemberEnd(runId, record, member)) return
    }
    if (stopReason === undefined) {
      this.activateRecovered(runId)
      return
    }
    for (const seq of [...record.openMembers].sort((left, right) => left - right)) {
      if (!this.append(record.session, 'tool-workflow/agent-end', {
        runId, seq, outcome: 'cancelled',
      })) {
        this.disable(runId)
        return
      }
      record.openMembers.delete(seq)
    }
    this.append(record.session, 'tool-workflow/run-end', { runId, stopReason })
    this.disable(runId)
  }

  /** Close a prefix whose supervisor row no longer exists after successful recovery. */
  private finishMissing(runId: SupervisedWorkflowRunId, session: Session): void {
    const record = this.active.get(runId) as ActiveRecord
    for (const seq of [...record.openMembers].sort((left, right) => left - right)) {
      if (!this.append(session, 'tool-workflow/agent-end', { runId, seq, outcome: 'cancelled' })) {
        this.disable(runId)
        return
      }
      record.openMembers.delete(seq)
    }
    this.append(session, 'tool-workflow/run-end', { runId, stopReason: 'interrupted' })
    this.disable(runId)
  }

  /** Release one live recovered prefix and replay lifecycle buffered during its snapshot. */
  private activateRecovered(runId: SupervisedWorkflowRunId): void {
    this.recoveryCandidates.delete(runId)
    const record = this.active.get(runId) as ActiveRecord
    const pending = record.pending.splice(0)
    for (const event of pending) {
      switch (event.kind) {
        case 'member-start':
          if (!record.startedMembers.has(event.member.seq)) {
            if (!this.appendMemberStart(runId, record, event.member)) return
          }
          break
        case 'member-end':
          if (!record.startedMembers.has(event.member.seq)
            && !this.appendMemberStart(runId, record, event.member)) return
          if (record.openMembers.has(event.member.seq)) {
            this.appendMemberEnd(runId, record, event.member)
          }
          break
        case 'run-end':
          this.finish(runId, event.stopReason)
          return
        /* v8 ignore next 2 -- PendingLifecycle is a closed same-module union. */
        default:
          assertNever(event)
      }
    }
  }
}

export default WorkflowRunRecorder
