import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  SlotRegistry, type ObservableSnapshot, type SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {
  ActionCommandUiSpec, CommandContribution, CommandDecoration,
} from '@deepseek-ai/dsh-client-ui-commands/client'
import type { WorkflowRunsSourceSnapshot } from '../src/client/contract.ts'
import type { WorkflowsDashboardInjected } from '../src/client/WorkflowsDashboard.tsx'
import { WorkflowsDashboard } from '../src/client/WorkflowsDashboard.tsx'
import { apply, inject } from '../src/client/index.ts'

const SESSION = 'session-a' as SessionId
const IDLE: WorkflowRunsSourceSnapshot = { phase: 'idle', runs: [], total: 0 }

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'shell.overlay': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const command = vi.fn(async () => ({ ok: true as const, value: { matched: true } }))
  ctx.provide('sessions', {
    binding: (sessionId: SessionId) => sessionId === SESSION
      ? { session: { command } }
      : undefined,
  } as never)
  const listDefinitions = vi.fn(async (_sessionId: SessionId, _signal?: AbortSignal) => ({
    ok: true as const,
    value: [{
      name: 'review-changes',
      description: 'Review the current diff',
      whenToUse: 'Before merge',
      scope: 'project' as const,
    }, {
      name: 'summarize-workspace',
      description: 'Summarize the current workspace',
      scope: 'user' as const,
    }],
  }))
  ctx.provide('remote', { workflowDefinitions: { list: listDefinitions } } as never)

  const listSource: ObservableSnapshot<WorkflowRunsSourceSnapshot> = {
    getSnapshot: () => IDLE,
    subscribe: () => () => {},
  }
  const controller = {
    source: vi.fn(() => listSource),
    refresh: vi.fn(async () => undefined),
    loadMore: vi.fn(async () => undefined),
    detail: vi.fn(async () => ({}) as never),
    members: vi.fn(async () => ({}) as never),
    memberDetail: vi.fn(async () => ({}) as never),
    logs: vi.fn(async () => ({}) as never),
    result: vi.fn(async () => ({}) as never),
    artifacts: vi.fn(async () => ({}) as never),
    artifact: vi.fn(async () => ({}) as never),
    control: vi.fn(async () => ({}) as never),
    resolveAndOpenChild: vi.fn(async () => false),
  }
  ctx.provide('workflowRuns', controller as never)

  let contribution: CommandContribution | undefined
  let decoration: CommandDecoration | undefined
  ctx.provide('commandUi', {
    register(value: CommandContribution) {
      contribution = value
      return () => { contribution = undefined }
    },
    decorate(value: CommandDecoration) {
      decoration = value
      return () => { decoration = undefined }
    },
  } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    ctx, controller, fiber, command, listDefinitions,
    contribution: () => contribution,
    decoration: () => decoration,
  }
}

describe('ui-workflows browser plugin', () => {
  it('declares only the services used by its client-owned action and overlay', () => {
    expect(inject).toEqual(['slots', 'sessions', 'workflowRuns', 'commandUi', 'locale', 'remote'])
  })

  it('decorates bare /workflow with the active session definition catalog and launches the selected name', async () => {
    const b = await bench()
    const decoration = b.decoration()
    expect(decoration?.name).toBe('workflow')
    expect(decoration?.available({ sessionId: SESSION })).toBe(true)
    const signal = new AbortController().signal
    const options = await decoration?.ui.options({ sessionId: SESSION }, signal)
    expect(b.listDefinitions).toHaveBeenCalledExactlyOnceWith(SESSION, signal)
    expect(options).toEqual([{
      id: 'review-changes',
      label: 'review-changes',
      detail: 'Review the current diff — Before merge · project',
    }, {
      id: 'summarize-workspace',
      label: 'summarize-workspace',
      detail: 'Summarize the current workspace · user',
    }])
    const option = options?.[0]
    if (option === undefined) throw new Error('expected a workflow option')
    await decoration?.ui.onSelect(option, { sessionId: SESSION })
    expect(b.command).toHaveBeenCalledExactlyOnceWith('/workflow review-changes')
  })

  it('opens /workflows locally and never needs a Host command Remote', async () => {
    const b = await bench()
    const entry = b.ctx.slots.entries('shell.overlay')
      .find(candidate => candidate.component === WorkflowsDashboard)
    expect(entry).toBeDefined()
    const open = vi.fn()
    const injected = (entry?.inject as unknown as (actions: unknown) => WorkflowsDashboardInjected)({
      open,
      close: vi.fn(),
      selectRun: vi.fn(),
      reconcileRun: vi.fn(),
      selectMember: vi.fn(),
      selectTab: vi.fn(),
      showRuns: vi.fn(),
      showRun: vi.fn(),
    })
    expect(injected.hooks.workflowRuns.getSnapshot()).toStrictEqual(IDLE)
    injected.operations.observe(SESSION)
    expect(b.controller.source).toHaveBeenCalledWith(SESSION)

    const command = b.contribution()
    expect(command?.name).toBe('workflows')
    expect(command?.available({ sessionId: SESSION })).toBe(true)
    expect(command?.ui.kind).toBe('action')
    if (command?.ui.kind !== 'action') throw new Error('expected action command')
    await command.ui.run({ sessionId: SESSION })
    expect(open).toHaveBeenCalledOnce()
  })

  it('fails loud when the overlay has not mounted', async () => {
    const b = await bench()
    const command = b.contribution()
    if (command?.ui.kind !== 'action') throw new Error('expected action command')
    const action: ActionCommandUiSpec = command.ui
    expect(() => { void action.run({ sessionId: SESSION }) }).toThrow('workflow dashboard overlay is not mounted')
  })

  it('surfaces picker and launch failures without fallback behavior', async () => {
    const b = await bench()
    const decoration = b.decoration()
    expect(decoration?.available({ sessionId: SESSION })).toBe(true)
    if (decoration?.ui.kind !== 'popupSelect') throw new Error('expected popupSelect decoration')

    b.listDefinitions.mockResolvedValueOnce({
      ok: false,
      error: { code: 'BROKEN_REGISTRY', message: 'catalog unavailable' },
    } as never)
    await expect(decoration.ui.options({ sessionId: SESSION }, new AbortController().signal))
      .rejects.toThrow('workflow definitions failed: BROKEN_REGISTRY: catalog unavailable')

    await expect(decoration.ui.onSelect({ id: 'review-changes', label: 'review-changes' }, {
      sessionId: 'missing-session' as SessionId,
    })).rejects.toThrow('this session is not available')

    b.command.mockResolvedValueOnce({
      ok: false,
      error: { code: 'LAUNCH_FAILED', message: 'definition invalid' },
    } as never)
    await expect(decoration.ui.onSelect({ id: 'review-changes', label: 'review-changes' }, { sessionId: SESSION }))
      .rejects.toThrow('workflow launch failed: LAUNCH_FAILED: definition invalid')

    b.command.mockResolvedValueOnce({ ok: true, value: { matched: false } })
    await expect(decoration.ui.onSelect({ id: 'review-changes', label: 'review-changes' }, { sessionId: SESSION }))
      .rejects.toThrow('the host offers no /workflow command')
  })

  it('rejects direct application without the workflow controller', () => {
    const ctx = new Context()
    const locale = new LocaleRuntime(ctx)
    locale.setLocale('en')
    ctx.provide('locale', locale)
    expect(() => { apply(ctx) }).toThrow('workflow-runs controller is unavailable')
  })

  it('removes both registrations and releases observation on disposal', async () => {
    const b = await bench()
    const entry = b.ctx.slots.entries('shell.overlay')[0]
    const injected = (entry?.inject as unknown as (actions: unknown) => WorkflowsDashboardInjected)({
      open: vi.fn(), close: vi.fn(), selectRun: vi.fn(), reconcileRun: vi.fn(),
      selectMember: vi.fn(), selectTab: vi.fn(), showRuns: vi.fn(), showRun: vi.fn(),
    })
    injected.operations.observe(SESSION)
    await b.fiber.dispose()
    expect(b.contribution()).toBeUndefined()
    expect(b.decoration()).toBeUndefined()
    expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
    expect(injected.hooks.workflowRuns.getSnapshot()).toEqual(IDLE)
  })
})
