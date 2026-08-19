/**
 * The host⇄worker wire protocol: one string-valued enum of message tags per direction, a
 * payload map giving each tag its parameters (the single source of truth), and the message
 * unions derived from them. Payloads are plain JSON by construction for structured clone. Both
 * directions are closed engine protocols. The host runtime-decodes the worker direction before
 * dispatch; generic typed senders make tag/payload mismatches compile-time errors rather than
 * silently skipped messages.
 * @module @deepseek-ai/dsh-workflow-worker-thread/protocol
 */

import { Buffer } from 'node:buffer'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-session'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowErrorCode,
  WorkflowGateInfo,
  WorkflowJournalEntry,
  WorkflowResult,
} from '@deepseek-ai/dsh-workflow'
import type { ChildResult, ChildStartRequest } from './types.ts'

/** Message tags the worker sends the host (the wire values are the tag strings). */
export enum WorkerToHostType {
  /** The startup handshake: the session is listening and awaits {@link HostToWorkerType.Go}. */
  Ready = 'ready',
  /** Observer narration: a `phase(title)` call. */
  Phase = 'phase',
  /** Observer narration: a `log(message)` call. */
  Log = 'log',
  /** Observer lifecycle: one `agent()` call started a child. */
  AgentStart = 'agent-start',
  /** Observer lifecycle: one `agent()` call settled. */
  AgentEnd = 'agent-end',
  /** Observer gate: the script parked on a `pause()`/`await_user()` call. */
  Gate = 'gate',
  /** Journal: one committed host call appended for same-process replay. */
  JournalCommit = 'journal-commit',
  /** Child RPC: start a child on the host (answered by ChildStarted or ChildStartError). */
  ChildStart = 'child-start',
  /** Child RPC: dispose a started child (answered by ChildDisposed). */
  ChildDispose = 'child-dispose',
  /** Scratch RPC: write one single-component scratch file (answered by ScratchWritten). */
  ScratchWrite = 'scratch-write',
  /** Scratch RPC: read one single-component scratch file (answered by ScratchReadResult). */
  ScratchRead = 'scratch-read',
  /** The run's single terminal result. */
  Result = 'result',
}

/** The payload each worker→host tag carries. */
export interface WorkerToHostPayloads {
  /** Ready carries nothing. */
  [WorkerToHostType.Ready]: Record<never, never>
  /** The phase title, verbatim. */
  [WorkerToHostType.Phase]: { title: string }
  /** The logged message, verbatim. */
  [WorkerToHostType.Log]: { message: string }
  /** The call's sequence number, label, phase, and child id. */
  [WorkerToHostType.AgentStart]: { info: WorkflowAgentInfo }
  /** The call identity plus its outcome. */
  [WorkerToHostType.AgentEnd]: { info: WorkflowAgentEndInfo }
  /** A parked gate's kind, message, and resumability. */
  [WorkerToHostType.Gate]: { gate: WorkflowGateInfo }
  /** One committed host call (including a result for result-producing calls). */
  [WorkerToHostType.JournalCommit]: { entry: WorkflowJournalEntry }
  /** The RPC correlation id and the prompt plus validated options. */
  [WorkerToHostType.ChildStart]: { callId: number; request: ChildStartRequest }
  /** The RPC correlation id of the child to dispose. */
  [WorkerToHostType.ChildDispose]: { callId: number }
  /** The RPC correlation id, file name, and content to write. */
  [WorkerToHostType.ScratchWrite]: { callId: number; name: string; content: string }
  /** The RPC correlation id and file name to read. */
  [WorkerToHostType.ScratchRead]: { callId: number; name: string }
  /** The run's terminal outcome. */
  [WorkerToHostType.Result]: { result: WorkflowResult }
}

/** Message tags the host sends the worker (the wire values are the tag strings). */
export enum HostToWorkerType {
  /** Releases the startup gate: run the script body. */
  Go = 'go',
  /** Cancel the run: hooks start throwing and the script dies at its next await. */
  Cancel = 'cancel',
  /** Resume a parked gate: `await_user` returns, `pause` re-fires. */
  Resume = 'resume',
  /** Child RPC reply: the provider fulfilled with a published run (exactly one start reply per ChildStart). */
  ChildStarted = 'child-started',
  /** Child RPC reply: the provider's asynchronous start failed. */
  ChildStartError = 'child-start-error',
  /** Child RPC: a started child's result RESOLVED (its JSON projection). */
  ChildSettled = 'child-settled',
  /** Child RPC: a started child's result REJECTED (an infrastructure fault, rendered). */
  ChildFailed = 'child-failed',
  /** Child RPC reply: a requested disposal completed. */
  ChildDisposed = 'child-disposed',
  /** Scratch RPC reply: a write completed. */
  ScratchWritten = 'scratch-written',
  /** Scratch RPC reply: a read completed with content, or undefined when absent. */
  ScratchReadResult = 'scratch-read-result',
}

/** The payload each host→worker tag carries. */
export interface HostToWorkerPayloads {
  /** Go carries nothing. */
  [HostToWorkerType.Go]: Record<never, never>
  /** The cancel reason, canonical for the whole run. */
  [HostToWorkerType.Cancel]: { reason: string }
  /** Resume carries nothing: release the parked gate. */
  [HostToWorkerType.Resume]: Record<never, never>
  /** The RPC correlation id and the child agent's id (minted by the subagent seam). */
  [HostToWorkerType.ChildStarted]: { callId: number; childId: string }
  /** The RPC correlation id and the rendered start failure. */
  [HostToWorkerType.ChildStartError]: { callId: number; rendered: string }
  /** The RPC correlation id and the child's terminal result projection. */
  [HostToWorkerType.ChildSettled]: { callId: number; result: ChildResult }
  /** The RPC correlation id and the rendered infrastructure fault. */
  [HostToWorkerType.ChildFailed]: { callId: number; rendered: string }
  /** The RPC correlation id of the completed disposal. */
  [HostToWorkerType.ChildDisposed]: { callId: number }
  /** The RPC correlation id of the completed write. */
  [HostToWorkerType.ScratchWritten]: { callId: number }
  /** The RPC correlation id and read content (absent content = file missing). */
  [HostToWorkerType.ScratchReadResult]: { callId: number; content?: string }
}

/**
 * One worker→host message of tag `T`; unparameterized, the closed union over
 * every tag (a discriminated union — `switch` on `type` narrows).
 */
export type WorkerToHostMessage<T extends WorkerToHostType = WorkerToHostType> =
  { [K in T]: { type: K } & WorkerToHostPayloads[K] }[T]

/**
 * One host→worker message of tag `T`; unparameterized, the closed union over
 * every tag (a discriminated union — `switch` on `type` narrows).
 */
export type HostToWorkerMessage<T extends HostToWorkerType = HostToWorkerType> =
  { [K in T]: { type: K } & HostToWorkerPayloads[K] }[T]

/** A worker message failed the runtime protocol checks at the untrusted thread boundary. */
export class WorkflowProtocolError extends Error {
  constructor(detail: string) {
    super(`invalid workflow worker message: ${detail}`)
    this.name = 'WorkflowProtocolError'
  }
}

/** Convert one JSON snapshot to a record or reject it with a path-qualified diagnostic. */
function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkflowProtocolError(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

/** Reject missing, extra, or inherited wire fields. */
function fields(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new WorkflowProtocolError(`${path}.${key} is required`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new WorkflowProtocolError(`${path}.${key} is not recognized`)
  }
}

function string(value: unknown, path: string, empty = true): string {
  if (typeof value !== 'string' || (!empty && value.length === 0)) {
    throw new WorkflowProtocolError(`${path} must be ${empty ? 'a string' : 'a non-empty string'}`)
  }
  return value
}

function integer(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new WorkflowProtocolError(`${path} must be a safe integer no less than ${minimum}`)
  }
  return value as number
}

function optionalString(value: Record<string, unknown>, key: string, path: string): string | undefined {
  return value[key] === undefined ? undefined : string(value[key], `${path}.${key}`)
}

function agentInfo(value: unknown, path: string): WorkflowAgentInfo {
  const info = record(value, path)
  fields(info, path, ['seq', 'label', 'childId'], ['phase'])
  const phase = optionalString(info, 'phase', path)
  return {
    seq: integer(info.seq, `${path}.seq`, 1),
    label: string(info.label, `${path}.label`),
    ...(phase === undefined ? {} : { phase }),
    childId: string(info.childId, `${path}.childId`, false) as WorkflowAgentInfo['childId'],
  }
}

function agentEndInfo(value: unknown): WorkflowAgentEndInfo {
  const info = record(value, 'message.info')
  fields(info, 'message.info', ['seq', 'label', 'childId', 'outcome'], ['phase'])
  if (info.outcome !== 'completed' && info.outcome !== 'failed' && info.outcome !== 'cancelled') {
    throw new WorkflowProtocolError('message.info.outcome is not recognized')
  }
  const phase = optionalString(info, 'phase', 'message.info')
  return {
    seq: integer(info.seq, 'message.info.seq', 1),
    label: string(info.label, 'message.info.label'),
    ...(phase === undefined ? {} : { phase }),
    childId: string(info.childId, 'message.info.childId', false) as WorkflowAgentInfo['childId'],
    outcome: info.outcome,
  }
}

function gateInfo(value: unknown): WorkflowGateInfo {
  const gate = record(value, 'message.gate')
  fields(gate, 'message.gate', ['kind', 'message', 'resumable'])
  if (gate.kind !== 'user'
    && gate.kind !== 'back_off'
    && gate.kind !== 'no_progress'
    && gate.kind !== 'verification'
    && gate.kind !== 'infra') {
    throw new WorkflowProtocolError('message.gate.kind is not recognized')
  }
  if (typeof gate.resumable !== 'boolean') {
    throw new WorkflowProtocolError('message.gate.resumable must be a boolean')
  }
  return { kind: gate.kind, message: string(gate.message, 'message.gate.message'), resumable: gate.resumable }
}

function childStartRequest(value: unknown): ChildStartRequest {
  const request = record(value, 'message.request')
  fields(request, 'message.request', ['prompt'], ['schema', 'provider', 'model'])
  const schema = request.schema
  if (schema !== undefined) {
    try {
      assertObjectJsonSchema(schema)
    } catch (error: unknown) {
      throw new WorkflowProtocolError(`message.request.schema is unsupported: ${String(error)}`)
    }
  }
  const provider = optionalString(request, 'provider', 'message.request')
  const model = optionalString(request, 'model', 'message.request')
  return {
    prompt: string(request.prompt, 'message.request.prompt', false),
    ...(schema === undefined ? {} : { schema }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

function workflowResult(value: unknown): WorkflowResult {
  const result = record(value, 'message.result')
  fields(result, 'message.result', ['value', 'stopReason', 'agentsStarted'], ['error', 'errorCode'])
  if (result.stopReason !== 'completed' && result.stopReason !== 'cancelled' && result.stopReason !== 'error') {
    throw new WorkflowProtocolError('message.result.stopReason is not recognized')
  }
  const error = optionalString(result, 'error', 'message.result')
  const errorCode = result.errorCode === undefined
    ? undefined
    : workflowErrorCode(result.errorCode, 'message.result.errorCode')
  if (result.stopReason === 'completed' && (error !== undefined || errorCode !== undefined)) {
    throw new WorkflowProtocolError('message.result.error and errorCode are forbidden for a completed result')
  }
  if (result.stopReason !== 'completed' && error === undefined) {
    throw new WorkflowProtocolError('message.result.error is required for a non-completed result')
  }
  return {
    value: result.value as WorkflowResult['value'],
    stopReason: result.stopReason,
    ...(error === undefined ? {} : { error }),
    ...(errorCode === undefined ? {} : { errorCode }),
    agentsStarted: integer(result.agentsStarted, 'message.result.agentsStarted', 0),
  }
}

/** Compile-time-exhaustive runtime table for the seam's closed failure taxonomy. */
const WORKFLOW_ERROR_CODES: { readonly [K in WorkflowErrorCode]: K } = {
  SCRIPT_PARSE: 'SCRIPT_PARSE',
  META_INVALID: 'META_INVALID',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  UNSUPPORTED_OPTION: 'UNSUPPORTED_OPTION',
  UNSUPPORTED_SCHEMA: 'UNSUPPORTED_SCHEMA',
  AGENT_CAP: 'AGENT_CAP',
  ITEM_CAP: 'ITEM_CAP',
  AGENT_START: 'AGENT_START',
  AGENT_RESULT: 'AGENT_RESULT',
  JOURNAL_DIVERGENCE: 'JOURNAL_DIVERGENCE',
  RESULT_UNSERIALIZABLE: 'RESULT_UNSERIALIZABLE',
  CANCELLED: 'CANCELLED',
}

/** Decode one machine-routable workflow failure code. */
function workflowErrorCode(value: unknown, path: string): WorkflowErrorCode {
  if (typeof value !== 'string' || !Object.hasOwn(WORKFLOW_ERROR_CODES, value)) {
    throw new WorkflowProtocolError(`${path} is not recognized`)
  }
  return WORKFLOW_ERROR_CODES[value as WorkflowErrorCode]
}

function journalEntry(value: unknown): WorkflowJournalEntry {
  const entry = record(value, 'message.entry')
  const kind = string(entry.kind, 'message.entry.kind', false)
  const fingerprint = string(entry.fingerprint, 'message.entry.fingerprint', false)
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new WorkflowProtocolError('message.entry.fingerprint must be a lowercase SHA-256 digest')
  }
  const base = {
    ordinal: integer(entry.ordinal, 'message.entry.ordinal', 1),
    callId: string(entry.callId, 'message.entry.callId', false),
    fingerprint,
  }
  switch (kind) {
    case 'agent':
      fields(entry, 'message.entry', ['kind', 'ordinal', 'callId', 'fingerprint', 'seq', 'result'])
      return { ...base, kind, seq: integer(entry.seq, 'message.entry.seq', 1), result: entry.result as JsonValue }
    case 'phase':
      fields(entry, 'message.entry', ['kind', 'ordinal', 'callId', 'fingerprint', 'title'])
      return { ...base, kind, title: string(entry.title, 'message.entry.title', false) }
    case 'log':
      fields(entry, 'message.entry', ['kind', 'ordinal', 'callId', 'fingerprint', 'message'])
      return { ...base, kind, message: string(entry.message, 'message.entry.message') }
    case 'scratch-write':
    case 'await-user':
      fields(entry, 'message.entry', ['kind', 'ordinal', 'callId', 'fingerprint'])
      return { ...base, kind }
    case 'scratch-read': {
      fields(entry, 'message.entry', ['kind', 'ordinal', 'callId', 'fingerprint'], ['content'])
      const content = optionalString(entry, 'content', 'message.entry')
      return { ...base, kind, ...(content === undefined ? {} : { content }) }
    }
    default:
      throw new WorkflowProtocolError('message.entry.kind is not recognized')
  }
}

/**
 * Decode and detach one worker→host message before any observer, filesystem,
 * or subagent side effect. The worker is model-script controlled after a VM
 * escape, so TypeScript's protocol union is not evidence at this boundary.
 * @param value - raw structured-clone payload received from the Worker.
 * @param maxBytes - maximum UTF-8 JSON size accepted for one frame.
 * @returns a detached, strictly validated protocol message.
 */
export function decodeWorkerToHostMessage(value: unknown, maxBytes = Number.MAX_SAFE_INTEGER): WorkerToHostMessage {
  let detached: unknown
  try {
    detached = snapshotJsonValue(value)
  } catch (error: unknown) {
    throw new WorkflowProtocolError(`message could not be read as JSON data: ${String(error)}`)
  }
  if (detached === undefined) throw new WorkflowProtocolError('message must be lossless JSON data')
  const encoded = JSON.stringify(detached)
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new WorkflowProtocolError(`message exceeds the ${maxBytes}-byte protocol limit`)
  }
  const message = record(detached, 'message')
  // The exhaustive switch below validates membership before this asserted enum leaves the decoder.
  const type = string(message.type, 'message.type', false) as WorkerToHostType
  switch (type) {
    case WorkerToHostType.Ready:
      fields(message, 'message', ['type'])
      return { type }
    case WorkerToHostType.Phase:
      fields(message, 'message', ['type', 'title'])
      return { type, title: string(message.title, 'message.title', false) }
    case WorkerToHostType.Log:
      fields(message, 'message', ['type', 'message'])
      return { type, message: string(message.message, 'message.message') }
    case WorkerToHostType.AgentStart:
      fields(message, 'message', ['type', 'info'])
      return { type, info: agentInfo(message.info, 'message.info') }
    case WorkerToHostType.AgentEnd:
      fields(message, 'message', ['type', 'info'])
      return { type, info: agentEndInfo(message.info) }
    case WorkerToHostType.Gate:
      fields(message, 'message', ['type', 'gate'])
      return { type, gate: gateInfo(message.gate) }
    case WorkerToHostType.JournalCommit:
      fields(message, 'message', ['type', 'entry'])
      return { type, entry: journalEntry(message.entry) }
    case WorkerToHostType.ChildStart:
      fields(message, 'message', ['type', 'callId', 'request'])
      return { type, callId: integer(message.callId, 'message.callId', 1), request: childStartRequest(message.request) }
    case WorkerToHostType.ChildDispose:
      fields(message, 'message', ['type', 'callId'])
      return { type, callId: integer(message.callId, 'message.callId', 1) }
    case WorkerToHostType.ScratchWrite:
      fields(message, 'message', ['type', 'callId', 'name', 'content'])
      return {
        type,
        callId: integer(message.callId, 'message.callId', 1),
        name: string(message.name, 'message.name', false),
        content: string(message.content, 'message.content'),
      }
    case WorkerToHostType.ScratchRead:
      fields(message, 'message', ['type', 'callId', 'name'])
      return {
        type,
        callId: integer(message.callId, 'message.callId', 1),
        name: string(message.name, 'message.name', false),
      }
    case WorkerToHostType.Result:
      fields(message, 'message', ['type', 'result'])
      return { type, result: workflowResult(message.result) }
    default:
      throw new WorkflowProtocolError(`message.type ${JSON.stringify(type)} is not recognized`)
  }
}
