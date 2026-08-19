import { Buffer } from 'node:buffer'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { WorkflowJournalEntry, WorkflowRun } from '@deepseek-ai/dsh-workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorkerThreadWorkflowEngine from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { WorkerToHostType } from '../src/protocol.ts'

vi.setConfig({ testTimeout: 30_000 })

/** Async resources owned by one test and released even when its assertion fails. */
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Parent identity needed by the workflow seam; no child is launched in these tests. */
function parent(): Agent {
  return { id: SessionId('host-security-parent'), options: {} } as unknown as Agent
}

/** Mount a real worker engine with a provider that makes unexpected child launches visible. */
async function setup(config?: Config, childReply?: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  let childIndex = 0
  const provider: SubagentProvider = {
    name: 'security-stub',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
    inheritsParentContext: false,
    start: async () => {
      if (childReply === undefined) throw new Error('security regression unexpectedly launched a child')
      const index = childIndex
      childIndex += 1
      return {
        id: SessionId(`host-security-child-${index}`),
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: childReply }],
          stopReason: 'completed',
        }),
        dispose: () => Promise.resolve(),
      }
    },
  }
  ctx.subagents.registerProvider(provider)
  await ctx.plugin(WorkerThreadWorkflowEngine, {
    provider: provider.name,
    maxConcurrentAgents: 2,
    disposeGraceMs: 250,
    ...config,
  })
  cleanups.push(async () => { await ctx.fiber.dispose() })
  return ctx
}

/** Start one script that remains live while a raw worker frame is injected. */
async function waitingRun(ctx: Context, scratchDir?: string): Promise<WorkflowRun> {
  const run = ctx.workflowEngine.start({
    meta: { name: 'host-security', description: 'host security regression' },
    script: 'await new Promise(() => {})',
    parent: parent(),
    ...(scratchDir === undefined ? {} : { scratchDir }),
  })
  cleanups.push(async () => { await run.dispose() })
  await vi.waitFor(() => {
    expect((run as unknown as { workerReady: boolean }).workerReady).toBe(true)
  }, { timeout: 10_000, interval: 20 })
  return run
}

/** The private Worker event is the exact raw host boundary exercised by a VM escape. */
function inject(run: WorkflowRun, frame: unknown): void {
  const worker = (run as unknown as { worker: Worker }).worker
  worker.emit('message', frame)
}

/** Invoke one private host state-machine method for forged boundary scenarios. */
function invoke(run: WorkflowRun, method: string, ...args: unknown[]): unknown {
  const target = run as unknown as Record<string, (...values: unknown[]) => unknown>
  return Reflect.apply(target[method]!, target, args)
}

/** Read a directory as empty when cancellation won before its lazy creation. */
async function entriesOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Make and register a temporary run directory. */
async function runDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workflow-security-'))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

describe('untrusted worker frame containment', () => {
  it.each([
    { type: WorkerToHostType.Log, message: 'before ready' },
    { type: WorkerToHostType.Ready },
  ])('rejects an invalid startup sequence: %j', async (frame) => {
    const ctx = await setup()
    const run = ctx.workflowEngine.start({
      meta: { name: 'startup-protocol', description: 'startup protocol regression' },
      script: 'await new Promise(() => {})',
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })

    if (frame.type === WorkerToHostType.Ready) {
      await vi.waitFor(() => {
        expect((run as unknown as { workerReady: boolean }).workerReady).toBe(true)
      }, { timeout: 10_000, interval: 20 })
    }
    inject(run, frame)

    await expect(run.result).resolves.toMatchObject({
      stopReason: 'error',
      error: expect.stringContaining('protocol violation') as unknown,
    })
  })

  it.each([
    { type: 'forged-unknown-tag' },
    { type: WorkerToHostType.ChildStart, callId: 'not-an-integer', request: { prompt: 'forged' } },
    {
      type: WorkerToHostType.JournalCommit,
      entry: {
        kind: 'agent', ordinal: 1, seq: 1, callId: 'root/agent:1', fingerprint: '0'.repeat(64), result: 'forged',
      },
    },
  ])('settles only the offending run for an invalid raw frame: %j', async (frame) => {
    const ctx = await setup()
    const run = await waitingRun(ctx)

    expect(() => { inject(run, frame) }).not.toThrow()
    const result = await run.result
    expect(result.value).toBeNull()
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('workflow worker protocol violation')
  })

  it('contains an oversized forged frame before observer dispatch', async () => {
    const ctx = await setup({ maxProtocolMessageBytes: 128 })
    const logs: string[] = []
    ctx.on('workflow/log', (_info, message) => { logs.push(message) })
    const run = await waitingRun(ctx)

    inject(run, { type: WorkerToHostType.Log, message: 'x'.repeat(256) })

    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('128-byte protocol limit')
    expect(logs).toEqual([])
  })

  it('rejects a terminal child count below host-observed admission', async () => {
    const ctx = await setup({ maxTotalAgents: 1 })
    const run = await waitingRun(ctx)

    inject(run, {
      type: WorkerToHostType.ChildStart,
      callId: 1,
      request: { prompt: 'admitted before the forged result' },
    })
    inject(run, {
      type: WorkerToHostType.Result,
      result: { value: null, stopReason: 'completed', agentsStarted: 0 },
    })

    const result = await run.result
    expect(result).toMatchObject({ value: null, stopReason: 'error', agentsStarted: 1 })
    expect(result.error).toContain('below the host-observed spend 1')
  })

  it('rejects a terminal child count above the run budget', async () => {
    const ctx = await setup({ maxTotalAgents: 1 })
    const run = await waitingRun(ctx)
    inject(run, {
      type: WorkerToHostType.Result,
      result: { value: null, stopReason: 'completed', agentsStarted: 2 },
    })
    await expect(run.result).resolves.toMatchObject({
      stopReason: 'error',
      error: expect.stringContaining('exceeds the 1-agent cap') as unknown,
    })
  })

  it.each([
    ['claimCallId', [1, 'scratch-read'], 'reused callId'],
    ['assertEventText', ['oversized', 'log message'], 'byte limit'],
    ['onAgentStart', [{ seq: 0, label: 'x', childId: 'c' }], 'does not advance prior seq'],
    ['onAgentStart', [{ seq: 1, label: 'x', childId: 'c' }], 'sequence range'],
    ['onAgentStart', [{ seq: 1, label: 'x', childId: 'c' }], 'unpublished child'],
    ['onAgentEnd', [{ seq: 1, label: 'x', childId: 'c', outcome: 'failed' }], 'unknown seq'],
    ['onJournalCommit', [{
      kind: 'agent', ordinal: 1, seq: 1, callId: 'a', fingerprint: '0'.repeat(64), result: null,
    }], 'unknown live seq'],
    ['onChildDispose', [99], 'unknown callId'],
  ] as const)('contains forged host lifecycle state through %s', async (method, values, diagnostic) => {
    const ctx = await setup({ maxEventTextBytes: 1 })
    const run = await waitingRun(ctx)
    if (method === 'claimCallId') invoke(run, method, 1, 'child-start')
    if (method === 'onAgentStart' && diagnostic === 'unpublished child') {
      ;(run as unknown as { hostStarted: number }).hostStarted = 1
    }
    expect(() => { invoke(run, method, ...values) }).toThrow(diagnostic)
  })

  it('rejects duplicate and mismatched member lifecycle frames', async () => {
    const ctx = await setup(undefined, 'done')
    const run = await waitingRun(ctx)
    inject(run, { type: WorkerToHostType.ChildStart, callId: 1, request: { prompt: 'child' } })
    await vi.waitFor(() => {
      expect((run as unknown as { children: Map<number, unknown> }).children.has(1)).toBe(true)
    })
    const childId = 'host-security-child-0'
    const start = { seq: 1, label: 'child', childId }
    invoke(run, 'onAgentStart', start)
    expect(() => { invoke(run, 'onAgentStart', start) }).toThrow('reused seq')
    expect(() => {
      invoke(run, 'onAgentEnd', { ...start, label: 'changed', outcome: 'failed' })
    }).toThrow('metadata does not match')
    expect(() => {
      invoke(run, 'onAgentEnd', { ...start, outcome: 'cancelled' })
    }).toThrow('reported cancellation before the run was cancelled')
    expect(() => {
      invoke(run, 'onAgentEnd', { ...start, outcome: 'completed' })
    }).toThrow('without a committed result')
  })

  it('rejects invalid child-start admission and disposal ordering', async () => {
    const ctx = await setup({ maxTotalAgents: 1, maxChildPromptBytes: 1 })
    const run = await waitingRun(ctx)
    expect(() => { invoke(run, 'onChildStart', 1, { prompt: 'long' }) }).toThrow('prompt exceeds')
    expect(() => { invoke(run, 'onChildStart', 2, { prompt: 'x' }) }).not.toThrow()
    expect(() => { invoke(run, 'onChildStart', 3, { prompt: 'x' }) }).toThrow('total agent cap')
    expect(() => { invoke(run, 'onChildDispose', 2) }).toThrow('before host-side disposal')
    expect(() => { invoke(run, 'onChildDispose', 2) }).toThrow('repeated callId')
  })
})

describe('host-call journal containment', () => {
  const reply = 'é'

  it('accepts a multibyte result at the exact cumulative JSON byte limit', async () => {
    const probe = await setup(undefined, reply)
    const probeEntries: WorkflowJournalEntry[] = []
    probe.on('workflow/journal-commit', (_info, entry) => { probeEntries.push(entry) })
    const probeRun = probe.workflowEngine.start({
      meta: { name: 'journal-probe', description: 'journal byte-count probe' },
      script: 'return await agent(\'bounded result\')',
      parent: parent(),
    })
    cleanups.push(async () => { await probeRun.dispose() })
    await expect(probeRun.result).resolves.toMatchObject({ stopReason: 'completed' })
    const exactBytes = Buffer.byteLength(JSON.stringify(probeEntries), 'utf8')

    const ctx = await setup({ maxJournalBytes: exactBytes }, reply)
    const committed: WorkflowJournalEntry[] = []
    ctx.on('workflow/journal-commit', (_info, entry) => { committed.push(entry) })
    const run = ctx.workflowEngine.start({
      meta: { name: 'journal-exact', description: 'journal exact-byte regression' },
      script: 'return await agent(\'bounded result\')',
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })

    await expect(run.result).resolves.toMatchObject({ value: reply, stopReason: 'completed' })
    expect(committed).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(committed), 'utf8')).toBe(exactBytes)
  })

  it('rejects an oversized replay journal before creating a worker', async () => {
    const ctx = await setup({ maxJournalBytes: 2 })

    expect(() => ctx.workflowEngine.start({
      meta: { name: 'journal-replay-limit', description: 'journal replay limit regression' },
      script: 'return \'unreachable\'',
      journal: [{
        kind: 'agent',
        ordinal: 1,
        seq: 1,
        callId: 'root/agent:1',
        fingerprint: '0'.repeat(64),
        result: reply,
      }],
      initialAgentSpend: 1,
      initialAgentSeq: 1,
      parent: parent(),
    })).toThrow('journal exceeds the 2-byte limit before this attempt starts')
  })

  it('fails before observer persistence when the next result exceeds the journal by one byte', async () => {
    const probe = await setup(undefined, reply)
    const probeEntries: WorkflowJournalEntry[] = []
    probe.on('workflow/journal-commit', (_info, entry) => { probeEntries.push(entry) })
    const probeRun = probe.workflowEngine.start({
      meta: { name: 'journal-probe', description: 'journal byte-count probe' },
      script: 'return await agent(\'bounded result\')',
      parent: parent(),
    })
    cleanups.push(async () => { await probeRun.dispose() })
    await expect(probeRun.result).resolves.toMatchObject({ stopReason: 'completed' })
    const exactBytes = Buffer.byteLength(JSON.stringify(probeEntries), 'utf8')

    const ctx = await setup({ maxJournalBytes: exactBytes - 1 }, reply)
    const committed: WorkflowJournalEntry[] = []
    ctx.on('workflow/journal-commit', (_info, entry) => { committed.push(entry) })
    const run = ctx.workflowEngine.start({
      meta: { name: 'journal-oversize', description: 'journal oversize regression' },
      script: 'return await agent(\'bounded result\')',
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })

    const result = await run.result
    expect(result).toMatchObject({ value: null, stopReason: 'error' })
    expect(result.error).toContain(`${exactBytes - 1}-byte journal limit`)
    expect(committed).toEqual([])
  })
})

describe('scratch effect containment', () => {
  it('acknowledges scratch hooks without storage when the run has no scratch directory', async () => {
    const ctx = await setup()
    const run = ctx.workflowEngine.start({
      meta: { name: 'scratch-disabled', description: 'scratch disabled regression' },
      script: `
        await write_scratch_file('ignored', 'content')
        return (await read_scratch_file('ignored')) ?? null
      `,
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })
    await expect(run.result).resolves.toMatchObject({ value: null, stopReason: 'completed' })
  })

  it('accounts, reads, and atomically overwrites a retained scratch file', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    await mkdir(join(dir, 'scratch'), { recursive: true })
    await writeFile(join(dir, 'scratch', 'report.md'), 'old', { mode: 0o644 })
    const run = ctx.workflowEngine.start({
      meta: { name: 'scratch-resume', description: 'scratch resume regression' },
      script: `
        const before = await read_scratch_file('report.md')
        await write_scratch_file('report.md', 'new content')
        const after = await read_scratch_file('report.md')
        return { before, after }
      `,
      scratchDir: dir,
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })

    await expect(run.result).resolves.toMatchObject({
      value: { before: 'old', after: 'new content' },
      stopReason: 'completed',
    })
    await expect(readFile(join(dir, 'scratch', 'report.md'), 'utf8')).resolves.toBe('new content')
  })

  it.each([
    {
      label: 'preexisting file count',
      config: { scratchMaxFiles: 1 },
      files: [['one', 'a'], ['two', 'b']],
      diagnostic: '1-file quota',
    },
    {
      label: 'preexisting total bytes',
      config: { scratchMaxFileBytes: 4, scratchMaxTotalBytes: 4 },
      files: [['one', 'abc'], ['two', 'def']],
      diagnostic: '4-byte quota',
    },
    {
      label: 'preexisting per-file bytes',
      config: { scratchMaxFileBytes: 2, scratchMaxTotalBytes: 8 },
      files: [['one', 'abc']],
      diagnostic: 'per-file quota',
    },
  ])('rejects $label before reading retained content', async ({ config, files, diagnostic }) => {
    const ctx = await setup(config)
    const dir = await runDirectory()
    await mkdir(join(dir, 'scratch'), { recursive: true })
    for (const [name, content] of files) await writeFile(join(dir, 'scratch', name!), content!)
    const run = ctx.workflowEngine.start({
      meta: { name: 'scratch-retained-quota', description: 'retained scratch quota regression' },
      script: 'return await read_scratch_file(\'one\')',
      scratchDir: dir,
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })

    const result = await run.result
    expect(result).toMatchObject({ stopReason: 'error' })
    expect(result.error).toContain(diagnostic)
  })

  it('rejects an invalid retained scratch filename', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    await mkdir(join(dir, 'scratch'), { recursive: true })
    await writeFile(join(dir, 'scratch', '.hidden'), 'content')
    const run = ctx.workflowEngine.start({
      meta: { name: 'scratch-invalid-entry', description: 'invalid scratch entry regression' },
      script: 'return await read_scratch_file(\'missing\')',
      scratchDir: dir,
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })
    await expect(run.result).resolves.toMatchObject({
      stopReason: 'error',
      error: expect.stringContaining('unsupported entry') as unknown,
    })
  })

  it('drains an unawaited write before publishing a completed result', async () => {
    const ctx = await setup({
      maxProtocolMessageBytes: 512 * 1024,
      scratchMaxFileBytes: 256 * 1024,
      scratchMaxTotalBytes: 256 * 1024,
    })
    const dir = await runDirectory()
    const content = 'report'.repeat(20_000)
    const run = ctx.workflowEngine.start({
      meta: { name: 'scratch-drain', description: 'scratch drain regression' },
      script: 'write_scratch_file(\'report.md\', args.content); return \'done\'',
      args: { content },
      scratchDir: dir,
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })

    await expect(run.result).resolves.toMatchObject({ value: 'done', stopReason: 'completed' })
    await expect(readFile(join(dir, 'scratch', 'report.md'), 'utf8')).resolves.toBe(content)
  })

  it.each([
    {
      label: 'per-file byte',
      config: { scratchMaxFiles: 4, scratchMaxFileBytes: 4, scratchMaxTotalBytes: 16 },
      script: 'await write_scratch_file(\'too-big\', \'ééé\')',
      absent: 'too-big',
      diagnostic: 'per-file quota',
    },
    {
      label: 'file-count',
      config: { scratchMaxFiles: 1, scratchMaxFileBytes: 16, scratchMaxTotalBytes: 16 },
      script: 'await write_scratch_file(\'first\', \'a\'); await write_scratch_file(\'second\', \'b\')',
      absent: 'second',
      diagnostic: '1-file quota',
    },
    {
      label: 'total-byte',
      config: { scratchMaxFiles: 4, scratchMaxFileBytes: 5, scratchMaxTotalBytes: 5 },
      script: 'await write_scratch_file(\'first\', \'abc\'); await write_scratch_file(\'second\', \'def\')',
      absent: 'second',
      diagnostic: '5-byte total quota',
    },
  ])('fails the run without publishing content over the $label limit', async ({ config, script, absent, diagnostic }) => {
    const ctx = await setup(config)
    const dir = await runDirectory()
    const run = ctx.workflowEngine.start({
      meta: { name: 'scratch-limit', description: 'scratch quota regression' },
      script,
      scratchDir: dir,
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })

    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain(diagnostic)
    expect(await readdir(join(dir, 'scratch'))).not.toContain(absent)
  })

  it.skipIf(process.platform === 'win32')('refuses a preexisting scratch symlink without reading its target', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    const secret = join(dir, 'outside-secret.txt')
    await writeFile(secret, 'must remain private', { mode: 0o600 })
    await mkdir(join(dir, 'scratch'), { recursive: true })
    await symlink(secret, join(dir, 'scratch', 'report.md'), 'file')
    const run = ctx.workflowEngine.start({
      meta: { name: 'scratch-symlink', description: 'scratch symlink regression' },
      script: 'return await read_scratch_file(\'report.md\')',
      scratchDir: dir,
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })

    const result = await run.result
    expect(result).toMatchObject({ value: null, stopReason: 'error' })
    expect(result.error).toContain('unsupported entry')
    await expect(readFile(secret, 'utf8')).resolves.toBe('must remain private')
  })

  it('cancellation wins and aborts an admitted fire-and-forget write before publication', async () => {
    const ctx = await setup({
      maxProtocolMessageBytes: 4 * 1024 * 1024,
      scratchMaxFileBytes: 3 * 1024 * 1024,
      scratchMaxTotalBytes: 3 * 1024 * 1024,
    })
    const dir = await runDirectory()
    const run = await waitingRun(ctx, dir)

    inject(run, {
      type: WorkerToHostType.ScratchWrite,
      callId: 999,
      name: 'cancelled.bin',
      content: 'x'.repeat(2 * 1024 * 1024),
    })
    run.cancel('cancel scratch effect')

    const result = await run.result
    expect(result.stopReason).toBe('cancelled')
    expect(result.error).toContain('cancel scratch effect')
    await run.dispose()
    expect(await entriesOrEmpty(join(dir, 'scratch'))).not.toContain('cancelled.bin')
  })

  it('bounds scratch operations over the attempt lifetime', async () => {
    const ctx = await setup({ scratchMaxOperations: 1, scratchMaxPendingOperations: 1 })
    const dir = await runDirectory()
    const run = ctx.workflowEngine.start({
      meta: { name: 'scratch-operations', description: 'scratch operation limit regression' },
      script: 'await write_scratch_file(\'report\', \'one\'); await read_scratch_file(\'report\')',
      scratchDir: dir,
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })

    const result = await run.result
    expect(result).toMatchObject({ value: null, stopReason: 'error' })
    expect(result.error).toContain('1-operation scratch limit')
    await expect(readFile(join(dir, 'scratch', 'report'), 'utf8')).resolves.toBe('one')
  })

  it('rejects a fire-and-forget scratch queue above the pending-operation limit', async () => {
    const ctx = await setup({
      maxProtocolMessageBytes: 512 * 1024,
      scratchMaxOperations: 4,
      scratchMaxPendingOperations: 1,
      scratchMaxFileBytes: 256 * 1024,
      scratchMaxTotalBytes: 256 * 1024,
    })
    const dir = await runDirectory()
    const run = await waitingRun(ctx, dir)

    inject(run, {
      type: WorkerToHostType.ScratchWrite,
      callId: 1001,
      name: 'first',
      content: 'x'.repeat(128 * 1024),
    })
    inject(run, {
      type: WorkerToHostType.ScratchWrite,
      callId: 1002,
      name: 'second',
      content: 'second',
    })

    const result = await run.result
    expect(result).toMatchObject({ value: null, stopReason: 'error' })
    expect(result.error).toContain('1-operation pending scratch limit')
    expect(await entriesOrEmpty(join(dir, 'scratch'))).not.toContain('second')
  })

  it.skipIf(process.platform === 'win32')('creates owner-private scratch storage', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    const run = ctx.workflowEngine.start({
      meta: { name: 'scratch-mode', description: 'scratch mode regression' },
      script: 'await write_scratch_file(\'report\', \'private\')',
      scratchDir: dir,
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })

    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect((await stat(join(dir, 'scratch'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, 'scratch', 'report'))).mode & 0o777).toBe(0o600)
  })
})
