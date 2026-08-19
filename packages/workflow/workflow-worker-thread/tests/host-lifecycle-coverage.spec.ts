import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { WorkflowJournalEntry, WorkflowRun } from '@deepseek-ai/dsh-workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorkerThreadWorkflowEngine from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { WorkerToHostType } from '../src/protocol.ts'

vi.setConfig({ testTimeout: 30_000 })

const cleanups: (() => Promise<void>)[] = []
const fingerprint = '0'.repeat(64)

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function parent(): Agent {
  return { id: SessionId('host-lifecycle-parent'), options: {} } as unknown as Agent
}

async function setup(
  config: Config = {},
  resultMode: 'resolved' | 'pending' = 'resolved',
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  let childIndex = 0
  const provider: SubagentProvider = {
    name: 'host-lifecycle-stub',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
    inheritsParentContext: false,
    start: async () => {
      const index = childIndex
      childIndex += 1
      const pending = Promise.withResolvers<Awaited<SubagentRun['result']>>()
      return {
        id: SessionId(`host-lifecycle-child-${index}`),
        localAgent: undefined,
        result: resultMode === 'resolved'
          ? Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' })
          : pending.promise,
        dispose: () => Promise.resolve(),
      }
    },
  }
  ctx.subagents.registerProvider(provider)
  await ctx.plugin(WorkerThreadWorkflowEngine, {
    provider: provider.name,
    maxConcurrentAgents: 3,
    maxTotalAgents: 3,
    disposeGraceMs: 50,
    ...config,
  })
  cleanups.push(async () => { await ctx.fiber.dispose() })
  return ctx
}

async function waitingRun(ctx: Context, scratchDir?: string): Promise<WorkflowRun> {
  const run = ctx.workflowEngine.start({
    meta: { name: 'host-lifecycle', description: 'Host lifecycle regression' },
    script: 'await new Promise(() => {})',
    parent: parent(),
    ...(scratchDir === undefined ? {} : { scratchDir }),
  })
  cleanups.push(async () => { await run.dispose() })
  await vi.waitFor(() => {
    expect(Reflect.get(run, 'workerReady')).toBe(true)
  }, { timeout: 10_000, interval: 20 })
  return run
}

function invoke(run: WorkflowRun, method: string, ...args: unknown[]): unknown {
  const target = run as unknown as Record<string, (...values: unknown[]) => unknown>
  return Reflect.apply(target[method]!, target, args)
}

function installChild(
  run: WorkflowRun,
  callId: number,
  childId: string,
  resultState: 'pending' | 'settled' | 'failed',
): void {
  const child: SubagentRun = {
    id: SessionId(childId),
    localAgent: undefined,
    result: Promise.resolve({ output: [], stopReason: 'completed' }),
    dispose: () => Promise.resolve(),
  }
  const children = Reflect.get(run, 'children') as Map<number, {
    run: SubagentRun
    resultState: 'pending' | 'settled' | 'failed'
  }>
  children.set(callId, { run: child, resultState })
  Reflect.set(run, 'hostStarted', (Reflect.get(run, 'hostStarted') as number) + 1)
}

function phaseEntry(ordinal: number, callId: string): WorkflowJournalEntry {
  return { kind: 'phase', ordinal, callId, fingerprint, title: 'Review' }
}

async function runDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workflow-host-lifecycle-'))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

describe('host lifecycle protocol defenses', () => {
  it('contains an unexpected dispatch exception as a run-local protocol failure', async () => {
    const ctx = await setup()
    const run = await waitingRun(ctx)
    Reflect.set(run, 'onMessage', () => { throw new Error('unexpected dispatch failure') })

    invoke(run, 'onRawMessage', { type: WorkerToHostType.Log, message: 'valid frame' })

    await expect(run.result).resolves.toMatchObject({
      stopReason: 'error',
      error: expect.stringContaining('unexpected dispatch failure') as unknown,
    })
  })

  it('suppresses narration and unmatched member frames after cancellation admission', async () => {
    const ctx = await setup()
    const phases: string[] = []
    const logs: string[] = []
    const gates: string[] = []
    ctx.on('workflow/phase', (_info, title) => { phases.push(title) })
    ctx.on('workflow/log', (_info, message) => { logs.push(message) })
    ctx.on('workflow/gate', (_info, gate) => { gates.push(gate.message) })
    const run = await waitingRun(ctx)
    Reflect.set(run, 'cancelReason', 'already stopping')

    invoke(run, 'onMessage', { type: WorkerToHostType.Phase, title: 'Late phase' })
    invoke(run, 'onMessage', { type: WorkerToHostType.Log, message: 'Late log' })
    invoke(run, 'onMessage', {
      type: WorkerToHostType.Gate,
      gate: { kind: 'infra', message: 'Late gate', resumable: false },
    })
    expect(() => {
      invoke(run, 'onAgentStart', { seq: 1, label: 'late', childId: 'missing' })
      invoke(run, 'onAgentEnd', {
        seq: 1,
        label: 'late',
        childId: 'missing',
        outcome: 'cancelled',
      })
    }).not.toThrow()

    expect({ phases, logs, gates }).toEqual({ phases: [], logs: [], gates: [] })
    Reflect.set(run, 'cancelReason', undefined)
  })

  it('rejects reused child identities and lifecycle outcomes that disagree with host state', async () => {
    const ctx = await setup()
    const run = await waitingRun(ctx)
    Reflect.set(Reflect.get(run, 'init') as object, 'initialAgentSeq', undefined)
    for (let callId = 1; callId <= 3; callId += 1) {
      installChild(run, callId, `host-lifecycle-child-${callId - 1}`, 'settled')
    }

    const first = { seq: 1, label: 'first', childId: 'host-lifecycle-child-0' }
    const second = { seq: 2, label: 'second', childId: 'host-lifecycle-child-1' }
    invoke(run, 'onAgentStart', first)
    invoke(run, 'onAgentStart', second)
    expect(() => {
      invoke(run, 'onAgentStart', { seq: 3, label: 'duplicate child', childId: first.childId })
    }).toThrow('reused child id')
    expect(() => {
      invoke(run, 'onAgentEnd', { ...first, outcome: 'failed' })
    }).toThrow('does not match the host-observed child result')

    invoke(run, 'onJournalCommit', {
      kind: 'agent', ordinal: 1, seq: 1, callId: 'root/agent:1', fingerprint, result: 'done',
    })
    expect(() => {
      invoke(run, 'onJournalCommit', {
        kind: 'agent', ordinal: 2, seq: 1, callId: 'root/agent:retry', fingerprint, result: 'done',
      })
    }).toThrow('reused seq')

    const agentChildren = Reflect.get(run, 'agentChildren') as Map<number, unknown>
    agentChildren.delete(2)
    expect(() => {
      invoke(run, 'onAgentEnd', { ...second, outcome: 'failed' })
    }).toThrow('lost its host child correlation')
  })

  it('rejects journal gaps, duplicate call identities, and commits before child settlement', async () => {
    const ctx = await setup({}, 'pending')
    const run = await waitingRun(ctx)

    expect(() => { invoke(run, 'onJournalCommit', phaseEntry(2, 'root/phase:gap')) }).toThrow(
      'does not follow 0',
    )
    invoke(run, 'onJournalCommit', phaseEntry(1, 'root/phase:one'))
    expect(() => { invoke(run, 'onJournalCommit', phaseEntry(2, 'root/phase:one')) }).toThrow(
      'reused call identity',
    )
    installChild(run, 1, 'host-lifecycle-child-0', 'pending')
    invoke(run, 'onAgentStart', { seq: 1, label: 'pending', childId: 'host-lifecycle-child-0' })
    expect(() => {
      invoke(run, 'onJournalCommit', {
        kind: 'agent', ordinal: 2, seq: 1, callId: 'root/agent:pending', fingerprint, result: null,
      })
    }).toThrow('before a host-observed child result')
  })

  it('enforces concurrent admission independently from cumulative spend', async () => {
    const ctx = await setup({ maxConcurrentAgents: 1 }, 'pending')
    const run = await waitingRun(ctx)
    Reflect.set(Reflect.get(run, 'init') as object, 'initialAgentSpend', undefined)

    invoke(run, 'onChildStart', 1, { prompt: 'first' })
    expect(() => { invoke(run, 'onChildStart', 2, { prompt: 'second' }) }).toThrow(
      'concurrent agent cap',
    )
  })
})

describe('scratch lifecycle defenses', () => {
  it('returns a missing retained scratch file without inventing content', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    const run = ctx.workflowEngine.start({
      meta: { name: 'scratch-missing', description: 'Missing scratch regression' },
      script: 'return (await read_scratch_file(\'missing\')) ?? null',
      scratchDir: dir,
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })

    await expect(run.result).resolves.toMatchObject({ value: null, stopReason: 'completed' })
  })

  it('rejects unsafe names and scratch effects admitted after a terminal decision', async () => {
    const ctx = await setup()
    const run = await waitingRun(ctx)

    expect(() => { invoke(run, 'claimScratchCall', 1, '../escape', 'scratch-read') }).toThrow(
      'one safe path component',
    )
    Reflect.set(run, 'terminalClaimed', true)
    expect(() => { invoke(run, 'claimScratchCall', 2, 'report', 'scratch-write') }).toThrow(
      'after the run stopped admitting effects',
    )
    Reflect.set(run, 'terminalClaimed', false)
  })

  it('keeps the first scratch failure as the terminal diagnostic', async () => {
    const ctx = await setup()
    const run = await waitingRun(ctx)

    invoke(run, 'onScratchFailure', new Error('first scratch failure'))
    expect(() => { invoke(run, 'onScratchFailure', new Error('second scratch failure')) }).not.toThrow()

    await expect(run.result).resolves.toMatchObject({
      stopReason: 'error',
      error: expect.stringContaining('first scratch failure') as unknown,
    })
  })

  it.skipIf(process.platform === 'win32')('rejects a scratch directory symlink at lazy initialization', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    const target = join(dir, 'target')
    await mkdir(target)
    await symlink(target, join(dir, 'scratch'), 'dir')
    const run = ctx.workflowEngine.start({
      meta: { name: 'scratch-directory-link', description: 'Scratch directory link regression' },
      script: 'return await read_scratch_file(\'report\')',
      scratchDir: dir,
      parent: parent(),
    })
    cleanups.push(async () => { await run.dispose() })

    await expect(run.result).resolves.toMatchObject({
      stopReason: 'error',
      error: expect.stringContaining('scratch path is not a real directory') as unknown,
    })
  })

  it('rejects a non-file passed to retained-file accounting', async () => {
    const ctx = await setup()
    const dir = await runDirectory()
    const run = await waitingRun(ctx)

    await expect(invoke(run, 'scratchFileState', dir) as Promise<unknown>).rejects.toThrow(
      'is not a regular file',
    )
  })
})
