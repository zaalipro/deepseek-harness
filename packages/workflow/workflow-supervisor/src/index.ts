/**
 * Session-owned workflow supervision with stable logical identity, retained
 * manifests, attempt-fenced pause/resume, and bounded completion delivery.
 * @module @deepseek-ai/dsh-workflow-supervisor
 */

import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import type { BigIntStats, Dirent } from 'node:fs'
import { lstat, mkdir, open, readdir, rm, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context, Events } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session/types'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { validateMeta } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowGateInfo,
  WorkflowJournalEntry,
  WorkflowMeta,
  WorkflowResult,
  WorkflowRun,
  WorkflowRunId,
} from '@deepseek-ai/dsh-workflow'
import type { WorkflowDefinition } from '@deepseek-ai/dsh-workflow-registry'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WorkflowCompletionNotifier } from './completion-notice.ts'
import {
  WorkflowRunManifestStore,
  type RecoveredWorkflowRunManifest,
  type WorkflowRunManifest,
  type WorkflowRunManifestMember,
} from './manifest-store.ts'
import type {
  SupervisedWorkflowResultInfo,
  SupervisedWorkflowRunId as LogicalRunId,
  SupervisedWorkflowRunInfo,
  SupervisedWorkflowMemberLifecycleInfo,
  WorkflowGateId as GateId,
  WorkflowLaunched,
  WorkflowMemberId as MemberId,
  WorkflowRunChange,
  WorkflowRunArtifactChunk,
  WorkflowRunArtifactPage,
  WorkflowRunArtifactRequest,
  WorkflowRunArtifactsRequest,
  WorkflowRunControlRequest,
  WorkflowRunControlResult,
  WorkflowRunCursor,
  WorkflowRunDetail,
  WorkflowRunFeedEpoch,
  WorkflowRunHead,
  WorkflowRunListPage,
  WorkflowRunListRequest,
  WorkflowRunLogPage,
  WorkflowRunLogsRequest,
  WorkflowRunMemberDetail,
  WorkflowRunMemberHead,
  WorkflowRunMemberPage,
  WorkflowRunMemberRequest,
  WorkflowRunMembersRequest,
  WorkflowRunRequest,
  WorkflowRunResultView,
  WorkflowRunStatus,
  WorkflowRunValueView,
  WorkflowSaveScope,
  WorkflowValidation,
} from './types.ts'
import { workflowRunValueView } from './value-view.ts'

export type {
  SupervisedWorkflowResultInfo,
  SupervisedWorkflowRunInfo,
  SupervisedWorkflowMemberLifecycleInfo,
  WorkflowLaunched,
  WorkflowRunChange,
  WorkflowRunAction,
  WorkflowRunArtifactChunk,
  WorkflowRunArtifactPage,
  WorkflowRunArtifactRequest,
  WorkflowRunArtifactsRequest,
  WorkflowRunControlRequest,
  WorkflowRunControlResult,
  WorkflowRunCursor,
  WorkflowRunDetail,
  WorkflowRunHead,
  WorkflowRunListPage,
  WorkflowRunListRequest,
  WorkflowRunLogPage,
  WorkflowRunLogsRequest,
  WorkflowRunMemberDetail,
  WorkflowRunMemberHead,
  WorkflowRunMemberPage,
  WorkflowRunMemberRequest,
  WorkflowRunMembersRequest,
  WorkflowRunRequest,
  WorkflowRunResultView,
  WorkflowRunStatus,
  WorkflowSaveScope,
  WorkflowValidation,
} from './types.ts'

/** Stable identity of one logical supervised run across attempts. */
export type SupervisedWorkflowRunId = LogicalRunId
/** Stable identity of one actual child launch. */
export type WorkflowMemberId = MemberId
/** Stable identity of one human-gate occurrence. */
export type WorkflowGateId = GateId

/**
 * Brand one stable logical workflow-run id.
 * @param value - opaque logical run id.
 * @returns the branded id.
 */
export function SupervisedWorkflowRunId(value: string): SupervisedWorkflowRunId {
  return value as LogicalRunId
}

/**
 * Brand one stable actual-launch member id.
 * @param value - opaque member id.
 * @returns the branded id.
 */
export function WorkflowMemberId(value: string): WorkflowMemberId {
  return value as MemberId
}

/**
 * Brand one stable human-gate occurrence id.
 * @param value - opaque gate id.
 * @returns the branded id.
 */
export function WorkflowGateId(value: string): WorkflowGateId {
  return value as GateId
}

/** Process-local question bridge payload for one parked attempt. */
export interface WorkflowGateRequest {
  readonly info: SupervisedWorkflowRunInfo
  readonly executionId: WorkflowRunId
  readonly gateId: WorkflowGateId
  readonly gate: WorkflowGateInfo
  readonly parent: Agent
  readonly signal: AbortSignal
}

/** Atomic retained lifecycle state used to reconcile Host-side event recorders. */
export interface WorkflowRunRecordingSnapshot {
  readonly info: SupervisedWorkflowRunInfo
  readonly run: WorkflowRunHead
  readonly members: readonly SupervisedWorkflowMemberLifecycleInfo[]
  readonly result?: SupervisedWorkflowResultInfo
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowSupervisor: WorkflowSupervisor
  }

  interface Events {
    /**
     * One logical workflow run was durably published before its first member.
     * @mode emit
     * @param info - stable {@link SupervisedWorkflowRunInfo} identity.
     */
    'workflows/run-start'(info: SupervisedWorkflowRunInfo): void
    /**
     * One child launch joined a published logical workflow run.
     * @mode emit
     * @param info - stable {@link SupervisedWorkflowRunInfo} identity.
     * @param member - launched {@link SupervisedWorkflowMemberLifecycleInfo} including its child Session id.
     */
    'workflows/member-start'(info: SupervisedWorkflowRunInfo, member: SupervisedWorkflowMemberLifecycleInfo): void
    /**
     * One launched child settled within its logical workflow run.
     * @mode emit
     * @param info - stable {@link SupervisedWorkflowRunInfo} identity.
     * @param member - settled {@link SupervisedWorkflowMemberLifecycleInfo} including its child Session id.
     */
    'workflows/member-end'(info: SupervisedWorkflowRunInfo, member: SupervisedWorkflowMemberLifecycleInfo): void
    /**
     * One logical workflow run reached its exact-once terminal publication.
     * @mode emit
     * @param info - stable {@link SupervisedWorkflowRunInfo} identity.
     * @param result - bounded {@link SupervisedWorkflowResultInfo} without the result value.
     */
    'workflows/run-end'(info: SupervisedWorkflowRunInfo, result: SupervisedWorkflowResultInfo): void
    /**
     * One live workflow attempt parked for human input.
     * @mode emit
     * @param request - attempt-fenced {@link WorkflowGateRequest} and exact owner.
     */
    'workflows/gate-request'(request: WorkflowGateRequest): void
  }
}

/** Workflow supervisor plugin configuration. */
export interface Config {
  /**
   * Whether the supervisor accepts new operations.
   * @default true
   */
  enabled?: boolean
  /** Harness home used to derive the default run directory; resolved through the shared Harness-home policy when omitted. */
  dshHome?: string
  /**
   * Absolute child-launch budget assigned when a launch omits one.
   * @default 128
   */
  defaultAgentBudget?: number
  /**
   * Maximum absolute child-launch budget, including resume increases.
   * @default 1024
   */
  maxAgentBudget?: number
  /** Directory containing private run directories and per-Session manifests; defaults to `<dshHome>/workflow-runs`. */
  runsRoot?: string
  /**
   * Definition scope used when Save omits one.
   * @default project
   */
  saveScope?: WorkflowSaveScope
  /**
   * Maximum UTF-8 bytes in one model-visible completion notice.
   * @default 16384
   */
  completionNoticeMaxBytes?: number
  /**
   * Completion cohorts allowed to open owner turns before claimed human input resets the count.
   * @default 3
   */
  maxConsecutiveCompletionWakes?: number
  /**
   * Maximum serialized bytes retained for an available member or terminal result.
   * @default 131072
   */
  memberOutcomeMaxBytes?: number
  /**
   * Maximum manifest rows retained for one Session.
   * @default 256
   */
  maxRetainedRunsPerSession?: number
  /**
   * Maximum display-name ordinal entries retained for one Session.
   * @default 4096
   */
  maxWorkflowNamesPerSession?: number
  /**
   * Maximum member summaries retained for one logical run.
   * @default 2048
   */
  maxMembersPerRun?: number
  /**
   * Maximum serialized bytes in one per-Session manifest.
   * @default 8388608
   */
  maxManifestBytes?: number
  /**
   * Maximum published plus reserved nonterminal runs for one Session.
   * @default 64
   */
  maxActiveRunsPerSession?: number
  /**
   * Maximum published plus reserved nonterminal runs across the supervisor.
   * @default 1024
   */
  maxActiveRunsGlobal?: number
  /**
   * Maximum log-tail lines retained for one logical run.
   * @default 1000
   */
  maxLogLines?: number
  /**
   * Maximum UTF-8 bytes retained from one log line.
   * @default 16384
   */
  maxLogLineBytes?: number
  /**
   * Maximum live retained log bytes for one logical run.
   * @default 1048576
   */
  maxLogTotalBytes?: number
  /**
   * Maximum scratch artifact names retained for one logical run.
   * @default 256
   */
  maxRetainedArtifactsPerRun?: number
  /**
   * Maximum UTF-8 bytes accepted in one scratch artifact name.
   * @default 255
   */
  maxArtifactNameBytes?: number
  /**
   * Maximum UTF-8 bytes retained from a human-gate kind.
   * @default 64
   */
  maxGateKindBytes?: number
  /**
   * Maximum UTF-8 bytes retained from a human-gate message.
   * @default 4096
   */
  maxGateMessageBytes?: number
  /**
   * Maximum UTF-8 bytes read from or written to an editable script projection.
   * @default 1048576
   */
  maxScriptProjectionBytes?: number
  /**
   * Default number of items returned by a bounded Remote page.
   * @default 50
   */
  remotePageDefault?: number
  /**
   * Maximum number of items accepted for a bounded Remote page.
   * @default 200
   */
  remotePageMax?: number
  /**
   * Default maximum UTF-8 bytes returned from one artifact read.
   * @default 32768
   */
  artifactChunkDefaultBytes?: number
  /**
   * Maximum UTF-8 bytes accepted for one artifact read.
   * @default 131072
   */
  artifactChunkMaxBytes?: number
  /**
   * Maximum UTF-8 bytes retained in each text field of a Remote head or detail.
   * @default 4096
   */
  remoteHeadTextMaxBytes?: number
  /**
   * Maximum workflow phase declarations returned by a selected-run detail.
   * @default 64
   */
  remoteDetailMaxPhases?: number
}

export const Config: Schema<Config> = z.object({
  enabled: z.boolean().default(true),
  dshHome: z.string(),
  defaultAgentBudget: z.natural().min(1).default(128),
  maxAgentBudget: z.natural().min(1).default(1024),
  runsRoot: z.string(),
  saveScope: z.union(['project', 'user'] as const).default('project'),
  completionNoticeMaxBytes: z.natural().min(256).default(16_384),
  maxConsecutiveCompletionWakes: z.natural().min(1).default(3),
  memberOutcomeMaxBytes: z.natural().min(1).default(131_072),
  maxRetainedRunsPerSession: z.natural().min(1).default(256),
  maxWorkflowNamesPerSession: z.natural().min(1).default(4_096),
  maxMembersPerRun: z.natural().min(1).default(2_048),
  maxManifestBytes: z.natural().min(1_024).default(8_388_608),
  maxActiveRunsPerSession: z.natural().min(1).default(64),
  maxActiveRunsGlobal: z.natural().min(1).default(1_024),
  maxLogLines: z.natural().min(2).default(1_000),
  maxLogLineBytes: z.natural().min(1).default(16_384),
  maxLogTotalBytes: z.natural().min(1).default(1_048_576),
  maxRetainedArtifactsPerRun: z.natural().min(1).default(256),
  maxArtifactNameBytes: z.natural().min(1).default(255),
  maxGateKindBytes: z.natural().min(12).default(64),
  maxGateMessageBytes: z.natural().min(1).default(4_096),
  maxScriptProjectionBytes: z.natural().min(1).default(1_048_576),
  remotePageDefault: z.natural().min(1).default(50),
  remotePageMax: z.natural().min(1).default(200),
  artifactChunkDefaultBytes: z.natural().min(4).default(32_768),
  artifactChunkMaxBytes: z.natural().min(4).default(131_072),
  remoteHeadTextMaxBytes: z.natural().min(64).default(4_096),
  remoteDetailMaxPhases: z.natural().min(1).default(64),
})

type AttemptIntent = 'running' | 'pause' | 'stop' | 'teardown'

interface AttemptRecord {
  readonly generation: number
  readonly executionId: WorkflowRunId
  readonly handle: WorkflowRun
  intent: AttemptIntent
  observation: Promise<void>
}

interface GateRecord {
  readonly generation: number
  readonly executionId: WorkflowRunId
  readonly gateId: GateId
  readonly gate: WorkflowGateInfo
  readonly abort: AbortController
}

interface MemberRecord {
  readonly memberId: MemberId
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly childSessionId: SessionId
  status: WorkflowRunMemberHead['status']
  readonly startedAt: number
  settledAt?: number
  resultCommitted: boolean
  outcomeEvicted: boolean
  result: JsonValue | undefined
  outcomeView: WorkflowRunValueView | undefined
}

interface LogRecord {
  readonly index: number
  readonly text: string
  readonly totalBytes: number
  readonly truncated: boolean
  readonly retainedBytes: number
}

interface ArtifactRecord {
  readonly name: string
  readonly bytes: number
  readonly identity?: string
}

type SupervisorLifecycleEventName =
  | 'workflows/run-start'
  | 'workflows/member-start'
  | 'workflows/member-end'
  | 'workflows/run-end'
  | 'workflows/gate-request'
  | 'workflows/run-change'

interface SupervisedRun {
  readonly runId: LogicalRunId
  readonly sessionId: SessionId
  readonly displayName: string
  readonly meta: WorkflowMeta
  script: string | undefined
  args: unknown
  budget: number
  spent: number
  readonly journal: Map<string, WorkflowJournalEntry>
  readonly members: Map<number, MemberRecord>
  parent: Agent | undefined
  status: WorkflowRunStatus
  phase: string | undefined
  gate: GateRecord | undefined
  durableGate: WorkflowRunManifest['gate'] | undefined
  resultView: WorkflowRunValueView
  error: string | undefined
  attempt: AttemptRecord | undefined
  generation: number
  revision: number
  detailRevision: number
  membersRevision: number
  logsRevision: number
  resultRevision: number
  artifactsRevision: number
  readonly logs: LogRecord[]
  logBytes: number
  droppedLogLines: number
  artifacts: ArtifactRecord[]
  artifactTotal: number
  readonly scriptPath?: string
  readonly runDirectory: string
  readonly scratchDir: string
  readonly builtin: boolean
  readonly numberedHandle: boolean
  readonly startedAt: number
  settledAt: number | undefined
  terminalPublished: boolean
  published: boolean
  ownerCleanup: (() => void | Promise<void>) | undefined
  completionDelivery: Promise<void>
  durablePublication: Promise<void>
  lifecyclePublication: Promise<void>
  lifecyclePending: number
}

interface ExecutionLookup {
  readonly run: SupervisedRun
  readonly generation: number
}

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>([
  'completed', 'failed', 'cancelled', 'interrupted',
])

function renderThrown(error: unknown): string {
  try { return String(error) } catch { return '[unrenderable thrown value]' }
}

function errorFromThrown(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(renderThrown(error), { cause: error })
}

function definitionMeta(definition: WorkflowDefinition): WorkflowMeta {
  return {
    name: definition.name,
    description: definition.description,
    ...(definition.whenToUse === undefined ? {} : { whenToUse: definition.whenToUse }),
    ...(definition.phases === undefined ? {} : { phases: [...definition.phases] }),
  }
}

function isNonterminal(status: WorkflowRunStatus): boolean {
  return !TERMINAL_STATUSES.has(status)
}

const encoder = new TextEncoder()
const SCRATCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

function artifactIdentity(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

type CursorKind = 'runs' | 'members' | 'logs' | 'artifacts' | 'artifact'

interface CursorPayload {
  readonly kind: CursorKind
  readonly owner: string
  readonly revision: number
  readonly offset: number
}

function retainText(text: string, maxBytes: number): {
  readonly text: string
  readonly totalBytes: number
  readonly truncated: boolean
} {
  const totalBytes = encoder.encode(text).byteLength
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(text)
  const retained = retainer.finish()
  return { text: retained.text, totalBytes, truncated: retained.truncated }
}

function encodeCursor(payload: CursorPayload): WorkflowRunCursor {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url') as WorkflowRunCursor
}

function decodeCursor(value: WorkflowRunCursor, expectedKind: CursorKind, expectedOwner: string): CursorPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
  } catch (error) {
    throw new Error('workflow run cursor is invalid', { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('workflow run cursor is invalid')
  }
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).length !== 4
    || record.kind !== expectedKind
    || record.owner !== expectedOwner
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
    || !Number.isSafeInteger(record.offset)
    || (record.offset as number) < 0) {
    throw new Error('workflow run cursor is invalid or belongs to another collection')
  }
  return {
    kind: expectedKind,
    owner: expectedOwner,
    revision: record.revision as number,
    offset: record.offset as number,
  }
}

function statusStopReason(status: WorkflowRunStatus): SupervisedWorkflowResultInfo['stopReason'] | undefined {
  switch (status) {
    case 'completed': return 'completed'
    case 'failed': return 'error'
    case 'cancelled': return 'cancelled'
    case 'interrupted': return 'interrupted'
    default: return undefined
  }
}

async function writePrivateProjection(
  path: string,
  script: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  if (encoder.encode(script).byteLength > maxBytes) {
    throw new Error(`workflow script projection exceeds the ${maxBytes}-byte limit`)
  }
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    signal?.throwIfAborted()
    await handle.writeFile(script, 'utf8')
    signal?.throwIfAborted()
  } finally {
    await handle.close()
  }
}

async function readBoundedProjection(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const pathInfo = await lstat(path, { bigint: true })
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
    throw new Error('workflow script projection is not an owned regular file')
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat({ bigint: true })
    /* v8 ignore start -- descriptor type or inode divergence requires an external path replacement between lstat() and open(). */
    if (!info.isFile() || !sameFile(pathInfo, info)) {
      throw new Error('workflow script projection changed before it could be opened')
    }
    /* v8 ignore stop */
    if (info.size > BigInt(maxBytes)) throw new Error(`workflow script projection exceeds the ${maxBytes}-byte limit`)
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      signal?.throwIfAborted()
      const chunk = new Uint8Array(Math.min(64 * 1024, maxBytes - total + 1))
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null)
      if (bytesRead === 0) break
      total += bytesRead
      /* v8 ignore next -- growth after the descriptor size check requires an external concurrent writer. */
      if (total > maxBytes) throw new Error(`workflow script projection exceeds the ${maxBytes}-byte limit`)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally {
    await handle.close()
  }
}

/** Logical workflow-run supervisor. */
export class WorkflowSupervisor extends TypertRemoteService {
  static inject = ['workflowEngine', 'workflows']
  static Config = Config

  private readonly enabled: boolean
  private readonly defaultAgentBudget: number
  private readonly maxAgentBudget: number
  private readonly runsRoot: string
  private readonly saveScope: WorkflowSaveScope
  private readonly memberOutcomeMaxBytes: number
  private readonly maxConsecutiveCompletionWakes: number
  private readonly maxActiveRunsPerSession: number
  private readonly maxActiveRunsGlobal: number
  private readonly maxLogLines: number
  private readonly maxLogLineBytes: number
  private readonly maxLogTotalBytes: number
  private readonly maxMembersPerRun: number
  private readonly maxRetainedArtifactsPerRun: number
  private readonly maxArtifactNameBytes: number
  private readonly maxGateKindBytes: number
  private readonly maxGateMessageBytes: number
  private readonly maxScriptProjectionBytes: number
  private readonly remotePageDefault: number
  private readonly remotePageMax: number
  private readonly artifactChunkDefaultBytes: number
  private readonly artifactChunkMaxBytes: number
  private readonly remoteHeadTextMaxBytes: number
  private readonly remoteDetailMaxPhases: number
  private readonly notifier: WorkflowCompletionNotifier
  private readonly manifests: WorkflowRunManifestStore
  private readonly runsById = new Map<string, SupervisedRun>()
  private readonly runsByDisplayName = new Map<string, SupervisedRun>()
  private readonly executions = new Map<string, ExecutionLookup>()
  private readonly recovery = new Map<string, Promise<void>>()
  private readonly sessionRevisions = new Map<string, number>()
  private readonly feedEpoch = randomUUID() as WorkflowRunFeedEpoch
  private readonly pendingStartsBySession = new Map<string, number>()
  private readonly pendingStartsByOwner = new WeakMap<Agent, number>()
  private readonly ownerDeliveries = new WeakMap<Agent, Set<Promise<void>>>()
  private readonly ownerWaiters = new Map<Agent, Set<() => void>>()
  private pendingStarts = 0
  private tearingDown = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'workflowSupervisor', { namespace: 'workflowRuns' })
    this.enabled = config.enabled ?? true
    this.defaultAgentBudget = config.defaultAgentBudget ?? 128
    this.maxAgentBudget = config.maxAgentBudget ?? 1_024
    if (this.defaultAgentBudget > this.maxAgentBudget) {
      throw new Error('workflow supervisor defaultAgentBudget must not exceed maxAgentBudget')
    }
    const dshHome = resolveDshHome(config.dshHome)
    this.runsRoot = config.runsRoot === undefined ? join(dshHome, 'workflow-runs') : resolve(config.runsRoot)
    this.saveScope = config.saveScope ?? 'project'
    this.memberOutcomeMaxBytes = config.memberOutcomeMaxBytes ?? 131_072
    this.maxConsecutiveCompletionWakes = config.maxConsecutiveCompletionWakes ?? 3
    this.maxActiveRunsPerSession = config.maxActiveRunsPerSession ?? 64
    this.maxActiveRunsGlobal = config.maxActiveRunsGlobal ?? 1_024
    this.maxLogLines = config.maxLogLines ?? 1_000
    this.maxLogLineBytes = config.maxLogLineBytes ?? 16_384
    this.maxLogTotalBytes = config.maxLogTotalBytes ?? 1_048_576
    this.maxRetainedArtifactsPerRun = config.maxRetainedArtifactsPerRun ?? 256
    this.maxArtifactNameBytes = config.maxArtifactNameBytes ?? 255
    this.maxGateKindBytes = config.maxGateKindBytes ?? 64
    this.maxGateMessageBytes = config.maxGateMessageBytes ?? 4_096
    this.maxScriptProjectionBytes = config.maxScriptProjectionBytes ?? 1_048_576
    this.remotePageDefault = config.remotePageDefault ?? 50
    this.remotePageMax = config.remotePageMax ?? 200
    this.artifactChunkDefaultBytes = config.artifactChunkDefaultBytes ?? 32_768
    this.artifactChunkMaxBytes = config.artifactChunkMaxBytes ?? 131_072
    this.remoteHeadTextMaxBytes = config.remoteHeadTextMaxBytes ?? 4_096
    this.remoteDetailMaxPhases = config.remoteDetailMaxPhases ?? 64
    if (this.maxActiveRunsPerSession > this.maxActiveRunsGlobal) {
      throw new Error('workflow supervisor maxActiveRunsPerSession must not exceed maxActiveRunsGlobal')
    }
    if (this.maxLogLineBytes > this.maxLogTotalBytes) {
      throw new Error('workflow supervisor maxLogLineBytes must not exceed maxLogTotalBytes')
    }
    if (this.maxGateKindBytes < encoder.encode('verification').byteLength) {
      throw new Error('workflow supervisor maxGateKindBytes cannot retain every workflow gate kind')
    }
    this.maxMembersPerRun = config.maxMembersPerRun ?? 2_048
    if (this.maxMembersPerRun < this.maxAgentBudget) {
      throw new Error('workflow supervisor maxMembersPerRun must be at least maxAgentBudget')
    }
    if ((config.remotePageDefault ?? 50) > (config.remotePageMax ?? 200)) {
      throw new Error('workflow supervisor remotePageDefault must not exceed remotePageMax')
    }
    if ((config.artifactChunkDefaultBytes ?? 32_768) > (config.artifactChunkMaxBytes ?? 131_072)) {
      throw new Error('workflow supervisor artifactChunkDefaultBytes must not exceed artifactChunkMaxBytes')
    }
    this.notifier = new WorkflowCompletionNotifier(ctx, {
      maxBytes: config.completionNoticeMaxBytes ?? 16_384,
      maxConsecutiveWakes: this.maxConsecutiveCompletionWakes,
    })
    this.manifests = new WorkflowRunManifestStore({
      runsRoot: this.runsRoot,
      maxRetainedRunsPerSession: config.maxRetainedRunsPerSession ?? 256,
      maxWorkflowNamesPerSession: config.maxWorkflowNamesPerSession ?? 4_096,
      maxMembersPerRun: this.maxMembersPerRun,
      maxRetainedLogLinesPerRun: this.maxLogLines,
      maxRetainedLogLineBytes: this.maxLogLineBytes,
      maxRetainedArtifactsPerRun: this.maxRetainedArtifactsPerRun,
      maxRetainedArtifactNameBytes: this.maxArtifactNameBytes,
      maxRetainedGateKindBytes: this.maxGateKindBytes,
      maxRetainedGateMessageBytes: this.maxGateMessageBytes,
      maxRetainedErrorBytes: this.remoteHeadTextMaxBytes,
      maxTerminalResultBytes: this.memberOutcomeMaxBytes,
      maxManifestBytes: config.maxManifestBytes ?? 8_388_608,
    })

    ctx.on('workflow/phase', (info, title) => {
      this.withAttempt(info.id, (run) => {
        run.phase = retainText(title, this.remoteHeadTextMaxBytes).text
        this.commit(run, 'detail')
      })
    })
    ctx.on('workflow/log', (info, message) => {
      this.withAttempt(info.id, (run) => {
        this.appendLog(run, message)
        this.commit(run, 'logs')
      })
    })
    ctx.on('workflow/agent-start', (info, member) => {
      this.onMemberStart(info.id, member)
    })
    ctx.on('workflow/journal-commit', (info, entry) => {
      this.onJournalCommit(info.id, entry)
    })
    ctx.on('workflow/agent-end', (info, member) => {
      this.onMemberEnd(info.id, member)
    })
    ctx.on('workflow/gate', (info, gate) => {
      this.onGate(info.id, gate)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      void this.disposeOwner(agent).catch((error: unknown) => {
        this.ctx.logger.warn(`workflow-supervisor: owner disposal failed: ${renderThrown(error)}`)
      })
    })
    ctx.effect(() => () => this.disposeService())
  }

  /**
   * Recover one Session roster and interrupt process-owned rows.
   * @param agent - exact Session owner used for authorization.
   * @param signal - optional cancellation while reading durable state.
   */
  async recoverSession(agent: Agent, signal?: AbortSignal): Promise<void> {
    const key = String(agent.session.id)
    const existing = this.recovery.get(key)
    if (existing !== undefined) {
      await existing
      return
    }
    const pending = this.loadRecovered(agent.session.id, signal)
    this.recovery.set(key, pending)
    try { await pending } catch (error) {
      this.recovery.delete(key)
      throw error
    }
  }

  /**
   * Launch one logical run and return after durable background publication.
   * @param spec - selected source, budget, exact owner, and optional cancellation.
   * @returns the stable logical id, display handle, and editable script path.
   */
  async start(spec: {
    definition?: WorkflowDefinition
    script?: string
    meta?: WorkflowMeta
    args?: unknown
    agentBudget?: number
    parent: Agent
    signal?: AbortSignal
  }): Promise<WorkflowLaunched> {
    if (!this.enabled) throw new Error('workflow supervisor is disabled')
    if (this.tearingDown) throw new Error('workflow supervisor is shutting down')
    const source = this.resolveSource(spec)
    const meta = validateMeta(source.meta)
    const budget = this.resolveBudget(spec.agentBudget)
    const releaseSlot = this.reserveStartSlot(spec.parent)
    try {
      await this.recoverSession(spec.parent, spec.signal)
      spec.signal?.throwIfAborted()
      const runDirectory = randomUUID()
      const scratchDir = join(this.runsRoot, runDirectory)
      const scriptPath = join(scratchDir, 'script.js')
      try {
        await mkdir(scratchDir, { recursive: true, mode: 0o700 })
        await mkdir(join(scratchDir, 'scratch'), { mode: 0o700 })
        await writePrivateProjection(
          scriptPath,
          source.script,
          this.maxScriptProjectionBytes,
          spec.signal,
        )
        spec.signal?.throwIfAborted()
      } catch (error) {
        await this.removeDirectory(scratchDir)
        throw error
      }
      let run: SupervisedRun | undefined
      try {
        const inserted = await this.manifests.insertWithNextDisplayName(
          spec.parent.session.id,
          meta.name,
          (displayName) => {
            run = {
              runId: SupervisedWorkflowRunId(`workflow-${randomUUID()}`),
              sessionId: spec.parent.session.id,
              displayName,
              meta,
              script: source.script,
              args: spec.args,
              budget,
              spent: 0,
              journal: new Map(),
              members: new Map(),
              parent: spec.parent,
              status: 'running',
              phase: undefined,
              gate: undefined,
              durableGate: undefined,
              resultView: { state: 'pending' },
              error: undefined,
              attempt: undefined,
              generation: 0,
              revision: 1,
              detailRevision: 1,
              membersRevision: 1,
              logsRevision: 1,
              resultRevision: 1,
              artifactsRevision: 1,
              logs: [],
              logBytes: 0,
              droppedLogLines: 0,
              artifacts: [],
              artifactTotal: 0,
              scriptPath,
              runDirectory,
              scratchDir,
              builtin: source.builtin,
              numberedHandle: displayName !== meta.name,
              startedAt: Date.now(),
              settledAt: undefined,
              terminalPublished: false,
              published: false,
              ownerCleanup: undefined,
              completionDelivery: Promise.resolve(),
              durablePublication: Promise.resolve(),
              lifecyclePublication: Promise.resolve(),
              lifecyclePending: 0,
            }
            return this.manifest(run)
          },
          spec.signal,
        )
        for (const evicted of inserted.evicted) this.removeEvicted(evicted)
      } catch (error) {
        await this.removeDirectory(scratchDir)
        throw error
      }
      if (run === undefined) throw new Error('workflow manifest insertion did not create a run')
      const publishedRun = run
      this.runsById.set(String(publishedRun.runId), publishedRun)
      this.runsByDisplayName.set(this.displayKey(publishedRun.sessionId, publishedRun.displayName), publishedRun)
      publishedRun.published = true
      this.publishChange(publishedRun)
      this.emitContained('workflows/run-start', this.info(publishedRun))
      try {
        publishedRun.ownerCleanup = spec.parent.ctx.effect(
          () => async () => {
            await this.disposeOwnedRun(publishedRun, 'workflow owner disposed')
          },
          `workflow-supervisor.run(${publishedRun.displayName})`,
        )
        const attempt = this.createAttempt(publishedRun)
        publishedRun.attempt = attempt
        this.executions.set(String(attempt.executionId), { run: publishedRun, generation: attempt.generation })
        attempt.observation = this.observeAttempt(publishedRun, attempt)
      } catch (error) {
        this.finishTerminal(publishedRun, 'failed', {
          value: null,
          stopReason: 'error',
          error: `workflow launch failed: ${renderThrown(error)}`,
          agentsStarted: 0,
        })
        await publishedRun.durablePublication
        throw error
      }
      return {
        displayName: publishedRun.displayName,
        runId: publishedRun.runId,
        scriptPath,
        status: 'started',
      }
    } finally {
      releaseSlot()
    }
  }

  /**
   * Smoke-check one selected path with canned hosts and no logical run.
   * @param spec - selected source, budget, exact owner, and optional cancellation.
   * @returns the validation result without retaining a run.
   */
  async validate(spec: {
    definition?: WorkflowDefinition
    script?: string
    meta?: WorkflowMeta
    args?: unknown
    agentBudget?: number
    parent?: Agent
    signal?: AbortSignal
  }): Promise<WorkflowValidation> {
    const source = this.resolveSource(spec)
    const meta = validateMeta(source.meta)
    if (spec.parent === undefined) return { ok: false, error: 'validate_only requires a calling agent' }
    const handle = this.ctx.workflowEngine.start({
      script: source.script,
      meta,
      ...(spec.args === undefined ? {} : { args: spec.args }),
      maxTotalAgents: this.resolveBudget(spec.agentBudget),
      initialAgentSpend: 0,
      validateOnly: true,
      parent: spec.parent,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    })
    try {
      const result = await handle.result
      return result.stopReason === 'completed'
        ? { ok: true, result: result.value }
        : { ok: false, error: result.error ?? 'workflow smoke check failed' }
    } finally { await handle.dispose() }
  }

  /**
   * Quiesce a running attempt for journal-replay pause.
   * @param displayName - Session-local run handle.
   * @param agent - exact live owner.
   * @param signal - optional cancellation for the caller's wait.
   */
  async pause(displayName: string, agent: Agent, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const run = this.lookupDisplay(displayName, agent)
    if (run.status !== 'running' || run.attempt === undefined) {
      throw new Error(`workflow "${displayName}" is not running (${run.status})`)
    }
    run.status = 'pausing'
    const attempt = run.attempt
    this.raiseIntent(attempt, 'pause')
    this.clearGate(run)
    attempt.handle.cancel('paused by user')
    this.commit(run, 'detail')
    await this.awaitWithSignal(attempt.observation, signal)
  }

  /**
   * Resume one live human gate or quiescent journal-replay pause.
   * @param displayName - Session-local run handle.
   * @param agent - exact live owner.
   */
  resume(displayName: string, agent: Agent): void {
    this.resumeRecord(this.lookupDisplay(displayName, agent), agent)
  }

  /**
   * Resume by logical id, optionally raising a budget-limited cap.
   * @param runId - stable logical run id.
   * @param agent - exact live owner.
   * @param higherBudget - replacement absolute budget for a budget-limited run.
   * @param signal - optional cancellation before a new attempt starts.
   * @returns the Session-local display handle.
   */
  resumeById(
    runId: SupervisedWorkflowRunId | string,
    agent: Agent,
    higherBudget?: number,
    signal?: AbortSignal,
  ): string {
    const run = this.lookupId(runId, agent)
    if (run.status !== 'needs-input' && run.status !== 'paused' && run.status !== 'budget-limited') {
      throw new Error(`workflow "${run.displayName}" cannot resume from ${run.status}`)
    }
    if (run.status === 'budget-limited') {
      if (higherBudget === undefined || higherBudget <= run.budget) {
        throw new Error(`workflow "${run.displayName}" requires a higher agent_budget to resume`)
      }
      const previousBudget = run.budget
      run.budget = this.resolveBudget(higherBudget)
      try {
        this.resumeRecord(run, agent, signal)
      } catch (error) {
        run.budget = previousBudget
        throw error
      }
      return run.displayName
    }
    if (higherBudget !== undefined && higherBudget !== run.budget) {
      throw new Error('agent_budget may be raised only when resuming a budget-limited workflow')
    }
    this.resumeRecord(run, agent, signal)
    return run.displayName
  }

  /**
   * Resume one question only while all logical, attempt, and gate ids remain current.
   * @param runId - stable logical run id.
   * @param executionId - current engine-attempt id.
   * @param gateId - current gate occurrence id.
   * @param agent - exact live owner.
   * @returns whether the fenced gate was resumed.
   */
  resumeGate(
    runId: SupervisedWorkflowRunId,
    executionId: WorkflowRunId,
    gateId: WorkflowGateId,
    agent: Agent,
  ): boolean {
    const run = this.runsById.get(String(runId))
    if (run === undefined || run.parent !== agent || run.status !== 'needs-input') return false
    const gate = run.gate
    const attempt = run.attempt
    if (gate === undefined || attempt === undefined) return false
    if (String(gate.executionId) !== String(executionId) || gate.gateId !== gateId) return false
    if (attempt.generation !== gate.generation) return false
    this.resumeLiveGate(run)
    return true
  }

  /**
   * Stop one nonterminal logical run and wait for attempt disposal.
   * @param displayName - Session-local run handle.
   * @param agent - exact live owner.
   * @param signal - optional cancellation for the caller's wait.
   */
  async stop(displayName: string, agent: Agent, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const run = this.lookupDisplay(displayName, agent)
    if (!isNonterminal(run.status)) {
      throw new Error(`workflow "${displayName}" already settled (${run.status})`)
    }
    this.clearGate(run)
    const attempt = run.attempt
    if (attempt !== undefined) {
      run.status = 'stopping'
      this.raiseIntent(attempt, 'stop')
      attempt.handle.cancel('stopped by user')
      this.commit(run, 'detail')
      await this.awaitWithSignal(attempt.observation, signal)
      return
    }
    this.finishTerminal(run, 'cancelled', {
      value: null,
      stopReason: 'cancelled',
      error: 'stopped by user',
      agentsStarted: run.spent,
    })
  }

  /**
   * Save the current editable projection through the definition registry.
   * @param displayName - unnumbered, non-built-in run handle.
   * @param agent - exact live owner.
   * @param scope - optional destination overriding the configured default.
   * @param signal - optional cancellation while reading and writing.
   * @returns the saved definition path.
   */
  async save(
    displayName: string,
    agent: Agent,
    scope?: WorkflowSaveScope,
    signal?: AbortSignal,
  ): Promise<string> {
    const run = this.lookupDisplay(displayName, agent)
    if (run.builtin) {
      throw new Error(`workflow "${displayName}" is a built-in: save an edited copy under a new meta.name`)
    }
    if (run.numberedHandle) {
      throw new Error(`workflow "${displayName}" is a numbered handle: save an edited copy under a new unique meta.name`)
    }
    if (run.scriptPath === undefined) throw new Error(`workflow "${displayName}" has no editable script projection`)
    const script = await readBoundedProjection(
      run.scriptPath,
      this.maxScriptProjectionBytes,
      signal,
    )
    const cwd = agent.session.header.cwd
    const path = await this.ctx.workflows.save(
      { meta: run.meta, script },
      {
        scope: scope ?? this.saveScope,
        ...(cwd === undefined ? {} : { cwd }),
        ...(signal === undefined ? {} : { signal }),
      },
    )
    this.commit(run, 'detail')
    return path
  }

  /**
   * Return one bounded member outcome after exact Session authorization.
   * @param agent - Session used for authorization.
   * @param request - logical run and member ids.
   * @returns bounded member metadata and outcome.
   */
  memberDetail(agent: Agent, request: WorkflowRunMemberRequest): WorkflowRunMemberDetail {
    const run = this.lookupIdForSession(request.runId, agent.session.id)
    const member = [...run.members.values()].find(candidate => candidate.memberId === request.memberId)
    if (member === undefined) throw new Error('workflow member was not found in this run')
    return {
      member: this.memberHead(member),
      childSessionId: member.childSessionId,
      outcome: member.outcomeView ?? (member.resultCommitted
        ? member.result === undefined
          ? { state: 'evicted' }
          : workflowRunValueView(member.result, this.memberOutcomeMaxBytes)
        : member.outcomeEvicted
          ? { state: 'evicted' }
          : member.status === 'running'
            ? { state: 'pending' }
            : { state: 'not-produced' }),
    }
  }

  /**
   * Return one atomic, retention-bounded lifecycle snapshot after Session
   * recovery. Host recorders use it to reconcile events missed during reload.
   * @param agent - exact Session owner used for authorization and recovery.
   * @param runId - stable logical run id.
   * @param signal - optional cancellation while durable state is recovered.
   * @returns the retained run state, or `undefined` when successful recovery confirms that the run is absent.
   * @throws When recovery fails, cancellation wins, or the id belongs to another recovered Session.
   */
  async recordingSnapshot(
    agent: Agent,
    runId: SupervisedWorkflowRunId,
    signal?: AbortSignal,
  ): Promise<WorkflowRunRecordingSnapshot | undefined> {
    await this.recoverSession(agent, signal)
    signal?.throwIfAborted()
    const run = this.runsById.get(String(runId))
    if (run === undefined) return undefined
    if (run.sessionId !== agent.session.id) {
      throw new Error('workflow run belongs to another Session')
    }
    const stopReason = statusStopReason(run.status)
    return {
      info: this.info(run),
      run: this.head(run),
      members: [...run.members.values()]
        .sort((left, right) => left.seq - right.seq)
        .map(member => this.memberLifecycle(member)),
      ...(stopReason === undefined ? {} : {
        result: {
          stopReason,
          ...(run.error === undefined ? {} : { error: run.error }),
          agentsStarted: run.spent,
        },
      }),
    }
  }

  /**
   * Reach a fixed point for background work owned by one exact Agent. Running
   * attempts, starts that reserved capacity, durable terminal publication,
   * completion delivery, and completion-woken Agent turns are all included.
   * Human gates, user pauses, and budget-limited runs are quiescent parked
   * states. A completion turn may launch more workflows; the fixed-point loop
   * follows at most the configured consecutive completion-wake budget.
   * @param agent - exact workflow owner whose work must reach quiescence.
   * @param signal - optional cancellation for the wait only.
   */
  async whenOwnerQuiescent(agent: Agent, signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted()
      if (this.ownerHasUnquiescedWork(agent)) {
        await this.waitForOwnerChange(agent, signal)
        continue
      }
      await this.awaitWithSignal(agent.whenIdle(), signal)
      signal?.throwIfAborted()
      if (!this.ownerHasUnquiescedWork(agent)) return
    }
  }

  /**
   * List one bounded retained-run page for the resolved Agent Session.
   * @param agent - Remote-resolved Session owner.
   * @param request - page size and optional revision-fenced cursor.
   * @param signal - cancellation for a superseded Remote read.
   * @returns bounded run heads and an optional next-page cursor.
   */
  @Remote('list')
  async listForClient(
    agent: Agent,
    request: WorkflowRunListRequest,
    signal: AbortSignal,
  ): Promise<WorkflowRunListPage> {
    await this.recoverSession(agent, signal)
    signal.throwIfAborted()
    const key = String(agent.session.id)
    const revision = this.sessionRevisions.get(key) ?? 0
    const offset = this.cursorOffset(request.cursor, 'runs', key, revision)
    const limit = this.pageLimit(request.limit)
    const rows = this.sessionRuns(agent.session.id)
    const items = rows.slice(offset, offset + limit).map(run => this.head(run))
    const nextOffset = offset + items.length
    return {
      epoch: this.feedEpoch,
      sessionRevision: revision,
      items,
      ...(nextOffset < rows.length
        ? { nextCursor: encodeCursor({ kind: 'runs', owner: key, revision, offset: nextOffset }) }
        : {}),
      total: rows.length,
    }
  }

  /**
   * Load bounded selected-run metadata for the resolved Agent Session.
   * @param agent - Remote-resolved Session owner.
   * @param request - selected logical run id.
   * @param signal - cancellation for a superseded Remote read.
   * @returns bounded detail for the selected run.
   */
  @Remote('detail')
  async detailForClient(
    agent: Agent,
    request: WorkflowRunRequest,
    signal: AbortSignal,
  ): Promise<WorkflowRunDetail> {
    await this.recoverSession(agent, signal)
    signal.throwIfAborted()
    const run = this.lookupIdForSession(request.runId, agent.session.id)
    const phases = run.meta.phases?.slice(0, this.remoteDetailMaxPhases).map(phase => ({
      title: retainText(phase.title, this.remoteHeadTextMaxBytes).text,
      ...(phase.detail === undefined ? {} : {
        detail: retainText(phase.detail, this.remoteHeadTextMaxBytes).text,
      }),
      ...(phase.provider === undefined ? {} : {
        provider: retainText(phase.provider, this.remoteHeadTextMaxBytes).text,
      }),
      ...(phase.model === undefined ? {} : {
        model: retainText(phase.model, this.remoteHeadTextMaxBytes).text,
      }),
    }))
    const gate = this.detailGate(run)
    return {
      run: this.head(run),
      ...(phases === undefined ? {} : { phases }),
      ...(gate === undefined ? {} : { gate }),
      ...(run.error === undefined ? {} : {
        error: retainText(run.error, this.remoteHeadTextMaxBytes).text,
      }),
      ...(run.scriptPath === undefined ? {} : { scriptPath: run.scriptPath }),
    }
  }

  /**
   * Load one bounded member-summary page for a selected run.
   * @param agent - Remote-resolved Session owner.
   * @param request - selected run, page size, and optional cursor.
   * @param signal - cancellation for a superseded Remote read.
   * @returns bounded member heads and an optional next-page cursor.
   */
  @Remote('members')
  async membersForClient(
    agent: Agent,
    request: WorkflowRunMembersRequest,
    signal: AbortSignal,
  ): Promise<WorkflowRunMemberPage> {
    await this.recoverSession(agent, signal)
    signal.throwIfAborted()
    const run = this.lookupIdForSession(request.runId, agent.session.id)
    const owner = String(run.runId)
    const offset = this.cursorOffset(request.cursor, 'members', owner, run.membersRevision)
    const limit = this.pageLimit(request.limit)
    const rows = [...run.members.values()].sort((left, right) => left.seq - right.seq)
    const items = rows.slice(offset, offset + limit).map(member => this.memberHead(member))
    const nextOffset = offset + items.length
    return {
      items,
      ...(nextOffset < rows.length ? {
        nextCursor: encodeCursor({
          kind: 'members', owner, revision: run.membersRevision, offset: nextOffset,
        }),
      } : {}),
      total: rows.length,
      revision: run.membersRevision,
    }
  }

  /**
   * Load one selected member's bounded committed outcome.
   * @param agent - Remote-resolved Session owner.
   * @param request - selected logical run and member ids.
   * @param signal - cancellation for a superseded Remote read.
   * @returns bounded member detail.
   */
  @Remote('memberDetail')
  async memberDetailForClient(
    agent: Agent,
    request: WorkflowRunMemberRequest,
    signal: AbortSignal,
  ): Promise<WorkflowRunMemberDetail> {
    await this.recoverSession(agent, signal)
    signal.throwIfAborted()
    return this.memberDetail(agent, request)
  }

  /**
   * Load one bounded retained log page for a selected run.
   * @param agent - Remote-resolved Session owner.
   * @param request - selected run, page size, and optional cursor.
   * @param signal - cancellation for a superseded Remote read.
   * @returns bounded retained log lines and an optional next-page cursor.
   */
  @Remote('logs')
  async logsForClient(
    agent: Agent,
    request: WorkflowRunLogsRequest,
    signal: AbortSignal,
  ): Promise<WorkflowRunLogPage> {
    await this.recoverSession(agent, signal)
    signal.throwIfAborted()
    const run = this.lookupIdForSession(request.runId, agent.session.id)
    const owner = String(run.runId)
    const offset = this.cursorOffset(request.cursor, 'logs', owner, run.logsRevision)
    const limit = this.pageLimit(request.limit)
    const rows = run.logs.slice(offset, offset + limit)
    const nextOffset = offset + rows.length
    return {
      items: rows.map(line => ({ index: line.index, text: line.text })),
      ...(nextOffset < run.logs.length ? {
        nextCursor: encodeCursor({ kind: 'logs', owner, revision: run.logsRevision, offset: nextOffset }),
      } : {}),
      evicted: run.droppedLogLines,
      total: run.droppedLogLines + run.logs.length,
      revision: run.logsRevision,
    }
  }

  /**
   * Load a selected run's bounded terminal-result projection.
   * @param agent - Remote-resolved Session owner.
   * @param request - selected logical run id.
   * @param signal - cancellation for a superseded Remote read.
   * @returns bounded result state and revision.
   */
  @Remote('result')
  async resultForClient(
    agent: Agent,
    request: WorkflowRunRequest,
    signal: AbortSignal,
  ): Promise<WorkflowRunResultView> {
    await this.recoverSession(agent, signal)
    signal.throwIfAborted()
    const run = this.lookupIdForSession(request.runId, agent.session.id)
    return {
      value: run.resultView,
      ...(run.error === undefined ? {} : {
        error: retainText(run.error, this.remoteHeadTextMaxBytes).text,
      }),
      revision: run.resultRevision,
    }
  }

  /**
   * Load one bounded scratch-artifact metadata page.
   * @param agent - Remote-resolved Session owner.
   * @param request - selected run, page size, and optional cursor.
   * @param signal - cancellation for the directory read.
   * @returns bounded artifact metadata and an optional next-page cursor.
   */
  @Remote('artifacts')
  async artifactsForClient(
    agent: Agent,
    request: WorkflowRunArtifactsRequest,
    signal: AbortSignal,
  ): Promise<WorkflowRunArtifactPage> {
    await this.recoverSession(agent, signal)
    const run = this.lookupIdForSession(request.runId, agent.session.id)
    await this.refreshArtifacts(run, signal)
    const owner = String(run.runId)
    const offset = this.cursorOffset(request.cursor, 'artifacts', owner, run.artifactsRevision)
    const limit = this.pageLimit(request.limit)
    const items = run.artifacts.slice(offset, offset + limit).map(({ name, bytes }) => ({ name, bytes }))
    const nextOffset = offset + items.length
    return {
      items,
      ...(nextOffset < run.artifacts.length ? {
        nextCursor: encodeCursor({
          kind: 'artifacts', owner, revision: run.artifactsRevision, offset: nextOffset,
        }),
      } : {}),
      omitted: run.artifactTotal - run.artifacts.length,
      total: run.artifactTotal,
      revision: run.artifactsRevision,
    }
  }

  /**
   * Read one UTF-8-safe scratch-artifact chunk without following links.
   * @param agent - Remote-resolved Session owner.
   * @param request - selected run, artifact, byte limit, and optional cursor.
   * @param signal - cancellation for the file read.
   * @returns bounded UTF-8 text with byte offsets and an optional cursor.
   */
  @Remote('artifact')
  async artifactForClient(
    agent: Agent,
    request: WorkflowRunArtifactRequest,
    signal: AbortSignal,
  ): Promise<WorkflowRunArtifactChunk> {
    await this.recoverSession(agent, signal)
    const run = this.lookupIdForSession(request.runId, agent.session.id)
    await this.refreshArtifacts(run, signal)
    if (request.expectedRevision !== undefined && request.expectedRevision !== run.artifactsRevision) {
      throw new Error('workflow artifact collection changed; refresh it before reading')
    }
    this.assertArtifactName(request.name)
    const artifact = run.artifacts.find(candidate => candidate.name === request.name)
    if (artifact === undefined) throw new Error('workflow scratch artifact was not found')
    const maxBytes = this.artifactBytes(request.maxBytes)
    const owner = `${run.runId}\u0000${request.name}`
    const offset = this.cursorOffset(request.cursor, 'artifact', owner, run.artifactsRevision)
    const chunk = await this.readArtifactChunk(run, artifact, offset, maxBytes, signal)
    const nextOffset = offset + chunk.bytes
    return {
      artifact: { name: artifact.name, bytes: artifact.bytes },
      text: chunk.text,
      offsetBytes: offset,
      returnedBytes: chunk.bytes,
      totalBytes: artifact.bytes,
      revision: run.artifactsRevision,
      ...(nextOffset < artifact.bytes ? {
        nextCursor: encodeCursor({
          kind: 'artifact', owner, revision: run.artifactsRevision, offset: nextOffset,
        }),
      } : {}),
    }
  }

  /**
   * Execute one revision-checked dashboard control to settlement.
   * @param agent - Remote-resolved exact run owner.
   * @param request - run id, action, and optional expected revision.
   * @param signal - cancellation for the control operation.
   * @returns the authoritative run head after settlement.
   */
  @Remote('control')
  async controlForClient(
    agent: Agent,
    request: WorkflowRunControlRequest,
    signal: AbortSignal,
  ): Promise<WorkflowRunControlResult> {
    await this.recoverSession(agent, signal)
    signal.throwIfAborted()
    const run = this.lookupId(request.runId, agent)
    if (request.expectedRevision !== undefined && request.expectedRevision !== run.revision) {
      throw new Error('workflow run changed; refresh it before applying a control')
    }
    switch (request.action) {
      case 'pause': await this.pause(run.displayName, agent, signal); break
      case 'resume': this.resumeRecord(run, agent, signal); break
      case 'stop': await this.stop(run.displayName, agent, signal); break
      case 'save': await this.save(run.displayName, agent, undefined, signal); break
    }
    signal.throwIfAborted()
    await run.durablePublication
    return { run: this.head(run) }
  }

  /** Cancel every process-owned nonterminal run as Interrupted. */
  markInterrupted(): void {
    for (const run of this.runsById.values()) {
      if (!isNonterminal(run.status)) continue
      const attempt = run.attempt
      if (attempt !== undefined) {
        attempt.intent = 'teardown'
        attempt.handle.cancel('workflow supervisor interrupted')
      } else {
        this.finishInterrupted(run)
      }
    }
  }

  private reserveStartSlot(agent: Agent): () => void {
    const sessionKey = String(agent.session.id)
    const pendingSession = this.pendingStartsBySession.get(sessionKey) ?? 0
    const activeSession = this.sessionRuns(agent.session.id).filter(run => isNonterminal(run.status)).length
    if (pendingSession + activeSession >= this.maxActiveRunsPerSession) {
      throw new Error(`workflow session reached its ${this.maxActiveRunsPerSession}-run active limit`)
    }
    const activeGlobal = [...this.runsById.values()].filter(run => isNonterminal(run.status)).length
    if (this.pendingStarts + activeGlobal >= this.maxActiveRunsGlobal) {
      throw new Error(`workflow supervisor reached its ${this.maxActiveRunsGlobal}-run active limit`)
    }
    this.pendingStarts += 1
    this.pendingStartsBySession.set(sessionKey, pendingSession + 1)
    this.pendingStartsByOwner.set(agent, (this.pendingStartsByOwner.get(agent) ?? 0) + 1)
    this.notifyOwnerChange(agent)
    let released = false
    return () => {
      if (released) return
      released = true
      this.pendingStarts -= 1
      const sessionRemaining = (this.pendingStartsBySession.get(sessionKey) ?? 1) - 1
      if (sessionRemaining === 0) this.pendingStartsBySession.delete(sessionKey)
      else this.pendingStartsBySession.set(sessionKey, sessionRemaining)
      const ownerRemaining = (this.pendingStartsByOwner.get(agent) ?? 1) - 1
      if (ownerRemaining === 0) this.pendingStartsByOwner.delete(agent)
      else this.pendingStartsByOwner.set(agent, ownerRemaining)
      this.notifyOwnerChange(agent)
    }
  }

  private raiseIntent(attempt: AttemptRecord, intent: Exclude<AttemptIntent, 'running'>): void {
    const rank: Record<AttemptIntent, number> = { running: 0, pause: 1, stop: 2, teardown: 3 }
    if (rank[intent] > rank[attempt.intent]) attempt.intent = intent
  }

  private appendLog(run: SupervisedRun, message: string): void {
    const retained = retainText(message, this.maxLogLineBytes)
    const record: LogRecord = {
      index: run.droppedLogLines + run.logs.length,
      ...retained,
      retainedBytes: encoder.encode(retained.text).byteLength,
    }
    run.logs.push(record)
    run.logBytes += record.retainedBytes
    while (run.logs.length > this.maxLogLines || run.logBytes > this.maxLogTotalBytes) {
      const dropped = run.logs.shift()
      /* v8 ignore next -- the loop condition proves the retained log array is non-empty. */
      if (dropped === undefined) break
      run.logBytes -= dropped.retainedBytes
      run.droppedLogLines += 1
    }
  }

  private pageLimit(requested: number | undefined): number {
    const limit = requested ?? this.remotePageDefault
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.remotePageMax) {
      throw new Error(`workflow page limit must be a safe integer from 1 through ${this.remotePageMax}`)
    }
    return limit
  }

  private artifactBytes(requested: number | undefined): number {
    const maxBytes = requested ?? this.artifactChunkDefaultBytes
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > this.artifactChunkMaxBytes) {
      throw new Error(`workflow artifact maxBytes must be a safe integer from 4 through ${this.artifactChunkMaxBytes}`)
    }
    return maxBytes
  }

  private cursorOffset(
    cursor: WorkflowRunCursor | undefined,
    kind: CursorKind,
    owner: string,
    revision: number,
  ): number {
    if (cursor === undefined) return 0
    const payload = decodeCursor(cursor, kind, owner)
    if (payload.revision !== revision) {
      throw new Error('workflow page cursor is stale; refresh the collection')
    }
    return payload.offset
  }

  private gateView(gate: WorkflowGateInfo): WorkflowGateInfo {
    return {
      kind: gate.kind,
      message: retainText(gate.message, this.maxGateMessageBytes).text,
      resumable: gate.resumable,
    }
  }

  private detailGate(run: SupervisedRun): WorkflowGateInfo | undefined {
    if (run.gate !== undefined) return this.gateView(run.gate.gate)
    if (run.durableGate === undefined) return undefined
    return {
      kind: run.durableGate.kind as WorkflowGateInfo['kind'],
      message: run.durableGate.message.text,
      resumable: false,
    }
  }

  private assertArtifactName(name: string): void {
    if (!SCRATCH_NAME.test(name) || encoder.encode(name).byteLength > this.maxArtifactNameBytes) {
      throw new Error('workflow artifact name must be one bounded scratch-file component')
    }
  }

  private async refreshArtifacts(run: SupervisedRun, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const scratch = join(run.scratchDir, 'scratch')
    let entries: Dirent[]
    try {
      entries = await readdir(scratch, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = []
      else throw error
    }
    const files = entries
      .filter(entry => entry.isFile() && !entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of files) this.assertArtifactName(entry.name)
    const artifacts: ArtifactRecord[] = []
    for (const entry of files.slice(0, this.maxRetainedArtifactsPerRun)) {
      signal?.throwIfAborted()
      const path = join(scratch, entry.name)
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat({ bigint: true })
        /* v8 ignore next -- a directory entry classified as a file can differ only after an external replacement race. */
        if (!info.isFile()) throw new Error(`workflow artifact ${JSON.stringify(entry.name)} is not a regular file`)
        artifacts.push({
          name: entry.name,
          bytes: Number(info.size),
          identity: artifactIdentity(info),
        })
      } finally {
        await handle.close()
      }
    }
    const changed = files.length !== run.artifactTotal
      || artifacts.length !== run.artifacts.length
      || artifacts.some((artifact, index) => {
        const prior = run.artifacts[index]
        return prior === undefined
          || prior.name !== artifact.name
          || prior.bytes !== artifact.bytes
          || prior.identity !== artifact.identity
      })
    if (!changed) return
    run.artifacts = artifacts
    run.artifactTotal = files.length
    run.revision += 1
    run.artifactsRevision += 1
    run.durablePublication = this.persist(run, signal)
    await run.durablePublication
    /* v8 ignore else -- Remote artifact refreshes authorize only already-published runs. */
    if (run.published) this.publishChange(run)
  }

  private async readArtifactChunk(
    run: SupervisedRun,
    artifact: ArtifactRecord,
    offset: number,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ readonly text: string; readonly bytes: number }> {
    if (offset > artifact.bytes) throw new Error('workflow artifact cursor is past the end of the file')
    signal.throwIfAborted()
    const handle = await open(
      join(run.scratchDir, 'scratch', artifact.name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile()
        || Number(before.size) !== artifact.bytes
        || artifact.identity === undefined
        || artifactIdentity(before) !== artifact.identity) {
        throw new Error('workflow artifact changed; refresh it before reading')
      }
      const available = Math.min(maxBytes, artifact.bytes - offset)
      const bytes = Buffer.allocUnsafe(available)
      let bytesRead = 0
      while (bytesRead < available) {
        const read = await handle.read(bytes, bytesRead, available - bytesRead, offset + bytesRead)
        /* v8 ignore next -- an unchanged local regular file makes progress until the requested range is exhausted. */
        if (read.bytesRead === 0) break
        bytesRead += read.bytesRead
      }
      signal.throwIfAborted()
      /* v8 ignore start -- a verified unchanged local file cannot return EOF before its retained byte size. */
      if (bytesRead === 0 && offset < artifact.bytes) {
        throw new Error(`workflow artifact ${JSON.stringify(artifact.name)} made no read progress`)
      }
      /* v8 ignore stop */
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          bytes.subarray(0, bytesRead),
          { stream: offset + bytesRead < artifact.bytes },
        )
      } catch (error) {
        throw new Error(`workflow artifact ${JSON.stringify(artifact.name)} is not valid UTF-8`, { cause: error })
      }
      const retained = encoder.encode(text).byteLength
      /* v8 ignore start -- cursors are emitted only at UTF-8 boundaries and the minimum chunk holds every code point. */
      if (retained === 0 && bytesRead > 0) {
        throw new Error(`workflow artifact ${JSON.stringify(artifact.name)} made no UTF-8 progress`)
      }
      /* v8 ignore stop */
      const after = await handle.stat({ bigint: true })
      /* v8 ignore start -- identity divergence requires an external write while the descriptor read is in progress. */
      if (artifactIdentity(after) !== artifact.identity) {
        throw new Error('workflow artifact changed while it was being read')
      }
      /* v8 ignore stop */
      return { text, bytes: retained }
    } finally {
      await handle.close()
    }
  }

  private ownerHasUnquiescedWork(agent: Agent): boolean {
    if ((this.pendingStartsByOwner.get(agent) ?? 0) > 0) return true
    const deliveries = this.ownerDeliveries.get(agent)
    if (deliveries !== undefined && deliveries.size > 0) return true
    return [...this.runsById.values()].some(run => run.parent === agent
      && (run.lifecyclePending > 0
        || run.status === 'running'
        || run.status === 'pausing'
        || run.status === 'stopping'))
  }

  private waitForOwnerChange(agent: Agent, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    return new Promise<void>((resolve, reject) => {
      const waiters = this.ownerWaiters.get(agent) ?? new Set<() => void>()
      this.ownerWaiters.set(agent, waiters)
      let settled = false
      const cleanup = (): void => {
        waiters.delete(finish)
        if (waiters.size === 0) this.ownerWaiters.delete(agent)
        signal?.removeEventListener('abort', abort)
      }
      const finish = (): void => {
        /* v8 ignore next -- only an abort racing a synchronous owner-change notification can call a settled waiter. */
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const abort = (): void => {
        /* v8 ignore next -- only an owner-change notification racing abort can call a settled waiter. */
        if (settled) return
        settled = true
        cleanup()
        reject(errorFromThrown(
          /* v8 ignore next -- a conforming aborted AbortSignal always exposes its abort reason. */
          signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'),
        ))
      }
      waiters.add(finish)
      signal?.addEventListener('abort', abort, { once: true })
      /* v8 ignore next -- covers abort in the narrow interval after the entry check and before listener installation. */
      if (signal?.aborted === true) abort()
      else if (!this.ownerHasUnquiescedWork(agent)) finish()
    })
  }

  private notifyOwnerChange(agent: Agent | undefined): void {
    if (agent === undefined) return
    const waiters = this.ownerWaiters.get(agent)
    if (waiters === undefined) return
    for (const waiter of [...waiters]) waiter()
  }

  private async awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return await promise
    signal.throwIfAborted()
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => { signal.removeEventListener('abort', abort) }
      const fulfill = (value: T): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const fail = (error: unknown): void => {
        /* v8 ignore next -- only promise settlement racing abort can call a settled rejection path. */
        if (settled) return
        settled = true
        cleanup()
        reject(errorFromThrown(error))
      }
      const abort = (): void => {
        /* v8 ignore next -- a conforming aborted AbortSignal always exposes its abort reason. */
        fail(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'))
      }
      signal.addEventListener('abort', abort, { once: true })
      /* v8 ignore next -- covers abort in the narrow interval after the entry check and before listener installation. */
      if (signal.aborted) abort()
      void promise.then(fulfill, fail)
    })
  }

  private emitContained<K extends SupervisorLifecycleEventName>(name: K, ...args: Parameters<Events[K]>): void {
    for (const callback of this.ctx.events.dispatch('emit', [name, ...args])) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`workflow-supervisor: ${name} listener rejected: ${renderThrown(error)}`)
        })
      } catch (error) {
        this.ctx.logger.warn(`workflow-supervisor: ${name} listener threw: ${renderThrown(error)}`)
      }
    }
  }

  private resolveSource(spec: {
    definition?: WorkflowDefinition
    script?: string
    meta?: WorkflowMeta
  }): { script: string; meta: WorkflowMeta; builtin: boolean } {
    if (spec.definition !== undefined) {
      if (spec.script !== undefined || spec.meta !== undefined) {
        throw new Error('workflow launch must select either a definition or an inline script plus meta')
      }
      return {
        script: spec.definition.script,
        meta: definitionMeta(spec.definition),
        builtin: spec.definition.scope === 'bundled',
      }
    }
    if ((spec.script === undefined) !== (spec.meta === undefined)) {
      throw new Error('inline workflow launch requires both script and meta')
    }
    if (spec.script !== undefined && spec.meta !== undefined) {
      return { script: spec.script, meta: spec.meta, builtin: false }
    }
    throw new Error('workflow launch requires a saved definition or an inline script plus meta')
  }

  private resolveBudget(requested: number | undefined): number {
    const budget = requested ?? this.defaultAgentBudget
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > this.maxAgentBudget) {
      throw new Error(`agent_budget must be a safe integer from 1 through ${this.maxAgentBudget}`)
    }
    return budget
  }

  private createAttempt(run: SupervisedRun, signal?: AbortSignal): AttemptRecord {
    if (run.script === undefined || run.parent === undefined) {
      throw new Error(`workflow "${run.displayName}" was interrupted and has no resumable execution`)
    }
    signal?.throwIfAborted()
    const generation = run.generation + 1
    const journal = [...run.journal.values()].sort((left, right) => left.ordinal - right.ordinal)
    const maxMemberSeq = [...run.members.keys()].reduce((maximum, seq) => Math.max(maximum, seq), 0)
    const maxJournalSeq = journal.reduce(
      (maximum, entry) => entry.kind === 'agent' ? Math.max(maximum, entry.seq) : maximum,
      0,
    )
    const handle = this.ctx.workflowEngine.start({
      script: run.script,
      meta: run.meta,
      ...(run.args === undefined ? {} : { args: run.args }),
      maxTotalAgents: run.budget,
      initialAgentSpend: run.spent,
      initialAgentSeq: Math.max(maxMemberSeq, maxJournalSeq),
      ...(journal.length === 0 ? {} : { journal }),
      scratchDir: run.scratchDir,
      parent: run.parent,
    })
    run.generation = generation
    return {
      generation,
      executionId: handle.id,
      handle,
      intent: 'running',
      observation: Promise.resolve(),
    }
  }

  private resumeRecord(run: SupervisedRun, agent: Agent, signal?: AbortSignal): void {
    if (run.status !== 'needs-input' && run.status !== 'paused' && run.status !== 'budget-limited') {
      throw new Error(`workflow "${run.displayName}" cannot resume from ${run.status}`)
    }
    if (run.parent !== agent) throw new Error(`workflow "${run.displayName}" is not owned by this Agent`)
    if (run.status === 'needs-input') {
      this.resumeLiveGate(run)
      return
    }
    if (run.status === 'budget-limited' && run.spent >= run.budget) {
      throw new Error(`workflow "${run.displayName}" requires a higher agent_budget to resume`)
    }
    const attempt = this.createAttempt(run, signal)
    run.attempt = attempt
    run.status = 'running'
    run.gate = undefined
    run.error = undefined
    run.settledAt = undefined
    this.executions.set(String(attempt.executionId), { run, generation: attempt.generation })
    attempt.observation = this.observeAttempt(run, attempt)
    this.commit(run, 'result')
  }

  private resumeLiveGate(run: SupervisedRun): void {
    const attempt = run.attempt
    if (run.status !== 'needs-input' || attempt === undefined) {
      throw new Error(`workflow "${run.displayName}" has no live input gate`)
    }
    this.clearGate(run)
    run.status = 'running'
    attempt.intent = 'running'
    attempt.handle.resume()
    this.commit(run, 'detail')
  }

  private async observeAttempt(run: SupervisedRun, attempt: AttemptRecord): Promise<void> {
    const result = await attempt.handle.result
    try {
      await attempt.handle.dispose()
    } catch (error) {
      this.ctx.logger.warn(`workflow-supervisor: attempt disposal failed: ${renderThrown(error)}`)
    }
    const lookup = this.executions.get(String(attempt.executionId))
    if (lookup?.run === run && lookup.generation === attempt.generation) {
      this.executions.delete(String(attempt.executionId))
    }
    if (run.attempt !== attempt || run.generation !== attempt.generation) return
    run.attempt = undefined
    this.clearGate(run)
    run.spent = Math.max(run.spent, result.agentsStarted)
    switch (attempt.intent) {
      case 'pause':
        run.status = 'paused'
        run.resultView = { state: 'pending' }
        run.error = undefined
        run.settledAt = undefined
        this.commit(run, 'result')
        return
      case 'stop':
        this.finishTerminal(run, 'cancelled', {
          value: null,
          stopReason: 'cancelled',
          error: result.error ?? 'stopped by user',
          agentsStarted: run.spent,
        })
        return
      case 'teardown':
        this.finishInterrupted(run)
        return
      case 'running':
        if (result.errorCode === 'AGENT_CAP') {
          run.status = 'budget-limited'
          run.resultView = { state: 'pending' }
          run.error = result.error === undefined
            ? undefined
            : retainText(result.error, this.remoteHeadTextMaxBytes).text
          run.settledAt = undefined
          this.commit(run, 'result')
          return
        }
        this.finishTerminal(
          run,
          result.stopReason === 'completed'
            ? 'completed'
            : result.stopReason === 'cancelled'
              ? 'cancelled'
              : 'failed',
          result,
        )
    }
  }

  private finishTerminal(
    run: SupervisedRun,
    status: 'completed' | 'failed' | 'cancelled',
    result: WorkflowResult,
  ): void {
    if (run.terminalPublished) return
    const settledMembers = this.settleRunningMembers(run)
    run.status = status
    run.resultView = status === 'completed'
      ? workflowRunValueView(result.value, this.memberOutcomeMaxBytes)
      : { state: 'not-produced' }
    run.error = result.error === undefined
      ? undefined
      : retainText(result.error, this.remoteHeadTextMaxBytes).text
    run.spent = Math.max(run.spent, result.agentsStarted)
    run.settledAt = Date.now()
    run.terminalPublished = true
    this.releaseExecutionState(run)
    const parent = run.parent
    if (parent !== undefined) this.notifier.reserve(run, parent)
    run.parent = undefined
    this.commit(run, 'result')
    const publication = run.durablePublication
    for (const member of settledMembers) {
      this.publishLifecycle(run, publication, () => {
        this.emitContained('workflows/member-end', this.info(run), member)
      })
    }
    this.trackTerminalPublication(run, parent, () => {
      this.emitContained('workflows/run-end', this.info(run), {
        stopReason: status === 'failed' ? 'error' : status,
        ...(run.error === undefined ? {} : { error: run.error }),
        agentsStarted: run.spent,
      })
    }, async () => {
      if (this.tearingDown || parent === undefined) return
      await this.notifier.notify({
        token: run,
        parent,
        displayName: run.displayName,
        status,
        result,
        scratchDir: run.scratchDir,
      })
    })
    this.detachOwnerCleanup(run)
  }

  private finishInterrupted(run: SupervisedRun): void {
    if (run.terminalPublished) return
    const settledMembers = this.settleRunningMembers(run)
    const error = 'workflow execution was interrupted by process or owner disposal'
    run.status = 'interrupted'
    run.resultView = { state: 'not-produced' }
    run.error = error
    run.settledAt = Date.now()
    run.terminalPublished = true
    this.releaseExecutionState(run)
    const parent = run.parent
    run.parent = undefined
    this.commit(run, 'result')
    const publication = run.durablePublication
    for (const member of settledMembers) {
      this.publishLifecycle(run, publication, () => {
        this.emitContained('workflows/member-end', this.info(run), member)
      })
    }
    this.trackTerminalPublication(run, parent, () => {
      this.emitContained('workflows/run-end', this.info(run), {
        stopReason: 'interrupted',
        error,
        agentsStarted: run.spent,
      })
    })
    this.detachOwnerCleanup(run)
  }

  private trackTerminalPublication(
    run: SupervisedRun,
    parent: Agent | undefined,
    publish: () => void,
    deliver?: () => Promise<void>,
  ): void {
    const publication = run.durablePublication
    const priorLifecycle = run.lifecyclePublication
    const completion = (async () => {
      await priorLifecycle
      await publication
      publish()
      await deliver?.()
    })().catch((error: unknown) => {
      this.ctx.logger.warn(`workflow-supervisor: terminal publication failed: ${renderThrown(error)}`)
    })
    run.completionDelivery = completion
    if (parent === undefined) return
    const deliveries = this.ownerDeliveries.get(parent) ?? new Set<Promise<void>>()
    this.ownerDeliveries.set(parent, deliveries)
    deliveries.add(completion)
    this.notifyOwnerChange(parent)
    void completion.then(() => {
      deliveries.delete(completion)
      if (deliveries.size === 0) this.ownerDeliveries.delete(parent)
      this.notifyOwnerChange(parent)
    })
  }

  private publishLifecycle(run: SupervisedRun, publication: Promise<void>, publish: () => void): void {
    const prior = run.lifecyclePublication
    const next = (async () => {
      await prior
      await publication
      publish()
    })()
    run.lifecyclePublication = next
    run.lifecyclePending += 1
    this.notifyOwnerChange(run.parent)
    void next.then(
      () => { this.settleLifecyclePublication(run) },
      (error: unknown) => {
        this.ctx.logger.warn(`workflow-supervisor: lifecycle publication failed: ${renderThrown(error)}`)
        this.settleLifecyclePublication(run)
      },
    )
  }

  private settleLifecyclePublication(run: SupervisedRun): void {
    run.lifecyclePending -= 1
    this.notifyOwnerChange(run.parent)
  }

  private releaseExecutionState(run: SupervisedRun): void {
    run.script = undefined
    run.args = undefined
    run.journal.clear()
    for (const member of run.members.values()) {
      if (member.resultCommitted) {
        member.outcomeView = member.result === undefined
          ? { state: 'evicted' }
          : workflowRunValueView(member.result, this.memberOutcomeMaxBytes)
      }
      member.result = undefined
    }
  }

  private detachOwnerCleanup(run: SupervisedRun): void {
    const cleanup = run.ownerCleanup
    run.ownerCleanup = undefined
    if (cleanup === undefined) return
    void Promise.resolve(cleanup()).catch((error: unknown) => {
      this.ctx.logger.warn(`workflow-supervisor: owner cleanup detach failed: ${renderThrown(error)}`)
    })
  }

  private settleRunningMembers(run: SupervisedRun): SupervisedWorkflowMemberLifecycleInfo[] {
    const settled: SupervisedWorkflowMemberLifecycleInfo[] = []
    for (const member of run.members.values()) {
      if (member.status !== 'running') continue
      member.status = 'cancelled'
      member.settledAt = Date.now()
      run.membersRevision += 1
      settled.push(this.memberLifecycle(member))
    }
    return settled
  }

  private onMemberStart(executionId: WorkflowRunId, info: WorkflowAgentInfo): void {
    this.withAttempt(executionId, (run, attempt) => {
      if (run.members.has(info.seq)) {
        this.ctx.logger.warn(`workflow-supervisor: duplicate member sequence ${info.seq} ignored`)
        return
      }
      if (run.members.size >= this.maxMembersPerRun) {
        run.status = 'stopping'
        this.raiseIntent(attempt, 'stop')
        attempt.handle.cancel('workflow member retention limit exceeded')
        this.commit(run, 'detail')
        return
      }
      const member: MemberRecord = {
        memberId: WorkflowMemberId(`member-${randomUUID()}`),
        seq: info.seq,
        label: retainText(info.label, this.remoteHeadTextMaxBytes).text,
        ...(info.phase === undefined ? {} : {
          phase: retainText(info.phase, this.remoteHeadTextMaxBytes).text,
        }),
        childSessionId: info.childId,
        status: 'running',
        startedAt: Date.now(),
        resultCommitted: false,
        outcomeEvicted: false,
        result: undefined,
        outcomeView: undefined,
      }
      run.members.set(info.seq, member)
      run.spent += 1
      this.commit(run, 'members')
      const lifecycle = this.memberLifecycle(member)
      this.publishLifecycle(run, run.durablePublication, () => {
        this.emitContained('workflows/member-start', this.info(run), lifecycle)
      })
    })
  }

  private onJournalCommit(executionId: WorkflowRunId, entry: WorkflowJournalEntry): void {
    this.withAttempt(executionId, (run) => {
      const previous = run.journal.get(entry.callId)
      if (previous !== undefined) {
        if (!isDeepStrictEqual(previous, entry)) {
          this.ctx.logger.warn(`workflow-supervisor: conflicting journal entry ${entry.callId} ignored`)
        }
        return
      }
      const journal = [...run.journal.values()]
      const latestOrdinal = journal.reduce(
        (maximum, candidate) => Math.max(maximum, candidate.ordinal),
        0,
      )
      const conflicts = entry.ordinal <= latestOrdinal || journal.some(candidate =>
        candidate.kind === 'agent' && entry.kind === 'agent' && candidate.seq === entry.seq)
      if (conflicts) {
        this.ctx.logger.warn(`workflow-supervisor: conflicting journal identity ${entry.callId} ignored`)
        return
      }
      run.journal.set(entry.callId, entry)
      if (entry.kind !== 'agent') return
      const member = run.members.get(entry.seq)
      if (member !== undefined) {
        member.result = entry.result
        member.resultCommitted = true
        member.outcomeEvicted = false
        member.outcomeView = undefined
      }
      this.commit(run, 'members')
    })
  }

  private onMemberEnd(executionId: WorkflowRunId, info: WorkflowAgentEndInfo): void {
    this.withAttempt(executionId, (run) => {
      const member = run.members.get(info.seq)
      if (member === undefined) return
      if (member.status !== 'running') return
      member.status = info.outcome
      member.settledAt = Date.now()
      this.commit(run, 'members')
      const lifecycle = this.memberLifecycle(member)
      this.publishLifecycle(run, run.durablePublication, () => {
        this.emitContained('workflows/member-end', this.info(run), lifecycle)
      })
    })
  }

  private onGate(executionId: WorkflowRunId, gate: WorkflowGateInfo): void {
    this.withAttempt(executionId, (run, attempt) => {
      this.clearGate(run)
      const boundedGate = this.gateView(gate)
      const record: GateRecord = {
        generation: attempt.generation,
        executionId,
        gateId: WorkflowGateId(`gate-${randomUUID()}`),
        gate: boundedGate,
        abort: new AbortController(),
      }
      run.gate = record
      run.durableGate = {
        kind: retainText(boundedGate.kind, this.maxGateKindBytes).text,
        message: retainText(boundedGate.message, this.maxGateMessageBytes),
        interrupted: false,
      }
      run.status = 'needs-input'
      this.commit(run, 'detail')
      if (run.parent !== undefined) {
        this.emitContained('workflows/gate-request', {
          info: this.info(run),
          executionId,
          gateId: record.gateId,
          gate: boundedGate,
          parent: run.parent,
          signal: record.abort.signal,
        })
      }
    })
  }

  private withAttempt(
    executionId: WorkflowRunId,
    callback: (run: SupervisedRun, attempt: AttemptRecord) => void,
  ): void {
    const lookup = this.executions.get(String(executionId))
    if (lookup === undefined) return
    const attempt = lookup.run.attempt
    if (attempt === undefined || attempt.generation !== lookup.generation) return
    if (String(attempt.executionId) !== String(executionId)) return
    callback(lookup.run, attempt)
  }

  private clearGate(run: SupervisedRun, preserveInterrupted = false): void {
    const gate = run.gate
    if (gate === undefined) return
    run.gate = undefined
    run.durableGate = preserveInterrupted ? {
      kind: retainText(gate.gate.kind, this.maxGateKindBytes).text,
      message: retainText(gate.gate.message, this.maxGateMessageBytes),
      interrupted: true,
    } : undefined
    gate.abort.abort('workflow gate is no longer current')
  }

  private memberHead(member: MemberRecord): WorkflowRunMemberHead {
    return {
      memberId: member.memberId,
      seq: member.seq,
      label: retainText(member.label, this.remoteHeadTextMaxBytes).text,
      ...(member.phase === undefined ? {} : {
        phase: retainText(member.phase, this.remoteHeadTextMaxBytes).text,
      }),
      status: member.status,
      startedAt: member.startedAt,
      ...(member.settledAt === undefined ? {} : { settledAt: member.settledAt }),
      outcome: member.outcomeView?.state ?? (member.resultCommitted
        ? 'available'
        : member.outcomeEvicted
          ? 'evicted'
          : member.status === 'running'
            ? 'pending'
            : 'not-produced'),
    }
  }

  private memberLifecycle(member: MemberRecord): SupervisedWorkflowMemberLifecycleInfo {
    return { ...this.memberHead(member), childSessionId: member.childSessionId }
  }

  private info(run: SupervisedRun): SupervisedWorkflowRunInfo {
    return { id: run.runId, displayName: run.displayName, name: run.meta.name }
  }

  private head(run: SupervisedRun): WorkflowRunHead {
    const counts = { total: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
    for (const member of run.members.values()) {
      counts.total += 1
      counts[member.status] += 1
    }
    const allowedActions: Array<WorkflowRunHead['allowedActions'][number]> = []
    if (run.status === 'running') allowedActions.push('pause', 'stop')
    if (run.status === 'needs-input' || run.status === 'paused') allowedActions.push('resume', 'stop')
    if (run.status === 'budget-limited') allowedActions.push('stop')
    if (!run.builtin && !run.numberedHandle && run.scriptPath !== undefined) allowedActions.push('save')
    return {
      runId: run.runId,
      displayName: run.displayName,
      name: run.meta.name,
      description: retainText(run.meta.description, this.remoteHeadTextMaxBytes).text,
      status: run.status,
      ...(run.phase === undefined ? {} : {
        phase: retainText(run.phase, this.remoteHeadTextMaxBytes).text,
      }),
      budget: { total: run.budget, spent: run.spent, remaining: Math.max(0, run.budget - run.spent) },
      memberCounts: counts,
      startedAt: run.startedAt,
      ...(run.settledAt === undefined ? {} : { settledAt: run.settledAt }),
      allowedActions,
      revision: run.revision,
      detailRevision: run.detailRevision,
      membersRevision: run.membersRevision,
      logsRevision: run.logsRevision,
      resultRevision: run.resultRevision,
      artifactsRevision: run.artifactsRevision,
    }
  }

  private lookupDisplay(displayName: string, agent: Agent): SupervisedRun {
    const run = this.runsByDisplayName.get(this.displayKey(agent.session.id, displayName))
    if (run === undefined) throw new Error(`no workflow run named "${displayName}" in this session`)
    if (run.parent !== undefined && run.parent !== agent) {
      throw new Error(`workflow "${displayName}" is owned by another Agent instance`)
    }
    return run
  }

  private lookupIdForSession(runId: LogicalRunId | string, sessionId: SessionId): SupervisedRun {
    const run = this.runsById.get(String(runId))
    if (run === undefined || run.sessionId !== sessionId) {
      throw new Error('no workflow run with that id in this session')
    }
    return run
  }

  private lookupId(runId: LogicalRunId | string, agent: Agent): SupervisedRun {
    const run = this.lookupIdForSession(runId, agent.session.id)
    if (run.parent !== undefined && run.parent !== agent) {
      throw new Error('workflow run is owned by another Agent instance')
    }
    return run
  }

  private displayKey(sessionId: SessionId, displayName: string): string {
    return `${sessionId}\u0000${displayName}`
  }

  private sessionRuns(sessionId: SessionId): SupervisedRun[] {
    const rows = [...this.runsById.values()].filter(run => run.sessionId === sessionId)
    rows.sort((left, right) => {
      const leftLive = isNonterminal(left.status) ? 0 : 1
      const rightLive = isNonterminal(right.status) ? 0 : 1
      return leftLive - rightLive || left.startedAt - right.startedAt
    })
    return rows
  }

  private commit(
    run: SupervisedRun,
    aspect: 'detail' | 'members' | 'logs' | 'result' | 'artifacts',
  ): void {
    run.revision += 1
    switch (aspect) {
      case 'detail': run.detailRevision += 1; break
      case 'members': run.membersRevision += 1; break
      case 'logs': run.logsRevision += 1; break
      case 'result': run.resultRevision += 1; break
      case 'artifacts': run.artifactsRevision += 1; break
    }
    const publication = this.persist(run)
    run.durablePublication = publication
    void publication.catch((error: unknown) => {
      this.ctx.logger.warn(`workflow-supervisor: manifest update failed: ${renderThrown(error)}`)
    })
    this.publishChange(run)
    this.notifyOwnerChange(run.parent)
  }

  private async persist(run: SupervisedRun, signal?: AbortSignal): Promise<void> {
    const result = await this.manifests.upsert(this.manifest(run), signal)
    for (const evicted of result.evicted) this.removeEvicted(evicted)
  }

  private manifest(run: SupervisedRun): WorkflowRunManifest {
    const stopReason = statusStopReason(run.status)
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      displayName: run.displayName,
      meta: run.meta,
      status: run.status,
      ...(run.phase === undefined ? {} : { phase: run.phase }),
      budget: { total: run.budget, spent: Math.min(run.spent, run.budget) },
      members: [...run.members.values()].map(member => this.manifestMember(member)),
      builtin: run.builtin,
      numberedHandle: run.numberedHandle,
      runDirectory: run.runDirectory,
      startedAt: run.startedAt,
      ...(run.settledAt === undefined ? {} : { settledAt: run.settledAt }),
      ...(stopReason === undefined ? {} : { stopReason }),
      result: this.manifestResult(run.resultView),
      logs: {
        total: run.droppedLogLines + run.logs.length,
        retained: run.logs.map(line => ({
          index: line.index,
          text: line.text,
          totalBytes: line.totalBytes,
          truncated: line.truncated,
        })),
        revision: run.logsRevision,
      },
      ...(run.durableGate === undefined ? {} : { gate: run.durableGate }),
      artifacts: {
        total: run.artifactTotal,
        retained: run.artifacts.map(({ name, bytes }) => ({ name, bytes })),
        revision: run.artifactsRevision,
      },
      ...(run.error === undefined ? {} : { error: run.error }),
      revision: run.revision,
    }
  }

  private manifestResult(value: WorkflowRunValueView): WorkflowRunManifest['result'] {
    if (value.state !== 'available') return value
    if (value.content.kind === 'preview') {
      return {
        state: 'available',
        content: { kind: 'preview', text: value.content.text },
        totalBytes: value.totalBytes,
        truncated: true,
      }
    }
    return {
      state: 'available',
      content: { kind: 'json', text: JSON.stringify(value.content.value, null, 2) },
      totalBytes: value.totalBytes,
      truncated: false,
    }
  }

  private recoveredResult(value: WorkflowRunManifest['result']): WorkflowRunValueView {
    if (value.state !== 'available') return value
    if (value.content.kind === 'preview') {
      return {
        state: 'available',
        content: { kind: 'preview', text: value.content.text },
        totalBytes: value.totalBytes,
        truncated: true,
      }
    }
    return {
      state: 'available',
      content: { kind: 'value', value: JSON.parse(value.content.text) as JsonValue },
      totalBytes: value.totalBytes,
      truncated: false,
    }
  }

  private manifestMember(member: MemberRecord): WorkflowRunManifestMember {
    return {
      memberId: member.memberId,
      seq: member.seq,
      label: member.label,
      ...(member.phase === undefined ? {} : { phase: member.phase }),
      status: member.status,
      childSessionId: member.childSessionId,
      startedAt: member.startedAt,
      ...(member.settledAt === undefined ? {} : { settledAt: member.settledAt }),
      hadCommittedOutcome: member.resultCommitted || member.outcomeEvicted,
    }
  }

  private publishChange(run: SupervisedRun): void {
    const key = String(run.sessionId)
    const sessionRevision = (this.sessionRevisions.get(key) ?? 0) + 1
    this.sessionRevisions.set(key, sessionRevision)
    const change: WorkflowRunChange = {
      kind: 'upsert',
      sessionId: run.sessionId,
      epoch: this.feedEpoch,
      sessionRevision,
      head: this.head(run),
    }
    this.emitContained('workflows/run-change', change)
  }

  private removeEvicted(manifest: WorkflowRunManifest): void {
    const run = this.runsById.get(String(manifest.runId))
    if (run === undefined || isNonterminal(run.status)) return
    this.runsById.delete(String(run.runId))
    this.runsByDisplayName.delete(this.displayKey(run.sessionId, run.displayName))
    const key = String(run.sessionId)
    const sessionRevision = (this.sessionRevisions.get(key) ?? 0) + 1
    this.sessionRevisions.set(key, sessionRevision)
    this.emitContained('workflows/run-change', {
      kind: 'remove',
      sessionId: run.sessionId,
      epoch: this.feedEpoch,
      sessionRevision,
      runId: run.runId,
    })
    void this.removeDirectory(run.scratchDir)
  }

  private async loadRecovered(sessionId: SessionId, signal?: AbortSignal): Promise<void> {
    const recovered = await this.manifests.recoverSession(sessionId, signal)
    for (const manifest of recovered) {
      if (this.runsById.has(String(manifest.runId))) continue
      const run = this.fromRecovered(manifest)
      this.runsById.set(String(run.runId), run)
      this.runsByDisplayName.set(this.displayKey(run.sessionId, run.displayName), run)
      this.publishChange(run)
    }
  }

  private fromRecovered(manifest: RecoveredWorkflowRunManifest): SupervisedRun {
    const logs: LogRecord[] = manifest.logs.retained.map(line => ({
      index: line.index,
      text: line.text,
      totalBytes: line.totalBytes,
      truncated: line.truncated,
      retainedBytes: encoder.encode(line.text).byteLength,
    }))
    return {
      runId: manifest.runId,
      sessionId: manifest.sessionId,
      displayName: manifest.displayName,
      meta: manifest.meta,
      script: undefined,
      args: undefined,
      budget: manifest.budget.total,
      spent: manifest.budget.spent,
      journal: new Map(),
      members: new Map(manifest.members.map(member => [member.seq, {
        memberId: member.memberId,
        seq: member.seq,
        label: member.label,
        ...(member.phase === undefined ? {} : { phase: member.phase }),
        childSessionId: member.childSessionId,
        status: member.status,
        startedAt: member.startedAt ?? manifest.startedAt,
        ...(member.settledAt === undefined ? {} : { settledAt: member.settledAt }),
        resultCommitted: false,
        outcomeEvicted: member.hadCommittedOutcome,
        result: undefined,
        outcomeView: member.hadCommittedOutcome ? { state: 'evicted' } : undefined,
      }])),
      parent: undefined,
      status: manifest.status,
      phase: manifest.phase,
      gate: undefined,
      durableGate: manifest.gate,
      resultView: this.recoveredResult(manifest.result),
      error: manifest.error,
      attempt: undefined,
      generation: 0,
      revision: manifest.revision,
      detailRevision: manifest.revision,
      membersRevision: manifest.revision,
      logsRevision: manifest.logs.revision,
      resultRevision: manifest.revision,
      artifactsRevision: manifest.artifacts.revision,
      logs,
      logBytes: logs.reduce((total, line) => total + line.retainedBytes, 0),
      droppedLogLines: manifest.logs.total - logs.length,
      artifacts: [...manifest.artifacts.retained],
      artifactTotal: manifest.artifacts.total,
      runDirectory: manifest.runDirectory,
      scratchDir: join(this.runsRoot, manifest.runDirectory),
      builtin: manifest.builtin,
      numberedHandle: manifest.numberedHandle,
      startedAt: manifest.startedAt,
      settledAt: manifest.settledAt,
      terminalPublished: TERMINAL_STATUSES.has(manifest.status),
      published: true,
      ownerCleanup: undefined,
      completionDelivery: Promise.resolve(),
      durablePublication: Promise.resolve(),
      lifecyclePublication: Promise.resolve(),
      lifecyclePending: 0,
    }
  }

  private async disposeOwner(agent: Agent): Promise<void> {
    const observations: Promise<void>[] = []
    for (const run of this.runsById.values()) {
      if (run.parent !== agent || !isNonterminal(run.status)) continue
      observations.push(this.disposeOwnedRun(run, 'workflow owner disposed'))
    }
    await Promise.all(observations)
  }

  private async disposeOwnedRun(run: SupervisedRun, reason: string): Promise<void> {
    if (!isNonterminal(run.status)) return
    this.clearGate(run, true)
    const attempt = run.attempt
    if (attempt === undefined) {
      this.finishInterrupted(run)
    } else {
      this.raiseIntent(attempt, 'teardown')
      attempt.handle.cancel(reason)
      await attempt.observation
    }
    await run.completionDelivery
    await run.durablePublication
  }

  private async disposeService(): Promise<void> {
    if (this.tearingDown) return
    this.tearingDown = true
    const observations: Promise<void>[] = []
    for (const run of this.runsById.values()) {
      if (!isNonterminal(run.status)) continue
      observations.push(this.disposeOwnedRun(run, 'workflow supervisor disposed'))
    }
    await Promise.all(observations)
  }

  private async removeDirectory(path: string): Promise<void> {
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isDirectory()) await unlink(path)
      else await rm(path, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.ctx.logger.warn(`workflow-supervisor: failed to remove run directory: ${renderThrown(error)}`)
    }
  }
}

export default WorkflowSupervisor
