import { appendFile, chmod, mkdir, open, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SupervisedWorkflowRunId,
  WorkflowMemberId,
  WorkflowRunStatus,
} from '../src/types.ts'
import {
  WorkflowRunManifestStore,
  type WorkflowRunManifest,
  type WorkflowRunManifestStoreOptions,
} from '../src/manifest-store.ts'

const SESSION = SessionId('session-one')

function options(root: string, overrides: Partial<WorkflowRunManifestStoreOptions> = {}): WorkflowRunManifestStoreOptions {
  return {
    runsRoot: root,
    maxRetainedRunsPerSession: 4,
    maxWorkflowNamesPerSession: 4,
    maxMembersPerRun: 4,
    maxRetainedLogLinesPerRun: 4,
    maxRetainedLogLineBytes: 1_024,
    maxRetainedArtifactsPerRun: 4,
    maxRetainedArtifactNameBytes: 255,
    maxRetainedGateKindBytes: 64,
    maxRetainedGateMessageBytes: 1_024,
    maxRetainedErrorBytes: 1_024,
    maxTerminalResultBytes: 4_096,
    maxManifestBytes: 64 * 1024,
    ...overrides,
  }
}

function run(
  runId: string,
  displayName = 'audit',
  status: WorkflowRunStatus = 'running',
  overrides: Partial<WorkflowRunManifest> = {},
): WorkflowRunManifest {
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
  return {
    runId: runId as SupervisedWorkflowRunId,
    sessionId: SESSION,
    displayName,
    meta: { name: displayName.replace(/-[2-9][0-9]*$/u, ''), description: 'Audit the workspace' },
    status,
    budget: { total: 8, spent: 1 },
    members: [{
      memberId: `${runId}:member:1` as WorkflowMemberId,
      seq: 1,
      label: 'reviewer',
      status: terminal ? 'completed' : 'running',
      childSessionId: SessionId(`${runId}:child`),
      startedAt: 10,
      ...terminal ? { settledAt: 20 } : {},
      hadCommittedOutcome: terminal,
    }],
    builtin: false,
    numberedHandle: displayName !== displayName.replace(/-[2-9][0-9]*$/u, ''),
    runDirectory: runId,
    startedAt: Number(runId.replace(/\D/gu, '')) || 1,
    ...terminal ? { settledAt: 20 } : {},
    ...status === 'completed'
      ? {
        stopReason: 'completed' as const,
        result: {
          state: 'available' as const,
          content: { kind: 'json' as const, text: 'null' },
          totalBytes: 4,
          truncated: false as const,
        },
      }
      : status === 'failed'
        ? { stopReason: 'error' as const, result: { state: 'not-produced' as const } }
        : status === 'cancelled'
          ? { stopReason: 'cancelled' as const, result: { state: 'not-produced' as const } }
          : status === 'interrupted'
            ? { stopReason: 'interrupted' as const, result: { state: 'not-produced' as const } }
            : { result: { state: 'pending' as const } },
    logs: { total: 0, retained: [], revision: 1 },
    ...status === 'needs-input' ? {
      gate: {
        kind: 'user',
        message: { text: 'Continue?', totalBytes: 9, truncated: false },
        interrupted: false,
      },
    } : {},
    artifacts: { total: 0, retained: [], revision: 1 },
    revision: 1,
    ...overrides,
  }
}

function manifestPath(root: string, sessionId = SESSION): string {
  const digest = createHash('sha256').update(String(sessionId)).digest('hex')
  return join(root, 'sessions', digest, 'manifest.json')
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-workflow-manifests-'))
}

type MutableRecord = Record<string, unknown>

function record(value: unknown): MutableRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('fixture value is not an object')
  }
  return value as MutableRecord
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('fixture value is not an array')
  return value
}

function durableDocument(manifest: WorkflowRunManifest): MutableRecord {
  const cloned = JSON.parse(JSON.stringify(manifest)) as WorkflowRunManifest
  return {
    version: 2,
    sessionId: String(SESSION),
    ordinals: [{ name: cloned.meta.name, lastOrdinal: cloned.numberedHandle ? 2 : 1 }],
    runs: [cloned],
  }
}

async function expectCorrupt(
  manifest: WorkflowRunManifest,
  mutate: (document: MutableRecord) => void,
  expected: RegExp,
  overrides: Partial<WorkflowRunManifestStoreOptions> = {},
): Promise<void> {
  const root = await tempRoot()
  const document = durableDocument(manifest)
  mutate(document)
  const path = manifestPath(root)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(document), 'utf8')
  await expect(new WorkflowRunManifestStore(options(root, overrides)).recoverSession(SESSION))
    .rejects.toThrow(expected)
}

describe('WorkflowRunManifestStore', () => {
  it('persists never-reused display ordinals across concurrent reservations and restart', async () => {
    const root = await tempRoot()
    const first = new WorkflowRunManifestStore(options(root))
    expect(await first.reserveDisplayName(SESSION, 'audit')).toBe('audit')
    expect(await Promise.all([
      first.reserveDisplayName(SESSION, 'audit'),
      first.reserveDisplayName(SESSION, 'audit'),
    ])).toEqual(['audit-2', 'audit-3'])
    const restarted = new WorkflowRunManifestStore(options(root))
    expect(await restarted.reserveDisplayName(SESSION, 'audit')).toBe('audit-4')
    expect(() => restarted.reserveDisplayName(SESSION, 'pause')).toThrow(/invalid workflow name/)
  })

  it('recovers every process-owned state as terminal Interrupted and retains terminal history', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    try {
      const root = await tempRoot()
      const store = new WorkflowRunManifestStore(options(root))
      const statuses: WorkflowRunStatus[] = ['running', 'pausing', 'stopping', 'needs-input']
      for (const [index, status] of statuses.entries()) {
        await store.upsert(run(`run-${index + 1}`, `audit-${index + 2}`, status, {
          meta: { name: 'audit', description: 'Audit the workspace' },
          numberedHandle: true,
        }))
      }
      const larger = new WorkflowRunManifestStore(options(root, { maxRetainedRunsPerSession: 8 }))
      await larger.upsert(run('run-5', 'audit-6', 'paused', {
        meta: { name: 'audit', description: 'Audit the workspace' }, numberedHandle: true,
      }))
      await larger.upsert(run('run-6', 'audit-7', 'budget-limited', {
        meta: { name: 'audit', description: 'Audit the workspace' }, numberedHandle: true,
      }))
      await larger.upsert(run('run-7', 'audit-8', 'completed', {
        meta: { name: 'audit', description: 'Audit the workspace' }, numberedHandle: true,
      }))

      const recovered = await new WorkflowRunManifestStore(options(root, {
        maxRetainedRunsPerSession: 8,
      })).recoverSession(SESSION)
      expect(recovered.map(item => item.status)).toEqual([
        'interrupted', 'interrupted', 'interrupted', 'interrupted',
        'interrupted', 'interrupted', 'completed',
      ])
      expect(recovered.every(item => !item.executionAvailable)).toBe(true)
      expect(recovered.slice(0, 6).every(item => item.settledAt === 100)).toBe(true)
      expect(recovered[0]?.members[0]).toMatchObject({ status: 'cancelled', settledAt: 100 })
      expect(recovered[6]?.members[0]?.status).toBe('completed')
      expect((await new WorkflowRunManifestStore(options(root, {
        maxRetainedRunsPerSession: 8,
      })).recoverSession(SESSION)).map(item => item.revision)).toEqual([2, 2, 2, 2, 2, 2, 1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('evicts oldest terminal rows while preserving active rows and durable ordinals', async () => {
    const root = await tempRoot()
    const store = new WorkflowRunManifestStore(options(root, { maxRetainedRunsPerSession: 2 }))
    await store.upsert(run('run-1', 'audit', 'running'))
    await store.upsert(run('run-2', 'audit-2', 'completed'))
    const { evicted } = await store.upsert(run('run-3', 'audit-3', 'completed'))
    expect(evicted.map(item => item.runId)).toEqual(['run-2'])
    expect((await store.recoverSession(SESSION)).map(item => item.runId)).toEqual(['run-1', 'run-3'])
    expect(await store.reserveDisplayName(SESSION, 'audit')).toBe('audit-4')
  })

  it('rejects collisions, active overflow, invalid configuration, and cancellation', async () => {
    const root = await tempRoot()
    expect(() => new WorkflowRunManifestStore(options(root, { maxMembersPerRun: 0 }))).toThrow(/positive safe integer/)
    const store = new WorkflowRunManifestStore(options(root, { maxRetainedRunsPerSession: 1 }))
    await store.upsert(run('run-1'))
    await expect(store.upsert(run('run-2', 'audit-2'))).rejects.toThrow(/too many active runs/)
    await expect(store.upsert(run('other', 'audit'))).rejects.toThrow(/already retained/)
    await expect(store.upsert(run('run-1', 'other', 'running', {
      meta: { name: 'other', description: 'other' },
    }))).rejects.toThrow(/cannot change/)
    await expect(store.reserveDisplayName(SESSION, 'other', AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    await expect(store.recoverSession(SessionId(''), undefined)).rejects.toThrow(/session id/)
  })

  it('fails loud for truncated, oversized, symlinked, and cross-session durable files', async () => {
    const root = await tempRoot()
    const store = new WorkflowRunManifestStore(options(root, { maxManifestBytes: 1024 }))
    const path = manifestPath(root)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '{', 'utf8')
    await expect(store.recoverSession(SESSION)).rejects.toThrow(/not valid JSON/)

    await writeFile(path, Buffer.from([0xff]))
    await expect(store.recoverSession(SESSION)).rejects.toThrow(/not valid UTF-8/)

    await writeFile(path, 'x'.repeat(1025), 'utf8')
    await expect(store.recoverSession(SESSION)).rejects.toThrow(/exceeds the 1024-byte limit/)

    await writeFile(path, JSON.stringify({ version: 2, sessionId: 'other', ordinals: [], runs: [] }), 'utf8')
    await expect(store.recoverSession(SESSION)).rejects.toThrow(/sessionId does not match/)

    const target = join(root, 'outside.json')
    await writeFile(target, '{}', 'utf8')
    await writeFile(path, '{}', 'utf8')
    await chmod(path, 0o600)
    await unlink(path)
    await symlink(target, path)
    await expect(store.recoverSession(SESSION)).rejects.toThrow()
  })

  it('rejects malformed rows and never publishes an over-limit active roster', async () => {
    const root = await tempRoot()
    const roomy = new WorkflowRunManifestStore(options(root))
    await roomy.reserveDisplayName(SESSION, 'audit')
    await roomy.upsert(run('run-1'))
    const path = manifestPath(root)
    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      runs: Array<Record<string, unknown>>
    }
    stored.runs[0]!.budget = { total: 1, spent: 2 }
    await writeFile(path, JSON.stringify(stored), 'utf8')
    await expect(roomy.recoverSession(SESSION)).rejects.toThrow(/spent exceeds total/)

    const smallRoot = await tempRoot()
    const small = new WorkflowRunManifestStore(options(smallRoot, { maxManifestBytes: 800 }))
    await expect(small.upsert(run('run-2', 'audit', 'running', {
      meta: { name: 'audit', description: 'x'.repeat(2_000) },
    }))).rejects.toThrow(/cannot fit its active runs/)
  })

  it('rejects every inconsistent retained text, log, result, gate, artifact, and member field', async () => {
    const completedRun = run('run-1', 'audit', 'completed', {
      members: [{
        memberId: 'member-1' as WorkflowMemberId,
        seq: 1,
        label: 'reviewer',
        phase: 'review',
        status: 'completed',
        childSessionId: SessionId('child-1'),
        startedAt: 1,
        settledAt: 2,
        hadCommittedOutcome: true,
      }],
      logs: {
        total: 1,
        retained: [{ index: 0, text: 'line', totalBytes: 4, truncated: false }],
        revision: 1,
      },
      artifacts: { total: 1, retained: [{ name: 'report.txt', bytes: 4 }], revision: 1 },
      error: 'bounded',
    })
    const runRecord = (document: MutableRecord): MutableRecord => record(array(document.runs)[0])
    const member = (document: MutableRecord): MutableRecord => record(array(runRecord(document).members)[0])
    const logs = (document: MutableRecord): MutableRecord => record(runRecord(document).logs)
    const log = (document: MutableRecord): MutableRecord => record(array(logs(document).retained)[0])
    const result = (document: MutableRecord): MutableRecord => record(runRecord(document).result)
    const content = (document: MutableRecord): MutableRecord => record(result(document).content)
    const artifacts = (document: MutableRecord): MutableRecord => record(runRecord(document).artifacts)
    const artifact = (document: MutableRecord): MutableRecord => record(array(artifacts(document).retained)[0])

    await expectCorrupt(completedRun, (document) => { document.extra = true }, /unknown field/)
    await expectCorrupt(completedRun, (document) => { logs(document).retained = {} }, /retained must be an array/)
    await expectCorrupt(completedRun, (document) => {
      logs(document).retained = Array.from({ length: 5 }, (_, index) => ({
        index, text: '', totalBytes: 0, truncated: false,
      }))
      logs(document).total = 5
    }, /line limit/)
    await expectCorrupt(completedRun, (document) => { logs(document).total = 0 }, /retained exceeds total/)
    await expectCorrupt(completedRun, (document) => { log(document).index = 1 }, /contiguous tail/)
    await expectCorrupt(completedRun, (document) => { log(document).text = 'x'.repeat(5) }, /text exceeds/, {
      maxRetainedLogLineBytes: 4,
    })
    await expectCorrupt(completedRun, (document) => { log(document).totalBytes = 5 }, /truncated does not match/)
    await expectCorrupt(completedRun, (document) => { content(document).kind = 'unknown' }, /kind is not recognized/)
    await expectCorrupt(completedRun, (document) => { content(document).text = 'x'.repeat(5) }, /content.text exceeds/, {
      maxTerminalResultBytes: 4,
    })
    await expectCorrupt(completedRun, (document) => { result(document).truncated = true }, /metadata disagree/)
    await expectCorrupt(completedRun, (document) => {
      content(document).text = '{'
      result(document).totalBytes = 1
    }, /not valid JSON/)
    await expectCorrupt(completedRun, (document) => { artifacts(document).retained = {} }, /retained must be an array/)
    await expectCorrupt(completedRun, (document) => {
      artifacts(document).retained = Array.from({ length: 5 }, (_, index) => ({ name: `a${index}`, bytes: 0 }))
      artifacts(document).total = 5
    }, /artifact limit/)
    await expectCorrupt(completedRun, (document) => { artifacts(document).total = 0 }, /retained exceeds total/)
    await expectCorrupt(completedRun, (document) => { artifact(document).name = '../bad' }, /one bounded path component/)
    await expectCorrupt(completedRun, (document) => {
      artifacts(document).retained = [{ name: 'same', bytes: 1 }, { name: 'same', bytes: 2 }]
      artifacts(document).total = 2
    }, /duplicate artifact names/)
    await expectCorrupt(completedRun, (document) => { member(document).memberId = 'x'.repeat(257) }, /memberId is too long/)
    await expectCorrupt(completedRun, (document) => { member(document).status = 'unknown' }, /status is not recognized/)
    await expectCorrupt(completedRun, (document) => { delete member(document).childSessionId }, /childSessionId must be a non-empty string/)
    await expectCorrupt(completedRun, (document) => { member(document).childSessionId = '' }, /childSessionId must be a non-empty string/)
    await expectCorrupt(completedRun, (document) => { member(document).hadCommittedOutcome = 'yes' }, /must be a boolean/)
    await expectCorrupt(completedRun, (document) => { member(document).seq = 0 }, /safe integer >= 1/)

    const gated = run('run-1', 'audit', 'needs-input')
    await expectCorrupt(gated, (document) => {
      record(runRecord(document).gate).kind = 'x'.repeat(65)
    }, /kind exceeds/)
    await expectCorrupt(gated, (document) => {
      record(record(runRecord(document).gate).message).text = 'x'.repeat(5)
    }, /text exceeds/, { maxRetainedGateMessageBytes: 4 })
    await expectCorrupt(gated, (document) => {
      record(record(runRecord(document).gate).message).truncated = true
    }, /truncated does not match/)
  })

  it('rejects inconsistent run lifecycle, identity, roster, and ordinal fields', async () => {
    const completedRun = run('run-1', 'audit', 'completed')
    const runRecord = (document: MutableRecord): MutableRecord => record(array(document.runs)[0])
    const ordinal = (document: MutableRecord): MutableRecord => record(array(document.ordinals)[0])

    await expectCorrupt(completedRun, (document) => { document.version = 1 }, /unsupported version/)
    await expectCorrupt(completedRun, (document) => { document.ordinals = {} }, /ordinals must be an array/)
    await expectCorrupt(completedRun, (document) => {
      document.ordinals = Array.from({ length: 5 }, (_, index) => ({ name: `name-${index}`, lastOrdinal: 1 }))
    }, /ordinals exceeds/)
    await expectCorrupt(completedRun, (document) => { ordinal(document).name = 'Invalid Name' }, /not a workflow name/)
    await expectCorrupt(completedRun, (document) => {
      document.ordinals = [{ name: 'audit', lastOrdinal: 1 }, { name: 'audit', lastOrdinal: 2 }]
    }, /duplicate names/)
    await expectCorrupt(completedRun, (document) => { document.runs = {} }, /runs must be an array/)
    await expectCorrupt(completedRun, (document) => {
      document.runs = Array.from({ length: 5 }, (_, index) => run(`run-${index + 1}`, `audit-${index + 2}`, 'completed', {
        meta: { name: 'audit', description: 'audit' }, numberedHandle: true,
      }))
    }, /runs exceeds/)
    await expectCorrupt(completedRun, (document) => { runRecord(document).runId = 'x'.repeat(257) }, /runId is too long/)
    await expectCorrupt(completedRun, (document) => { runRecord(document).sessionId = 'other' }, /owning session/)
    await expectCorrupt(completedRun, (document) => { runRecord(document).status = 'unknown' }, /status is not recognized/)
    await expectCorrupt(completedRun, (document) => { runRecord(document).meta = { name: 'Bad Name' } }, /meta is invalid/)
    await expectCorrupt(completedRun, (document) => {
      runRecord(document).members = Array.from({ length: 5 }, (_, index) => ({
        memberId: `m${index}`, seq: index + 1, label: '', status: 'completed', hadCommittedOutcome: false,
      }))
    }, /members exceeds/)
    await expectCorrupt(completedRun, (document) => {
      const members = array(runRecord(document).members)
      members.push({ ...record(members[0]), seq: 2 })
    }, /duplicate memberId/)
    await expectCorrupt(completedRun, (document) => {
      const members = array(runRecord(document).members)
      members.push({ ...record(members[0]), memberId: 'different' })
    }, /duplicate seq/)
    await expectCorrupt(completedRun, (document) => { runRecord(document).runDirectory = '../bad' }, /safe path component/)
    await expectCorrupt(completedRun, (document) => { delete runRecord(document).settledAt }, /settledAt is required/)
    await expectCorrupt(run('run-1'), (document) => { runRecord(document).settledAt = 2 }, /settledAt is forbidden/)
    await expectCorrupt(completedRun, (document) => { runRecord(document).stopReason = 'error' }, /does not match status/)
    await expectCorrupt(run('run-1'), (document) => { runRecord(document).result = { state: 'not-produced' } }, /must be pending/)
    await expectCorrupt(completedRun, (document) => { runRecord(document).result = { state: 'pending' } }, /cannot be pending/)
    await expectCorrupt(run('run-1', 'audit', 'failed'), (document) => {
      runRecord(document).result = {
        state: 'available', content: { kind: 'json', text: 'null' }, totalBytes: 4, truncated: false,
      }
    }, /available only for a completed/)
    await expectCorrupt(run('run-1', 'audit', 'interrupted', {
      gate: { kind: 'user', message: { text: 'x', totalBytes: 1, truncated: false }, interrupted: true },
    }), (document) => { record(runRecord(document).gate).interrupted = false }, /must be marked interrupted/)
    await expectCorrupt(run('run-1', 'audit', 'needs-input'), (document) => {
      record(runRecord(document).gate).interrupted = true
    }, /cannot be interrupted/)
    await expectCorrupt(completedRun, (document) => {
      runRecord(document).gate = { kind: 'user', message: { text: 'x', totalBytes: 1, truncated: false }, interrupted: false }
    }, /gate is forbidden/)
    await expectCorrupt(run('run-1', 'audit', 'needs-input'), (document) => { delete runRecord(document).gate }, /gate is required/)
    await expectCorrupt(completedRun, (document) => { runRecord(document).displayName = 'other' }, /displayName is invalid/)
    await expectCorrupt(completedRun, (document) => { runRecord(document).numberedHandle = true }, /numberedHandle does not match/)
    await expectCorrupt(completedRun, (document) => { runRecord(document).error = 'xxxxx' }, /error exceeds/, {
      maxRetainedErrorBytes: 4,
    })
    await expectCorrupt(completedRun, (document) => { document.ordinals = [] }, /display ordinal.*not retained/)

    const duplicate = run('run-2', 'audit-2', 'completed', {
      meta: { name: 'audit', description: 'audit' }, numberedHandle: true, runDirectory: 'run-2',
    })
    await expectCorrupt(completedRun, (document) => {
      document.ordinals = [{ name: 'audit', lastOrdinal: 2 }]
      document.runs = [completedRun, { ...duplicate, runId: completedRun.runId }]
    }, /duplicate runId/)
    await expectCorrupt(completedRun, (document) => {
      document.ordinals = [{ name: 'audit', lastOrdinal: 2 }]
      document.runs = [completedRun, { ...duplicate, displayName: 'audit', numberedHandle: false }]
    }, /duplicate displayName/)
    await expectCorrupt(completedRun, (document) => {
      document.ordinals = [{ name: 'audit', lastOrdinal: 2 }]
      document.runs = [completedRun, { ...duplicate, runDirectory: completedRun.runDirectory }]
    }, /duplicate runDirectory/)
  })

  it('covers insertion, removal, byte eviction, ordinal exhaustion, and owned-directory checks', async () => {
    const root = await tempRoot()
    const store = new WorkflowRunManifestStore(options(root, { maxRetainedRunsPerSession: 2 }))
    expect(() => store.insertWithNextDisplayName(SESSION, 'Invalid Name', () => run('x')))
      .toThrow(/invalid workflow name/)
    await expect(store.insertWithNextDisplayName(SESSION, 'audit', displayName => run('x', displayName, 'running', {
      sessionId: SessionId('other'),
    }))).rejects.toThrow(/allocated identity/)
    await expect(store.insertWithNextDisplayName(SESSION, 'audit', displayName => run('x', displayName, 'running', {
      numberedHandle: true,
    }))).rejects.toThrow(/numberedHandle/)

    await store.upsert(run('run-1', 'audit', 'completed'))
    expect(await store.remove(SESSION, 'missing' as never)).toBeUndefined()
    expect((await store.remove(SESSION, 'run-1' as never))?.runId).toBe('run-1')
    expect(await store.remove(SESSION, 'run-1' as never)).toBeUndefined()

    const collisionRoot = await tempRoot()
    const collisions = new WorkflowRunManifestStore(options(collisionRoot))
    await collisions.upsert(run('run-1', 'audit', 'completed'))
    await expect(collisions.upsert(run('run-2', 'audit-2', 'completed', {
      meta: { name: 'audit', description: 'audit' }, numberedHandle: true, runDirectory: 'run-1',
    }))).rejects.toThrow(/run directory.*already retained/)

    const nameRoot = await tempRoot()
    const names = new WorkflowRunManifestStore(options(nameRoot, { maxWorkflowNamesPerSession: 1 }))
    await names.reserveDisplayName(SESSION, 'audit')
    await expect(names.reserveDisplayName(SESSION, 'other')).rejects.toThrow(/workflow-name limit/)

    const exhaustedRoot = await tempRoot()
    const exhaustedPath = manifestPath(exhaustedRoot)
    await mkdir(join(exhaustedPath, '..'), { recursive: true })
    await writeFile(exhaustedPath, JSON.stringify({
      version: 2,
      sessionId: SESSION,
      ordinals: [{ name: 'audit', lastOrdinal: Number.MAX_SAFE_INTEGER }],
      runs: [],
    }), 'utf8')
    await expect(new WorkflowRunManifestStore(options(exhaustedRoot)).reserveDisplayName(SESSION, 'audit'))
      .rejects.toThrow(/ordinal.*exhausted/)

    const linkRoot = await tempRoot()
    const outside = await tempRoot()
    await symlink(outside, join(linkRoot, 'sessions'))
    await expect(new WorkflowRunManifestStore(options(linkRoot)).recoverSession(SESSION))
      .rejects.toThrow(/not an owned directory/)

    const directoryRoot = await tempRoot()
    const directoryPath = manifestPath(directoryRoot)
    await mkdir(directoryPath, { recursive: true })
    await expect(new WorkflowRunManifestStore(options(directoryRoot)).recoverSession(SESSION))
      .rejects.toThrow(/not a regular file|EISDIR/)

    await expectCorrupt(run('run-1', 'audit', 'running', { revision: Number.MAX_SAFE_INTEGER }), () => {}, /exhausted.*revision/)

    const bytesRoot = await tempRoot()
    const terminal = run('run-1', 'audit', 'completed', {
      meta: { name: 'audit', description: 'x'.repeat(800) },
    })
    const roomy = new WorkflowRunManifestStore(options(bytesRoot))
    await roomy.upsert(terminal)
    const currentBytes = Buffer.byteLength(await readFile(manifestPath(bytesRoot), 'utf8'))
    const bounded = new WorkflowRunManifestStore(options(bytesRoot, {
      maxManifestBytes: currentBytes + 500,
      maxRetainedRunsPerSession: 2,
    }))
    const evicted = await bounded.upsert(run('run-2', 'audit-2', 'running', {
      meta: { name: 'audit', description: 'active' }, numberedHandle: true,
    }))
    expect(evicted.evicted.map(item => item.runId)).toEqual(['run-1'])
  })

  it('covers remaining durable decoder variants and allocation failures', async () => {
    const completedRun = run('run-1', 'audit', 'completed')
    const runRecord = (document: MutableRecord): MutableRecord => record(array(document.runs)[0])
    await expectCorrupt(completedRun, (document) => { document.runs = [null] }, /must be an object/)
    await expectCorrupt(completedRun, (document) => { document.sessionId = 1 }, /must be a non-empty string/)
    await expectCorrupt(completedRun, (document) => {
      runRecord(document).logs = {
        total: 1,
        retained: [{ index: 0, text: 1, totalBytes: 0, truncated: false }],
        revision: 1,
      }
    }, /must be a string/)
    await expectCorrupt(completedRun, (document) => { runRecord(document).result = { state: 'unknown' } }, /state is not recognized/)
    await expectCorrupt(completedRun, (document) => { runRecord(document).members = {} }, /members must be an array/)
    await expectCorrupt(completedRun, (document) => { runRecord(document).stopReason = 'unknown' }, /stopReason is not recognized/)
    await expectCorrupt(completedRun, (document) => { runRecord(document).displayName = 'audit-1' }, /displayName is invalid/)
    await expectCorrupt(completedRun, (document) => {
      runRecord(document).displayName = `audit-${'9'.repeat(30)}`
    }, /displayName is invalid/)

    const preview = run('run-1', 'audit', 'completed', {
      result: {
        state: 'available',
        content: { kind: 'preview', text: 'head' },
        totalBytes: 10,
        truncated: true,
      },
      members: [{
        memberId: 'member-1' as WorkflowMemberId,
        seq: 1,
        label: 'done',
        status: 'completed',
        childSessionId: SessionId('preview-child'),
        hadCommittedOutcome: false,
      }],
    })
    const previewRoot = await tempRoot()
    await new WorkflowRunManifestStore(options(previewRoot)).upsert(preview)
    expect((await new WorkflowRunManifestStore(options(previewRoot)).recoverSession(SESSION))[0]?.result)
      .toMatchObject({ content: { kind: 'preview' } })

    const allocationRoot = await tempRoot()
    const allocations = new WorkflowRunManifestStore(options(allocationRoot))
    expect(await allocations.reserveDisplayName(SESSION, 'audit')).toBe('audit')
    expect(await allocations.reserveDisplayName(SESSION, 'audit')).toBe('audit-2')
    expect(await allocations.reserveDisplayName(SESSION, 'audit-2')).toBe('audit-2-2')
    expect(await allocations.reserveDisplayName(SESSION, 'other')).toBe('other')
    await allocations.insertWithNextDisplayName(SESSION, 'saved', displayName => run('saved-1', displayName))
    await expect(allocations.insertWithNextDisplayName(SESSION, 'saved', displayName => run('saved-2', displayName, 'running', {
      meta: { name: 'saved', description: 'saved' },
      numberedHandle: false,
    }))).rejects.toThrow(/numberedHandle/)

    const upsertNamesRoot = await tempRoot()
    const upsertNames = new WorkflowRunManifestStore(options(upsertNamesRoot, { maxWorkflowNamesPerSession: 1 }))
    await upsertNames.upsert(run('run-1', 'audit', 'completed'))
    await expect(upsertNames.upsert(run('run-2', 'other', 'completed', {
      meta: { name: 'other', description: 'other' },
    }))).rejects.toThrow(/workflow-name limit/)

    const orderedRoot = await tempRoot()
    const ordered = new WorkflowRunManifestStore(options(orderedRoot))
    await ordered.upsert(run('run-b', 'audit', 'completed', { startedAt: 1 }))
    await ordered.upsert(run('run-a', 'audit-2', 'completed', {
      meta: { name: 'audit', description: 'audit' }, numberedHandle: true, startedAt: 1,
    }))
    expect((await ordered.recoverSession(SESSION)).map(item => item.runId)).toEqual(['run-a', 'run-b'])

    const invalidStatusRoot = await tempRoot()
    const invalidStatus = new WorkflowRunManifestStore(options(invalidStatusRoot, { maxRetainedRunsPerSession: 1 }))
    await expect(invalidStatus.upsert({
      ...run('run-1', 'audit', 'completed'),
      status: 'unknown' as never,
    })).rejects.toThrow(/status is not recognized/)

    const thrownRoot = await tempRoot()
    const thrown = new WorkflowRunManifestStore(options(thrownRoot))
    const controller = new AbortController()
    const original = controller.signal.throwIfAborted.bind(controller.signal)
    let checks = 0
    Object.defineProperty(controller.signal, 'throwIfAborted', {
      value: () => {
        checks += 1
        if (checks === 3) throw new Error('publication probe failed')
        original()
      },
    })
    await expect(thrown.upsert(run('run-1'), controller.signal)).rejects.toThrow('publication probe failed')

    const variantsRoot = await tempRoot()
    const variants = new WorkflowRunManifestStore(options(variantsRoot))
    await variants.upsert(run('run-1', 'audit', 'cancelled', { phase: 'done' }))
    await variants.upsert(run('run-2', 'audit-2', 'running', {
      meta: { name: 'audit', description: 'audit' },
      numberedHandle: true,
      members: [{
        memberId: 'settled-member' as WorkflowMemberId,
        seq: 1,
        label: 'settled',
        status: 'completed',
        childSessionId: SessionId('settled-child'),
        settledAt: 2,
        hadCommittedOutcome: false,
      }],
    }))
    expect((await variants.recoverSession(SESSION))[1]?.members[0]?.status).toBe('completed')

    const recoveryProbeRoot = await tempRoot()
    const active = run('run-1')
    const recoveryProbe = new WorkflowRunManifestStore(options(recoveryProbeRoot))
    await recoveryProbe.upsert(active)
    const activeBytes = Buffer.byteLength(await readFile(manifestPath(recoveryProbeRoot), 'utf8'))
    await recoveryProbe.recoverSession(SESSION)
    const interruptedBytes = Buffer.byteLength(await readFile(manifestPath(recoveryProbeRoot), 'utf8'))
    expect(interruptedBytes).toBeGreaterThan(activeBytes)
    const recoveryLimitRoot = await tempRoot()
    await expect(new WorkflowRunManifestStore(options(recoveryLimitRoot, {
      maxManifestBytes: Math.floor((activeBytes + interruptedBytes) / 2),
    })).upsert(active)).rejects.toThrow(/cannot fit its active runs/)

    const growthRoot = await tempRoot()
    const growthStore = new WorkflowRunManifestStore(options(growthRoot))
    await growthStore.upsert(run('run-1', 'audit', 'completed'))
    const growthPath = manifestPath(growthRoot)
    const initialBytes = Buffer.byteLength(await readFile(growthPath, 'utf8'))
    const probe = await open(growthPath, 'r')
    const prototype = Object.getPrototypeOf(probe) as { stat: typeof probe.stat }
    await probe.close()
    const nativeStat = prototype.stat
    const grow = vi.spyOn(prototype, 'stat').mockImplementationOnce(async function (
      this: typeof probe,
      options?: Parameters<typeof probe.stat>[0],
    ) {
      const result = await nativeStat.call(this, options as never)
      await appendFile(growthPath, 'xxxxxxxx')
      return result
    })
    await expect(new WorkflowRunManifestStore(options(growthRoot, {
      maxManifestBytes: initialBytes + 1,
    })).recoverSession(SESSION)).rejects.toThrow(/exceeds the .*byte limit/)
    grow.mockRestore()
  })
})
