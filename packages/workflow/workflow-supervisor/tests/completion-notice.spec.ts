import { mkdir, mkdtemp, open, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type { WorkflowResult } from '@deepseek-ai/dsh-workflow'
import { describe, expect, it, vi } from 'vitest'
import {
  renderWorkflowCompletionNotice,
  WorkflowCompletionNotifier,
} from '../src/completion-notice.ts'

const completed = (value: JsonValue): WorkflowResult => ({
  value,
  stopReason: 'completed',
  agentsStarted: 1,
})

function fakeAgent(ctx: Context, initial: AgentStatus = 'running') {
  let status = initial
  const followup = vi.fn()
  const inject = vi.fn()
  const agent = {
    get status() { return status },
    followup,
    inject,
    ctx,
  } as unknown as Agent
  return {
    agent,
    followup,
    inject,
    setStatus(next: AgentStatus) { status = next },
  }
}

function noticeText(call: unknown[] | undefined): string {
  return (call?.[0] as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? ''
}

describe('renderWorkflowCompletionNotice', () => {
  it('renders terminal outcomes and a report reference', () => {
    expect(renderWorkflowCompletionNotice({
      displayName: 'audit',
      status: 'completed',
      result: completed({ answer: 42 }),
    }, 1_000, 'full report')).toBe([
      'workflow "audit" completed.',
      'Scratch report:',
      'full report',
      'Scratch report: scratch/report.md.',
      'Open /workflows to inspect the run.',
    ].join('\n'))

    expect(renderWorkflowCompletionNotice({
      displayName: 'audit',
      status: 'failed',
      result: { value: null, stopReason: 'error', error: 'boom', agentsStarted: 0 },
    }, 1_000, undefined)).toContain('workflow "audit" failed.\nReason: boom')
    expect(renderWorkflowCompletionNotice({
      displayName: 'audit',
      status: 'cancelled',
      result: { value: null, stopReason: 'cancelled', error: '', agentsStarted: 0 },
    }, 1_000, undefined)).toContain('workflow "audit" was stopped.\nOpen /workflows')
    expect(renderWorkflowCompletionNotice({
      displayName: 'audit',
      status: 'interrupted',
    }, 1_000, undefined)).toContain('workflow "audit" was interrupted.\nOpen /workflows')
  })

  it('bounds multibyte result and failure text without cutting UTF-8', () => {
    const completedText = renderWorkflowCompletionNotice({
      displayName: '😀-audit',
      status: 'completed',
      result: completed('界'.repeat(1_000)),
    }, 180, '界'.repeat(1_000))
    expect(Buffer.byteLength(completedText, 'utf8')).toBeLessThanOrEqual(180)
    expect(completedText).not.toContain('\uFFFD')
    expect(completedText).toContain('[notice truncated]')
    expect(completedText).toContain('Scratch report: scratch/report.md.')
    expect(completedText).toContain('Open /workflows')

    const failedText = renderWorkflowCompletionNotice({
      displayName: 'audit',
      status: 'failed',
      result: { value: null, stopReason: 'error', error: 'é'.repeat(1_000), agentsStarted: 0 },
    }, 96, undefined)
    expect(Buffer.byteLength(failedText, 'utf8')).toBeLessThanOrEqual(96)
    expect(failedText).not.toContain('\uFFFD')
    expect(failedText).toContain('Open /workflows')
  })

  it('remains total for tiny direct budgets and nonconforming result values', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(renderWorkflowCompletionNotice({
      displayName: 'audit',
      status: 'completed',
      result: completed(circular as never),
    }, 1_000, undefined)).toContain('[result could not be serialized]')
    expect(renderWorkflowCompletionNotice({
      displayName: 'audit',
      status: 'completed',
    }, 8, undefined)).toBe('\n[notice')
    expect(() => renderWorkflowCompletionNotice({
      displayName: 'audit',
      status: 'completed',
    }, 0, undefined)).toThrow(/positive safe integer/)
    expect(() => renderWorkflowCompletionNotice({
      displayName: 'audit',
      status: 'completed',
    }, Number.MAX_VALUE, undefined)).toThrow(/positive safe integer/)
  })
})

describe('WorkflowCompletionNotifier', () => {
  it('wakes an idle exact owner once and references an existing regular report', async () => {
    const ctx = new Context()
    const owner = fakeAgent(ctx, 'idle')
    const notifier = new WorkflowCompletionNotifier(ctx, { maxBytes: 1_000, maxConsecutiveWakes: 2 })
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-notice-'))
    await mkdir(join(root, 'scratch'))
    await writeFile(join(root, 'scratch', 'report.md'), 'full report', 'utf8')
    const token = {}
    const input = {
      token,
      parent: owner.agent,
      displayName: 'audit',
      status: 'completed' as const,
      result: completed({ answer: 42 }),
      scratchDir: root,
    }

    await expect(notifier.notify(input)).resolves.toBe(true)
    await expect(notifier.notify(input)).resolves.toBe(false)
    expect(owner.followup).toHaveBeenCalledTimes(1)
    expect(owner.inject).not.toHaveBeenCalled()
    expect(noticeText(owner.followup.mock.calls[0])).toContain('Scratch report:\nfull report')
    expect(noticeText(owner.followup.mock.calls[0])).toContain('Scratch report: scratch/report.md.')
    expect(owner.followup.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      source: {
        kind: 'plugin',
        plugin: 'workflow-supervisor',
        form: 'notice',
        summary: 'workflow audit completed',
      },
    })
  })

  it('coalesces a reserved completion cohort into one wake', async () => {
    const ctx = new Context()
    const owner = fakeAgent(ctx)
    const notifier = new WorkflowCompletionNotifier(ctx, { maxBytes: 1_000, maxConsecutiveWakes: 3 })
    const first = {}
    const second = {}
    notifier.reserve(first, owner.agent)
    notifier.reserve(second, owner.agent)

    await Promise.all([first, second].map((token, index) => notifier.notify({
      token,
      parent: owner.agent,
      displayName: `audit-${index}`,
      status: 'completed',
      result: completed(index),
    })))

    expect(owner.followup).toHaveBeenCalledTimes(1)
    expect(owner.inject).toHaveBeenCalledTimes(1)
    await notifier.notify({
      token: {}, parent: owner.agent, displayName: 'recursive', status: 'completed', result: completed(null),
    })
    expect(owner.followup).toHaveBeenCalledTimes(2)
  })

  it('wakes an older reserved cohort without rewinding the open cohort', async () => {
    const ctx = new Context()
    const owner = fakeAgent(ctx)
    const notifier = new WorkflowCompletionNotifier(ctx, { maxBytes: 1_000, maxConsecutiveWakes: 3 })
    const token = {}
    notifier.reserve(token, owner.agent)
    const internal = notifier as unknown as {
      wakeStates: WeakMap<Agent, { openBatch: number; wokenThrough: number }>
    }
    const state = internal.wakeStates.get(owner.agent)
    if (state === undefined) throw new Error('reservation did not create a wake state')
    state.openBatch = 1
    state.wokenThrough = -1

    await notifier.notify({
      token, parent: owner.agent, displayName: 'older', status: 'completed', result: completed(null),
    })

    expect(owner.followup).toHaveBeenCalledTimes(1)
    expect(state).toEqual({ openBatch: 1, wokenThrough: 0 })
  })

  it('omits malformed and symlinked reports without exposing their targets', async () => {
    const ctx = new Context()
    const owner = fakeAgent(ctx, 'idle')
    const notifier = new WorkflowCompletionNotifier(ctx, { maxBytes: 1_000, maxConsecutiveWakes: 1 })
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-notice-'))
    const scratch = join(root, 'scratch')
    const report = join(scratch, 'report.md')
    await mkdir(scratch)
    await writeFile(report, Buffer.from([0xff]))
    await notifier.notify({
      token: {}, parent: owner.agent, displayName: 'malformed', status: 'completed', result: completed('fallback'), scratchDir: root,
    })
    expect(noticeText(owner.followup.mock.calls[0])).toContain('Result:\n"fallback"')
    expect(noticeText(owner.followup.mock.calls[0])).not.toContain('Scratch report:')

    const outside = join(root, 'outside.md')
    await writeFile(outside, 'HOST SECRET', 'utf8')
    await unlink(report)
    await symlink(outside, report)
    await notifier.notify({
      token: {}, parent: owner.agent, displayName: 'linked', status: 'completed', result: completed(null), scratchDir: root,
    })
    expect(noticeText(owner.inject.mock.calls[0])).not.toContain('HOST SECRET')
    expect(noticeText(owner.inject.mock.calls[0])).not.toContain('Scratch report:')
  })

  it('loops through legal short reads and omits premature EOF or changed reports', async () => {
    const ctx = new Context()
    const owner = fakeAgent(ctx, 'idle')
    const notifier = new WorkflowCompletionNotifier(ctx, { maxBytes: 1_000, maxConsecutiveWakes: 4 })
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-notice-'))
    const scratch = join(root, 'scratch')
    const report = join(scratch, 'report.md')
    await mkdir(scratch)
    await writeFile(report, 'complete short-read report', 'utf8')
    const probe = await open(report, 'r')
    const prototype = Object.getPrototypeOf(probe) as {
      read: typeof probe.read
      stat: typeof probe.stat
    }
    await probe.close()
    const nativeRead = prototype.read
    const shortRead = vi.spyOn(prototype, 'read').mockImplementation(function (
      this: typeof probe,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) {
      return Reflect.apply(nativeRead, this, [buffer, offset, Math.min(2, length), position]) as ReturnType<typeof probe.read>
    } as typeof probe.read)
    await notifier.notify({
      token: {}, parent: owner.agent, displayName: 'short', status: 'completed', result: completed('fallback'), scratchDir: root,
    })
    expect(noticeText(owner.followup.mock.calls[0])).toContain('complete short-read report')
    shortRead.mockRestore()

    const noProgress = vi.spyOn(prototype, 'read').mockResolvedValueOnce({
      bytesRead: 0,
      buffer: new Uint8Array(),
    })
    await notifier.notify({
      token: {}, parent: owner.agent, displayName: 'eof', status: 'completed', result: completed('fallback'), scratchDir: root,
    })
    expect(noticeText(owner.followup.mock.calls[1])).toContain('Result:\n"fallback"')
    noProgress.mockRestore()

    const nativeStat = prototype.stat
    let stats = 0
    const changed = vi.spyOn(prototype, 'stat').mockImplementation(async function (
      this: typeof probe,
      options?: Parameters<typeof probe.stat>[0],
    ) {
      stats += 1
      if (stats === 2) await writeFile(report, 'report changed after read', 'utf8')
      return await nativeStat.call(this, options as never)
    })
    await notifier.notify({
      token: {}, parent: owner.agent, displayName: 'changed', status: 'completed', result: completed('fallback'), scratchDir: root,
    })
    expect(noticeText(owner.followup.mock.calls[2])).toContain('Result:\n"fallback"')
    changed.mockRestore()
  })

  it('omits a report whose opened descriptor is no longer the probed file', async () => {
    const ctx = new Context()
    const owner = fakeAgent(ctx, 'idle')
    const notifier = new WorkflowCompletionNotifier(ctx, { maxBytes: 1_000, maxConsecutiveWakes: 1 })
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-notice-'))
    const scratch = join(root, 'scratch')
    const report = join(scratch, 'report.md')
    await mkdir(scratch)
    await writeFile(report, 'must not be retained', 'utf8')
    const probe = await open(report, 'r')
    const prototype = Object.getPrototypeOf(probe) as { stat: typeof probe.stat }
    await probe.close()
    const nativeStat = prototype.stat
    const changed = vi.spyOn(prototype, 'stat').mockImplementation(async function (
      this: typeof probe,
      options?: Parameters<typeof probe.stat>[0],
    ) {
      const info = await nativeStat.call(this, options as never)
      return new Proxy(info, {
        get(target, key, receiver) {
          if (key === 'isFile') return () => false
          return Reflect.get(target, key, receiver) as unknown
        },
      })
    })

    await notifier.notify({
      token: {}, parent: owner.agent, displayName: 'changed', status: 'completed', result: completed('fallback'), scratchDir: root,
    })
    expect(noticeText(owner.followup.mock.calls[0])).toContain('Result:\n"fallback"')
    changed.mockRestore()
  })

  it('trims valid oversized report boundaries and rejects oversized malformed bytes', async () => {
    const ctx = new Context()
    const owner = fakeAgent(ctx, 'idle')
    const notifier = new WorkflowCompletionNotifier(ctx, { maxBytes: 256, maxConsecutiveWakes: 2 })
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-notice-'))
    const scratch = join(root, 'scratch')
    const report = join(scratch, 'report.md')
    await mkdir(scratch)
    await writeFile(report, `${'x'.repeat(255)}😀${'x'.repeat(20)}`, 'utf8')
    await notifier.notify({
      token: {}, parent: owner.agent, displayName: 'valid', status: 'completed', result: completed('fallback'), scratchDir: root,
    })
    expect(noticeText(owner.followup.mock.calls[0])).toContain('Scratch report: scratch/report.md.')

    await writeFile(report, Buffer.alloc(300, 0xff))
    await notifier.notify({
      token: {}, parent: owner.agent, displayName: 'invalid', status: 'completed', result: completed('fallback'), scratchDir: root,
    })
    expect(noticeText(owner.followup.mock.calls[1])).toContain('Result:\n"fallback"')
    expect(noticeText(owner.followup.mock.calls[1])).not.toContain('Scratch report:')
  })

  it('queues one busy-owner wake and does not claim absent or non-file reports', async () => {
    const ctx = new Context()
    const owner = fakeAgent(ctx)
    const notifier = new WorkflowCompletionNotifier(ctx, { maxBytes: 1_000, maxConsecutiveWakes: 1 })
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-notice-'))
    const absentRoot = await mkdtemp(join(tmpdir(), 'dsh-workflow-notice-'))
    await mkdir(join(root, 'scratch', 'report.md'), { recursive: true })

    await notifier.notify({
      token: {},
      parent: owner.agent,
      displayName: 'x'.repeat(500),
      status: 'failed',
      result: { value: null, stopReason: 'error', agentsStarted: 0 },
      scratchDir: root,
    })
    await notifier.notify({
      token: {},
      parent: owner.agent,
      displayName: 'absent',
      status: 'cancelled',
      result: { value: null, stopReason: 'cancelled', agentsStarted: 0 },
      scratchDir: absentRoot,
    })

    await notifier.notify({
      token: {},
      parent: owner.agent,
      displayName: 'no-root',
      status: 'cancelled',
      result: { value: null, stopReason: 'cancelled', agentsStarted: 0 },
    })

    expect(owner.followup).toHaveBeenCalledTimes(1)
    expect(owner.inject).toHaveBeenCalledTimes(2)
    expect(noticeText(owner.followup.mock.calls[0])).not.toContain('Scratch report')
    expect((owner.followup.mock.calls[0]?.[0] as { source: { summary: string } }).source.summary.length).toBeLessThanOrEqual(120)
  })

  it('bounds consecutive idle wakes and resets them only after claimed human input', async () => {
    const ctx = new Context()
    const owner = fakeAgent(ctx, 'idle')
    const notifier = new WorkflowCompletionNotifier(ctx, { maxBytes: 1_000, maxConsecutiveWakes: 1 })
    const notify = (token: object) => notifier.notify({
      token,
      parent: owner.agent,
      displayName: 'audit',
      status: 'completed',
      result: completed(null),
    })

    await notify({})
    await notify({})
    expect(owner.followup).toHaveBeenCalledTimes(1)
    expect(owner.inject).toHaveBeenCalledTimes(1)

    ctx.emit('agent/inbox/claimed', {
      agent: owner.agent,
      message: createUserMessage({ content: [{ type: 'text', text: 'plugin' }], source: { kind: 'plugin', plugin: 'test', form: 'relay' } }),
      turn: 1,
    })
    await notify({})
    expect(owner.followup).toHaveBeenCalledTimes(1)
    expect(owner.inject).toHaveBeenCalledTimes(2)

    ctx.emit('agent/inbox/claimed', {
      agent: owner.agent,
      message: createUserMessage({ content: [{ type: 'text', text: 'human' }], source: { kind: 'user' } }),
      turn: 2,
    })
    await notify({})
    expect(owner.followup).toHaveBeenCalledTimes(2)
  })

  it('contains disposal races and never retries a claimed token', async () => {
    const ctx = new Context()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const owner = fakeAgent(ctx, 'idle')
    const thrown = { toString() { throw new Error('cannot render') } }
    owner.followup.mockImplementation(() => { throw thrown })
    const notifier = new WorkflowCompletionNotifier(ctx, { maxBytes: 1_000, maxConsecutiveWakes: 1 })
    const token = {}
    const input = {
      token,
      parent: owner.agent,
      displayName: 'audit',
      status: 'completed' as const,
      result: completed(null),
    }

    await expect(notifier.notify(input)).resolves.toBe(true)
    await expect(notifier.notify(input)).resolves.toBe(false)
    expect(owner.followup).toHaveBeenCalledTimes(1)
    expect(warnings).toEqual(['workflow-supervisor: completion notice delivery failed: [unrenderable thrown value]'])
  })

  it('rejects invalid delivery budgets', () => {
    const ctx = new Context()
    expect(() => new WorkflowCompletionNotifier(ctx, { maxBytes: 0, maxConsecutiveWakes: 1 })).toThrow(/maxBytes/)
    expect(() => new WorkflowCompletionNotifier(ctx, { maxBytes: 1, maxConsecutiveWakes: 0 })).toThrow(/maxConsecutiveWakes/)
    expect(() => new WorkflowCompletionNotifier(ctx, { maxBytes: 1, maxConsecutiveWakes: 1.5 })).toThrow(/maxConsecutiveWakes/)
  })

  it('rejects completion tokens that change owner or lose their reservation', async () => {
    const ctx = new Context()
    const first = fakeAgent(ctx)
    const second = fakeAgent(ctx)
    const notifier = new WorkflowCompletionNotifier(ctx, { maxBytes: 1_000, maxConsecutiveWakes: 1 })
    const token = {}
    notifier.reserve(token, first.agent)
    expect(() => {
      notifier.reserve(token, second.agent)
    }).toThrow(/changed owner/)

    const broken = new WorkflowCompletionNotifier(ctx, { maxBytes: 1_000, maxConsecutiveWakes: 1 })
    const internal = broken as unknown as {
      reserve: (token: object, parent: Agent) => void
    }
    internal.reserve = () => {}
    await expect(broken.notify({
      token: {}, parent: first.agent, displayName: 'broken', status: 'completed', result: completed(null),
    })).rejects.toThrow(/reservation is inconsistent/)
  })
})
