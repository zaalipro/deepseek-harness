// Keyless shipped-Web acceptance for the workflow run dashboard: saved
// definitions, slash discovery, background launch with display-name handles,
// pause/resume gates, stop, and the supervisor roster that the dashboard
// mirrors. No browser and no model call — the workflow scripts below complete
// or park on script-level gates, so no child agent or provider is needed.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
// Empty type imports carry the commands/workflows/supervisor Context merges.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-workflow-registry'
import type {} from '@deepseek-ai/dsh-workflow-supervisor'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

let scaffold: WebScaffold | undefined

afterEach(async () => {
  await scaffold?.close()
  scaffold = undefined
})

/** A definition whose script completes immediately (no child agents). */
function definition(name: string, script: string): string {
  return JSON.stringify({ meta: { name, description: 'a keyless test workflow' }, script })
}

async function writeDefinition(workspaceCwd: string, name: string, script: string): Promise<void> {
  // Anchor project discovery on a .git inside the workspace, so the project
  // root is the workspace rather than a stray ancestor (this host has /tmp/.git).
  await mkdir(join(workspaceCwd, '.git'), { recursive: true })
  const dir = join(workspaceCwd, '.dsh', 'workflows')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${name}.workflow.json`), definition(name, script), 'utf8')
}

describe('keyless web: workflow dashboard path', () => {
  it('discovers saved definitions, launches in the background with numbered handles, and never prints a run id', async () => {
    scaffold = await launchWebScaffold()
    const ctx = scaffold.ctx
    await writeDefinition(scaffold.workspaceCwd, 'smoke', 'complete({ ok: true })')
    const handle = await ctx.agents.create({
      sessionId: SessionId('wf-dashboard'),
      meta: { cwd: scaffold.workspaceCwd },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    try {
      // Slash discovery: the built-in workflow commands are always present.
      expect(ctx.commands.list(handle.agent).map(d => d.name)).toEqual(
        expect.arrayContaining(['workflow', 'workflows', 'create-workflow']),
      )

      // Background launch: the command returns immediately with the display name.
      const first = await ctx.commands.execute(handle.agent, '/workflow smoke', AbortSignal.timeout(10_000))
      expect(first?.result.kind).toBe('success')
      expect(first?.result.text).toContain('Started workflow "smoke" in the background')
      expect(first?.result.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)

      // The completed run reaches the retained roster the dashboard reads.
      await vi.waitFor(() => {
        const runs = ctx.workflowSupervisor.listRuns(handle.agent)
        expect(runs).toHaveLength(1)
        expect(runs[0]).toMatchObject({ displayName: 'smoke', name: 'smoke', status: 'completed', numberedHandle: false })
      })

      // Launching the same definition again numbers the handle.
      await ctx.commands.execute(handle.agent, '/workflow smoke', AbortSignal.timeout(10_000))
      await vi.waitFor(() => {
        const runs = ctx.workflowSupervisor.listRuns(handle.agent)
        expect(runs).toHaveLength(2)
        expect(runs.map(run => run.displayName)).toEqual(expect.arrayContaining(['smoke', 'smoke-2']))
        expect(runs.find(run => run.displayName === 'smoke-2')).toMatchObject({ numberedHandle: true })
      })
    } finally {
      await handle.dispose()
    }
  })

  it('parks a script-level gate as needs-input and resumes past an await_user gate to completion', async () => {
    scaffold = await launchWebScaffold()
    const ctx = scaffold.ctx
    await writeDefinition(scaffold.workspaceCwd, 'gated', "await await_user('verification', 'confirm this'); complete({ advanced: true })")
    const handle = await ctx.agents.create({
      sessionId: SessionId('wf-gated'),
      meta: { cwd: scaffold.workspaceCwd },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    try {
      await ctx.commands.execute(handle.agent, '/workflow gated', AbortSignal.timeout(10_000))

      // The script parks on await_user → Needs input.
      await vi.waitFor(() => {
        const run = ctx.workflowSupervisor.listRuns(handle.agent)[0]
        expect(run?.status).toBe('needs-input')
        expect(run?.gate).toMatchObject({ resumable: true, kind: 'verification' })
      })

      // Resume continues past the gate and the run completes.
      const resume = await ctx.commands.execute(handle.agent, '/workflow resume gated', AbortSignal.timeout(10_000))
      expect(resume?.result.kind).toBe('success')
      await vi.waitFor(() => {
        const run = ctx.workflowSupervisor.listRuns(handle.agent)[0]
        expect(run?.status).toBe('completed')
        expect(run?.result).toEqual({ advanced: true })
      })
    } finally {
      await handle.dispose()
    }
  })

  it('rejects save for a numbered duplicate handle', async () => {
    scaffold = await launchWebScaffold()
    const ctx = scaffold.ctx
    await writeDefinition(scaffold.workspaceCwd, 'dedupe', 'complete({})')
    const handle = await ctx.agents.create({
      sessionId: SessionId('wf-dedupe'),
      meta: { cwd: scaffold.workspaceCwd },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    try {
      await ctx.commands.execute(handle.agent, '/workflow dedupe', AbortSignal.timeout(10_000))
      await ctx.commands.execute(handle.agent, '/workflow dedupe', AbortSignal.timeout(10_000))
      await vi.waitFor(() => {
        expect(ctx.workflowSupervisor.listRuns(handle.agent)).toHaveLength(2)
      })
      const save = await ctx.commands.execute(handle.agent, '/workflow save dedupe-2', AbortSignal.timeout(10_000))
      expect(save?.result.kind).toBe('error')
      expect(save?.result.text).toContain('numbered handle')
    } finally {
      await handle.dispose()
    }
  })
})
