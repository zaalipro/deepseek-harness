/**
 * Durable, execution-free workflow-run manifests. The store addresses one
 * Session directly through a hash of its opaque id, so recovery never scans a
 * global run directory. Each session file contains a bounded retained roster
 * plus independent display-name ordinals. Active rows are committed as
 * Interrupted before recovery returns; no engine attempt, Agent, journal,
 * script, or args cross the process lifetime.
 *
 * @module @deepseek-ai/dsh-workflow-supervisor/manifest-store
 */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { isWorkflowName, validateMeta } from '@deepseek-ai/dsh-workflow'
import type { WorkflowMeta } from '@deepseek-ai/dsh-workflow'
import type {
  SupervisedWorkflowStopReason,
  SupervisedWorkflowRunId,
  WorkflowMemberId,
  WorkflowRunStatus,
} from './types.ts'

const MANIFEST_VERSION = 2
const MANIFEST_FILENAME = 'manifest.json'
const SESSION_MANIFEST_DIRECTORY = 'sessions'
const RUN_DIRECTORY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
const OPAQUE_ID_MAX_LENGTH = 256

const STOP_REASONS = new Set<SupervisedWorkflowStopReason>([
  'completed',
  'cancelled',
  'error',
  'interrupted',
])

const ACTIVE_STATUSES = new Set<WorkflowRunStatus>([
  'running',
  'pausing',
  'stopping',
  'needs-input',
  'paused',
  'budget-limited',
])

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

const MEMBER_STATUSES = new Set<WorkflowRunManifestMember['status']>([
  'running',
  'completed',
  'failed',
  'cancelled',
])

/** One child-launch summary retained without its potentially large outcome. */
export interface WorkflowRunManifestMember {
  readonly memberId: WorkflowMemberId
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly childSessionId: SessionIdType
  readonly startedAt?: number
  readonly settledAt?: number
  /** Whether the process committed a value that recovery must report as evicted. */
  readonly hadCommittedOutcome: boolean
}

/** UTF-8-bounded text retained with its original byte count. */
export interface WorkflowRunManifestText {
  readonly text: string
  readonly totalBytes: number
  readonly truncated: boolean
}

/** One retained log preview addressed by its immutable zero-based index. */
export interface WorkflowRunManifestLogLine extends WorkflowRunManifestText {
  readonly index: number
}

/** Bounded log tail plus the complete logical line count. */
export interface WorkflowRunManifestLogs {
  readonly total: number
  readonly retained: readonly WorkflowRunManifestLogLine[]
  readonly revision: number
}

/** Human-gate presentation retained after its process-owned question expires. */
export interface WorkflowRunManifestGate {
  readonly kind: string
  readonly message: WorkflowRunManifestText
  readonly interrupted: boolean
}

/** Serialized bounded projection of a terminal workflow result. */
export type WorkflowRunManifestResult =
  | { readonly state: 'pending' }
  | { readonly state: 'not-produced' }
  | { readonly state: 'evicted' }
  | {
    readonly state: 'available'
    readonly content: { readonly kind: 'json' | 'preview'; readonly text: string }
    readonly totalBytes: number
    readonly truncated: boolean
  }

/** One scratch artifact's durable name and byte size, never its content. */
export interface WorkflowRunManifestArtifact {
  readonly name: string
  readonly bytes: number
}

/** Bounded artifact-name roster plus the complete logical artifact count. */
export interface WorkflowRunManifestArtifacts {
  readonly total: number
  readonly retained: readonly WorkflowRunManifestArtifact[]
  readonly revision: number
}

/** Metadata sufficient to render a retained row without execution authority. */
export interface WorkflowRunManifest {
  readonly runId: SupervisedWorkflowRunId
  readonly sessionId: SessionIdType
  readonly displayName: string
  readonly meta: WorkflowMeta
  readonly status: WorkflowRunStatus
  readonly phase?: string
  readonly budget: { readonly total: number; readonly spent: number }
  readonly members: readonly WorkflowRunManifestMember[]
  readonly builtin: boolean
  readonly numberedHandle: boolean
  /** Single path component beneath the configured runs root. */
  readonly runDirectory: string
  readonly startedAt: number
  readonly settledAt?: number
  readonly stopReason?: SupervisedWorkflowStopReason
  readonly result: WorkflowRunManifestResult
  readonly logs: WorkflowRunManifestLogs
  readonly gate?: WorkflowRunManifestGate
  readonly artifacts: WorkflowRunManifestArtifacts
  readonly error?: string
  readonly revision: number
}

/** A persisted row recovered without any resumable process-owned resources. */
export interface RecoveredWorkflowRunManifest extends WorkflowRunManifest {
  readonly executionAvailable: false
}

/** Required storage limits; the owning supervisor exposes deployment defaults. */
export interface WorkflowRunManifestStoreOptions {
  readonly runsRoot: string
  readonly maxRetainedRunsPerSession: number
  readonly maxWorkflowNamesPerSession: number
  readonly maxMembersPerRun: number
  readonly maxRetainedLogLinesPerRun: number
  readonly maxRetainedLogLineBytes: number
  readonly maxRetainedArtifactsPerRun: number
  readonly maxRetainedArtifactNameBytes: number
  readonly maxRetainedGateKindBytes: number
  readonly maxRetainedGateMessageBytes: number
  readonly maxRetainedErrorBytes: number
  readonly maxTerminalResultBytes: number
  readonly maxManifestBytes: number
}

/** Rows removed from the durable roster by one successful upsert. */
export interface WorkflowRunManifestWriteResult {
  readonly evicted: readonly WorkflowRunManifest[]
}

/** Initial row and any terminal rows removed by its atomic insertion. */
export interface WorkflowRunManifestInsertResult extends WorkflowRunManifestWriteResult {
  readonly run: WorkflowRunManifest
}

interface WorkflowNameOrdinal {
  readonly name: string
  readonly lastOrdinal: number
}

interface SessionManifest {
  readonly version: typeof MANIFEST_VERSION
  readonly sessionId: SessionIdType
  readonly ordinals: readonly WorkflowNameOrdinal[]
  readonly runs: readonly WorkflowRunManifest[]
}

/** Render a contextual durable-format failure. */
function corrupt(path: string, message: string, cause?: unknown): Error {
  return new Error(`workflow run manifest "${path}" is corrupt: ${message}`, cause === undefined ? undefined : { cause })
}

/** Require a plain JSON object at one decoded path. */
function objectAt(value: unknown, path: string, file: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw corrupt(file, `${path} must be an object`)
  }
  return value as Record<string, unknown>
}

/** Reject additions to the frozen pre-release manifest format. */
function exactKeys(record: Record<string, unknown>, allowed: readonly string[], path: string, file: string): void {
  const accepted = new Set(allowed)
  const unknown = Object.keys(record).filter(key => !accepted.has(key))
  if (unknown.length > 0) throw corrupt(file, `${path} has unknown field(s): ${unknown.join(', ')}`)
}

function stringAt(value: unknown, path: string, file: string, allowEmpty = true): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw corrupt(file, `${path} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`)
  }
  return value
}

function booleanAt(value: unknown, path: string, file: string): boolean {
  if (typeof value !== 'boolean') throw corrupt(file, `${path} must be a boolean`)
  return value
}

function integerAt(value: unknown, path: string, file: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw corrupt(file, `${path} must be a safe integer >= ${minimum}`)
  }
  return value as number
}

function optionalString(record: Record<string, unknown>, key: string, path: string, file: string): string | undefined {
  return record[key] === undefined ? undefined : stringAt(record[key], `${path}.${key}`, file)
}

function optionalInteger(record: Record<string, unknown>, key: string, path: string, file: string): number | undefined {
  return record[key] === undefined ? undefined : integerAt(record[key], `${path}.${key}`, file, 0)
}

const utf8Encoder = new TextEncoder()

/** Decode one retained text projection and verify its byte accounting. */
function decodeText(
  value: unknown,
  path: string,
  file: string,
  maxBytes: number,
): WorkflowRunManifestText {
  const record = objectAt(value, path, file)
  exactKeys(record, ['text', 'totalBytes', 'truncated'], path, file)
  const text = stringAt(record.text, `${path}.text`, file)
  const retainedBytes = utf8Encoder.encode(text).byteLength
  if (retainedBytes > maxBytes) throw corrupt(file, `${path}.text exceeds the configured byte limit`)
  const totalBytes = integerAt(record.totalBytes, `${path}.totalBytes`, file, retainedBytes)
  const truncated = booleanAt(record.truncated, `${path}.truncated`, file)
  if (truncated !== (totalBytes > retainedBytes)) {
    throw corrupt(file, `${path}.truncated does not match its retained and total byte counts`)
  }
  return { text, totalBytes, truncated }
}

/** Decode a bounded tail of retained workflow log previews. */
function decodeLogs(
  value: unknown,
  path: string,
  file: string,
  options: WorkflowRunManifestStoreOptions,
): WorkflowRunManifestLogs {
  const record = objectAt(value, path, file)
  exactKeys(record, ['total', 'retained', 'revision'], path, file)
  const total = integerAt(record.total, `${path}.total`, file, 0)
  if (!Array.isArray(record.retained)) throw corrupt(file, `${path}.retained must be an array`)
  if (record.retained.length > options.maxRetainedLogLinesPerRun) {
    throw corrupt(file, `${path}.retained exceeds the configured line limit`)
  }
  if (record.retained.length > total) throw corrupt(file, `${path}.retained exceeds total`)
  const firstIndex = total - record.retained.length
  const retained = record.retained.map((value, index) => {
    const linePath = `${path}.retained[${index}]`
    const line = objectAt(value, linePath, file)
    exactKeys(line, ['index', 'text', 'totalBytes', 'truncated'], linePath, file)
    const decoded = decodeText({
      text: line.text,
      totalBytes: line.totalBytes,
      truncated: line.truncated,
    }, linePath, file, options.maxRetainedLogLineBytes)
    const retainedIndex = integerAt(line.index, `${linePath}.index`, file, 0)
    if (retainedIndex !== firstIndex + index) {
      throw corrupt(file, `${path}.retained must be a contiguous tail ending at total`)
    }
    return { index: retainedIndex, ...decoded }
  })
  return {
    total,
    retained,
    revision: integerAt(record.revision, `${path}.revision`, file, 0),
  }
}

/** Decode one bounded terminal result projection. */
function decodeResult(
  value: unknown,
  path: string,
  file: string,
  maxBytes: number,
): WorkflowRunManifestResult {
  const record = objectAt(value, path, file)
  const state = stringAt(record.state, `${path}.state`, file)
  if (state === 'pending' || state === 'not-produced' || state === 'evicted') {
    exactKeys(record, ['state'], path, file)
    return { state }
  }
  if (state !== 'available') throw corrupt(file, `${path}.state is not recognized`)
  exactKeys(record, ['state', 'content', 'totalBytes', 'truncated'], path, file)
  const content = objectAt(record.content, `${path}.content`, file)
  exactKeys(content, ['kind', 'text'], `${path}.content`, file)
  const kind = stringAt(content.kind, `${path}.content.kind`, file)
  if (kind !== 'json' && kind !== 'preview') throw corrupt(file, `${path}.content.kind is not recognized`)
  const text = stringAt(content.text, `${path}.content.text`, file)
  const retainedBytes = utf8Encoder.encode(text).byteLength
  if (retainedBytes > maxBytes) throw corrupt(file, `${path}.content.text exceeds the configured byte limit`)
  const totalBytes = integerAt(record.totalBytes, `${path}.totalBytes`, file, retainedBytes)
  const truncated = booleanAt(record.truncated, `${path}.truncated`, file)
  if (truncated !== (totalBytes > retainedBytes) || truncated !== (kind === 'preview')) {
    throw corrupt(file, `${path} content kind and truncation metadata disagree`)
  }
  if (kind === 'json') {
    try {
      JSON.parse(text)
    } catch (error) {
      throw corrupt(file, `${path}.content.text is not valid JSON`, error)
    }
  }
  return { state: 'available', content: { kind, text }, totalBytes, truncated }
}

/** Decode one retained human-gate preview. */
function decodeGate(
  value: unknown,
  path: string,
  file: string,
  options: WorkflowRunManifestStoreOptions,
): WorkflowRunManifestGate {
  const record = objectAt(value, path, file)
  exactKeys(record, ['kind', 'message', 'interrupted'], path, file)
  const kind = stringAt(record.kind, `${path}.kind`, file, false)
  if (utf8Encoder.encode(kind).byteLength > options.maxRetainedGateKindBytes) {
    throw corrupt(file, `${path}.kind exceeds the configured byte limit`)
  }
  return {
    kind,
    message: decodeText(record.message, `${path}.message`, file, options.maxRetainedGateMessageBytes),
    interrupted: booleanAt(record.interrupted, `${path}.interrupted`, file),
  }
}

/** Decode a bounded scratch-artifact metadata roster. */
function decodeArtifacts(
  value: unknown,
  path: string,
  file: string,
  options: WorkflowRunManifestStoreOptions,
): WorkflowRunManifestArtifacts {
  const record = objectAt(value, path, file)
  exactKeys(record, ['total', 'retained', 'revision'], path, file)
  const total = integerAt(record.total, `${path}.total`, file, 0)
  if (!Array.isArray(record.retained)) throw corrupt(file, `${path}.retained must be an array`)
  if (record.retained.length > options.maxRetainedArtifactsPerRun) {
    throw corrupt(file, `${path}.retained exceeds the configured artifact limit`)
  }
  if (record.retained.length > total) throw corrupt(file, `${path}.retained exceeds total`)
  const retained = record.retained.map((value, index) => {
    const artifactPath = `${path}.retained[${index}]`
    const artifact = objectAt(value, artifactPath, file)
    exactKeys(artifact, ['name', 'bytes'], artifactPath, file)
    const name = stringAt(artifact.name, `${artifactPath}.name`, file, false)
    if (
      utf8Encoder.encode(name).byteLength > options.maxRetainedArtifactNameBytes
      || basename(name) !== name
      || name === '.'
      || name === '..'
    ) {
      throw corrupt(file, `${artifactPath}.name must be one bounded path component`)
    }
    return { name, bytes: integerAt(artifact.bytes, `${artifactPath}.bytes`, file, 0) }
  })
  if (new Set(retained.map(artifact => artifact.name)).size !== retained.length) {
    throw corrupt(file, `${path}.retained contains duplicate artifact names`)
  }
  return {
    total,
    retained,
    revision: integerAt(record.revision, `${path}.revision`, file, 0),
  }
}

/** Decode one member while retaining only navigation and outcome-availability metadata. */
function decodeMember(value: unknown, index: number, file: string): WorkflowRunManifestMember {
  const path = `runs[].members[${index}]`
  const record = objectAt(value, path, file)
  exactKeys(record, [
    'memberId', 'seq', 'label', 'phase', 'status', 'childSessionId',
    'startedAt', 'settledAt', 'hadCommittedOutcome',
  ], path, file)
  const memberId = stringAt(record.memberId, `${path}.memberId`, file, false)
  if (memberId.length > OPAQUE_ID_MAX_LENGTH) throw corrupt(file, `${path}.memberId is too long`)
  const status = stringAt(record.status, `${path}.status`, file)
  if (!MEMBER_STATUSES.has(status as WorkflowRunManifestMember['status'])) {
    throw corrupt(file, `${path}.status is not recognized`)
  }
  const childSessionId = stringAt(record.childSessionId, `${path}.childSessionId`, file, false)
  const phase = optionalString(record, 'phase', path, file)
  const startedAt = optionalInteger(record, 'startedAt', path, file)
  const settledAt = optionalInteger(record, 'settledAt', path, file)
  return {
    memberId: memberId as WorkflowMemberId,
    seq: integerAt(record.seq, `${path}.seq`, file, 1),
    label: stringAt(record.label, `${path}.label`, file),
    ...phase === undefined ? {} : { phase },
    status: status as WorkflowRunManifestMember['status'],
    childSessionId: SessionId(childSessionId),
    ...startedAt === undefined ? {} : { startedAt },
    ...settledAt === undefined ? {} : { settledAt },
    hadCommittedOutcome: booleanAt(record.hadCommittedOutcome, `${path}.hadCommittedOutcome`, file),
  }
}

/** Decode one strict run record from a bounded session manifest. */
function decodeRun(
  value: unknown,
  index: number,
  expectedSessionId: SessionIdType,
  options: WorkflowRunManifestStoreOptions,
  file: string,
): WorkflowRunManifest {
  const path = `runs[${index}]`
  const record = objectAt(value, path, file)
  exactKeys(record, [
    'runId', 'sessionId', 'displayName', 'meta', 'status', 'phase', 'budget',
    'members', 'builtin', 'numberedHandle', 'runDirectory', 'startedAt',
    'settledAt', 'stopReason', 'result', 'logs', 'gate', 'artifacts', 'error',
    'revision',
  ], path, file)
  const runId = stringAt(record.runId, `${path}.runId`, file, false)
  if (runId.length > OPAQUE_ID_MAX_LENGTH) throw corrupt(file, `${path}.runId is too long`)
  const sessionId = stringAt(record.sessionId, `${path}.sessionId`, file, false)
  if (sessionId !== expectedSessionId) throw corrupt(file, `${path}.sessionId does not match the owning session`)
  const status = stringAt(record.status, `${path}.status`, file)
  if (!ACTIVE_STATUSES.has(status as WorkflowRunStatus) && !TERMINAL_STATUSES.has(status as WorkflowRunStatus)) {
    throw corrupt(file, `${path}.status is not recognized`)
  }
  let meta: WorkflowMeta
  try {
    meta = validateMeta(record.meta)
  } catch (error) {
    throw corrupt(file, `${path}.meta is invalid`, error)
  }
  const budgetRecord = objectAt(record.budget, `${path}.budget`, file)
  exactKeys(budgetRecord, ['total', 'spent'], `${path}.budget`, file)
  const total = integerAt(budgetRecord.total, `${path}.budget.total`, file, 1)
  const spent = integerAt(budgetRecord.spent, `${path}.budget.spent`, file, 0)
  if (spent > total) throw corrupt(file, `${path}.budget.spent exceeds total`)
  if (!Array.isArray(record.members)) throw corrupt(file, `${path}.members must be an array`)
  if (record.members.length > options.maxMembersPerRun) {
    throw corrupt(file, `${path}.members exceeds the configured limit`)
  }
  const members = record.members.map((member, memberIndex) => decodeMember(member, memberIndex, file))
  const memberIds = new Set(members.map(member => member.memberId))
  const memberSeqs = new Set(members.map(member => member.seq))
  if (memberIds.size !== members.length) throw corrupt(file, `${path}.members contains duplicate memberId values`)
  if (memberSeqs.size !== members.length) throw corrupt(file, `${path}.members contains duplicate seq values`)
  const runDirectory = stringAt(record.runDirectory, `${path}.runDirectory`, file, false)
  if (!RUN_DIRECTORY_PATTERN.test(runDirectory) || basename(runDirectory) !== runDirectory) {
    throw corrupt(file, `${path}.runDirectory must be one safe path component`)
  }
  const settledAt = optionalInteger(record, 'settledAt', path, file)
  const typedStatus = status as WorkflowRunStatus
  if (TERMINAL_STATUSES.has(typedStatus) && settledAt === undefined) {
    throw corrupt(file, `${path}.settledAt is required for a terminal status`)
  }
  if (ACTIVE_STATUSES.has(typedStatus) && settledAt !== undefined) {
    throw corrupt(file, `${path}.settledAt is forbidden for an active status`)
  }
  const stopReasonValue = optionalString(record, 'stopReason', path, file)
  const stopReason = stopReasonValue as SupervisedWorkflowStopReason | undefined
  if (stopReason !== undefined && !STOP_REASONS.has(stopReason)) {
    throw corrupt(file, `${path}.stopReason is not recognized`)
  }
  const expectedStopReason: SupervisedWorkflowStopReason | undefined = typedStatus === 'completed'
    ? 'completed'
    : typedStatus === 'failed'
      ? 'error'
      : typedStatus === 'cancelled'
        ? 'cancelled'
        : typedStatus === 'interrupted'
          ? 'interrupted'
          : undefined
  if (stopReason !== expectedStopReason) {
    throw corrupt(file, `${path}.stopReason does not match status`)
  }
  const result = decodeResult(record.result, `${path}.result`, file, options.maxTerminalResultBytes)
  if (ACTIVE_STATUSES.has(typedStatus) && result.state !== 'pending') {
    throw corrupt(file, `${path}.result must be pending for an active status`)
  }
  if (TERMINAL_STATUSES.has(typedStatus) && result.state === 'pending') {
    throw corrupt(file, `${path}.result cannot be pending for a terminal status`)
  }
  if (typedStatus !== 'completed' && result.state === 'available') {
    throw corrupt(file, `${path}.result can be available only for a completed status`)
  }
  const logs = decodeLogs(record.logs, `${path}.logs`, file, options)
  const gate = record.gate === undefined ? undefined : decodeGate(record.gate, `${path}.gate`, file, options)
  if (gate !== undefined) {
    if (typedStatus === 'interrupted') {
      if (!gate.interrupted) throw corrupt(file, `${path}.gate must be marked interrupted`)
    } else if (ACTIVE_STATUSES.has(typedStatus)) {
      if (gate.interrupted) throw corrupt(file, `${path}.gate cannot be interrupted while the run is active`)
    } else {
      throw corrupt(file, `${path}.gate is forbidden for this terminal status`)
    }
  }
  if (typedStatus === 'needs-input' && gate === undefined) {
    throw corrupt(file, `${path}.gate is required for needs-input`)
  }
  const artifacts = decodeArtifacts(record.artifacts, `${path}.artifacts`, file, options)
  const displayName = stringAt(record.displayName, `${path}.displayName`, file, false)
  let ordinal: number
  try {
    ordinal = displayOrdinal(meta.name, displayName)
  } catch (error) {
    throw corrupt(file, `${path}.displayName is invalid for meta.name`, error)
  }
  const numberedHandle = booleanAt(record.numberedHandle, `${path}.numberedHandle`, file)
  if (numberedHandle !== (ordinal > 1)) throw corrupt(file, `${path}.numberedHandle does not match displayName`)
  const phase = optionalString(record, 'phase', path, file)
  const error = optionalString(record, 'error', path, file)
  if (error !== undefined && utf8Encoder.encode(error).byteLength > options.maxRetainedErrorBytes) {
    throw corrupt(file, `${path}.error exceeds the configured byte limit`)
  }
  return {
    runId: runId as SupervisedWorkflowRunId,
    sessionId: expectedSessionId,
    displayName,
    meta,
    status: typedStatus,
    ...phase === undefined ? {} : { phase },
    budget: { total, spent },
    members,
    builtin: booleanAt(record.builtin, `${path}.builtin`, file),
    numberedHandle,
    runDirectory,
    startedAt: integerAt(record.startedAt, `${path}.startedAt`, file, 0),
    ...settledAt === undefined ? {} : { settledAt },
    ...stopReason === undefined ? {} : { stopReason },
    result,
    logs,
    ...gate === undefined ? {} : { gate },
    artifacts,
    ...error === undefined ? {} : { error },
    revision: integerAt(record.revision, `${path}.revision`, file, 1),
  }
}

/** Decode and cross-check one complete session manifest. */
function decodeManifest(
  value: unknown,
  expectedSessionId: SessionIdType,
  options: WorkflowRunManifestStoreOptions,
  file: string,
): SessionManifest {
  const record = objectAt(value, 'root', file)
  exactKeys(record, ['version', 'sessionId', 'ordinals', 'runs'], 'root', file)
  if (record.version !== MANIFEST_VERSION) throw corrupt(file, `unsupported version ${String(record.version)}`)
  const sessionId = stringAt(record.sessionId, 'sessionId', file, false)
  if (sessionId !== expectedSessionId) throw corrupt(file, 'sessionId does not match its hashed storage directory')
  if (!Array.isArray(record.ordinals)) throw corrupt(file, 'ordinals must be an array')
  if (record.ordinals.length > options.maxWorkflowNamesPerSession) {
    throw corrupt(file, 'ordinals exceeds the configured limit')
  }
  const ordinals = record.ordinals.map((value, index) => {
    const ordinal = objectAt(value, `ordinals[${index}]`, file)
    exactKeys(ordinal, ['name', 'lastOrdinal'], `ordinals[${index}]`, file)
    const name = stringAt(ordinal.name, `ordinals[${index}].name`, file, false)
    if (!isWorkflowName(name)) throw corrupt(file, `ordinals[${index}].name is not a workflow name`)
    return { name, lastOrdinal: integerAt(ordinal.lastOrdinal, `ordinals[${index}].lastOrdinal`, file, 1) }
  })
  if (new Set(ordinals.map(ordinal => ordinal.name)).size !== ordinals.length) {
    throw corrupt(file, 'ordinals contains duplicate names')
  }
  if (!Array.isArray(record.runs)) throw corrupt(file, 'runs must be an array')
  if (record.runs.length > options.maxRetainedRunsPerSession) {
    throw corrupt(file, 'runs exceeds the configured limit')
  }
  const runs = record.runs.map((run, index) => decodeRun(
    run,
    index,
    expectedSessionId,
    options,
    file,
  ))
  if (new Set(runs.map(run => run.runId)).size !== runs.length) throw corrupt(file, 'runs contains duplicate runId values')
  if (new Set(runs.map(run => run.displayName)).size !== runs.length) throw corrupt(file, 'runs contains duplicate displayName values')
  if (new Set(runs.map(run => run.runDirectory)).size !== runs.length) throw corrupt(file, 'runs contains duplicate runDirectory values')
  const byName = new Map(ordinals.map(ordinal => [ordinal.name, ordinal.lastOrdinal]))
  for (const run of runs) {
    const lastOrdinal = byName.get(run.meta.name)
    if (lastOrdinal === undefined || lastOrdinal < displayOrdinal(run.meta.name, run.displayName)) {
      throw corrupt(file, `display ordinal for "${run.displayName}" is not retained`)
    }
  }
  return { version: MANIFEST_VERSION, sessionId: expectedSessionId, ordinals, runs }
}

/** Parse a display handle back to its session-local launch ordinal. */
function displayOrdinal(name: string, displayName: string): number {
  if (displayName === name) return 1
  const prefix = `${name}-`
  if (!displayName.startsWith(prefix)) throw new Error(`workflow display name "${displayName}" does not belong to "${name}"`)
  const suffix = displayName.slice(prefix.length)
  if (!/^(?:[2-9]|[1-9][0-9]+)$/u.test(suffix)) throw new Error(`workflow display name "${displayName}" has an invalid ordinal`)
  const ordinal = Number(suffix)
  if (!Number.isSafeInteger(ordinal)) throw new Error(`workflow display name "${displayName}" has an unsafe ordinal`)
  return ordinal
}

/** Read a regular manifest without following its final symlink or buffering past the limit. */
async function readBounded(path: string, maxBytes: number, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted()
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`workflow run manifest "${path}" is not a regular file`)
    if (info.size > maxBytes) throw new Error(`workflow run manifest "${path}" exceeds the ${maxBytes}-byte limit`)
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      signal?.throwIfAborted()
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) throw new Error(`workflow run manifest "${path}" exceeds the ${maxBytes}-byte limit`)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))
    } catch (error) {
      throw corrupt(path, 'content is not valid UTF-8', error)
    }
  } finally {
    await handle.close()
  }
}

/** Convert JSON parse failures into one path-specific durable-format error. */
function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw corrupt(path, 'content is not valid JSON', error)
  }
}

/** Convert an active process-owned row into a terminal recovery-only record. */
function interrupt(run: WorkflowRunManifest, recoveredAt: number): WorkflowRunManifest {
  if (!ACTIVE_STATUSES.has(run.status)) return run
  if (run.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error(`workflow run "${run.runId}" exhausted its durable revision counter`)
  }
  return {
    ...run,
    status: 'interrupted',
    members: run.members.map(member => member.status === 'running'
      ? { ...member, status: 'cancelled', settledAt: recoveredAt }
      : member),
    settledAt: Math.max(run.startedAt, recoveredAt),
    stopReason: 'interrupted',
    result: { state: 'not-produced' },
    ...run.gate === undefined ? {} : { gate: { ...run.gate, interrupted: true } },
    error: 'Process exited before workflow settlement.',
    revision: run.revision + 1,
  }
}

/** Deterministic oldest-first retained-row order. */
function compareRuns(left: WorkflowRunManifest, right: WorkflowRunManifest): number {
  return left.startedAt - right.startedAt || String(left.runId).localeCompare(String(right.runId))
}

/**
 * Session-addressed durable workflow roster. Operations for one Session are
 * FIFO-linearized in-process and whole-file commits are atomic. A signal is
 * checked while waiting/reading and immediately before publication; once the
 * atomic replacement starts, its successful commit wins the abort race.
 */
export class WorkflowRunManifestStore {
  private readonly options: WorkflowRunManifestStoreOptions
  private readonly sessionsRoot: string
  private readonly locks = new Map<SessionIdType, Promise<unknown>>()

  /**
   * @param options - absolute storage root and required roster/byte limits.
   */
  constructor(options: WorkflowRunManifestStoreOptions) {
    for (const [key, value] of Object.entries(options).filter(([key]) => key !== 'runsRoot')) {
      if (!Number.isSafeInteger(value) || (value as number) < 1) {
        throw new Error(`workflow manifest store ${key} must be a positive safe integer`)
      }
    }
    this.options = options
    this.sessionsRoot = join(resolve(options.runsRoot), SESSION_MANIFEST_DIRECTORY)
  }

  /**
   * Atomically reserve the next never-reused display handle for one workflow.
   * @param sessionId - owning Session.
   * @param name - validated workflow definition name.
   * @param signal - aborts before the ordinal commit.
   * @returns the base name for ordinal one, otherwise `<name>-N`.
   */
  reserveDisplayName(sessionId: SessionIdType, name: string, signal?: AbortSignal): Promise<string> {
    if (!isWorkflowName(name)) throw new Error(`cannot reserve display name for invalid workflow name "${name}"`)
    return this.withSessionLock(sessionId, async () => {
      signal?.throwIfAborted()
      const catalog = await this.read(sessionId, signal)
      const { displayName, ordinals } = this.allocateDisplayName(catalog, name)
      await this.commit({
        ...catalog,
        ordinals: [...ordinals].map(([ordinalName, lastOrdinal]) => ({ name: ordinalName, lastOrdinal })),
      }, signal)
      return displayName
    })
  }

  /**
   * Allocate a display handle and insert its initial row in one manifest
   * commit, so a failed pre-publication launch cannot consume an ordinal.
   * @param sessionId - owning Session.
   * @param name - validated workflow definition name.
   * @param create - builds the initial row from the allocated display handle.
   * @param signal - aborts before the atomic roster commit.
   * @returns the inserted row and any evicted terminal rows.
   */
  insertWithNextDisplayName(
    sessionId: SessionIdType,
    name: string,
    create: (displayName: string) => WorkflowRunManifest,
    signal?: AbortSignal,
  ): Promise<WorkflowRunManifestInsertResult> {
    if (!isWorkflowName(name)) throw new Error(`cannot allocate display name for invalid workflow name "${name}"`)
    return this.withSessionLock(sessionId, async () => {
      signal?.throwIfAborted()
      const catalog = await this.read(sessionId, signal)
      const { displayName, ordinals } = this.allocateDisplayName(catalog, name)
      const run = create(displayName)
      if (run.sessionId !== sessionId || run.meta.name !== name || run.displayName !== displayName) {
        throw new Error('workflow initial manifest does not match its allocated identity')
      }
      if (run.numberedHandle !== (displayName !== name)) {
        throw new Error('workflow initial manifest numberedHandle does not match its display name')
      }
      const result = await this.commitRun(catalog, run, ordinals, signal)
      return { run, ...result }
    })
  }

  /**
   * Insert or replace one durable row and evict only the oldest terminal rows
   * needed to satisfy configured count/byte limits.
   * @param run - execution-free row snapshot.
   * @param signal - aborts before the roster commit.
   * @returns rows removed from the durable roster.
   */
  upsert(run: WorkflowRunManifest, signal?: AbortSignal): Promise<WorkflowRunManifestWriteResult> {
    return this.withSessionLock(run.sessionId, async () => {
      signal?.throwIfAborted()
      const catalog = await this.read(run.sessionId, signal)
      const ordinal = displayOrdinal(run.meta.name, run.displayName)
      const ordinals = new Map(catalog.ordinals.map(entry => [entry.name, entry.lastOrdinal]))
      const previousOrdinal = ordinals.get(run.meta.name)
      if (previousOrdinal === undefined) {
        if (ordinals.size >= this.options.maxWorkflowNamesPerSession) {
          throw new Error(`workflow manifest for session "${run.sessionId}" reached its workflow-name limit`)
        }
        ordinals.set(run.meta.name, ordinal)
      } else if (ordinal > previousOrdinal) {
        ordinals.set(run.meta.name, ordinal)
      }
      return await this.commitRun(catalog, run, ordinals, signal)
    })
  }

  /**
   * Remove one execution-free row while retaining its display-name ordinal.
   * The caller must first quiesce any process-owned execution for the row.
   * @param sessionId - owning Session.
   * @param runId - stable logical run id to remove.
   * @param signal - aborts before the roster commit.
   * @returns the removed row, or `undefined` when it was not retained.
   */
  remove(
    sessionId: SessionIdType,
    runId: WorkflowRunManifest['runId'],
    signal?: AbortSignal,
  ): Promise<WorkflowRunManifest | undefined> {
    return this.withSessionLock(sessionId, async () => {
      signal?.throwIfAborted()
      const catalog = await this.read(sessionId, signal)
      const index = catalog.runs.findIndex(run => run.runId === runId)
      if (index < 0) return undefined
      const runs = [...catalog.runs]
      const [removed] = runs.splice(index, 1)
      await this.commit({ ...catalog, runs }, signal)
      return removed
    })
  }

  /**
   * Load one bounded Session roster and atomically terminalize every state that
   * depended on the dead process. All returned rows explicitly lack execution
   * authority, including rows that were already terminal.
   * @param sessionId - exact Session to recover; no directory enumeration occurs.
   * @param signal - aborts before a required Interrupted commit.
   * @returns retained rows ordered oldest first.
   */
  recoverSession(sessionId: SessionIdType, signal?: AbortSignal): Promise<readonly RecoveredWorkflowRunManifest[]> {
    return this.withSessionLock(sessionId, async () => {
      const catalog = await this.read(sessionId, signal)
      const recoveredAt = Date.now()
      const runs = catalog.runs.map(run => interrupt(run, recoveredAt))
      if (runs.some((run, index) => run !== catalog.runs[index])) {
        await this.commit({ ...catalog, runs }, signal)
      }
      return runs.map(run => ({ ...run, executionAvailable: false as const }))
    })
  }

  private async read(sessionId: SessionIdType, signal?: AbortSignal): Promise<SessionManifest> {
    const path = this.pathFor(sessionId)
    await this.assertSessionDirectory(path)
    const text = await readBounded(path, this.options.maxManifestBytes, signal)
    if (text === undefined) return { version: MANIFEST_VERSION, sessionId, ordinals: [], runs: [] }
    return decodeManifest(parseJson(text, path), sessionId, this.options, path)
  }

  private async commit(manifest: SessionManifest, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const path = this.pathFor(manifest.sessionId)
    await this.ensureSessionDirectory(path)
    const text = this.render(manifest, path)
    const bytes = Buffer.byteLength(text)
    if (bytes > this.options.maxManifestBytes) {
      throw new ManifestTooLargeError(path, bytes, this.options.maxManifestBytes)
    }
    const recoveryBytes = Buffer.byteLength(this.render({
      ...manifest,
      runs: manifest.runs.map(run => interrupt(run, Date.now())),
    }, path))
    if (recoveryBytes > this.options.maxManifestBytes) {
      throw new ManifestTooLargeError(path, recoveryBytes, this.options.maxManifestBytes)
    }
    signal?.throwIfAborted()
    await writeFileAtomic(path, text, { mode: 0o600, dirMode: 0o700 })
  }

  private allocateDisplayName(
    catalog: SessionManifest,
    name: string,
  ): { readonly displayName: string; readonly ordinals: Map<string, number> } {
    const ordinals = new Map(catalog.ordinals.map(entry => [entry.name, entry.lastOrdinal]))
    if (!ordinals.has(name) && ordinals.size >= this.options.maxWorkflowNamesPerSession) {
      throw new Error(`workflow manifest for session "${catalog.sessionId}" reached its workflow-name limit`)
    }
    let next = (ordinals.get(name) ?? 0) + 1
    for (;;) {
      if (!Number.isSafeInteger(next)) throw new Error(`workflow display ordinal for "${name}" is exhausted`)
      const candidate = next === 1 ? name : `${name}-${next}`
      const collision = [...ordinals].some(([otherName, lastOrdinal]) => {
        try {
          return displayOrdinal(otherName, candidate) <= lastOrdinal
        } catch {
          return false
        }
      })
      if (!collision) break
      next += 1
    }
    ordinals.set(name, next)
    return { displayName: next === 1 ? name : `${name}-${next}`, ordinals }
  }

  private async commitRun(
    catalog: SessionManifest,
    run: WorkflowRunManifest,
    ordinals: ReadonlyMap<string, number>,
    signal?: AbortSignal,
  ): Promise<WorkflowRunManifestWriteResult> {
    const sameDisplay = catalog.runs.find(existing => existing.displayName === run.displayName && existing.runId !== run.runId)
    if (sameDisplay !== undefined) throw new Error(`workflow display name "${run.displayName}" is already retained by another run`)
    const sameDirectory = catalog.runs.find(existing => existing.runDirectory === run.runDirectory && existing.runId !== run.runId)
    if (sameDirectory !== undefined) throw new Error(`workflow run directory "${run.runDirectory}" is already retained by another run`)
    const previous = catalog.runs.find(existing => existing.runId === run.runId)
    if (previous !== undefined && (previous.sessionId !== run.sessionId || previous.displayName !== run.displayName)) {
      throw new Error(`workflow run "${run.runId}" cannot change its owning session or display name`)
    }
    const candidates = [...catalog.runs.filter(existing => existing.runId !== run.runId), run].sort(compareRuns)
    if (candidates.filter(candidate => ACTIVE_STATUSES.has(candidate.status)).length > this.options.maxRetainedRunsPerSession) {
      throw new Error(`workflow manifest for session "${run.sessionId}" has too many active runs to retain safely`)
    }
    const evicted: WorkflowRunManifest[] = []
    while (candidates.length > this.options.maxRetainedRunsPerSession) {
      const index = candidates.findIndex(candidate => TERMINAL_STATUSES.has(candidate.status))
      /* v8 ignore next -- the active-count guard above proves an over-limit candidate set contains a terminal row. */
      if (index < 0) throw new Error(`workflow manifest for session "${run.sessionId}" cannot evict an active run`)
      evicted.push(...candidates.splice(index, 1))
    }
    const nextOrdinals = [...ordinals].map(([ordinalName, lastOrdinal]) => ({ name: ordinalName, lastOrdinal }))
    for (;;) {
      try {
        await this.commit({ ...catalog, ordinals: nextOrdinals, runs: candidates }, signal)
        return { evicted }
      } catch (error) {
        if (!(error instanceof ManifestTooLargeError)) throw error
        const index = candidates.findIndex(candidate => TERMINAL_STATUSES.has(candidate.status))
        if (index < 0) {
          throw new Error(`workflow manifest for session "${run.sessionId}" cannot fit its active runs within the byte limit`, { cause: error })
        }
        evicted.push(...candidates.splice(index, 1))
      }
    }
  }

  private render(manifest: SessionManifest, path: string): string {
    const materialized = JSON.parse(JSON.stringify(manifest)) as unknown
    const normalized = decodeManifest(materialized, manifest.sessionId, this.options, path)
    return `${JSON.stringify(normalized, null, 2)}\n`
  }

  private pathFor(sessionId: SessionIdType): string {
    const value = String(sessionId)
    if (value.length === 0 || value.length > OPAQUE_ID_MAX_LENGTH) {
      throw new Error(`workflow manifest session id must contain 1-${OPAQUE_ID_MAX_LENGTH} characters`)
    }
    const digest = createHash('sha256').update(value).digest('hex')
    return join(this.sessionsRoot, digest, MANIFEST_FILENAME)
  }

  private async assertSessionDirectory(path: string): Promise<void> {
    await this.assertOwnedDirectory(this.sessionsRoot)
    await this.assertOwnedDirectory(join(path, '..'))
  }

  private async assertOwnedDirectory(directory: string): Promise<void> {
    try {
      const info = await lstat(directory)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`workflow manifest path "${directory}" is not an owned directory`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async ensureSessionDirectory(path: string): Promise<void> {
    const directory = join(path, '..')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await this.assertOwnedDirectory(this.sessionsRoot)
    await this.assertOwnedDirectory(directory)
  }

  private async withSessionLock<T>(sessionId: SessionIdType, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(sessionId) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(sessionId, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(sessionId) === tail) this.locks.delete(sessionId)
    }
  }
}

/** Internal signal that byte retention may retry after evicting a terminal row. */
class ManifestTooLargeError extends Error {
  constructor(path: string, actual: number, limit: number) {
    super(`workflow run manifest "${path}" is ${actual} bytes; limit is ${limit}`)
  }
}
