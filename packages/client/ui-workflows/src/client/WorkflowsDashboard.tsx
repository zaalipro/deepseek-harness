import { useRef, type KeyboardEvent } from 'react'
import type { SessionId, WorkflowRunView } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { createWorkflowsStore } from './store.ts'
import { NS } from './locales.ts'
import css from './WorkflowsDashboard.module.css'

/** Full component props: runtime + store + locale shares plus the injected face. */
export type WorkflowsDashboardProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createWorkflowsStore>>
  & PropsLocale<typeof NS>
  & WorkflowsDashboardInjected

/** Injected business face: controls execute host commands by display name. */
export interface WorkflowsDashboardInjected {
  /** Execute `/workflow <action> <displayName>` against one session. */
  runControl: (sessionId: SessionId, displayName: string, action: 'pause' | 'resume' | 'stop' | 'save') => void
}

/** Stable empty run list so a session with no runs keeps one array identity. */
const NO_RUNS: readonly WorkflowRunView[] = []

/** Closed-union exhaustiveness fence for the wire status set. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a status is forged */
function assertNever(value: never): never {
  throw new Error(`unhandled workflow run status: ${JSON.stringify(value)}`)
}

/** Status marker semantics for a run row. */
function runDotState(status: WorkflowRunView['status']): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'needs-input': return 'warning'
    case 'paused': return 'warning'
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'cancelled': return 'warning'
    case 'interrupted': return 'error'
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

/** Group key preserving omitted phase versus the empty string (exact identity). */
function phaseKey(phase: string | undefined): string {
  return phase === undefined ? 'missing' : `value:${phase.length}:${phase}`
}

/** One member's run status → its dot state. */
function memberDot(status: WorkflowRunView['members'][number]['status']): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'cancelled': return 'warning'
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

/**
 * Fullscreen workflow-run dashboard. Renders nothing while closed; when open
 * it overlays the frame and shows the current session's runs with a per-run
 * detail view and Pause/Resume/Stop/Save controls.
 */
export function WorkflowsDashboard({
  useSessions,
  useStore,
  actions,
  t,
  runControl,
}: WorkflowsDashboardProps) {
  const { open, selected } = useStore(s => s)
  const sessionId = useSessions(s => s.current)
  const runs = useSessions(s => (s.current !== undefined ? s.workflowRunsBySession?.[s.current] : undefined)) ?? NO_RUNS
  const rootRef = useRef<HTMLDivElement>(null)

  const selectedRun = open && selected !== undefined
    ? runs.find(run => run.displayName === selected)
    : undefined

  if (!open) return null

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      actions.close()
      return
    }
    if (selectedRun === undefined) return
    const key = event.key.toLowerCase()
    if (key === 'p') runControl(currentSessionOrThrow(sessionId), selectedRun.displayName, 'pause')
    else if (key === 'r') runControl(currentSessionOrThrow(sessionId), selectedRun.displayName, 'resume')
    else if (key === 'x') runControl(currentSessionOrThrow(sessionId), selectedRun.displayName, 'stop')
    else if (key === 's' && !selectedRun.builtin && !selectedRun.numberedHandle) {
      runControl(currentSessionOrThrow(sessionId), selectedRun.displayName, 'save')
    }
  }

  const rows = orderRuns(runs)

  return (
    <div ref={rootRef} className={css.overlay} role="dialog" aria-modal="true" aria-label={t('title')} onKeyDown={onKeyDown} tabIndex={-1}>
      <div className={css.header}>
        <h1 className={css.title}>{t('title')}</h1>
        <span className={css.kbdHint}>{t('kbd.hint')}</span>
        <button type="button" className={css.close} onClick={actions.close} aria-label={t('close')}>×</button>
      </div>
      {rows.length === 0
        ? (
          <div className={css.empty}>
            <p className={css.emptyTitle}>{t('empty.title')}</p>
            <p className={css.emptyBody}>{t('empty.body')}</p>
          </div>
        )
        : (
          <div className={css.body}>
            <ul className={css.list} aria-label="workflow runs">
              {rows.map(run => (
                <li key={run.displayName}>
                  <button
                    type="button"
                    className={run.displayName === selected ? `${css.row} ${css.rowSelected}` : css.row}
                    onClick={() => { actions.select(run.displayName) }}
                  >
                    <StateDot state={runDotState(run.status)} className={css.rowDot} />
                    <span className={css.rowName}>{run.displayName}</span>
                    <span className={css.rowPhase}>{run.phase ?? ''}</span>
                    <span className={css.rowStatus}>{t(STATUS_KEYS[run.status])}</span>
                    <span className={css.rowBudget}>
                      {run.budget.spent}/{run.budget.total} {t('progress.label')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {selectedRun !== undefined && sessionId !== undefined
              ? <Detail view={selectedRun} sessionId={sessionId} t={t} runControl={runControl} />
              : null}
          </div>
        )}
    </div>
  )
}

/** One run's detail pane. */
function Detail(props: {
  view: WorkflowRunView
  sessionId: SessionId
  t: PropsLocale<typeof NS>['t']
  runControl: WorkflowsDashboardInjected['runControl']
}) {
  const { view, sessionId, t, runControl } = props
  const groups = groupMembers(view.members)
  const saveHidden = view.builtin || view.numberedHandle
  return (
    <section className={css.detail}>
      <header className={css.detailHeader}>
        <h2 className={css.detailTitle}>{view.displayName}</h2>
        <p className={css.detailDesc}>{view.description}</p>
        <div className={css.controls}>
          {view.status === 'running' || view.status === 'needs-input'
            ? <button type="button" className={css.control} onClick={() => { runControl(sessionId, view.displayName, 'pause') }}>{t('control.pause')}</button>
            : null}
          {view.status === 'needs-input' || view.status === 'paused'
            ? <button type="button" className={css.control} onClick={() => { runControl(sessionId, view.displayName, 'resume') }}>{t('control.resume')}</button>
            : null}
          {view.status === 'running' || view.status === 'needs-input' || view.status === 'paused'
            ? <button type="button" className={css.control} onClick={() => { runControl(sessionId, view.displayName, 'stop') }}>{t('control.stop')}</button>
            : null}
          {!saveHidden && (view.status === 'completed' || view.status === 'failed' || view.status === 'paused' || view.status === 'needs-input')
            ? <button type="button" className={css.control} onClick={() => { runControl(sessionId, view.displayName, 'save') }}>{t('control.save')}</button>
            : null}
        </div>
      </header>
      {view.phases !== undefined && view.phases.length > 0
        ? (
          <ol className={css.rail} aria-label={t('phase.rail.aria')}>
            {view.phases.map(phase => (
              <li key={phase.title} className={phase.title === view.phase ? `${css.railStep} ${css.railActive}` : css.railStep}>
                {phase.title}
              </li>
            ))}
            {view.phase !== undefined && view.phases.every(phase => phase.title !== view.phase)
              ? <li className={`${css.railStep} ${css.railActive}`}>{view.phase}</li>
              : null}
          </ol>
        )
        : null}
      <div className={css.members} aria-label={t('members.aria')}>
        {groups.map(group => (
          <div key={group.key} className={css.group}>
            <p className={css.groupName}>{group.phase === undefined ? '' : group.phase}</p>
            {group.members.map(member => (
              <div key={member.seq} className={css.member}>
                <StateDot state={memberDot(member.status)} className={css.memberDot} />
                <span className={css.memberLabel}>{member.label}</span>
                <span className={css.memberStatus}>{t(MEMBER_KEYS[member.status])}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {view.logs.length > 0
        ? (
          <pre className={css.logs} aria-label={t('logs.aria')}>
            {view.logs.join('\n')}
          </pre>
        )
        : null}
      {view.result !== undefined
        ? (
          <pre className={css.result} aria-label={t('result.aria')}>
            {JSON.stringify(view.result, null, 2)}
          </pre>
        )
        : null}
      {view.error !== undefined
        ? <p className={css.error}>{view.error}</p>
        : null}
    </section>
  )
}

/** Group members by exact phase identity (omitted ≠ empty string). */
function groupMembers(members: WorkflowRunView['members']): { key: string; phase: string | undefined; members: WorkflowRunView['members'] }[] {
  const groups = new Map<string, { phase: string | undefined; members: WorkflowRunView['members'] }>()
  for (const member of members) {
    const key = phaseKey(member.phase)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { phase: member.phase, members: [member] })
    else group.members = [...group.members, member]
  }
  return [...groups].map(([key, group]) => ({ key, phase: group.phase, members: group.members }))
}

/** Live runs first in start order, then settled newest-first. */
function orderRuns(runs: readonly WorkflowRunView[]): WorkflowRunView[] {
  return [...runs].sort((left, right) => {
    const live = (run: WorkflowRunView) => run.status === 'running' || run.status === 'needs-input' || run.status === 'paused'
    if (live(left) !== live(right)) return live(left) ? -1 : 1
    return left.startedAt - right.startedAt
  })
}

/** Wire status → locale key. */
const STATUS_KEYS = {
  running: 'status.running',
  'needs-input': 'status.needs-input',
  paused: 'status.paused',
  completed: 'status.completed',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
  interrupted: 'status.interrupted',
} as const

/** Member status → locale key. */
const MEMBER_KEYS = {
  running: 'member.running',
  completed: 'member.completed',
  failed: 'member.failed',
  cancelled: 'member.cancelled',
} as const

/** Keyboard controls need one session to address; tabs always have one while the overlay is open. */
function currentSessionOrThrow(sessionId: SessionId | undefined): SessionId {
  if (sessionId === undefined) throw new Error('workflow dashboard requires a current session')
  return sessionId
}
