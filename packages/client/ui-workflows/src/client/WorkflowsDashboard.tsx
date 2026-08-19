import clsx from 'clsx'
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent,
} from 'react'
import type { ObservableSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  SupervisedWorkflowRunId,
  WorkflowMemberId,
  WorkflowRunAction,
  WorkflowRunArtifactChunk,
  WorkflowRunArtifactPage,
  WorkflowRunDetail,
  WorkflowRunHead,
  WorkflowRunLogPage,
  WorkflowRunMemberDetail,
  WorkflowRunMemberHead,
  WorkflowRunMemberPage,
  WorkflowRunResultView,
  WorkflowRunStatus,
  WorkflowRunValueView,
  WorkflowPhase,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  InjectFace, PropsLocale, PropsRuntime, PropsStore, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  CodeBlock,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconDownloadOutline16,
  IconPauseOutline16,
  IconPlayOutline16,
  IconRefreshOutline16,
  IconRightUpOutline16,
  IconStopFill16,
  JsonTree,
  MarkdownText,
  StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkflowRunsOperations, WorkflowRunsSourceSnapshot } from './contract.ts'
import { createWorkflowsStore, type WorkflowInspectorTab } from './store.ts'
import { NS } from './locales.ts'
import css from './WorkflowsDashboard.module.css'

/** Full component props: runtime, interaction store, locale, and business adapter. */
export type WorkflowsDashboardProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createWorkflowsStore>>
  & PropsLocale<typeof NS>
  & InjectFace<WorkflowsDashboardInjected>

/** Business dependencies supplied by the browser plugin. */
export interface WorkflowsDashboardInjected {
  hooks: {
    /** Observed session's bounded run heads, bound as `useWorkflowRuns`. */
    workflowRuns: ObservableSnapshot<WorkflowRunsSourceSnapshot>
  }
  /** Observation ownership, on-demand reads, controls, and child navigation. */
  operations: WorkflowRunsOperations
}

type T = TranslateNS<typeof NS>
type Loadable<TValue> =
  | { phase: 'loading' }
  | { phase: 'ready'; value: TValue }
  | { phase: 'error'; error: string }

/** Closed-union backstop for browser-safe protocol enums. */
/* v8 ignore next 3 -- only forged protocol values can reach this backstop. */
function assertNever(value: never): never {
  throw new Error(`unhandled workflow dashboard value: ${JSON.stringify(value)}`)
}

/** Whether a run belongs in the live navigator group. */
function isActive(status: WorkflowRunStatus): boolean {
  switch (status) {
    case 'running':
    case 'pausing':
    case 'stopping':
    case 'needs-input':
    case 'paused':
    case 'budget-limited': return true
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'interrupted': return false
    /* v8 ignore next -- closed protocol status union. */
    default: return assertNever(status)
  }
}

/** Status marker semantics shared by list and detail headers. */
function runDot(status: WorkflowRunStatus): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'pausing':
    case 'stopping':
    case 'needs-input':
    case 'paused':
    case 'budget-limited':
    case 'cancelled': return 'warning'
    case 'completed': return 'done'
    case 'failed':
    case 'interrupted': return 'error'
    /* v8 ignore next -- closed protocol status union. */
    default: return assertNever(status)
  }
}

/** Localized run lifecycle label. */
function statusLabel(status: WorkflowRunStatus, t: T): string {
  switch (status) {
    case 'running': return t('status.running')
    case 'pausing': return t('status.pausing')
    case 'stopping': return t('status.stopping')
    case 'needs-input': return t('status.needs-input')
    case 'paused': return t('status.paused')
    case 'budget-limited': return t('status.budget-limited')
    case 'completed': return t('status.completed')
    case 'failed': return t('status.failed')
    case 'cancelled': return t('status.cancelled')
    case 'interrupted': return t('status.interrupted')
    /* v8 ignore next -- closed protocol status union. */
    default: return assertNever(status)
  }
}

/** Member marker semantics. */
function memberDot(status: WorkflowRunMemberHead['status']): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'cancelled': return 'warning'
    /* v8 ignore next -- closed protocol member-status union. */
    default: return assertNever(status)
  }
}

/** Localized member lifecycle label. */
function memberStatusLabel(status: WorkflowRunMemberHead['status'], t: T): string {
  switch (status) {
    case 'running': return t('member.running')
    case 'completed': return t('member.completed')
    case 'failed': return t('member.failed')
    case 'cancelled': return t('member.cancelled')
    /* v8 ignore next -- closed protocol member-status union. */
    default: return assertNever(status)
  }
}

/** Localized member-outcome availability label. */
function outcomeLabel(state: WorkflowRunMemberHead['outcome'], t: T): string {
  switch (state) {
    case 'pending': return t('outcome.pending.short')
    case 'available': return t('outcome.available.short')
    case 'not-produced': return t('outcome.not-produced.short')
    case 'evicted': return t('outcome.evicted.short')
    /* v8 ignore next -- closed protocol outcome-status union. */
    default: return assertNever(state)
  }
}

/** Stable ordering: active oldest-first, history newest-first. */
function orderRuns(runs: readonly WorkflowRunHead[]): WorkflowRunHead[] {
  return [...runs].sort((left, right) => {
    const leftActive = isActive(left.status)
    const rightActive = isActive(right.status)
    if (leftActive !== rightActive) return leftActive ? -1 : 1
    if (leftActive) return left.startedAt - right.startedAt
    const leftEnd = left.settledAt ?? left.startedAt
    const rightEnd = right.settledAt ?? right.startedAt
    return rightEnd - leftEnd || right.startedAt - left.startedAt
  })
}

/** Compact elapsed duration for high-density metadata. */
function formatDuration(ms: number, t: T): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 60) return t('duration.seconds', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('duration.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('duration.hours', { count: hours })
  return t('duration.days', { count: Math.floor(hours / 24) })
}

/** Human byte quantity for retained outcomes and artifacts. */
function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`
}

/** Exact grouping preserving omitted phase versus the empty string. */
function groupMembers(members: readonly WorkflowRunMemberHead[]): Array<{
  key: string
  phase: string | undefined
  members: WorkflowRunMemberHead[]
}> {
  const groups = new Map<string, { phase: string | undefined; members: WorkflowRunMemberHead[] }>()
  for (const member of members) {
    const key = member.phase === undefined ? 'missing' : `value:${String(member.phase.length)}:${member.phase}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { phase: member.phase, members: [member] })
    else group.members.push(member)
  }
  return [...groups].map(([key, group]) => ({ key, ...group }))
}

/** Suppress cancellation rejections after a selection changes. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Settle one cancellable detail read without publishing stale or aborted state. */
function settleLoad<TValue>(
  request: Promise<TValue>,
  signal: AbortSignal | undefined,
  publish: (state: Loadable<TValue>) => void,
): void {
  void request.then(
    (value) => {
      if (signal?.aborted !== true) publish({ phase: 'ready', value })
    },
    (error: unknown) => {
      if (signal?.aborted !== true && !isAbort(error)) {
        publish({ phase: 'error', error: errorText(error) })
      }
    },
  )
}

/** Append one cursor page while preserving already-rendered rows on failure. */
function appendPage<TPage extends { items: readonly unknown[] }>(options: {
  request: Promise<TPage>
  previous: TPage
  generation: number
  currentGeneration: () => number
  publish: (state: Loadable<TPage>) => void
  publishError: (error: string) => void
  release: () => void
}): void {
  void options.request.then(
    (page) => {
      if (options.currentGeneration() === options.generation) {
        options.publish({
          phase: 'ready',
          value: { ...page, items: [...options.previous.items, ...page.items] },
        })
      }
    },
    (error: unknown) => {
      if (options.currentGeneration() === options.generation) options.publishError(errorText(error))
    },
  ).finally(() => {
    if (options.currentGeneration() === options.generation) options.release()
  })
}

/** Text-entry descendants that must keep ordinary single-key behavior. */
function ownsTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.closest('input, textarea, select, [contenteditable="true"]') !== null
}

function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((node) => {
    if (node.hidden || node.closest('[inert], [aria-hidden="true"]') !== null) return false
    for (let current: HTMLElement | null = node; current !== null && current !== root; current = current.parentElement) {
      const style = window.getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden') return false
    }
    return true
  })
}

/**
 * Fullscreen workflow-run control room. The three panes share a bounded data
 * controller; narrow layouts turn them into an explicit drilldown.
 */
export function WorkflowsDashboard({
  useSessions,
  useStore,
  actions,
  t,
  useWorkflowRuns,
  operations,
}: WorkflowsDashboardProps) {
  const state = useStore(value => value)
  const sessionId = useSessions(value => value.current)
  const snapshot = useWorkflowRuns(value => value)
  const rootRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const selectedRunRef = useRef<WorkflowRunHead>()
  /* v8 ignore next -- replaced before the document shortcut listener is installed. */
  const executeControlRef = useRef<(action: WorkflowRunAction) => void>(() => {})
  const controlAbortRef = useRef<AbortController>()
  const controlPendingRef = useRef<WorkflowRunAction>()
  const [now, setNow] = useState(() => Date.now())
  const [responsiveDrilldown, setResponsiveDrilldown] = useState(() => window.innerWidth < 1_200)
  const [controlState, setControlState] = useState<{
    pending?: WorkflowRunAction
    error?: string
    notice?: string
  }>({})

  const rows = useMemo(() => orderRuns(snapshot.runs), [snapshot.runs])
  const requestedRun = state.selectedRunId === undefined
    ? undefined
    : rows.find(run => String(run.runId) === state.selectedRunId)
  const selectedRun = requestedRun ?? rows[0]
  selectedRunRef.current = selectedRun
  const liveCount = rows.filter(run => isActive(run.status)).length

  useEffect(() => {
    operations.observe(state.open ? sessionId : undefined)
    return () => { operations.observe(undefined) }
  }, [operations, sessionId, state.open])

  useEffect(() => {
    if (!state.open || liveCount === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [liveCount, state.open])

  useEffect(() => {
    if (!state.open) return
    const onResize = (): void => { setResponsiveDrilldown(window.innerWidth < 1_200) }
    window.addEventListener('resize', onResize)
    onResize()
    return () => { window.removeEventListener('resize', onResize) }
  }, [state.open])

  useEffect(() => {
    if (!state.open || selectedRun === undefined) return
    if (state.selectedRunId !== String(selectedRun.runId)) actions.reconcileRun(String(selectedRun.runId))
  }, [actions, selectedRun, state.open, state.selectedRunId])

  const executeControl = useCallback((action: WorkflowRunAction) => {
    /* v8 ignore next -- controls and shortcuts are absent without both values. */
    if (sessionId === undefined || selectedRun === undefined) return
    if (!selectedRun.allowedActions.includes(action) || controlPendingRef.current !== undefined) return
    controlAbortRef.current?.abort('workflow control superseded')
    const controller = new AbortController()
    controlAbortRef.current = controller
    controlPendingRef.current = action
    setControlState({ pending: action })
    void operations.control(
      sessionId,
      selectedRun.runId,
      action,
      selectedRun.revision,
      controller.signal,
    ).then(
      () => {
        if (controlAbortRef.current === controller) {
          controlPendingRef.current = undefined
          controlAbortRef.current = undefined
        }
        if (!controller.signal.aborted) setControlState({ notice: t('control.accepted', { action: t(`control.${action}`) }) })
      },
      (error: unknown) => {
        if (controlAbortRef.current === controller) {
          controlPendingRef.current = undefined
          controlAbortRef.current = undefined
        }
        if (!controller.signal.aborted && !isAbort(error)) setControlState({ error: errorText(error) })
      },
    )
  }, [operations, selectedRun, sessionId, t])
  executeControlRef.current = executeControl

  const selectedRunKey = selectedRun === undefined ? undefined : String(selectedRun.runId)
  useEffect(() => {
    controlAbortRef.current?.abort('workflow dashboard selection changed')
    controlAbortRef.current = undefined
    controlPendingRef.current = undefined
    setControlState({})
  }, [selectedRunKey, sessionId, state.open])

  useEffect(() => {
    if (!state.open) return
    /* v8 ignore next -- browser document.activeElement is always an Element while the page is active. */
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = rootRef.current
    /* v8 ignore next -- the effect runs only after React attaches the dialog ref. */
    if (root === null) return

    const overlayLayer = root.closest<HTMLElement>('[data-shell-overlay]')
    const shell = overlayLayer?.parentElement
    const disabled = shell === null || shell === undefined
      ? []
      : Array.from(shell.children).filter((child): child is HTMLElement => (
        child instanceof HTMLElement && child !== overlayLayer
      )).map(element => ({
        element,
        inert: element.hasAttribute('inert'),
        ariaHidden: element.getAttribute('aria-hidden'),
      }))
    for (const { element } of disabled) {
      element.inert = true
      element.setAttribute('aria-hidden', 'true')
    }

    root.focus()
    const onFocus = (event: FocusEvent): void => {
      if (event.target instanceof Node && root.contains(event.target)) return
      ;(focusable(root)[0] ?? root).focus()
    }
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        actions.close()
        return
      }
      if (event.key === 'Tab') {
        const targets = focusable(root)
        if (targets.length === 0) {
          event.preventDefault()
          root.focus()
          return
        }
        const first = targets[0]
        const last = targets.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || ownsTyping(event.target)) return
      if (event.repeat) return
      const shortcut = SHORTCUTS[event.key.toLowerCase()]
      const currentRun = selectedRunRef.current
      if (shortcut === undefined || currentRun === undefined || !currentRun.allowedActions.includes(shortcut)) return
      event.preventDefault()
      executeControlRef.current(shortcut)
    }
    document.addEventListener('focusin', onFocus, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('focusin', onFocus, true)
      document.removeEventListener('keydown', onKey, true)
      for (const { element, inert, ariaHidden } of disabled) {
        element.inert = inert
        if (ariaHidden === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', ariaHidden)
      }
      const opener = openerRef.current
      if (opener?.isConnected === true) opener.focus()
      openerRef.current = null
    }
  }, [actions, state.open])

  useEffect(() => {
    if (!state.open || !responsiveDrilldown) return
    const root = rootRef.current
    /* v8 ignore next -- the open dashboard owns a mounted root ref. */
    if (root === null) return
    let target: HTMLElement | null | undefined
    if (state.mobileView === 'runs') {
      target = [...root.querySelectorAll<HTMLElement>('[data-workflow-run-id]')]
        .find(element => element.dataset.workflowRunId === selectedRunKey)
    } else if (state.mobileView === 'run') {
      target = [...root.querySelectorAll<HTMLElement>('[data-workflow-member-id]')]
        .find(element => element.dataset.workflowMemberId === state.selectedMemberId)
        ?? [...root.querySelectorAll<HTMLElement>('[data-workflow-output-tab]')]
          .find(element => element.dataset.workflowOutputTab === state.inspectorTab)
        ?? root.querySelector<HTMLElement>('#workflow-run-heading')
    } else {
      target = root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    }
    target?.focus()
  }, [responsiveDrilldown, selectedRunKey, state.inspectorTab, state.mobileView, state.open, state.selectedMemberId])

  if (!state.open) return null

  return (
    <div
      ref={rootRef}
      className={css.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="workflow-dashboard-title"
      tabIndex={-1}
      data-mobile-view={state.mobileView}
      data-workflows-dashboard
    >
      <header className={css.topbar}>
        <div className={css.headingBlock}>
          <h1 id="workflow-dashboard-title" className={css.title}>{t('title')}</h1>
          <span className={css.topSummary}>
            {t('summary.counts', { live: liveCount, loaded: rows.length, total: snapshot.total })}
          </span>
        </div>
        {selectedRun !== undefined && (
          <span className={css.selectedStatus}>
            <StateDot state={runDot(selectedRun.status)} />
            {selectedRun.displayName} · {statusLabel(selectedRun.status, t)}
          </span>
        )}
        <span className={css.kbdHint}>{t('kbd.hint')}</span>
        <button type="button" className={css.close} onClick={actions.close} aria-label={t('close')}>
          <IconCloseOutline16 />
        </button>
      </header>

      {sessionId === undefined
        ? <EmptyState title={t('session.empty.title')} body={t('session.empty.body')} />
        : snapshot.phase === 'loading' && rows.length === 0
          ? <LoadingState t={t} />
          : snapshot.phase === 'error' && rows.length === 0
            ? (
              <EmptyState title={t('load.error.title')} body={snapshot.error ?? t('load.error.body')} error>
                <Button variant="outline" icon={<IconRefreshOutline16 />} onClick={() => { void operations.refresh(sessionId) }}>
                  {t('retry')}
                </Button>
              </EmptyState>
            )
            : rows.length === 0
              ? <EmptyState title={t('empty.title')} body={t('empty.body')} />
              : (
                <div className={css.body}>
                  <RunNavigator
                    rows={rows}
                    selectedRunId={selectedRun?.runId}
                    liveCount={liveCount}
                    hasMore={snapshot.nextCursor !== undefined}
                    t={t}
                    onSelect={(runId) => { actions.selectRun(String(runId)); setControlState({}) }}
                    onMore={() => { void operations.loadMore(sessionId) }}
                  />
                  {selectedRun !== undefined && (
                    <RunWorkspace
                      key={String(selectedRun.runId)}
                      sessionId={sessionId}
                      head={selectedRun}
                      selectedMemberId={state.selectedMemberId}
                      inspectorTab={state.inspectorTab}
                      now={now}
                      operations={operations}
                      t={t}
                      controlState={controlState}
                      onControl={executeControl}
                      onSelectMember={(memberId) => { actions.selectMember(String(memberId)) }}
                      onSelectTab={actions.selectTab}
                      onShowRuns={actions.showRuns}
                      onShowRun={actions.showRun}
                      onClose={actions.close}
                    />
                  )}
                </div>
              )}
    </div>
  )
}

function EmptyState({
  title,
  body,
  error = false,
  children,
}: {
  title: string
  body: string
  error?: boolean
  children?: React.ReactNode
}) {
  return (
    <main className={css.empty}>
      <div className={clsx(css.emptyGlyph, error && css.emptyGlyphError)} aria-hidden="true">⌁</div>
      <h2 className={css.emptyTitle}>{title}</h2>
      <p className={css.emptyBody}>{body}</p>
      {children}
    </main>
  )
}

function LoadingState({ t }: { t: T }) {
  return (
    <main className={css.loading} aria-live="polite">
      <div className={css.loadingRail} aria-hidden="true">
        <span /><span /><span /><span />
      </div>
      <p>{t('loading')}</p>
    </main>
  )
}

function RunNavigator({
  rows,
  selectedRunId,
  liveCount,
  hasMore,
  t,
  onSelect,
  onMore,
}: {
  rows: readonly WorkflowRunHead[]
  selectedRunId: SupervisedWorkflowRunId | undefined
  liveCount: number
  hasMore: boolean
  t: T
  onSelect: (runId: SupervisedWorkflowRunId) => void
  onMore: () => void
}) {
  const active = rows.slice(0, liveCount)
  const history = rows.slice(liveCount)
  return (
    <nav className={css.runNavigator} aria-label={t('runs.aria')}>
      <header className={css.navigatorHeader}>
        <span>{t('runs.title')}</span>
        <span className={css.navigatorCount}>{rows.length}</span>
      </header>
      <div className={css.runScroll}>
        {active.length > 0 && (
          <RunGroup label={t('runs.active')} rows={active} selectedRunId={selectedRunId} t={t} onSelect={onSelect} />
        )}
        {history.length > 0 && (
          <RunGroup label={t('runs.history')} rows={history} selectedRunId={selectedRunId} t={t} onSelect={onSelect} />
        )}
        {hasMore && <Button variant="ghost" className={css.loadMoreRuns} onClick={onMore}>{t('load.more.runs')}</Button>}
      </div>
    </nav>
  )
}

function RunGroup({
  label,
  rows,
  selectedRunId,
  t,
  onSelect,
}: {
  label: string
  rows: readonly WorkflowRunHead[]
  selectedRunId: SupervisedWorkflowRunId | undefined
  t: T
  onSelect: (runId: SupervisedWorkflowRunId) => void
}) {
  return (
    <section className={css.runGroup} aria-label={label}>
      <h2 className={css.runGroupTitle}>{label}</h2>
      <ul className={css.runList}>
        {rows.map((run) => {
          const progress = run.budget.total === 0 ? 0 : Math.min(100, run.budget.spent / run.budget.total * 100)
          const selected = run.runId === selectedRunId
          return (
            <li key={String(run.runId)}>
              <button
                type="button"
                className={clsx(css.runRow, selected && css.runRowSelected)}
                aria-current={selected ? 'true' : undefined}
                data-workflow-run-id={String(run.runId)}
                aria-label={t('run.row.aria', {
                  name: run.displayName,
                  status: statusLabel(run.status, t),
                  phase: run.phase ?? t('phase.none'),
                })}
                onClick={() => { onSelect(run.runId) }}
              >
                <span className={css.runPrimary}>
                  <StateDot state={runDot(run.status)} className={css.runDot} />
                  <span className={css.runName} title={run.displayName}>{run.displayName}</span>
                  <span className={css.runStatus}>{statusLabel(run.status, t)}</span>
                </span>
                <span className={css.runSecondary}>
                  <span className={css.runPhase} title={run.phase}>{run.phase ?? t('phase.none')}</span>
                  <span className={css.runAgents}>
                    {t('run.agents.compact', { done: run.budget.spent, total: run.budget.total })}
                  </span>
                </span>
                <span className={css.progressTrack} aria-hidden="true">
                  <span className={css.progressFill} style={{ '--workflow-progress': `${String(progress)}%` } as CSSProperties} />
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function RunWorkspace({
  sessionId,
  head,
  selectedMemberId,
  inspectorTab,
  now,
  operations,
  t,
  controlState,
  onControl,
  onSelectMember,
  onSelectTab,
  onShowRuns,
  onShowRun,
  onClose,
}: {
  sessionId: SessionId
  head: WorkflowRunHead
  selectedMemberId: string | undefined
  inspectorTab: WorkflowInspectorTab
  now: number
  operations: WorkflowRunsOperations
  t: T
  controlState: { pending?: WorkflowRunAction; error?: string; notice?: string }
  onControl: (action: WorkflowRunAction) => void
  onSelectMember: (memberId: WorkflowMemberId) => void
  onSelectTab: (tab: WorkflowInspectorTab) => void
  onShowRuns: () => void
  onShowRun: () => void
  onClose: () => void
}) {
  const [detail, setDetail] = useState<Loadable<WorkflowRunDetail>>({ phase: 'loading' })
  const [members, setMembers] = useState<Loadable<WorkflowRunMemberPage>>({ phase: 'loading' })
  const [memberDetail, setMemberDetail] = useState<Loadable<WorkflowRunMemberDetail>>({ phase: 'loading' })
  const [logs, setLogs] = useState<Loadable<WorkflowRunLogPage>>({ phase: 'loading' })
  const [result, setResult] = useState<Loadable<WorkflowRunResultView>>({ phase: 'loading' })
  const [artifacts, setArtifacts] = useState<Loadable<WorkflowRunArtifactPage>>({ phase: 'loading' })
  const [memberPageError, setMemberPageError] = useState<string>()
  const [logPageError, setLogPageError] = useState<string>()
  const [artifactPageError, setArtifactPageError] = useState<string>()
  const pageLoads = useRef({ members: false, logs: false, artifacts: false })
  const pageGenerations = useRef({ members: 0, logs: 0, artifacts: 0 })

  useEffect(() => () => {
    pageGenerations.current.members += 1
    pageGenerations.current.logs += 1
    pageGenerations.current.artifacts += 1
  }, [])

  const reloadDetail = useCallback((signal?: AbortSignal) => {
    setDetail({ phase: 'loading' })
    settleLoad(operations.detail(sessionId, head.runId, signal), signal, setDetail)
  }, [head.detailRevision, head.runId, operations, sessionId])

  const reloadMembers = useCallback((signal?: AbortSignal) => {
    pageGenerations.current.members += 1
    pageLoads.current.members = false
    setMemberPageError(undefined)
    setMembers({ phase: 'loading' })
    settleLoad(operations.members(sessionId, head.runId, undefined, signal), signal, setMembers)
  }, [head.membersRevision, head.runId, operations, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    reloadDetail(controller.signal)
    reloadMembers(controller.signal)
    return () => { controller.abort() }
  }, [reloadDetail, reloadMembers])

  const memberRows = members.phase === 'ready' ? members.value.items : []
  const selectedMember = selectedMemberId === undefined
    ? memberRows[0]
    : memberRows.find(member => String(member.memberId) === selectedMemberId) ?? memberRows[0]

  const reloadMemberDetail = useCallback((signal?: AbortSignal) => {
    if (selectedMember === undefined) return
    setMemberDetail({ phase: 'loading' })
    settleLoad(operations.memberDetail(sessionId, head.runId, selectedMember.memberId, signal), signal, setMemberDetail)
  }, [head.membersRevision, head.runId, operations, selectedMember, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    reloadMemberDetail(controller.signal)
    return () => { controller.abort() }
  }, [reloadMemberDetail])

  const loadLogs = useCallback((signal?: AbortSignal) => {
    pageGenerations.current.logs += 1
    pageLoads.current.logs = false
    setLogPageError(undefined)
    setLogs({ phase: 'loading' })
    settleLoad(operations.logs(sessionId, head.runId, undefined, signal), signal, setLogs)
  }, [head.logsRevision, head.runId, operations, sessionId])
  const loadResult = useCallback((signal?: AbortSignal) => {
    setResult({ phase: 'loading' })
    settleLoad(operations.result(sessionId, head.runId, signal), signal, setResult)
  }, [head.resultRevision, head.runId, operations, sessionId])
  const loadArtifacts = useCallback((signal?: AbortSignal) => {
    pageGenerations.current.artifacts += 1
    pageLoads.current.artifacts = false
    setArtifactPageError(undefined)
    setArtifacts({ phase: 'loading' })
    settleLoad(operations.artifacts(sessionId, head.runId, undefined, signal), signal, setArtifacts)
  }, [head.artifactsRevision, head.runId, operations, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    if (inspectorTab === 'logs') loadLogs(controller.signal)
    else if (inspectorTab === 'result') loadResult(controller.signal)
    else if (inspectorTab === 'artifacts') loadArtifacts(controller.signal)
    return () => { controller.abort() }
  }, [inspectorTab, loadArtifacts, loadLogs, loadResult])

  const appendMembers = (): void => {
    if (members.phase !== 'ready' || members.value.nextCursor === undefined || pageLoads.current.members) return
    const previous = members.value
    const generation = pageGenerations.current.members
    pageLoads.current.members = true
    setMemberPageError(undefined)
    appendPage({
      request: operations.members(sessionId, head.runId, previous.nextCursor),
      previous,
      generation,
      currentGeneration: () => pageGenerations.current.members,
      publish: setMembers,
      publishError: setMemberPageError,
      release: () => { pageLoads.current.members = false },
    })
  }
  const appendLogs = (): void => {
    if (logs.phase !== 'ready' || logs.value.nextCursor === undefined || pageLoads.current.logs) return
    const previous = logs.value
    const generation = pageGenerations.current.logs
    pageLoads.current.logs = true
    setLogPageError(undefined)
    appendPage({
      request: operations.logs(sessionId, head.runId, previous.nextCursor),
      previous,
      generation,
      currentGeneration: () => pageGenerations.current.logs,
      publish: setLogs,
      publishError: setLogPageError,
      release: () => { pageLoads.current.logs = false },
    })
  }
  const appendArtifacts = (): void => {
    if (artifacts.phase !== 'ready' || artifacts.value.nextCursor === undefined || pageLoads.current.artifacts) return
    const previous = artifacts.value
    const generation = pageGenerations.current.artifacts
    pageLoads.current.artifacts = true
    setArtifactPageError(undefined)
    appendPage({
      request: operations.artifacts(sessionId, head.runId, previous.nextCursor),
      previous,
      generation,
      currentGeneration: () => pageGenerations.current.artifacts,
      publish: setArtifacts,
      publishError: setArtifactPageError,
      release: () => { pageLoads.current.artifacts = false },
    })
  }

  const resolvedDetail = detail.phase === 'ready' ? detail.value : undefined
  const durationEnd = head.settledAt ?? now
  const settledMemberCount = head.memberCounts.completed
    + head.memberCounts.failed
    + head.memberCounts.cancelled
  return (
    <>
      <main className={css.execution} aria-label={t('execution.aria')}>
        <button type="button" className={css.mobileBack} onClick={onShowRuns}>
          <IconChevronLeftOutline14 /> {t('back.runs')}
        </button>
        <header className={css.executionHeader}>
          <div className={css.statusLine}>
            <span className={css.statusBadge}>
              <StateDot state={runDot(head.status)} />
              {statusLabel(head.status, t)}
            </span>
            <span className={css.elapsed}>{formatDuration(durationEnd - head.startedAt, t)}</span>
          </div>
          <h2 id="workflow-run-heading" className={css.executionTitle} tabIndex={-1}>{head.displayName}</h2>
          <p className={css.executionDescription}>{head.description}</p>
          <div className={css.controlRow} aria-label={t('controls.aria')}>
            {CONTROL_ORDER.filter(action => head.allowedActions.includes(action)).map(action => (
              <Button
                key={action}
                variant={action === 'stop' ? 'outline' : action === 'resume' ? 'primary' : 'toolbar'}
                size="sm"
                className={clsx(css.controlButton, action === 'stop' && css.stopControl)}
                icon={controlIcon(action)}
                disabled={controlState.pending !== undefined}
                aria-keyshortcuts={ACTION_SHORTCUT[action]}
                onClick={() => { onControl(action) }}
              >
                {controlState.pending === action ? t('control.pending') : t(`control.${action}`)}
              </Button>
            ))}
          </div>
          {controlState.error !== undefined && <p className={css.actionError} role="alert">{controlState.error}</p>}
          {controlState.notice !== undefined && <p className={css.actionNotice} role="status">{controlState.notice}</p>}
        </header>

        {head.status === 'budget-limited' && (
          <aside className={css.warningCallout} role="note">
            <strong>{t('budget.limit.title')}</strong>
            <span>{t('budget.limit.body')}</span>
          </aside>
        )}
        {resolvedDetail?.gate !== undefined && (
          <aside className={css.gateCallout} role="status">
            <span className={css.calloutEyebrow}>{t('gate.label', { kind: resolvedDetail.gate.kind })}</span>
            <strong>{t('gate.title')}</strong>
            <span>{resolvedDetail.gate.message}</span>
            <span className={css.calloutFoot}>
              {resolvedDetail.gate.resumable ? t('gate.resumable') : t('gate.repeats')}
            </span>
          </aside>
        )}
        {resolvedDetail?.error !== undefined && <p className={css.runError} role="alert">{resolvedDetail.error}</p>}
        {detail.phase === 'error' && (
          <InlineError error={detail.error} t={t} onRetry={() => { reloadDetail() }} />
        )}

        <section className={css.metrics} aria-label={t('metrics.aria')}>
          <div className={css.metric}>
            <span>{t('metric.agents')}</span>
            <strong>{settledMemberCount}/{head.memberCounts.total}</strong>
          </div>
          <div className={css.metric}>
            <span>{t('metric.running')}</span>
            <strong>{head.memberCounts.running}</strong>
          </div>
          <div className={css.metricWide}>
            <span>{t('metric.budget')}</span>
            <strong>{head.budget.spent}/{head.budget.total}</strong>
            <span className={css.budgetTrack} aria-hidden="true">
              <span
                className={css.budgetFill}
                style={{
                  '--workflow-progress': `${String(head.budget.total === 0 ? 0 : Math.min(100, head.budget.spent / head.budget.total * 100))}%`,
                } as CSSProperties}
              />
            </span>
          </div>
        </section>

        <section className={css.outputSection} aria-labelledby="workflow-output-heading">
          <div className={css.sectionHeading}>
            <div>
              <span className={css.eyebrow}>{t('output.eyebrow')}</span>
              <h3 id="workflow-output-heading">{t('output.title')}</h3>
            </div>
          </div>
          <div className={css.outputNav} role="group" aria-label={t('output.aria')}>
            {(['logs', 'result', 'artifacts'] as const).map(tab => (
              <button
                type="button"
                key={tab}
                className={css.outputButton}
                aria-pressed={inspectorTab === tab}
                data-workflow-output-tab={tab}
                onClick={() => { onSelectTab(tab) }}
              >
                <span>{t(`tab.${tab}`)}</span>
                <IconChevronRightOutline14 />
              </button>
            ))}
          </div>
        </section>

        <PhaseTimeline phases={resolvedDetail?.phases} current={head.phase} t={t} />

        <section className={css.agentSection} aria-labelledby="workflow-agents-heading">
          <div className={css.sectionHeading}>
            <div>
              <span className={css.eyebrow}>{t('agents.eyebrow')}</span>
              <h3 id="workflow-agents-heading">{t('agents.title')}</h3>
            </div>
            <span className={css.sectionCount}>{members.phase === 'ready' ? members.value.total : head.memberCounts.total}</span>
          </div>
          {members.phase === 'loading' && <p className={css.mutedState}>{t('agents.loading')}</p>}
          {members.phase === 'error' && <InlineError error={members.error} t={t} onRetry={() => { reloadMembers() }} />}
          {members.phase === 'ready' && members.value.items.length === 0 && <p className={css.mutedState}>{t('agents.empty')}</p>}
          {members.phase === 'ready' && (
            <div className={css.memberGroups}>
              {groupMembers(members.value.items).map(group => (
                <section key={group.key} className={css.memberGroup} aria-label={group.phase ?? t('phase.unassigned')}>
                  <h4>{group.phase === undefined ? t('phase.unassigned') : group.phase === '' ? t('phase.empty') : group.phase}</h4>
                  <div className={css.memberList}>
                    {group.members.map((member) => {
                      const selected = selectedMember?.memberId === member.memberId
                      const end = member.settledAt ?? now
                      const duration = member.startedAt === undefined ? undefined : formatDuration(end - member.startedAt, t)
                      return (
                        <button
                          type="button"
                          key={String(member.memberId)}
                          className={clsx(css.memberRow, selected && css.memberRowSelected)}
                          aria-pressed={selected}
                          data-workflow-member-id={String(member.memberId)}
                          aria-label={t('member.row.aria', {
                            label: member.label,
                            status: memberStatusLabel(member.status, t),
                            outcome: outcomeLabel(member.outcome, t),
                          })}
                          onClick={() => { onSelectMember(member.memberId) }}
                        >
                          <StateDot state={memberDot(member.status)} className={css.memberDot} />
                          <span className={css.memberCopy}>
                            <strong title={member.label}>{member.label}</strong>
                            <span>{duration === undefined ? outcomeLabel(member.outcome, t) : `${outcomeLabel(member.outcome, t)} · ${duration}`}</span>
                          </span>
                          <span className={css.memberStatus}>{memberStatusLabel(member.status, t)}</span>
                          <IconChevronRightOutline14 className={css.memberChevron} />
                        </button>
                      )
                    })}
                  </div>
                </section>
              ))}
              {members.value.nextCursor !== undefined && (
                <Button variant="ghost" className={css.loadMore} onClick={appendMembers}>{t('load.more.agents')}</Button>
              )}
              {memberPageError !== undefined && (
                <InlineError error={memberPageError} t={t} onRetry={appendMembers} />
              )}
            </div>
          )}
        </section>
      </main>

      <Inspector
        sessionId={sessionId}
        head={head}
        selectedMember={selectedMember}
        memberDetail={memberDetail}
        tab={inspectorTab}
        logs={logs}
        logPageError={logPageError}
        result={result}
        artifacts={artifacts}
        artifactPageError={artifactPageError}
        operations={operations}
        t={t}
        onSelectTab={onSelectTab}
        onBack={onShowRun}
        onClose={onClose}
        onRetryMember={() => { reloadMemberDetail() }}
        onRetryLogs={() => { loadLogs() }}
        onRetryResult={() => { loadResult() }}
        onRetryArtifacts={() => { loadArtifacts() }}
        onMoreLogs={appendLogs}
        onMoreArtifacts={appendArtifacts}
      />
    </>
  )
}

function PhaseTimeline({ phases, current, t }: {
  phases: readonly WorkflowPhase[] | undefined
  current: string | undefined
  t: T
}) {
  if ((phases === undefined || phases.length === 0) && current === undefined) return null
  const declared = phases ?? []
  const currentIndex = current === undefined ? -1 : declared.findIndex(phase => phase.title === current)
  const rows = current !== undefined && currentIndex === -1
    ? [...declared, { title: current, detail: t('phase.undeclared') }]
    : declared
  return (
    <section className={css.phaseSection} aria-labelledby="workflow-phase-heading">
      <div className={css.sectionHeading}>
        <div>
          <span className={css.eyebrow}>{t('phase.eyebrow')}</span>
          <h3 id="workflow-phase-heading">{t('phase.title')}</h3>
        </div>
        {current !== undefined && <span className={css.currentPhase}>{current}</span>}
      </div>
      <ol className={css.timeline}>
        {rows.map((phase, index) => {
          const active = phase.title === current
          const reached = currentIndex >= 0 && index < currentIndex
          return (
            <li key={`${phase.title}:${String(index)}`} className={clsx(css.phaseStep, active && css.phaseCurrent, reached && css.phaseReached)}>
              <span className={css.phaseMarker} aria-hidden="true" />
              <span className={css.phaseCopy}>
                <strong>{phase.title}</strong>
                {phase.detail !== undefined && <span>{phase.detail}</span>}
              </span>
              <span className={css.phaseState}>{active ? t('phase.current') : reached ? t('phase.reached') : t('phase.upcoming')}</span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function Inspector({
  sessionId,
  head,
  selectedMember,
  memberDetail,
  tab,
  logs,
  logPageError,
  result,
  artifacts,
  artifactPageError,
  operations,
  t,
  onSelectTab,
  onBack,
  onClose,
  onRetryMember,
  onRetryLogs,
  onRetryResult,
  onRetryArtifacts,
  onMoreLogs,
  onMoreArtifacts,
}: {
  sessionId: SessionId
  head: WorkflowRunHead
  selectedMember: WorkflowRunMemberHead | undefined
  memberDetail: Loadable<WorkflowRunMemberDetail>
  tab: WorkflowInspectorTab
  logs: Loadable<WorkflowRunLogPage>
  logPageError: string | undefined
  result: Loadable<WorkflowRunResultView>
  artifacts: Loadable<WorkflowRunArtifactPage>
  artifactPageError: string | undefined
  operations: WorkflowRunsOperations
  t: T
  onSelectTab: (tab: WorkflowInspectorTab) => void
  onBack: () => void
  onClose: () => void
  onRetryMember: () => void
  onRetryLogs: () => void
  onRetryResult: () => void
  onRetryArtifacts: () => void
  onMoreLogs: () => void
  onMoreArtifacts: () => void
}) {
  const [childError, setChildError] = useState<string>()
  const [openingChild, setOpeningChild] = useState(false)
  const tabs: WorkflowInspectorTab[] = ['outcome', 'logs', 'result', 'artifacts']
  const activeTab = tab

  useEffect(() => {
    setChildError(undefined)
    setOpeningChild(false)
  }, [selectedMember?.memberId])

  const onTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = tabs.indexOf(activeTab)
    let next: number | undefined
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    if (next === undefined) return
    event.preventDefault()
    const nextTab = tabs[next] as WorkflowInspectorTab
    onSelectTab(nextTab)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  const openChild = (childSessionId: SessionId): void => {
    setOpeningChild(true)
    setChildError(undefined)
    void operations.resolveAndOpenChild(sessionId, childSessionId).then(
      (opened) => {
        setOpeningChild(false)
        if (opened) onClose()
        else setChildError(t('child.unavailable'))
      },
      (error: unknown) => { setOpeningChild(false); setChildError(errorText(error)) },
    )
  }

  return (
    <aside className={css.inspector} aria-label={t('inspector.aria')}>
      <button type="button" className={css.mobileBack} onClick={onBack}>
        <IconChevronLeftOutline14 /> {t('back.run')}
      </button>
      <header className={css.inspectorHeader}>
        <span className={css.eyebrow}>{t('inspector.eyebrow')}</span>
        <h2 id="workflow-inspector-heading">
          {activeTab === 'outcome' ? selectedMember?.label ?? t('inspector.outcome') : t(`tab.${activeTab}`)}
        </h2>
        {activeTab === 'outcome' && selectedMember !== undefined && (
          <p>{selectedMember.phase ?? t('phase.unassigned')} · {memberStatusLabel(selectedMember.status, t)}</p>
        )}
      </header>
      <div className={css.tabs} role="tablist" aria-label={t('tabs.aria')} onKeyDown={onTabsKeyDown}>
        {tabs.map(item => (
          <button
            type="button"
            role="tab"
            id={`workflow-tab-${item}`}
            aria-selected={activeTab === item}
            aria-controls={`workflow-panel-${item}`}
            tabIndex={activeTab === item ? 0 : -1}
            key={item}
            onClick={() => { onSelectTab(item) }}
          >
            {t(`tab.${item}`)}
          </button>
        ))}
      </div>
      <section
        id={`workflow-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`workflow-tab-${activeTab}`}
        className={css.inspectorBody}
        tabIndex={0}
      >
        {activeTab === 'outcome' && (
          <OutcomePanel
            member={selectedMember}
            detail={memberDetail}
            childError={childError}
            openingChild={openingChild}
            t={t}
            onOpenChild={openChild}
            onRetry={onRetryMember}
          />
        )}
        {activeTab === 'logs' && (
          <LogsPanel state={logs} pageError={logPageError} t={t} onRetry={onRetryLogs} onMore={onMoreLogs} />
        )}
        {activeTab === 'result' && (
          <ResultPanel state={result} runError={head.status === 'failed'} t={t} onRetry={onRetryResult} />
        )}
        {activeTab === 'artifacts' && (
          <ArtifactsPanel
            sessionId={sessionId}
            head={head}
            state={artifacts}
            pageError={artifactPageError}
            operations={operations}
            t={t}
            onRetry={onRetryArtifacts}
            onMore={onMoreArtifacts}
          />
        )}
      </section>
    </aside>
  )
}

function OutcomePanel({
  member,
  detail,
  childError,
  openingChild,
  t,
  onOpenChild,
  onRetry,
}: {
  member: WorkflowRunMemberHead | undefined
  detail: Loadable<WorkflowRunMemberDetail>
  childError: string | undefined
  openingChild: boolean
  t: T
  onOpenChild: (childSessionId: SessionId) => void
  onRetry: () => void
}) {
  if (member === undefined) return <InspectorEmpty title={t('outcome.empty.title')} body={t('outcome.empty.body')} />
  if (detail.phase === 'loading') return <InspectorLoading label={t('outcome.loading')} />
  if (detail.phase === 'error') return <InlineError error={detail.error} t={t} onRetry={onRetry} />
  return (
    <div className={css.outcomePanel}>
      <div className={css.outcomeMeta}>
        <span>{t('outcome.sequence', { seq: detail.value.member.seq })}</span>
        <span>{outcomeLabel(detail.value.member.outcome, t)}</span>
      </div>
      <ValueView value={detail.value.outcome} t={t} />
      <Button
        variant="outline"
        icon={<IconRightUpOutline16 />}
        disabled={openingChild}
        onClick={() => { onOpenChild(detail.value.childSessionId) }}
      >
        {openingChild ? t('child.opening') : t('child.open')}
      </Button>
      {childError !== undefined && <p role="alert" className={css.actionError}>{childError}</p>}
    </div>
  )
}

function ValueView({ value, t }: { value: WorkflowRunValueView; t: T }) {
  switch (value.state) {
    case 'pending': return <InspectorEmpty title={t('outcome.pending.title')} body={t('outcome.pending.body')} active />
    case 'not-produced': return <InspectorEmpty title={t('outcome.not-produced.title')} body={t('outcome.not-produced.body')} />
    case 'evicted': return <InspectorEmpty title={t('outcome.evicted.title')} body={t('outcome.evicted.body')} />
    case 'available': {
      if (value.content.kind === 'preview') {
        return (
          <div className={css.valueStack}>
            <p className={css.truncatedNotice}>{t('outcome.truncated', { bytes: formatBytes(value.totalBytes) })}</p>
            <CodeBlock code={value.content.text} lang="json" copyLabel={t('copy')} copiedLabel={t('copied')} />
          </div>
        )
      }
      const data = value.content.value
      if (typeof data === 'object' && data !== null) {
        return (
          <JsonTree
            data={data}
            label={t('outcome.json.aria')}
            className={css.jsonTree}
            labels={{
              copyValue: t('json.copy.value'), copyJson: t('json.copy.json'), copyPath: t('json.copy.path'),
              copyPrettyJson: t('json.copy.pretty'), copyCompactJson: t('json.copy.compact'),
              copied: t('copied'), copyFailed: t('copy.failed'), collapseNode: t('json.collapse'),
              expandNode: t('json.expand'), copyButtonTitle: action => t('json.copy.button', { action }),
            }}
          />
        )
      }
      if (typeof data === 'string') return <div className={css.markdown}><MarkdownText text={data} /></div>
      return <CodeBlock code={JSON.stringify(data, null, 2)} lang="json" copyLabel={t('copy')} copiedLabel={t('copied')} />
    }
    /* v8 ignore next -- closed protocol value-view union. */
    default: return assertNever(value)
  }
}

function LogsPanel({ state, pageError, t, onRetry, onMore }: {
  state: Loadable<WorkflowRunLogPage>
  pageError: string | undefined
  t: T
  onRetry: () => void
  onMore: () => void
}) {
  if (state.phase === 'loading') return <InspectorLoading label={t('logs.loading')} />
  if (state.phase === 'error') return <InlineError error={state.error} t={t} onRetry={onRetry} />
  if (state.value.items.length === 0) {
    const retained = state.value.evicted > 0
    return (
      <div className={css.valueStack}>
        {retained && <RetentionNotice>{t('logs.evicted', { count: state.value.evicted })}</RetentionNotice>}
        <InspectorEmpty
          title={t(retained ? 'logs.retained.empty.title' : 'logs.empty.title')}
          body={t(retained ? 'logs.retained.empty.body' : 'logs.empty.body')}
        />
      </div>
    )
  }
  return (
    <div className={css.logPanel}>
      {state.value.evicted > 0 && <RetentionNotice>{t('logs.evicted', { count: state.value.evicted })}</RetentionNotice>}
      <ol className={css.logs} aria-label={t('logs.aria')}>
        {state.value.items.map(line => (
          <li key={line.index}>
            <span>{String(line.index + 1).padStart(3, '0')}</span>
            <code>{line.text}</code>
          </li>
        ))}
      </ol>
      {state.value.nextCursor !== undefined && <Button variant="ghost" onClick={onMore}>{t('load.more.logs')}</Button>}
      {pageError !== undefined && <InlineError error={pageError} t={t} onRetry={onMore} />}
    </div>
  )
}

function ResultPanel({ state, runError, t, onRetry }: {
  state: Loadable<WorkflowRunResultView>
  runError: boolean
  t: T
  onRetry: () => void
}) {
  if (state.phase === 'loading') return <InspectorLoading label={t('result.loading')} />
  if (state.phase === 'error') return <InlineError error={state.error} t={t} onRetry={onRetry} />
  return (
    <div className={css.valueStack}>
      {state.value.error !== undefined && <p className={css.runError} role="alert">{state.value.error}</p>}
      {runError && state.value.error === undefined && <p className={css.mutedState}>{t('result.failed.no-message')}</p>}
      <ValueView value={state.value.value} t={t} />
    </div>
  )
}

function ArtifactsPanel({
  sessionId,
  head,
  state,
  pageError,
  operations,
  t,
  onRetry,
  onMore,
}: {
  sessionId: SessionId
  head: WorkflowRunHead
  state: Loadable<WorkflowRunArtifactPage>
  pageError: string | undefined
  operations: WorkflowRunsOperations
  t: T
  onRetry: () => void
  onMore: () => void
}) {
  const items = state.phase === 'ready' ? state.value.items : []
  const [selectedName, setSelectedName] = useState<string>()
  const selected = items.find(item => item.name === selectedName) ?? items[0]
  const selectedArtifactName = selected?.name
  const [content, setContent] = useState<Loadable<WorkflowRunArtifactChunk>>({ phase: 'loading' })
  const [contentPageError, setContentPageError] = useState<string>()
  const pageLoading = useRef(false)
  const generation = useRef(0)

  useEffect(() => {
    if (selected !== undefined && selected.name !== selectedName) setSelectedName(selected.name)
  }, [selected, selectedName])

  const loadContent = useCallback((artifactName: string, signal?: AbortSignal) => {
    const requestGeneration = ++generation.current
    pageLoading.current = false
    setContentPageError(undefined)
    setContent({ phase: 'loading' })
    void operations.artifact(
      sessionId,
      head.runId,
      artifactName,
      undefined,
      head.artifactsRevision,
      signal,
    ).then(
      (value) => {
        if (generation.current === requestGeneration && signal?.aborted !== true) {
          setContent({ phase: 'ready', value })
        }
      },
      (error: unknown) => {
        if (generation.current === requestGeneration && signal?.aborted !== true && !isAbort(error)) {
          setContent({ phase: 'error', error: errorText(error) })
        }
      },
    )
  }, [head.artifactsRevision, head.runId, operations, sessionId])

  useEffect(() => {
    if (selectedArtifactName === undefined) return
    const controller = new AbortController()
    loadContent(selectedArtifactName, controller.signal)
    return () => { controller.abort() }
  }, [loadContent, selectedArtifactName])

  useEffect(() => () => { generation.current += 1 }, [])

  if (state.phase !== 'ready' || items.length === 0) {
    return <ArtifactList state={state} t={t} onRetry={onRetry} />
  }
  const activeArtifact = selected
  /* v8 ignore next -- the non-empty branch above guarantees the first item. */
  if (activeArtifact === undefined) throw new Error('artifact selection is unavailable')

  const appendContent = (): void => {
    if (content.phase !== 'ready' || content.value.nextCursor === undefined || pageLoading.current) return
    const previous = content.value
    const requestGeneration = generation.current
    pageLoading.current = true
    setContentPageError(undefined)
    void operations.artifact(
      sessionId,
      head.runId,
      activeArtifact.name,
      previous.nextCursor,
      head.artifactsRevision,
    ).then(
      (value) => {
        if (generation.current === requestGeneration) {
          setContent({
            phase: 'ready',
            value: {
              ...value,
              text: previous.text + value.text,
              offsetBytes: previous.offsetBytes,
              returnedBytes: previous.returnedBytes + value.returnedBytes,
            },
          })
        }
      },
      (error: unknown) => {
        if (generation.current === requestGeneration && !isAbort(error)) {
          setContentPageError(errorText(error))
        }
      },
    ).finally(() => {
      if (generation.current === requestGeneration) pageLoading.current = false
    })
  }

  return (
    <div className={css.artifactExplorer}>
      <div className={css.artifactPicker} aria-label={t('tab.artifacts')}>
        {state.value.omitted > 0 && (
          <RetentionNotice>{t('artifacts.omitted', { count: state.value.omitted })}</RetentionNotice>
        )}
        {items.map(item => (
          <button
            type="button"
            key={item.name}
            className={clsx(css.artifactButton, item.name === selected?.name && css.artifactButtonSelected)}
            aria-pressed={item.name === selected?.name}
            onClick={() => {
              generation.current += 1
              pageLoading.current = false
              setContentPageError(undefined)
              setSelectedName(item.name)
            }}
          >
            <IconDownloadOutline16 />
            <span className={css.artifactName}>{item.name}</span>
            <span>{formatBytes(item.bytes)}</span>
          </button>
        ))}
        {state.value.nextCursor !== undefined && (
          <Button variant="ghost" className={css.loadMore} onClick={onMore}>{t('load.more.artifacts')}</Button>
        )}
        {pageError !== undefined && <InlineError error={pageError} t={t} onRetry={onMore} />}
      </div>
      <section className={css.artifactContent} aria-label={activeArtifact.name}>
        {content.phase === 'loading' && <InspectorLoading label={t('artifacts.loading')} />}
        {content.phase === 'error' && <InlineError error={content.error} t={t} onRetry={() => { loadContent(activeArtifact.name) }} />}
        {content.phase === 'ready' && (
          <>
            <div className={css.artifactToolbar}>
              <strong>{content.value.artifact.name}</strong>
              <span>{formatBytes(content.value.totalBytes)}</span>
            </div>
            {content.value.artifact.name.toLowerCase().endsWith('.md')
              ? <div className={css.markdown}><MarkdownText text={content.value.text} /></div>
              : (
                <CodeBlock
                  code={content.value.text}
                  copyLabel={t('copy')}
                  copiedLabel={t('copied')}
                />
              )}
            {content.value.nextCursor !== undefined && (
              <Button variant="ghost" className={css.loadMore} onClick={appendContent}>{t('load.more.artifacts')}</Button>
            )}
            {contentPageError !== undefined && (
              <InlineError error={contentPageError} t={t} onRetry={appendContent} />
            )}
          </>
        )}
      </section>
    </div>
  )
}

function ArtifactList({ state, t, onRetry }: {
  state: Loadable<WorkflowRunArtifactPage>
  t: T
  onRetry: () => void
}) {
  if (state.phase === 'loading') return <InspectorLoading label={t('artifacts.loading')} />
  if (state.phase === 'error') return <InlineError error={state.error} t={t} onRetry={onRetry} />
  const retained = state.value.omitted > 0
  return (
    <div className={css.valueStack}>
      {retained && (
        <RetentionNotice>{t('artifacts.omitted', { count: state.value.omitted })}</RetentionNotice>
      )}
      <InspectorEmpty
        title={t(retained ? 'artifacts.retained.empty.title' : 'artifacts.empty.title')}
        body={t(retained ? 'artifacts.retained.empty.body' : 'artifacts.empty.body')}
      />
    </div>
  )
}

function RetentionNotice({ children }: { children: React.ReactNode }) {
  return <p className={css.retentionNotice} role="note">{children}</p>
}

function InlineError({ error, t, onRetry }: { error: string; t: T; onRetry: () => void }) {
  return (
    <div className={css.inlineError} role="alert">
      <strong>{t('inline.error.title')}</strong>
      <span>{error}</span>
      <Button variant="outline" size="sm" icon={<IconRefreshOutline16 />} onClick={onRetry}>{t('retry')}</Button>
    </div>
  )
}

function InspectorLoading({ label }: { label: string }) {
  return (
    <div className={css.inspectorLoading} role="status">
      <span className={css.loadingPulse} aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

function InspectorEmpty({ title, body, active = false }: { title: string; body: string; active?: boolean }) {
  return (
    <div className={css.inspectorEmpty}>
      <StateDot state={active ? 'ongoing' : 'done'} />
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  )
}

function controlIcon(action: WorkflowRunAction): React.ReactNode {
  switch (action) {
    case 'pause': return <IconPauseOutline16 />
    case 'resume': return <IconPlayOutline16 />
    case 'stop': return <IconStopFill16 />
    case 'save': return <IconDownloadOutline16 />
    /* v8 ignore next -- closed workflow-action union. */
    default: return assertNever(action)
  }
}

const CONTROL_ORDER: readonly WorkflowRunAction[] = ['pause', 'resume', 'stop', 'save']
const ACTION_SHORTCUT: Record<WorkflowRunAction, string> = { pause: 'P', resume: 'R', stop: 'X', save: 'S' }
const SHORTCUTS: Readonly<Record<string, WorkflowRunAction | undefined>> = {
  p: 'pause', r: 'resume', x: 'stop', s: 'save',
}
