// @vitest-environment jsdom

import { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  JsonValue, SessionId, SupervisedWorkflowRunId, WorkflowMemberId, WorkflowRunHead,
  WorkflowRunArtifactChunk, WorkflowRunMemberDetail, WorkflowRunMemberHead,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  WorkflowsDashboard, type WorkflowsDashboardProps,
} from '../src/client/WorkflowsDashboard.tsx'
import type {
  WorkflowRunsOperations, WorkflowRunsSourceSnapshot,
} from '../src/client/contract.ts'
import { createWorkflowsStore, type WorkflowsState } from '../src/client/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = 'session-a' as SessionId
const CHILD = 'child-a' as SessionId
const RUN = 'run-a' as SupervisedWorkflowRunId
const MEMBER_A = 'member-a' as WorkflowMemberId
const MEMBER_B = 'member-b' as WorkflowMemberId

const HEAD: WorkflowRunHead = {
  runId: RUN,
  displayName: 'review-changes',
  name: 'review-changes',
  description: 'Review the selected change.',
  status: 'running',
  phase: 'Review',
  budget: { total: 8, spent: 2, remaining: 6 },
  memberCounts: { total: 2, running: 0, completed: 2, failed: 0, cancelled: 0 },
  startedAt: 1_000,
  allowedActions: ['pause', 'stop', 'save'],
  revision: 1,
  detailRevision: 1,
  membersRevision: 1,
  logsRevision: 1,
  resultRevision: 1,
  artifactsRevision: 1,
}

const A: WorkflowRunMemberHead = {
  memberId: MEMBER_A,
  seq: 1,
  label: 'Correctness reviewer',
  phase: 'Review',
  status: 'completed',
  startedAt: 1_100,
  settledAt: 1_200,
  outcome: 'available',
}

const B: WorkflowRunMemberHead = {
  memberId: MEMBER_B,
  seq: 2,
  label: 'Evidence skeptic',
  phase: 'Verify',
  status: 'completed',
  startedAt: 1_200,
  settledAt: 1_300,
  outcome: 'available',
}

function valueDetail(
  member: WorkflowRunMemberHead,
  value: JsonValue,
  childSessionId: SessionId = CHILD,
): WorkflowRunMemberDetail {
  return {
    member,
    childSessionId,
    outcome: {
      state: 'available',
      content: { kind: 'value', value },
      totalBytes: 32,
      truncated: false,
    },
  }
}

function runHead(
  id: string,
  status: WorkflowRunHead['status'],
  overrides: Partial<WorkflowRunHead> = {},
): WorkflowRunHead {
  return {
    ...HEAD,
    runId: id as SupervisedWorkflowRunId,
    displayName: id,
    name: id,
    status,
    ...overrides,
  }
}

function memberHead(
  id: string,
  status: WorkflowRunMemberHead['status'],
  outcome: WorkflowRunMemberHead['outcome'],
  overrides: Partial<WorkflowRunMemberHead> = {},
): WorkflowRunMemberHead {
  return {
    memberId: id as WorkflowMemberId,
    seq: Number(id.replace(/\D/g, '')) || 1,
    label: id,
    phase: 'Review',
    status,
    outcome,
    ...overrides,
  }
}

function withoutPhase<TValue extends { readonly phase?: string }>(value: TValue): Omit<TValue, 'phase'> {
  const { phase: _phase, ...without } = value
  return without
}

function operations(
  overrides: Partial<WorkflowRunsOperations> = {},
): WorkflowRunsOperations {
  return {
    observe: vi.fn(),
    refresh: vi.fn(async () => undefined),
    loadMore: vi.fn(async () => undefined),
    detail: vi.fn<WorkflowRunsOperations['detail']>(async () => ({ run: HEAD, phases: [] })),
    members: vi.fn<WorkflowRunsOperations['members']>(async () => ({ items: [A, B], total: 2, revision: 1 })),
    memberDetail: vi.fn<WorkflowRunsOperations['memberDetail']>(async (_session, _run, memberId) => (
      memberId === MEMBER_A
        ? valueDetail(A, { finding: 'Null check is missing.' }, CHILD)
        : valueDetail(B, 'Independently verified with line-level evidence.')
    )),
    logs: vi.fn<WorkflowRunsOperations['logs']>(async () => ({ items: [], evicted: 0, total: 0, revision: 1 })),
    result: vi.fn<WorkflowRunsOperations['result']>(async () => ({ value: { state: 'pending' }, revision: 1 })),
    artifacts: vi.fn<WorkflowRunsOperations['artifacts']>(async () => ({ items: [], omitted: 0, total: 0, revision: 1 })),
    artifact: vi.fn<WorkflowRunsOperations['artifact']>(async () => ({
      artifact: { name: 'report.md', bytes: 0 },
      text: '',
      offsetBytes: 0,
      returnedBytes: 0,
      totalBytes: 0,
      revision: 1,
    })),
    control: vi.fn<WorkflowRunsOperations['control']>(async () => ({ run: HEAD })),
    resolveAndOpenChild: vi.fn(async () => true),
    ...overrides,
  }
}

interface Bench {
  readonly mount: HTMLElement
  readonly shell: HTMLElement
  readonly opener: HTMLButtonElement
  readonly root: Root
  readonly store: ReturnType<ReturnType<typeof createWorkflowsStore>['create']>
  readonly operations: WorkflowRunsOperations
}

interface BenchOptions {
  readonly outsideOverlay?: boolean
  readonly openerAriaHidden?: string
  readonly openerInert?: boolean
  readonly translate?: (key: string, values?: Record<string, unknown>) => string
}

const benches: Bench[] = []

function bench(
  op = operations(),
  snapshot: WorkflowRunsSourceSnapshot = { phase: 'ready', runs: [HEAD], total: 1 },
  currentSession: SessionId | null = SESSION,
  options: BenchOptions = {},
): Bench {
  const shell = document.createElement('div')
  const opener = document.createElement('button')
  opener.textContent = 'Open workflows'
  if (options.openerInert === true) opener.setAttribute('inert', '')
  if (options.openerAriaHidden !== undefined) opener.setAttribute('aria-hidden', options.openerAriaHidden)
  const overlayLayer = document.createElement('div')
  overlayLayer.dataset.shellOverlay = ''
  const mount = document.createElement('div')
  if (options.outsideOverlay === true) shell.append(opener, mount)
  else {
    overlayLayer.append(mount)
    shell.append(opener, overlayLayer)
  }
  document.body.append(shell)
  const root = createRoot(mount)
  const store = createWorkflowsStore().create()
  store.actions.open()
  const useStore = <T,>(selector: (state: WorkflowsState) => T): T => useSyncExternalStore(
    listener => store.subscribe(listener),
    () => selector(store.getSnapshot()),
    () => selector(store.getSnapshot()),
  )
  const props = {
    useSessions: (selector: (state: { current: SessionId | undefined }) => unknown) => selector({
      current: currentSession ?? undefined,
    }),
    useStore,
    actions: store.actions,
    t: options.translate ?? ((key: string) => key),
    useWorkflowRuns: (selector: (state: WorkflowRunsSourceSnapshot) => unknown) => selector(snapshot),
    operations: op,
  }
  opener.focus()
  act(() => {
    root.render(<WorkflowsDashboard {...(props as unknown as WorkflowsDashboardProps)} />)
  })
  const value = { mount, shell, opener, root, store, operations: op }
  benches.push(value)
  return value
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function buttonContaining(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(button =>  button.textContent?.includes(text))
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`)
  return found
}

function release(b: Bench): void {
  act(() => { b.root.unmount() })
  b.shell.remove()
  benches.splice(benches.indexOf(b), 1)
}

afterEach(() => {
  for (const b of benches.splice(0)) {
    act(() => { b.root.unmount() })
    b.shell.remove()
  }
  vi.restoreAllMocks()
})

describe('WorkflowsDashboard', () => {
  it('renders every run and member lifecycle without losing phase identity', async () => {
    const statuses: WorkflowRunHead['status'][] = [
      'running', 'pausing', 'stopping', 'needs-input', 'paused', 'budget-limited',
      'completed', 'failed', 'cancelled', 'interrupted',
    ]
    const runs = statuses.map((status, index) => {
      const run = runHead(`run-${String(index)}`, status, {
        startedAt: 1_000 + index,
        ...(index > 6 ? { settledAt: 9_000 - index } : {}),
        ...(index === 0 ? {} : { phase: `phase-${String(index)}` }),
        budget: index === 0 ? { total: 0, spent: 0, remaining: 0 } : HEAD.budget,
      })
      return index === 0 ? withoutPhase(run) : run
    })
    const members = [
      withoutPhase(memberHead('member-1', 'running', 'pending')),
      memberHead('member-2', 'completed', 'available', { phase: '', startedAt: 0, settledAt: 90_000 }),
      memberHead('member-3', 'failed', 'not-produced', { phase: 'Review', startedAt: 0, settledAt: 7_200_000 }),
      memberHead('member-4', 'cancelled', 'evicted', { phase: 'Review', startedAt: 0, settledAt: 172_800_000 }),
    ]
    const b = bench(operations({
      members: vi.fn(async () => ({ items: members, total: members.length, revision: 1 })),
      memberDetail: vi.fn<WorkflowRunsOperations['memberDetail']>(async (_session, _run, memberId) => ({
        member: members.find(member => member.memberId === memberId) ?? members[0] as WorkflowRunMemberHead,
        childSessionId: CHILD,
        outcome: { state: 'pending' },
      })),
    }), { phase: 'ready', runs, total: runs.length })
    await settle()

    for (const status of statuses) expect(b.mount.textContent).toContain(`status.${status}`)
    expect(b.mount.textContent).toContain('runs.active')
    expect(b.mount.textContent).toContain('runs.history')
    expect(b.mount.textContent).toContain('phase.none')
    expect(b.mount.textContent).toContain('phase.unassigned')
    expect(b.mount.textContent).toContain('phase.empty')
    expect(b.mount.textContent).toContain('member.running')
    expect(b.mount.textContent).toContain('member.failed')
    expect(b.mount.textContent).toContain('member.cancelled')
    expect(b.mount.textContent).toContain('outcome.not-produced.short')
    expect(b.mount.textContent).toContain('outcome.evicted.short')
    expect(b.mount.textContent).toContain('duration.minutes')
    expect(b.mount.textContent).toContain('duration.hours')
    expect(b.mount.textContent).toContain('duration.days')
  })

  it('orders live runs oldest-first and history by settlement then start time', async () => {
    const runs = [
      runHead('live-new', 'running', { startedAt: 30 }),
      runHead('history-old', 'completed', { startedAt: 10, settledAt: 50 }),
      runHead('live-old', 'paused', { startedAt: 20 }),
      runHead('history-newer-start', 'failed', { startedAt: 40, settledAt: 100 }),
      runHead('history-older-start', 'cancelled', { startedAt: 35, settledAt: 100 }),
      runHead('history-without-settlement', 'interrupted', { startedAt: 150 }),
    ]
    const b = bench(operations(), { phase: 'ready', runs, total: runs.length })
    await settle()
    const labels = [...b.mount.querySelectorAll<HTMLButtonElement>('nav button')]
      .map(button => button.textContent ?? '')
    expect(labels[0]).toContain('live-old')
    expect(labels[1]).toContain('live-new')
    expect(labels[2]).toContain('history-without-settlement')
    expect(labels[3]).toContain('history-newer-start')
    expect(labels[4]).toContain('history-older-start')
    expect(labels[5]).toContain('history-old')
  })

  it('renders session, loading, load-error, and empty states with recovery', async () => {
    const noSession = bench(operations(), { phase: 'idle', runs: [], total: 0 }, null)
    expect(noSession.mount.textContent).toContain('session.empty.title')
    release(noSession)

    const loading = bench(operations(), { phase: 'loading', runs: [], total: 0 })
    expect(loading.mount.textContent).toContain('loading')
    release(loading)

    const refresh = vi.fn(async () => undefined)
    const failed = bench(operations({ refresh }), { phase: 'error', runs: [], total: 0 })
    expect(failed.mount.textContent).toContain('load.error.body')
    act(() => { buttonContaining(failed.mount, 'retry').click() })
    expect(refresh).toHaveBeenCalledExactlyOnceWith(SESSION)
    release(failed)

    const explicit = bench(operations(), { phase: 'error', runs: [], total: 0, error: 'wire unavailable' })
    expect(explicit.mount.textContent).toContain('wire unavailable')
    release(explicit)

    const empty = bench(operations(), { phase: 'ready', runs: [], total: 0 })
    expect(empty.mount.textContent).toContain('empty.title')
  })

  it('loads more retained runs and reconciles a stale selected run', async () => {
    const loadMore = vi.fn(async () => undefined)
    const history = runHead('old-run', 'completed', { settledAt: 2_000 })
    const b = bench(operations({ loadMore }), {
      phase: 'error',
      error: 'later refresh failed',
      runs: [HEAD, history],
      total: 3,
      nextCursor: 'runs-next' as never,
    })
    act(() => { b.store.actions.selectRun('missing-run') })
    await settle()
    expect(b.store.getSnapshot().selectedRunId).toBe(String(HEAD.runId))
    act(() => { buttonContaining(b.mount, 'load.more.runs').click() })
    expect(loadMore).toHaveBeenCalledExactlyOnceWith(SESSION)
    act(() => { buttonContaining(b.mount, 'old-run').click() })
    await settle()
    expect(b.store.getSnapshot().selectedRunId).toBe('old-run')
  })

  it('labels paged summary counts as loaded rows rather than the complete roster', async () => {
    const history = runHead('old-run', 'completed', { settledAt: 2_000 })
    const b = bench(operations(), {
      phase: 'ready', runs: [HEAD, history], total: 14, nextCursor: 'runs-next' as never,
    }, SESSION, {
      translate: (key, values) => key === 'summary.counts'
        ? `${String(values?.live)} active shown; ${String(values?.loaded)}/${String(values?.total)} loaded`
        : key,
    })
    await settle()
    expect(b.mount.textContent).toContain('1 active shown; 2/14 loaded')
  })

  it('refreshes elapsed durations while live work is visible and clears the timer', async () => {
    let tick: (() => void) | undefined
    const timerId = 17 as unknown as ReturnType<typeof window.setInterval>
    const interval = vi.spyOn(window, 'setInterval').mockImplementation((handler) => {
      tick = () => { handler() }
      return timerId
    })
    const clear = vi.spyOn(window, 'clearInterval').mockImplementation(() => {})
    const b = bench()
    await settle()
    act(() => { tick?.() })
    expect(interval).toHaveBeenCalled()
    release(b)
    expect(clear).toHaveBeenCalledWith(timerId)
  })

  it('selects any agent and shows complete JSON or Markdown outcomes', async () => {
    const b = bench()
    await settle()
    expect(b.mount.textContent).toContain('Null check is missing.')

    act(() => { buttonContaining(b.mount, 'Evidence skeptic').click() })
    await settle()
    expect(b.mount.textContent).toContain('Independently verified with line-level evidence.')
  })

  it('opens run-level output on drill-down layouts even when the run has no agents', async () => {
    const b = bench(operations({
      members: vi.fn<WorkflowRunsOperations['members']>(async () => ({
        items: [], total: 0, revision: 1,
      })),
      logs: vi.fn<WorkflowRunsOperations['logs']>(async () => ({
        items: [{ index: 0, text: 'zero-agent log' }], evicted: 0, total: 1, revision: 1,
      })),
    }))
    await settle()

    const outputLogs = b.mount.querySelector<HTMLButtonElement>('[data-workflow-output-tab="logs"]')
    if (outputLogs === null) throw new Error('run-output Logs control missing')
    act(() => { outputLogs.click() })
    await settle()

    expect(b.store.getSnapshot()).toMatchObject({ mobileView: 'inspector', inspectorTab: 'logs' })
    expect(b.mount.textContent).toContain('zero-agent log')
    expect(document.activeElement).toBe(b.mount.querySelector('[role="tab"][aria-selected="true"]'))
  })

  it('moves and restores focus across responsive run and member drill-downs', async () => {
    const b = bench()
    await settle()

    const run = b.mount.querySelector<HTMLButtonElement>(`[data-workflow-run-id="${String(RUN)}"]`)
    if (run === null) throw new Error('run row missing')
    act(() => { run.click() })
    await settle()
    expect(document.activeElement).toBe(b.mount.querySelector('#workflow-run-heading'))

    const member = b.mount.querySelector<HTMLButtonElement>(`[data-workflow-member-id="${String(MEMBER_A)}"]`)
    if (member === null) throw new Error('member row missing')
    act(() => { member.click() })
    await settle()
    expect(document.activeElement).toBe(b.mount.querySelector('[role="tab"][aria-selected="true"]'))

    const backToRun = [...b.mount.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'back.run')
    if (backToRun === undefined) throw new Error('run back control missing')
    act(() => { backToRun.click() })
    await settle()
    expect(document.activeElement).toBe(member)

    const backToRuns = [...b.mount.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'back.runs')
    if (backToRuns === undefined) throw new Error('runs back control missing')
    act(() => { backToRuns.click() })
    await settle()
    expect(document.activeElement).toBe(run)
  })

  it('opens only the selected member child through verified navigation', async () => {
    const resolveAndOpenChild = vi.fn(async () => true)
    const b = bench(operations({ resolveAndOpenChild }))
    await settle()

    act(() => { buttonContaining(b.mount, 'child.open').click() })
    await settle()

    expect(resolveAndOpenChild).toHaveBeenCalledExactlyOnceWith(SESSION, CHILD)
    expect(b.mount.querySelector('[data-workflows-dashboard]')).toBeNull()
  })

  it('keeps the dashboard open when child navigation is unavailable or fails', async () => {
    const unavailable = bench(operations({ resolveAndOpenChild: vi.fn(async () => false) }))
    await settle()
    act(() => { buttonContaining(unavailable.mount, 'child.open').click() })
    await settle()
    expect(unavailable.mount.textContent).toContain('child.unavailable')
    expect(unavailable.mount.querySelector('[data-workflows-dashboard]')).not.toBeNull()
    release(unavailable)

    const failed = bench(operations({
      resolveAndOpenChild: vi.fn(async () => { throw 'child lookup failed' }),
    }))
    await settle()
    act(() => { buttonContaining(failed.mount, 'child.open').click() })
    await settle()
    expect(failed.mount.textContent).toContain('child lookup failed')
  })

  it('keeps null, pending, unavailable, evicted, and truncated outcomes distinct', async () => {
    const variants: Array<[WorkflowRunMemberDetail['outcome'], string]> = [
      [{ state: 'available', content: { kind: 'value', value: null }, totalBytes: 4, truncated: false }, 'null'],
      [{ state: 'pending' }, 'outcome.pending.title'],
      [{ state: 'not-produced' }, 'outcome.not-produced.title'],
      [{ state: 'evicted' }, 'outcome.evicted.title'],
      [{
        state: 'available',
        content: { kind: 'preview', text: '{"partial":true}' },
        totalBytes: 9_999,
        truncated: true,
      }, '{"partial":true}'],
    ]
    for (const [outcome, visible] of variants) {
      const op = operations({
        memberDetail: vi.fn(async () => ({ member: A, childSessionId: CHILD, outcome })),
      })
      const b = bench(op)
      await settle()
      expect(b.mount.textContent).toContain(visible)
      act(() => { b.root.unmount() })
      b.shell.remove()
      benches.splice(benches.indexOf(b), 1)
    }
  })

  it('formats retained previews across byte ranges and exposes JSON copy labels', async () => {
    const variants: Array<[JsonValue, number, string]> = [
      [{ nested: { value: 0 } }, 32, '0'],
      [true, 10_240, '10 KB'],
      [{ nested: { value: 1 } }, 2_000_000, '1.9 MB'],
      [{ nested: { value: 2 } }, 12_000_000, '11 MB'],
    ]
    for (const [value, bytes, visible] of variants) {
      const outcome: WorkflowRunMemberDetail['outcome'] = bytes === 32
        ? { state: 'available' as const, content: { kind: 'value' as const, value }, totalBytes: bytes, truncated: false }
        : { state: 'available' as const, content: { kind: 'preview' as const, text: visible }, totalBytes: bytes, truncated: true }
      const b = bench(operations({
        memberDetail: vi.fn<WorkflowRunsOperations['memberDetail']>(async () => ({
          member: A,
          childSessionId: CHILD,
          outcome,
        })),
      }))
      await settle()
      expect(b.mount.textContent).toContain(visible)
      if (bytes === 32) {
        const row = b.mount.querySelector<HTMLElement>('[data-json-root-row]')
          ?? b.mount.querySelector<HTMLElement>('[role="tree"] > *')
        if (row === null) throw new Error('JSON row missing')
        act(() => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
        const copy = b.mount.querySelector<HTMLElement>('[data-json-copy-button]')
        expect(copy?.title ?? '').toContain('json.copy.button')
      }
      release(b)
    }
  })

  it('does not let a stale member response overwrite the newer selection', async () => {
    let resolveA: ((value: WorkflowRunMemberDetail) => void) | undefined
    const detailA = new Promise<WorkflowRunMemberDetail>((resolve) => { resolveA = resolve })
    const op = operations({
      memberDetail: vi.fn(async (_session, _run, memberId) => (
        memberId === MEMBER_A ? detailA : valueDetail(B, { verdict: 'new selection' })
      )),
    })
    const b = bench(op)
    await settle()
    act(() => { buttonContaining(b.mount, 'Evidence skeptic').click() })
    await settle()
    expect(b.mount.textContent).toContain('new selection')

    await act(async () => { resolveA?.(valueDetail(A, { verdict: 'stale selection' })); await detailA })
    expect(b.mount.textContent).not.toContain('stale selection')
    expect(b.mount.textContent).toContain('new selection')
  })

  it('suppresses abort failures from cancellable reads', async () => {
    const aborted = new DOMException('superseded', 'AbortError')
    const b = bench(operations({
      detail: vi.fn(async () => { throw aborted }),
      members: vi.fn(async () => { throw aborted }),
    }))
    await settle()
    expect(b.mount.textContent).not.toContain('superseded')
    expect(b.mount.textContent).toContain('agents.loading')
  })

  it('falls back to the first member when retained selection is absent', async () => {
    const b = bench()
    act(() => { b.store.actions.selectMember('missing-member') })
    await settle()
    expect(b.mount.textContent).toContain('Null check is missing.')
  })

  it('shows a member read failure and retries without changing selection', async () => {
    const read = vi.fn<WorkflowRunsOperations['memberDetail']>()
      .mockRejectedValueOnce(new Error('outcome unavailable'))
      .mockResolvedValue(valueDetail(A, { recovered: true }))
    const b = bench(operations({ memberDetail: read }))
    await settle()
    expect(b.mount.textContent).toContain('outcome unavailable')
    act(() => { buttonContaining(b.mount, 'retry').click() })
    await settle()
    expect(read).toHaveBeenCalledTimes(2)
    expect(b.mount.textContent).toContain('recovered')
  })

  it('keeps loaded pages visible when a later page fails and can retry it', async () => {
    const logs = vi.fn<WorkflowRunsOperations['logs']>()
      .mockResolvedValueOnce({
        items: [{ index: 0, text: 'retained first page' }],
        evicted: 0,
        total: 2,
        revision: 1,
        nextCursor: 'logs-next' as never,
      })
      .mockRejectedValueOnce(new Error('next page unavailable'))
      .mockResolvedValueOnce({
        items: [{ index: 1, text: 'recovered second page' }],
        evicted: 0,
        total: 2,
        revision: 1,
      })
    const b = bench(operations({ logs }))
    await settle()

    act(() => { buttonContaining(b.mount, 'tab.logs').click() })
    await settle()
    act(() => { buttonContaining(b.mount, 'load.more.logs').click() })
    await settle()
    expect(b.mount.textContent).toContain('retained first page')
    expect(b.mount.textContent).toContain('next page unavailable')

    act(() => { buttonContaining(b.mount, 'retry').click() })
    await settle()
    expect(b.mount.textContent).toContain('retained first page')
    expect(b.mount.textContent).toContain('recovered second page')
  })

  it('supports tab keyboard navigation and renders log/result/artifact read states', async () => {
    const logs = vi.fn<WorkflowRunsOperations['logs']>()
      .mockRejectedValueOnce(new Error('logs unavailable'))
      .mockResolvedValueOnce({ items: [], evicted: 0, total: 0, revision: 1 })
    const result = vi.fn<WorkflowRunsOperations['result']>()
      .mockRejectedValueOnce(new Error('result unavailable'))
      .mockResolvedValueOnce({
        value: { state: 'available', content: { kind: 'value', value: false }, totalBytes: 5, truncated: false },
        error: 'workflow result diagnostic',
        revision: 1,
      })
    const artifacts = vi.fn<WorkflowRunsOperations['artifacts']>()
      .mockRejectedValueOnce(new Error('artifacts unavailable'))
      .mockResolvedValue({ items: [], omitted: 0, total: 0, revision: 1 })
    const failedHead = runHead('failed-run', 'failed')
    const b = bench(operations({ logs, result, artifacts }), {
      phase: 'ready', runs: [failedHead], total: 1,
    })
    await settle()
    const tabs = b.mount.querySelector('[role="tablist"]')
    if (!(tabs instanceof HTMLElement)) throw new Error('tablist missing')

    act(() => { tabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    await settle()
    expect(b.mount.textContent).toContain('logs unavailable')
    act(() => { buttonContaining(b.mount, 'retry').click() })
    await settle()
    expect(b.mount.textContent).toContain('logs.empty.title')

    act(() => { tabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    await settle()
    expect(b.mount.textContent).toContain('result unavailable')
    act(() => { buttonContaining(b.mount, 'retry').click() })
    await settle()
    expect(b.mount.textContent).toContain('workflow result diagnostic')
    expect(b.mount.textContent).toContain('false')

    act(() => { tabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    await settle()
    expect(b.mount.textContent).toContain('artifacts unavailable')
    act(() => { buttonContaining(b.mount, 'retry').click() })
    await settle()
    expect(b.mount.textContent).toContain('artifacts.empty.title')

    act(() => { tabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
    await settle()
    expect(b.store.getSnapshot().inspectorTab).toBe('outcome')
    act(() => { tabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    await settle()
    expect(b.store.getSnapshot().inspectorTab).toBe('artifacts')
    act(() => { tabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    const outcomeTab = b.mount.querySelector<HTMLButtonElement>('#workflow-tab-outcome')
    if (outcomeTab === null) throw new Error('outcome tab missing')
    act(() => { outcomeTab.click() })
    expect(b.store.getSnapshot().inspectorTab).toBe('outcome')
  })

  it('distinguishes a failed run with no result message', async () => {
    const failedHead = runHead('failed-no-message', 'failed')
    const b = bench(operations({
      result: vi.fn<WorkflowRunsOperations['result']>(async () => ({
        value: { state: 'not-produced' }, revision: 1,
      })),
    }), { phase: 'ready', runs: [failedHead], total: 1 })
    await settle()
    act(() => { buttonContaining(b.mount, 'tab.result').click() })
    await settle()
    expect(b.mount.textContent).toContain('result.failed.no-message')
  })

  it('uses one allowed-action table for buttons and keyboard shortcuts', async () => {
    let settleControl: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { settleControl = resolve })
    const control = vi.fn<WorkflowRunsOperations['control']>(async () => {
      await pending
      return { run: HEAD }
    })
    const b = bench(operations({ control }))
    await settle()

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true })) })
    expect(control).not.toHaveBeenCalled()
    act(() => { buttonContaining(b.mount, 'Correctness reviewer').dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true })) })
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true })) })
    expect(control).toHaveBeenCalledTimes(1)
    expect(control).toHaveBeenCalledWith(SESSION, RUN, 'pause', 1, expect.any(AbortSignal))

    await act(async () => { settleControl?.(); await pending })
  })

  it('executes every visible control and surfaces non-cancellation failures', async () => {
    const all = runHead('all-controls', 'paused', {
      allowedActions: ['pause', 'resume', 'stop', 'save'],
    })
    const control = vi.fn<WorkflowRunsOperations['control']>(async () => ({ run: all }))
    const b = bench(operations({ control }), { phase: 'ready', runs: [all], total: 1 })
    await settle()
    for (const action of ['pause', 'resume', 'stop', 'save']) {
      act(() => { buttonContaining(b.mount, `control.${action}`).click() })
      await settle()
    }
    expect(control.mock.calls.map(call => call[2])).toEqual(['pause', 'resume', 'stop', 'save'])
    expect(b.mount.textContent).toContain('control.accepted')
    release(b)

    const rejected = bench(operations({
      control: vi.fn(async () => { throw 'host rejected control' }),
    }), { phase: 'ready', runs: [all], total: 1 })
    await settle()
    act(() => { buttonContaining(rejected.mount, 'control.stop').click() })
    await settle()
    expect(rejected.mount.textContent).toContain('host rejected control')
    release(rejected)

    const aborted = bench(operations({
      control: vi.fn(async () => { throw new DOMException('cancelled', 'AbortError') }),
    }), { phase: 'ready', runs: [all], total: 1 })
    await settle()
    act(() => { buttonContaining(aborted.mount, 'control.save').click() })
    await settle()
    expect(aborted.mount.textContent).not.toContain('cancelled')
  })

  it('drops control settlements after the selected run changes', async () => {
    let resolveControl: (() => void) | undefined
    let rejectControl: ((error: Error) => void) | undefined
    const first = new Promise<void>((resolve) => { resolveControl = resolve })
    const second = new Promise<void>((_resolve, reject) => { rejectControl = reject })
    const control = vi.fn<WorkflowRunsOperations['control']>()
      .mockImplementationOnce(async () => { await first; return { run: HEAD } })
      .mockImplementationOnce(async () => { await second; return { run: HEAD } })
    const next = runHead('next-run', 'running', { startedAt: 2_000 })
    const b = bench(operations({ control }), {
      phase: 'ready', runs: [HEAD, next], total: 2,
    })
    await settle()

    act(() => { buttonContaining(b.mount, 'control.pause').click() })
    act(() => { buttonContaining(b.mount, 'next-run').click() })
    await settle()
    await act(async () => { resolveControl?.(); await first })
    expect(b.mount.textContent).not.toContain('control.accepted')

    act(() => { buttonContaining(b.mount, 'control.pause').click() })
    act(() => { buttonContaining(b.mount, 'review-changes').click() })
    await settle()
    await act(async () => {
      rejectControl?.(new Error('stale control failure'))
      await second.catch(() => undefined)
    })
    expect(b.mount.textContent).not.toContain('stale control failure')
  })

  it('shows budget, gate, run-error, and declared phase progress', async () => {
    const limited = runHead('budget-run', 'budget-limited', {
      phase: 'Verify',
      budget: { total: 0, spent: 0, remaining: 0 },
      allowedActions: ['stop'],
    })
    const b = bench(operations({
      detail: vi.fn<WorkflowRunsOperations['detail']>(async () => ({
        run: limited,
        phases: [
          { title: 'Review', detail: 'inspect' },
          { title: 'Verify', detail: 'challenge' },
          { title: 'Report' },
        ],
        gate: { kind: 'verification', message: 'Confirm evidence', resumable: true },
        error: 'retained run diagnostic',
      })),
    }), { phase: 'ready', runs: [limited], total: 1 })
    await settle()
    expect(b.mount.textContent).toContain('budget.limit.title')
    expect(b.mount.textContent).toContain('budget.limit.body')
    expect(buttonContaining(b.mount, 'control.stop').disabled).toBe(false)
    expect([...b.mount.querySelectorAll('button')].some(button => button.textContent?.includes('control.save'))).toBe(false)
    expect(b.mount.textContent).toContain('Confirm evidence')
    expect(b.mount.textContent).toContain('gate.resumable')
    expect(b.mount.textContent).toContain('retained run diagnostic')
    expect(b.mount.textContent).toContain('phase.reached')
    expect(b.mount.textContent).toContain('phase.current')
    expect(b.mount.textContent).toContain('phase.upcoming')
    expect(b.mount.textContent?.match(/phase\.reached/g)).toHaveLength(1)
    expect(b.mount.textContent?.match(/phase\.current/g)).toHaveLength(1)
    expect(b.mount.textContent?.match(/phase\.upcoming/g)).toHaveLength(1)
    release(b)

    const undeclared = runHead('undeclared-phase', 'needs-input', { phase: 'Typo phase' })
    const repeated = bench(operations({
      detail: vi.fn<WorkflowRunsOperations['detail']>(async () => ({
        run: undeclared,
        phases: [],
        gate: { kind: 'user', message: 'Missing invariant', resumable: false },
      })),
    }), { phase: 'ready', runs: [undeclared], total: 1 })
    await settle()
    expect(repeated.mount.textContent).toContain('phase.undeclared')
    expect(repeated.mount.textContent).toContain('gate.repeats')
  })

  it('shows declared phases before a workflow reports its current phase', async () => {
    const waiting = withoutPhase(runHead('waiting-phase', 'running'))
    const b = bench(operations({
      detail: vi.fn(async () => ({ run: waiting, phases: [{ title: 'Review' }] })),
    }), { phase: 'ready', runs: [waiting], total: 1 })
    await settle()
    expect(b.mount.textContent).toContain('Review')
    expect(b.mount.textContent).toContain('phase.upcoming')
  })

  it('recovers detail and member-list reads and preserves the empty roster', async () => {
    const detail = vi.fn<WorkflowRunsOperations['detail']>()
      .mockRejectedValueOnce(new Error('detail unavailable'))
      .mockResolvedValue({ run: HEAD, phases: [] })
    const members = vi.fn<WorkflowRunsOperations['members']>()
      .mockRejectedValueOnce(new Error('members unavailable'))
      .mockResolvedValue({ items: [], total: 0, revision: 1 })
    const b = bench(operations({ detail, members }))
    await settle()
    expect(b.mount.textContent).toContain('detail unavailable')
    expect(b.mount.textContent).toContain('members unavailable')
    const retries = [...b.mount.querySelectorAll('button')].filter(button => button.textContent?.includes('retry'))
    act(() => { retries.forEach((button) => { button.click() }) })
    await settle()
    expect(b.mount.textContent).toContain('agents.empty')
    expect(detail).toHaveBeenCalledTimes(2)
    expect(members).toHaveBeenCalledTimes(2)
  })

  it('paginates members and retries a later member page without losing rows', async () => {
    const members = vi.fn<WorkflowRunsOperations['members']>()
      .mockResolvedValueOnce({ items: [A], total: 2, revision: 1, nextCursor: 'members-next' as never })
      .mockRejectedValueOnce(new Error('member page unavailable'))
      .mockResolvedValueOnce({ items: [B], total: 2, revision: 1 })
    const b = bench(operations({ members }))
    await settle()
    act(() => { buttonContaining(b.mount, 'load.more.agents').click() })
    await settle()
    expect(b.mount.textContent).toContain('Correctness reviewer')
    expect(b.mount.textContent).toContain('member page unavailable')
    act(() => { buttonContaining(b.mount, 'retry').click() })
    await settle()
    expect(b.mount.textContent).toContain('Evidence skeptic')
  })

  it('drops member pages that settle after their run is replaced', async () => {
    let resolvePage: ((value: { items: WorkflowRunMemberHead[]; total: number; revision: number }) => void) | undefined
    const pendingPage = new Promise<{ items: WorkflowRunMemberHead[]; total: number; revision: number }>((resolve) => {
      resolvePage = resolve
    })
    const next = runHead('next-run', 'running', { startedAt: 2_000 })
    const members = vi.fn<WorkflowRunsOperations['members']>(async (_session, runId, cursor) => {
      if (runId === RUN && cursor === undefined) {
        return { items: [A], total: 2, revision: 1, nextCursor: 'members-next' as never }
      }
      if (runId === RUN) return pendingPage
      return { items: [B], total: 1, revision: 1 }
    })
    const b = bench(operations({ members }), {
      phase: 'ready', runs: [HEAD, next], total: 2,
    })
    await settle()
    act(() => { buttonContaining(b.mount, 'load.more.agents').click() })
    act(() => { buttonContaining(b.mount, 'next-run').click() })
    await settle()
    await act(async () => {
      resolvePage?.({ items: [memberHead('stale-member', 'completed', 'available')], total: 2, revision: 1 })
      await pendingPage
    })
    expect(b.mount.textContent).toContain('Evidence skeptic')
    expect(b.mount.textContent).not.toContain('stale-member')
  })

  it('drops member-page failures that arrive after their run is replaced', async () => {
    let rejectPage: ((error: Error) => void) | undefined
    const pendingPage = new Promise<never>((_resolve, reject) => { rejectPage = reject })
    const next = runHead('next-run', 'running', { startedAt: 2_000 })
    const members = vi.fn<WorkflowRunsOperations['members']>(async (_session, runId, cursor) => {
      if (runId === RUN && cursor === undefined) {
        return { items: [A], total: 2, revision: 1, nextCursor: 'members-next' as never }
      }
      if (runId === RUN) return pendingPage
      return { items: [B], total: 1, revision: 1 }
    })
    const b = bench(operations({ members }), {
      phase: 'ready', runs: [HEAD, next], total: 2,
    })
    await settle()
    act(() => { buttonContaining(b.mount, 'load.more.agents').click() })
    act(() => { buttonContaining(b.mount, 'next-run').click() })
    await settle()
    await act(async () => {
      rejectPage?.(new Error('stale page failure'))
      await pendingPage.catch(() => undefined)
    })
    expect(b.mount.textContent).toContain('Evidence skeptic')
    expect(b.mount.textContent).not.toContain('stale page failure')
  })

  it('admits at most one pending page for each visible paginator', async () => {
    let resolveMembers: ((value: { items: WorkflowRunMemberHead[]; total: number; revision: number }) => void) | undefined
    let resolveLogs: ((value: { items: []; evicted: number; total: number; revision: number }) => void) | undefined
    let resolveArtifacts: ((value: { items: []; omitted: number; total: number; revision: number }) => void) | undefined
    const memberPage = new Promise<{
      items: WorkflowRunMemberHead[]
      total: number
      revision: number
    }>((resolve) => { resolveMembers = resolve })
    const logPage = new Promise<{
      items: []
      evicted: number
      total: number
      revision: number
    }>((resolve) => { resolveLogs = resolve })
    const artifactPage = new Promise<{
      items: []
      omitted: number
      total: number
      revision: number
    }>((resolve) => { resolveArtifacts = resolve })
    const members = vi.fn<WorkflowRunsOperations['members']>()
      .mockResolvedValueOnce({ items: [A], total: 2, revision: 1, nextCursor: 'members-next' as never })
      .mockReturnValueOnce(memberPage)
    const logs = vi.fn<WorkflowRunsOperations['logs']>()
      .mockResolvedValueOnce({
        items: [{ index: 0, text: 'first log' }], evicted: 0, total: 2,
        revision: 1, nextCursor: 'logs-next' as never,
      })
      .mockReturnValueOnce(logPage)
    const artifacts = vi.fn<WorkflowRunsOperations['artifacts']>()
      .mockResolvedValueOnce({
        items: [{ name: 'first.md', bytes: 4 }], omitted: 0, total: 2,
        revision: 1, nextCursor: 'artifacts-next' as never,
      })
      .mockReturnValueOnce(artifactPage)
    const b = bench(operations({ members, logs, artifacts }))
    await settle()

    const memberMore = buttonContaining(b.mount, 'load.more.agents')
    act(() => { memberMore.click(); memberMore.click() })
    expect(members).toHaveBeenCalledTimes(2)
    await act(async () => { resolveMembers?.({ items: [B], total: 2, revision: 1 }); await memberPage })

    act(() => { buttonContaining(b.mount, 'tab.logs').click() })
    await settle()
    const logMore = buttonContaining(b.mount, 'load.more.logs')
    act(() => { logMore.click(); logMore.click() })
    expect(logs).toHaveBeenCalledTimes(2)
    await act(async () => { resolveLogs?.({ items: [], evicted: 0, total: 2, revision: 1 }); await logPage })

    act(() => { buttonContaining(b.mount, 'tab.artifacts').click() })
    await settle()
    const artifactMore = [...b.mount.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === 'load.more.artifacts')
    if (artifactMore === undefined) throw new Error('artifact metadata paginator missing')
    act(() => { artifactMore.click(); artifactMore.click() })
    expect(artifacts).toHaveBeenCalledTimes(2)
    await act(async () => {
      resolveArtifacts?.({ items: [], omitted: 0, total: 2, revision: 1 })
      await artifactPage
    })
  })

  it('takes and traps focus, makes the shell inert, closes on Escape, and restores its opener', async () => {
    const b = bench()
    await settle()
    const dialog = b.mount.querySelector<HTMLElement>('[data-workflows-dashboard]')
    expect(dialog).not.toBeNull()
    expect(dialog?.contains(document.activeElement)).toBe(true)
    expect(b.opener.inert).toBe(true)
    expect(b.opener.getAttribute('aria-hidden')).toBe('true')

    const focusable = [...b.mount.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
    const first = focusable[0]
    const last = focusable.at(-1)
    last?.focus()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
    expect(document.activeElement).toBe(first)

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(b.mount.querySelector('[data-workflows-dashboard]')).toBeNull()
    expect(b.opener.hasAttribute('inert')).toBe(false)
    expect(b.opener.hasAttribute('aria-hidden')).toBe(false)
    expect(document.activeElement).toBe(b.opener)
  })

  it('redirects escaped focus, wraps Shift+Tab, and ignores typing/modifier shortcuts', async () => {
    const control = vi.fn<WorkflowRunsOperations['control']>(async () => ({ run: HEAD }))
    const b = bench(operations({ control }))
    await settle()
    const dialog = b.mount.querySelector<HTMLElement>('[data-workflows-dashboard]')
    if (dialog === null) throw new Error('dashboard missing')
    b.opener.focus()
    expect(dialog.contains(document.activeElement)).toBe(true)

    const targets = [...b.mount.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
    const first = targets[0]
    dialog.focus()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })) })
    expect(document.activeElement).toBe(targets.at(-1))
    first?.focus()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })) })
    expect(document.activeElement).toBe(targets.at(-1))

    const input = document.createElement('input')
    dialog.append(input)
    for (const init of [
      { key: 'p', metaKey: true }, { key: 'p', ctrlKey: true }, { key: 'p', altKey: true },
      { key: 'p', shiftKey: true }, { key: 'p', repeat: true },
    ]) {
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true })) })
    }
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true })) })
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true })) })
    expect(control).not.toHaveBeenCalled()
  })

  it('excludes hidden controls from focus wrapping and restores prior shell attributes', async () => {
    const b = bench(operations(), undefined, SESSION, {
      openerAriaHidden: 'false', openerInert: true,
    })
    await settle()
    const buttons = [...b.mount.querySelectorAll<HTMLButtonElement>('button')]
    if (buttons[0] !== undefined) buttons[0].hidden = true
    if (buttons[1] !== undefined) buttons[1].style.visibility = 'hidden'
    if (buttons[2] !== undefined) buttons[2].style.display = 'none'
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
    release(b)
    expect(b.opener.hasAttribute('inert')).toBe(true)
    expect(b.opener.getAttribute('aria-hidden')).toBe('false')
  })

  it('keeps focus inside a dashboard with no interactive descendants', async () => {
    const b = bench(operations(), undefined, SESSION, { outsideOverlay: true })
    await settle()
    const dialog = b.mount.querySelector<HTMLElement>('[data-workflows-dashboard]')
    if (dialog === null) throw new Error('dashboard missing')
    for (const target of b.mount.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])')) {
      target.hidden = true
    }
    b.opener.focus()
    expect(document.activeElement).toBe(dialog)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
    expect(document.activeElement).toBe(dialog)
    expect(b.opener.hasAttribute('inert')).toBe(false)
  })

  it('does not focus an opener removed before the dashboard closes', async () => {
    const b = bench()
    await settle()
    b.opener.remove()
    act(() => { b.store.actions.close() })
    expect(b.mount.querySelector('[data-workflows-dashboard]')).toBeNull()
  })

  it('renders an explicit empty state without issuing detail reads', async () => {
    const detail = vi.fn<WorkflowRunsOperations['detail']>(async () => ({ run: HEAD, phases: [] }))
    const op = operations({ detail })
    const b = bench(op, { phase: 'ready', runs: [], total: 0 })
    await settle()
    expect(b.mount.textContent).toContain('empty.title')
    expect(detail).not.toHaveBeenCalled()
  })

  it('selects and progressively reads scratch artifact content', async () => {
    const artifact = vi.fn<WorkflowRunsOperations['artifact']>(async (_session, _run, _name, cursor) => (
      cursor === undefined
        ? {
          artifact: { name: 'report.md', bytes: 22 },
          text: '# Report\nFirst',
          offsetBytes: 0,
          returnedBytes: 14,
          totalBytes: 22,
          revision: 1,
          nextCursor: 'artifact-next' as never,
        }
        : {
          artifact: { name: 'report.md', bytes: 22 },
          text: ' second',
          offsetBytes: 14,
          returnedBytes: 8,
          totalBytes: 22,
          revision: 1,
        }
    ))
    const b = bench(operations({
      artifacts: vi.fn(async () => ({
        items: [{ name: 'report.md', bytes: 22 }],
        omitted: 0,
        total: 1,
        revision: 1,
      })),
      artifact,
    }))
    await settle()
    act(() => { buttonContaining(b.mount, 'tab.artifacts').click() })
    await settle()
    await settle()
    expect(b.mount.textContent).toContain('First')
    expect(artifact).toHaveBeenCalledWith(SESSION, RUN, 'report.md', undefined, 1, expect.any(AbortSignal))

    act(() => { buttonContaining(b.mount, 'load.more.artifacts').click() })
    await settle()
    expect(b.mount.textContent).toContain('second')
    expect(artifact).toHaveBeenLastCalledWith(SESSION, RUN, 'report.md', 'artifact-next', 1)
  })

  it('discloses evicted log prefixes and omitted artifact-name counts', async () => {
    const b = bench(operations({
      logs: vi.fn(async () => ({
        items: [{ index: 5, text: 'first retained line' }], evicted: 5, total: 6, revision: 1,
      })),
      artifacts: vi.fn(async () => ({
        items: [{ name: 'retained.md', bytes: 4 }], omitted: 3, total: 4, revision: 1,
      })),
      artifact: vi.fn(async () => ({
        artifact: { name: 'retained.md', bytes: 4 }, text: 'kept', offsetBytes: 0,
        returnedBytes: 4, totalBytes: 4, revision: 1,
      })),
    }), undefined, SESSION, {
      translate: (key, values) => key === 'logs.evicted' || key === 'artifacts.omitted'
        ? `${key}:${String(values?.count)}`
        : key,
    })
    await settle()
    act(() => { buttonContaining(b.mount, 'tab.logs').click() })
    await settle()
    expect(b.mount.textContent).toContain('logs.evicted:5')
    expect(b.mount.textContent).toContain('006')
    expect(b.mount.textContent).toContain('first retained line')

    act(() => { buttonContaining(b.mount, 'tab.artifacts').click() })
    await settle()
    expect(b.mount.textContent).toContain('artifacts.omitted:3')
    expect(b.mount.textContent).toContain('retained.md')
  })

  it('discloses retention loss even when no retained row remains', async () => {
    const b = bench(operations({
      logs: vi.fn(async () => ({ items: [], evicted: 2, total: 2, revision: 1 })),
      artifacts: vi.fn(async () => ({ items: [], omitted: 2, total: 2, revision: 1 })),
    }))
    await settle()
    act(() => { buttonContaining(b.mount, 'tab.logs').click() })
    await settle()
    expect(b.mount.textContent).toContain('logs.evicted')
    expect(b.mount.textContent).toContain('logs.retained.empty.title')
    expect(b.mount.textContent).not.toContain('logs.empty.body')
    act(() => { buttonContaining(b.mount, 'tab.artifacts').click() })
    await settle()
    expect(b.mount.textContent).toContain('artifacts.omitted')
    expect(b.mount.textContent).toContain('artifacts.retained.empty.title')
    expect(b.mount.textContent).not.toContain('artifacts.empty.body')
  })

  it('keeps loaded artifact content when a later chunk fails and retries it', async () => {
    const artifact = vi.fn<WorkflowRunsOperations['artifact']>()
      .mockResolvedValueOnce({
        artifact: { name: 'report.txt', bytes: 12 },
        text: 'first',
        offsetBytes: 0,
        returnedBytes: 5,
        totalBytes: 12,
        revision: 1,
        nextCursor: 'artifact-next' as never,
      })
      .mockRejectedValueOnce(new Error('artifact chunk unavailable'))
      .mockResolvedValueOnce({
        artifact: { name: 'report.txt', bytes: 12 },
        text: ' second',
        offsetBytes: 5,
        returnedBytes: 7,
        totalBytes: 12,
        revision: 1,
      })
      .mockResolvedValue({
        artifact: { name: 'large.bin', bytes: 12_000_000 },
        text: 'binary preview', offsetBytes: 0, returnedBytes: 14,
        totalBytes: 12_000_000, revision: 1,
      })
    const b = bench(operations({
      artifacts: vi.fn(async () => ({
        items: [
          { name: 'report.txt', bytes: 12 },
          { name: 'large.bin', bytes: 12_000_000 },
        ],
        omitted: 0,
        total: 2,
        revision: 1,
      })),
      artifact,
    }))
    await settle()
    act(() => { buttonContaining(b.mount, 'tab.artifacts').click() })
    await settle()
    expect(b.mount.textContent).toContain('first')
    act(() => { buttonContaining(b.mount, 'load.more.artifacts').click() })
    await settle()
    expect(b.mount.textContent).toContain('first')
    expect(b.mount.textContent).toContain('artifact chunk unavailable')
    act(() => { buttonContaining(b.mount, 'retry').click() })
    await settle()
    expect(b.mount.textContent).toContain('first second')

    act(() => { buttonContaining(b.mount, 'large.bin').click() })
    await settle()
    expect(artifact).toHaveBeenLastCalledWith(SESSION, RUN, 'large.bin', undefined, 1, expect.any(AbortSignal))
  })

  it('drops initial artifact reads that settle after another artifact is selected', async () => {
    let resolveFirst: ((value: WorkflowRunArtifactChunk) => void) | undefined
    const first = new Promise<WorkflowRunArtifactChunk>((resolve) => { resolveFirst = resolve })
    const artifact = vi.fn<WorkflowRunsOperations['artifact']>(async (_session, _run, name) => {
      if (name === 'first.md') return first
      return {
        artifact: { name, bytes: 6 }, text: 'second', offsetBytes: 0,
        returnedBytes: 6, totalBytes: 6, revision: 1,
      }
    })
    const b = bench(operations({
      artifacts: vi.fn(async () => ({
        items: [{ name: 'first.md', bytes: 5 }, { name: 'second.md', bytes: 6 }],
        omitted: 0, total: 2, revision: 1,
      })),
      artifact,
    }))
    await settle()
    act(() => { buttonContaining(b.mount, 'tab.artifacts').click() })
    await settle()
    act(() => { buttonContaining(b.mount, 'second.md').click() })
    await settle()
    expect(b.mount.textContent).toContain('second')
    await act(async () => {
      resolveFirst?.({
        artifact: { name: 'first.md', bytes: 5 }, text: 'stale-first', offsetBytes: 0,
        returnedBytes: 5, totalBytes: 5, revision: 1,
      })
      await first
    })
    expect(b.mount.textContent).toContain('second')
    expect(b.mount.textContent).not.toContain('stale-first')
  })

  it('drops initial artifact failures after another artifact is selected', async () => {
    let rejectFirst: ((error: Error) => void) | undefined
    const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject })
    const artifact = vi.fn<WorkflowRunsOperations['artifact']>(async (_session, _run, name) => {
      if (name === 'first.md') return first
      return {
        artifact: { name, bytes: 6 }, text: 'second', offsetBytes: 0,
        returnedBytes: 6, totalBytes: 6, revision: 1,
      }
    })
    const b = bench(operations({
      artifacts: vi.fn(async () => ({
        items: [{ name: 'first.md', bytes: 5 }, { name: 'second.md', bytes: 6 }],
        omitted: 0, total: 2, revision: 1,
      })),
      artifact,
    }))
    await settle()
    act(() => { buttonContaining(b.mount, 'tab.artifacts').click() })
    await settle()
    act(() => { buttonContaining(b.mount, 'second.md').click() })
    await settle()
    await act(async () => {
      rejectFirst?.(new Error('stale artifact failure'))
      await first.catch(() => undefined)
    })
    expect(b.mount.textContent).toContain('second')
    expect(b.mount.textContent).not.toContain('stale artifact failure')
  })

  it('drops artifact chunks that settle after another artifact is selected', async () => {
    let resolveChunk: ((value: WorkflowRunArtifactChunk) => void) | undefined
    const chunk = new Promise<WorkflowRunArtifactChunk>((resolve) => { resolveChunk = resolve })
    const artifact = vi.fn<WorkflowRunsOperations['artifact']>(async (_session, _run, name, cursor) => {
      if (cursor !== undefined) return chunk
      return {
        artifact: { name, bytes: 12 }, text: name === 'first.txt' ? 'first' : 'second',
        offsetBytes: 0, returnedBytes: 5, totalBytes: 12, revision: 1,
        ...(name === 'first.txt' ? { nextCursor: 'chunk-next' as never } : {}),
      }
    })
    const b = bench(operations({
      artifacts: vi.fn(async () => ({
        items: [{ name: 'first.txt', bytes: 12 }, { name: 'second.txt', bytes: 12 }],
        omitted: 0, total: 2, revision: 1,
      })),
      artifact,
    }))
    await settle()
    act(() => { buttonContaining(b.mount, 'tab.artifacts').click() })
    await settle()
    const more = buttonContaining(b.mount, 'load.more.artifacts')
    act(() => { more.click(); more.click() })
    expect(artifact).toHaveBeenCalledTimes(2)
    act(() => { buttonContaining(b.mount, 'second.txt').click() })
    await settle()
    await act(async () => {
      resolveChunk?.({
        artifact: { name: 'first.txt', bytes: 12 }, text: '-stale', offsetBytes: 5,
        returnedBytes: 6, totalBytes: 12, revision: 1,
      })
      await chunk
    })
    expect(b.mount.textContent).toContain('second')
    expect(b.mount.textContent).not.toContain('first-stale')
  })

  it('drops artifact chunk failures after another artifact is selected', async () => {
    let rejectChunk: ((error: Error) => void) | undefined
    const chunk = new Promise<never>((_resolve, reject) => { rejectChunk = reject })
    const artifact = vi.fn<WorkflowRunsOperations['artifact']>(async (_session, _run, name, cursor) => {
      if (cursor !== undefined) return chunk
      return {
        artifact: { name, bytes: 12 }, text: name === 'first.txt' ? 'first' : 'second',
        offsetBytes: 0, returnedBytes: 5, totalBytes: 12, revision: 1,
        ...(name === 'first.txt' ? { nextCursor: 'chunk-next' as never } : {}),
      }
    })
    const b = bench(operations({
      artifacts: vi.fn(async () => ({
        items: [{ name: 'first.txt', bytes: 12 }, { name: 'second.txt', bytes: 12 }],
        omitted: 0, total: 2, revision: 1,
      })),
      artifact,
    }))
    await settle()
    act(() => { buttonContaining(b.mount, 'tab.artifacts').click() })
    await settle()
    act(() => { buttonContaining(b.mount, 'load.more.artifacts').click() })
    act(() => { buttonContaining(b.mount, 'second.txt').click() })
    await settle()
    await act(async () => {
      rejectChunk?.(new Error('stale chunk failure'))
      await chunk.catch(() => undefined)
    })
    expect(b.mount.textContent).toContain('second')
    expect(b.mount.textContent).not.toContain('stale chunk failure')
  })

  it('retries an initial artifact content failure', async () => {
    const artifact = vi.fn<WorkflowRunsOperations['artifact']>()
      .mockRejectedValueOnce(new Error('artifact unavailable'))
      .mockResolvedValueOnce({
        artifact: { name: 'report.md', bytes: 4 }, text: 'done', offsetBytes: 0,
        returnedBytes: 4, totalBytes: 4, revision: 1,
      })
    const b = bench(operations({
      artifacts: vi.fn(async () => ({
        items: [{ name: 'report.md', bytes: 4 }], omitted: 0, total: 1, revision: 1,
      })),
      artifact,
    }))
    await settle()
    act(() => { buttonContaining(b.mount, 'tab.artifacts').click() })
    await settle()
    expect(b.mount.textContent).toContain('artifact unavailable')
    act(() => { buttonContaining(b.mount, 'retry').click() })
    await settle()
    expect(b.mount.textContent).toContain('done')
  })

  it('paginates artifact metadata without hiding the selected content', async () => {
    const artifacts = vi.fn<WorkflowRunsOperations['artifacts']>()
      .mockResolvedValueOnce({
        items: [{ name: 'first.md', bytes: 4 }], omitted: 0, total: 2, revision: 1,
        nextCursor: 'artifacts-next' as never,
      })
      .mockRejectedValueOnce(new Error('artifact page unavailable'))
      .mockResolvedValueOnce({
        items: [{ name: 'second.md', bytes: 4 }], omitted: 0, total: 2, revision: 1,
      })
    const b = bench(operations({
      artifacts,
      artifact: vi.fn<WorkflowRunsOperations['artifact']>(async (_session, _run, name) => ({
        artifact: { name, bytes: 4 }, text: 'kept content', offsetBytes: 0,
        returnedBytes: 4, totalBytes: 4, revision: 1,
      })),
    }))
    await settle()
    act(() => { buttonContaining(b.mount, 'tab.artifacts').click() })
    await settle()
    act(() => { buttonContaining(b.mount, 'load.more.artifacts').click() })
    await settle()
    expect(b.mount.textContent).toContain('kept content')
    expect(b.mount.textContent).toContain('artifact page unavailable')
    act(() => { buttonContaining(b.mount, 'retry').click() })
    await settle()
    expect(b.mount.textContent).toContain('first.md')
    expect(b.mount.textContent).toContain('second.md')
  })
})
