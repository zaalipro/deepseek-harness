import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { WorkflowRun } from '@deepseek-ai/dsh-workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorkerThreadWorkflowEngine from '../src/index.ts'
import type { Config } from '../src/index.ts'

vi.setConfig({ testTimeout: 30_000 })

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function parent(): Agent {
  return { id: SessionId('host-scratch-coverage-parent'), options: {} } as unknown as Agent
}

async function setup(config?: Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  const provider: SubagentProvider = {
    name: 'host-scratch-coverage',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
    inheritsParentContext: false,
    start: () => { throw new Error('scratch coverage unexpectedly launched a child') },
  }
  ctx.subagents.registerProvider(provider)
  await ctx.plugin(WorkerThreadWorkflowEngine, {
    provider: provider.name,
    maxConcurrentAgents: 1,
    disposeGraceMs: 250,
    ...config,
  })
  cleanups.push(async () => { await ctx.fiber.dispose() })
  return ctx
}

async function runDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workflow-scratch-coverage-'))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

async function waitingRun(ctx: Context, scratchDir: string): Promise<WorkflowRun> {
  const run = ctx.workflowEngine.start({
    meta: { name: 'host-scratch-coverage', description: 'scratch filesystem regression' },
    script: 'await new Promise(() => {})',
    scratchDir,
    parent: parent(),
  })
  cleanups.push(async () => { await run.dispose() })
  await vi.waitFor(() => {
    expect((run as unknown as { workerReady: boolean }).workerReady).toBe(true)
  }, { timeout: 10_000, interval: 20 })
  return run
}

function invoke(run: WorkflowRun, method: string, ...args: unknown[]): unknown {
  const target = run as unknown as Record<string, (...values: unknown[]) => unknown>
  return Reflect.apply(target[method]!, target, args)
}

async function scratchState(run: WorkflowRun): Promise<unknown> {
  return await invoke(run, 'initializeScratch')
}

async function withScratchSignalHook<T>(
  run: WorkflowRun,
  hook: (call: number) => void,
  operation: () => Promise<T>,
): Promise<T> {
  const signal = (run as unknown as { scratchController: AbortController }).scratchController.signal
  const original = signal.throwIfAborted.bind(signal)
  let calls = 0
  Object.defineProperty(signal, 'throwIfAborted', {
    configurable: true,
    value: (): void => {
      calls += 1
      hook(calls)
      original()
    },
  })
  try {
    return await operation()
  } finally {
    delete (signal as unknown as { throwIfAborted?: () => void }).throwIfAborted
  }
}

describe('scratch filesystem identity and rollback', () => {
  it('rejects a retained hard link before chmod or reading its outside inode', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    const outside = join(dir, 'outside.txt')
    const scratch = join(dir, 'scratch')
    await writeFile(outside, 'outside data', { mode: 0o644 })
    await mkdir(scratch)
    await link(outside, join(scratch, 'report'))
    const modeBefore = (await stat(outside)).mode & 0o777
    const run = ctx.workflowEngine.start({
      meta: { name: 'scratch-hard-link', description: 'retained hard-link regression' },
      script: 'return await read_scratch_file(\'report\')',
      scratchDir: dir,
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })

    await expect(run.result).resolves.toMatchObject({
      stopReason: 'error',
      error: expect.stringContaining('multiple hard links') as unknown,
    })
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside data')
    if (process.platform !== 'win32') expect((await stat(outside)).mode & 0o777).toBe(modeBefore)
  })

  it('rejects a retained file replaced by an outside hard link after initialization', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    const scratch = join(dir, 'scratch')
    const target = join(scratch, 'report')
    const outside = join(dir, 'outside.txt')
    await mkdir(scratch)
    await writeFile(target, 'retained')
    await writeFile(outside, 'outside data')
    const run = await waitingRun(ctx, dir)
    const state = await scratchState(run)
    await rm(target)
    await link(outside, target)

    await expect(invoke(run, 'readScratch', state, 'report') as Promise<string | undefined>)
      .rejects.toThrow('multiple hard links')
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside data')
  })

  it('rejects a retained file replaced by a new inode or a directory', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    const scratch = join(dir, 'scratch')
    const target = join(scratch, 'report')
    await mkdir(scratch)
    await writeFile(target, 'retained')
    const run = await waitingRun(ctx, dir)
    const state = await scratchState(run)

    await rm(target)
    await writeFile(target, 'replacement')
    await expect(invoke(run, 'readScratch', state, 'report') as Promise<string | undefined>)
      .rejects.toThrow('changed after initialization')

    await rm(target)
    await mkdir(target)
    await expect(invoke(run, 'readScratch', state, 'report') as Promise<string | undefined>)
      .rejects.toThrow('is not a regular file')
  })

  it('atomically refuses to replace a concurrent target on first publication', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    const scratch = join(dir, 'scratch')
    const target = join(scratch, 'report')
    const run = await waitingRun(ctx, dir)
    const state = await scratchState(run)

    await expect(withScratchSignalHook(run, (call) => {
      if (call === 2) writeFileSync(target, 'concurrent actor', { flag: 'wx' })
    }, async () => { await (invoke(run, 'writeScratch', state, 'report', 'workflow data') as Promise<void>) }))
      .rejects.toMatchObject({ code: 'EEXIST' })

    await expect(readFile(target, 'utf8')).resolves.toBe('concurrent actor')
    expect((await readdir(scratch)).filter(name => name.startsWith('.'))).toEqual([])
  })

  it('preserves both a concurrent target and the retained backup when rollback cannot restore', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    const scratch = join(dir, 'scratch')
    const target = join(scratch, 'report')
    await mkdir(scratch)
    await writeFile(target, 'retained data')
    const run = await waitingRun(ctx, dir)
    const state = await scratchState(run)

    await expect(withScratchSignalHook(run, (call) => {
      if (call === 3) {
        writeFileSync(target, 'concurrent actor', { flag: 'wx' })
        throw new Error('forced rollback')
      }
    }, async () => { await (invoke(run, 'writeScratch', state, 'report', 'workflow data') as Promise<void>) }))
      .rejects.toThrow('forced rollback')

    await expect(readFile(target, 'utf8')).resolves.toBe('concurrent actor')
    const backup = (await readdir(scratch)).find(name => name.endsWith('.bak'))
    expect(backup).toBeDefined()
    await expect(readFile(join(scratch, backup!), 'utf8')).resolves.toBe('retained data')
    expect((await readdir(scratch)).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('rejects a scratch directory replaced after lazy initialization', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    const scratch = join(dir, 'scratch')
    const displaced = join(dir, 'displaced-scratch')
    const run = await waitingRun(ctx, dir)
    const state = await scratchState(run)
    await rename(scratch, displaced)
    await mkdir(scratch)

    await expect(invoke(run, 'writeScratch', state, 'report', 'content') as Promise<void>)
      .rejects.toThrow('scratch directory changed after initialization')
    expect(await readdir(scratch)).toEqual([])
  })

  it('updates missing-file accounting before admitting a replacement file', async () => {
    const ctx = await setup({ scratchMaxFiles: 1, scratchMaxFileBytes: 16, scratchMaxTotalBytes: 16 })
    const dir = await runDirectory()
    const scratch = join(dir, 'scratch')
    const target = join(scratch, 'old')
    await mkdir(scratch)
    await writeFile(target, 'old')
    const run = await waitingRun(ctx, dir)
    const state = await scratchState(run)
    await rm(target)

    await expect(invoke(run, 'readScratch', state, 'old') as Promise<string | undefined>).resolves.toBeUndefined()
    await expect(invoke(run, 'writeScratch', state, 'new', 'replacement') as Promise<void>).resolves.toBeUndefined()
    await expect(readFile(join(scratch, 'new'), 'utf8')).resolves.toBe('replacement')
  })

  it('rejects external growth that makes retained scratch exceed the total quota', async () => {
    const ctx = await setup({ scratchMaxFiles: 2, scratchMaxFileBytes: 6, scratchMaxTotalBytes: 6 })
    const dir = await runDirectory()
    const scratch = join(dir, 'scratch')
    await mkdir(scratch)
    await writeFile(join(scratch, 'one'), 'abc')
    await writeFile(join(scratch, 'two'), 'def')
    const run = await waitingRun(ctx, dir)
    const state = await scratchState(run)
    await writeFile(join(scratch, 'one'), 'abcd')

    await expect(invoke(run, 'readScratch', state, 'one') as Promise<string | undefined>)
      .rejects.toThrow('grew beyond the total quota')
  })

  it('rejects retained-file growth beyond the per-file quota before reading', async () => {
    const ctx = await setup({ scratchMaxFiles: 1, scratchMaxFileBytes: 4, scratchMaxTotalBytes: 8 })
    const dir = await runDirectory()
    const scratch = join(dir, 'scratch')
    const target = join(scratch, 'report')
    await mkdir(scratch)
    await writeFile(target, 'old')
    const run = await waitingRun(ctx, dir)
    const state = await scratchState(run)
    await writeFile(target, 'grown')

    await expect(invoke(run, 'readScratch', state, 'report') as Promise<string | undefined>)
      .rejects.toThrow('exceeds the per-file quota')
  })

  it('rejects a publication identity that does not name the expected inode', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    const scratch = join(dir, 'scratch')
    const target = join(scratch, 'report')
    await mkdir(scratch)
    await writeFile(target, 'retained')
    const info = await stat(target)
    const run = await waitingRun(ctx, dir)

    await expect(invoke(run, 'assertScratchFileIdentity', target, {
      device: info.dev,
      inode: info.ino + 1,
      size: info.size,
    }) as Promise<void>).rejects.toThrow('changed during publication')
  })

  it('publishes a normal overwrite without transaction debris', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    const scratch = join(dir, 'scratch')
    await mkdir(scratch)
    await writeFile(join(scratch, 'report'), 'old')
    const run = ctx.workflowEngine.start({
      meta: { name: 'scratch-normal-overwrite', description: 'normal overwrite regression' },
      script: 'await write_scratch_file(\'report\', \'new\'); return await read_scratch_file(\'report\')',
      scratchDir: dir,
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })

    await expect(run.result).resolves.toMatchObject({ value: 'new', stopReason: 'completed' })
    expect(await readdir(scratch)).toEqual(['report'])
  })
})
