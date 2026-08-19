import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { WorkflowRunId, type WorkflowGateInfo } from '@deepseek-ai/dsh-workflow'
import type {
  SupervisedWorkflowRunId,
  WorkflowGateId,
} from '@deepseek-ai/dsh-workflow-supervisor/types'
import { apply, inject, workflowGateQuestion } from '../src/index.ts'

const parent = { id: 'session-1', session: { id: 'session-1' } } as unknown as Agent

const resumableGate: WorkflowGateInfo = {
  kind: 'verification',
  message: 'Confirm the independently verified evidence.',
  resumable: true,
}

type Ask = (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>

function gateRequest(signal = new AbortController().signal, gate = resumableGate) {
  return {
    info: {
      id: 'logical-1' as SupervisedWorkflowRunId,
      displayName: 'review-changes',
      name: 'review-changes',
    },
    executionId: WorkflowRunId('execution-1'),
    gateId: 'gate-1' as WorkflowGateId,
    gate,
    parent,
    signal,
  }
}

async function setup(ask: Ask) {
  const ctx = new Context()
  const resumeGate = vi.fn(() => true)
  ctx.provide('userQuestions', { ask } as never)
  ctx.provide('workflowSupervisor', { resumeGate } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, resumeGate }
}

describe('workflow-user-questions', () => {
  it('presents resumable and repeating gates as explicit acknowledgements', () => {
    expect(workflowGateQuestion('review-changes', resumableGate)).toEqual({
      id: 'workflow-gate',
      header: 'Workflow · review-changes',
      question: 'Confirm the independently verified evidence.',
      options: [{
        label: 'Resume workflow',
        description: 'Continue past this input request.',
      }],
    })
    expect(workflowGateQuestion('review-changes', {
      kind: 'verification', message: 'Pass args.target.', resumable: false,
    }).options).toEqual([{
      label: 'Resume workflow',
      description: 'Retry the paused condition; it may ask again when nothing changed.',
    }])
  })

  it('asks in the exact parent Session and resumes only the correlated gate occurrence', async () => {
    const answer = Promise.withResolvers<AskUserQuestionAnswer>()
    const ask = vi.fn<Ask>(() => answer.promise)
    const { ctx, resumeGate } = await setup(ask)
    const request = gateRequest()

    ctx.emit('workflows/gate-request', request)
    expect(ask).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0]?.[0]).toMatchObject({
      agent: parent,
      questions: [{
        id: 'workflow-gate',
        header: 'Workflow · review-changes',
        question: resumableGate.message,
      }],
    })
    expect(JSON.stringify(ask.mock.calls[0]?.[0].questions)).not.toContain('logical-1')
    expect(JSON.stringify(ask.mock.calls[0]?.[0].questions)).not.toContain('execution-1')

    answer.resolve({ answers: [{ id: 'workflow-gate', selected: ['Resume workflow'] }] })
    await vi.waitFor(() => {
      expect(resumeGate).toHaveBeenCalledWith(
        request.info.id, request.executionId, request.gateId, parent,
      )
    })
  })

  it('resumes only when the workflow acknowledgement was selected', async () => {
    const ask = vi.fn<Ask>()
      .mockResolvedValueOnce({ answers: [{ id: 'workflow-gate', selected: [] }] })
      .mockResolvedValueOnce({ answers: [{ id: 'another-question', selected: ['Resume workflow'] }] })
      .mockResolvedValueOnce({ answers: [{ id: 'workflow-gate', selected: [], custom: 'Resume workflow' }] })
      .mockResolvedValueOnce({ answers: [{ id: 'workflow-gate', selected: ['Resume workflow'] }] })
    const { ctx, resumeGate } = await setup(ask)

    for (let index = 0; index < 4; index++) ctx.emit('workflows/gate-request', gateRequest())

    await vi.waitFor(() => { expect(ask).toHaveBeenCalledTimes(4) })
    await vi.waitFor(() => { expect(resumeGate).toHaveBeenCalledOnce() })
  })

  it('leaves the run parked when the user dismisses or the supervisor withdraws a question', async () => {
    const controller = new AbortController()
    const ask = vi.fn<Ask>()
      .mockRejectedValueOnce(new UserQuestionError('dismissed', 'ASK_CANCELLED'))
      .mockRejectedValueOnce(new UserQuestionError('provider stopped', 'ASK_ABORTED'))
      .mockImplementationOnce(request => new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          reject(new UserQuestionError('run moved on', 'ASK_ABORTED'))
        }, { once: true })
      }))
    const { ctx, resumeGate } = await setup(ask)
    const warnings: unknown[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(message) }) as typeof ctx.logger.warn

    ctx.emit('workflows/gate-request', gateRequest())
    ctx.emit('workflows/gate-request', gateRequest())
    ctx.emit('workflows/gate-request', gateRequest(controller.signal))
    controller.abort()

    await vi.waitFor(() => { expect(ask).toHaveBeenCalledTimes(3) })
    await Promise.resolve()
    expect(resumeGate).not.toHaveBeenCalled()
    expect(warnings).toEqual([])
  })

  it('contains provider and resume failures while preserving a useful diagnostic', async () => {
    const unrenderable = { [Symbol.toPrimitive]: () => { throw new Error('coercion denied') } }
    const ask = vi.fn<Ask>()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockRejectedValueOnce(new UserQuestionError('bad caller', 'CALLER_NOT_LIVE'))
      .mockRejectedValueOnce(unrenderable)
      .mockResolvedValueOnce({ answers: [{ id: 'workflow-gate', selected: ['Resume workflow'] }] })
    const { ctx, resumeGate } = await setup(ask)
    resumeGate.mockImplementationOnce(() => { throw new Error('stale gate') })
    const warnings: unknown[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(message) }) as typeof ctx.logger.warn

    for (let index = 0; index < 4; index++) ctx.emit('workflows/gate-request', gateRequest())

    await vi.waitFor(() => { expect(warnings).toHaveLength(4) })
    expect(warnings.map(String)).toEqual([
      'workflow-user-questions: could not answer gate for "review-changes": Error: provider unavailable',
      'workflow-user-questions: could not answer gate for "review-changes": UserQuestionError: bad caller',
      'workflow-user-questions: could not answer gate for "review-changes": [unrenderable thrown value]',
      'workflow-user-questions: could not answer gate for "review-changes": Error: stale gate',
    ])
  })

  it('aborts and drains an outstanding question when its plugin fiber unloads', async () => {
    let seenSignal: AbortSignal | undefined
    const ask = vi.fn<Ask>(request => new Promise((_resolve, reject) => {
      seenSignal = request.signal
      request.signal?.addEventListener('abort', () => {
        reject(new UserQuestionError('plugin disposed', 'ASK_ABORTED'))
      }, { once: true })
    }))
    const { ctx, fiber, resumeGate } = await setup(ask)
    ctx.emit('workflows/gate-request', gateRequest())
    expect(seenSignal?.aborted).toBe(false)

    await fiber.dispose()

    expect(seenSignal?.aborted).toBe(true)
    expect(resumeGate).not.toHaveBeenCalled()
    ctx.emit('workflows/gate-request', gateRequest())
    expect(ask).toHaveBeenCalledOnce()
  })
})
