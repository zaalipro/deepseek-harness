import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { Session } from '@deepseek-ai/dsh-session'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { WorkflowRegistry } from '../src/index.ts'

const contexts: Context[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function harness(): Promise<{ ctx: Context; project: string }> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-wf-registry-remote-'))
  temporaryDirectories.push(base)
  const home = join(base, 'home')
  const project = join(base, 'project')
  await mkdir(join(home, 'workflows'), { recursive: true })
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, '.dsh', 'workflows'), { recursive: true })
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: project })
  await ctx.plugin(WorkflowRegistry, { enabled: true, dshHome: home, watch: false })
  return { ctx, project }
}

describe('workflow definition Remote', () => {
  it.skipIf(process.platform === 'win32')('publishes session-cwd-fenced browser summaries', async () => {
    const { ctx, project } = await harness()
    const sessionProject = join(project, '..', 'session-project')
    await mkdir(join(sessionProject, '.git'), { recursive: true })
    await mkdir(join(sessionProject, '.dsh', 'workflows'), { recursive: true })
    await writeFile(join(project, '.dsh', 'workflows', 'host-only.workflow.json'), JSON.stringify({
      meta: { name: 'host-only', description: 'Must not cross the session fence' },
      script: 'return 0',
    }))
    await writeFile(join(sessionProject, '.dsh', 'workflows', 'review.workflow.json'), JSON.stringify({
      meta: {
        name: 'review',
        description: 'Review the current project',
        whenToUse: 'Before merging',
        phases: [{ title: 'Inspect', detail: 'Read the diff' }],
      },
      script: 'return 1',
    }))
    await writeFile(join(sessionProject, '.dsh', 'workflows', 'plain.workflow.json'), JSON.stringify({
      meta: { name: 'plain', description: 'No listing guidance' },
      script: 'return 2',
    }))

    expect(ctx.workflows.typertRemote).toMatchObject({
      serviceKey: 'workflows',
      namespace: 'workflowDefinitions',
    })
    expect(remoteMethods(ctx.workflows)).toEqual([
      { method: 'listForClient', exportName: 'list', invocation: { kind: 'direct' } },
    ])
    const session = { header: { cwd: sessionProject } } as unknown as Session
    await expect(ctx.workflows.listForClient(session, new AbortController().signal)).resolves.toStrictEqual([
      {
        name: 'plain',
        description: 'No listing guidance',
        scope: 'project',
      },
      {
        name: 'review',
        description: 'Review the current project',
        whenToUse: 'Before merging',
        scope: 'project',
      },
    ])
  })

  it('does not fall back to the Host cwd when the session has no cwd', async () => {
    const { ctx } = await harness()
    const session = { header: {} } as unknown as Session

    await expect(ctx.workflows.listForClient(session, new AbortController().signal))
      .rejects.toThrow('workflow definition listing requires a session cwd')
  })
})
