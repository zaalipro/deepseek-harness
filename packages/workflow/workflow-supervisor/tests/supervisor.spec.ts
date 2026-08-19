import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { WorkflowRunId, WorkflowEngine } from '@deepseek-ai/dsh-workflow'
import type { WorkflowMeta, WorkflowResult, WorkflowRun, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import WorkflowSupervisor from '../src/index.ts'

class StubEngine extends WorkflowEngine {
  static inject = [] as const
  requests: WorkflowStartRequest[] = []
  cancels: string[] = []
  readonly settlements = new Map<string, (result: WorkflowResult) => void>()

  start(request: WorkflowStartRequest): WorkflowRun {
    this.requests.push(request)
    const id = WorkflowRunId(`run-${this.requests.length}`)
    const result = new Promise<WorkflowResult>((resolve) => { this.settlements.set(String(id), resolve) })
    return {
      id,
      meta: request.meta,
      result,
      cancel: (reason?: string) => {
        this.cancels.push(reason ?? 'cancelled')
        this.settlements.get(String(id))?.({
          value: null,
          stopReason: 'cancelled',
          ...reason !== undefined ? { error: reason } : {},
          agentsStarted: 0,
        })
      },
      resume: () => {},
      dispose: async () => { this.settlements.delete(String(id)) },
    }
  }
}

const META: WorkflowMeta = { name: 'audit', description: 'review' }

async function setup() {
  const project = await mkdtemp(join(tmpdir(), 'dsh-supervisor-'))
  const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-home-'))
  const ctx = new Context()
  await ctx.plugin(StubEngine)
  ctx.provide('workflows', { get: async () => undefined, list: async () => [] })
  await ctx.plugin(WorkflowSupervisor, { enabled: true, dshHome: root, runsRoot: join(root, 'workflow-runs') })
  const engine = ctx.workflowEngine as StubEngine
  const session = Session.create(SessionId('session-1')) as unknown as Session
  const parent = { id: session.id, options: {}, session, inject: () => {} } as unknown as Agent
  return { ctx, engine, parent, session, project }
}

describe('WorkflowSupervisor', () => {
  it('allocates session-unique display names (name, name-2, ...)', async () => {
    const { ctx, parent } = await setup()
    const first = await ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent })
    const second = await ctx.workflowSupervisor.start({ script: 'return 2', meta: META, parent })
    expect(first.displayName).toBe('audit')
    expect(second.displayName).toBe('audit-2')
    expect(ctx.workflowSupervisor.listRuns(parent).map(run => run.displayName)).toEqual(['audit', 'audit-2'])
  })

  it('launches in the background and owns the run handle', async () => {
    const { ctx, engine, parent } = await setup()
    const launched = await ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent })
    expect(launched.status).toBe('started')
    expect(String(launched.runId)).toBe('run-1')
    expect(engine.requests).toHaveLength(1)
    expect(engine.requests[0]).toMatchObject({ script: 'return 1', meta: META, parent })
    // The run returns immediately; the supervisor does not await settlement.
    expect(engine.settlements.has('run-1')).toBe(true)
  })

  it('pause cancels the run and marks it paused; resume re-runs with the journal', async () => {
    const { ctx, engine, parent } = await setup()
    const launched = await ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent })
    ctx.workflowSupervisor.pause('audit', parent)
    expect(engine.cancels).toEqual(['paused by user'])
    const views = ctx.workflowSupervisor.listRuns(parent)
    expect(views[0]?.status).toBe('paused')
    // Resume starts a second engine run (journal replay path).
    ctx.workflowSupervisor.resume('audit', parent)
    expect(engine.requests).toHaveLength(2)
    expect(ctx.workflowSupervisor.listRuns(parent)[0]?.status).toBe('running')
    void launched
  })

  it('rejects save for numbered duplicate handles and built-ins', async () => {
    const { ctx, parent } = await setup()
    await ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent })
    await ctx.workflowSupervisor.start({ script: 'return 2', meta: META, parent })
    await expect(ctx.workflowSupervisor.save('audit-2', parent)).rejects.toThrow(/numbered handle/)
    // A bundled definition hides save too.
    await ctx.workflowSupervisor.start({
      definition: { name: 'builtin', description: 'd', script: 'return 3', scope: 'bundled' },
      parent,
    })
    await expect(ctx.workflowSupervisor.save('builtin', parent)).rejects.toThrow(/built-in/)
  })

  it('marks active runs interrupted on process exit', async () => {
    const { ctx, parent } = await setup()
    await ctx.workflowSupervisor.start({ script: 'return 1', meta: META, parent })
    ctx.workflowSupervisor.markInterrupted()
    expect(ctx.workflowSupervisor.listRuns(parent)[0]?.status).toBe('interrupted')
    expect(() => ctx.workflowSupervisor.resume('audit', parent)).toThrow(/cannot resume/)
  })
})
