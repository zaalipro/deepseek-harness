/**
 * Web-capable human-input Consumer for supervised workflow gates. Each
 * generation-fenced `workflows/gate-request` becomes one `ctx.userQuestions`
 * request owned by the workflow's exact parent Agent. An accepted answer
 * resumes only the gate occurrence that created it; cancellation leaves the
 * run parked for dashboard control.
 *
 * @module @deepseek-ai/dsh-workflow-user-questions
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions'
import type { WorkflowGateInfo } from '@deepseek-ai/dsh-workflow'
// Type-only edges resolve the injected service and event declarations.
import type {} from '@deepseek-ai/dsh-workflow-supervisor'

/** Cordis plugin name. */
export const name = 'workflow-user-questions'

/** Services required before workflow questions can be presented. */
export const inject = ['workflowSupervisor', 'userQuestions']

/** Stable question id inside each independently correlated ask request. */
const QUESTION_ID = 'workflow-gate'

/** Stable option value whose selection acknowledges a parked workflow. */
const RESUME_LABEL = 'Resume workflow'

/**
 * Convert a supervised gate into the existing question service's UI data.
 * @param displayName - session-unique human handle for the parked run.
 * @param gate - script-provided message and resume behavior.
 * @returns one acknowledgement question containing no internal run identity.
 */
export function workflowGateQuestion(displayName: string, gate: WorkflowGateInfo): AskUserQuestionItem {
  return {
    id: QUESTION_ID,
    header: `Workflow · ${displayName}`,
    question: gate.message,
    options: [{
      label: RESUME_LABEL,
      description: gate.resumable
        ? 'Continue past this input request.'
        : 'Retry the paused condition; it may ask again when nothing changed.',
    }],
  }
}

/** Render any thrown value without trusting its coercion. */
function renderThrown(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/** Whether a question rejection is an expected withdrawal rather than a bridge failure. */
function isWithdrawal(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (error instanceof UserQuestionError
      && (error.code === 'ASK_ABORTED' || error.code === 'ASK_CANCELLED'))
}

/** Whether the provider returned the acknowledgement offered by this bridge. */
function answersResume(answer: AskUserQuestionAnswer): boolean {
  return answer.answers.some(item =>
    item.id === QUESTION_ID && item.selected.includes(RESUME_LABEL))
}

/**
 * Register workflow gate questions and drain pending asks during plugin
 * teardown. Supervisor gate tokens provide the authority check after an
 * answer; a late answer never resumes a replacement attempt.
 *
 * @param ctx - context carrying the workflow supervisor and question service.
 */
export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  const active = new Set<Promise<void>>()

  const disposeListener = ctx.on('workflows/gate-request', (request) => {
    const signal = AbortSignal.any([request.signal, lifetime.signal])
    const operation = (async (): Promise<void> => {
      try {
        const answer = await ctx.userQuestions.ask({
          questions: [workflowGateQuestion(request.info.displayName, request.gate)],
          agent: request.parent,
          signal,
        })
        if (!answersResume(answer)) return
        ctx.workflowSupervisor.resumeGate(
          request.info.id,
          request.executionId,
          request.gateId,
          request.parent,
        )
      } catch (error: unknown) {
        if (!isWithdrawal(error, signal)) {
          ctx.logger.warn(
            `workflow-user-questions: could not answer gate for "${request.info.displayName}": ${renderThrown(error)}`,
          )
        }
      }
    })()
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    void operation.then(retire, retire)
  })

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('workflow-user-questions plugin disposed'))
    await Promise.allSettled(active)
  }, 'workflow-user-questions: abort and drain pending questions')
}
