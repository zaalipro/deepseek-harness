import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { parseDefinitionFile, WorkflowRegistry } from '../src/index.ts'
import { isWorkflowName } from '../src/types.ts'

describe('parseDefinitionFile', () => {
  it('parses a valid envelope', () => {
    const def = parseDefinitionFile(JSON.stringify({
      meta: { name: 'review-changes', description: 'Review a diff' },
      script: 'complete({ done: true })',
    }), '/tmp/review-changes.workflow.json', 'review-changes')
    expect(def.name).toBe('review-changes')
    expect(def.script).toContain('complete')
  })

  it('rejects a filename that does not match meta.name', () => {
    expect(() => parseDefinitionFile(JSON.stringify({
      meta: { name: 'other', description: 'x' },
      script: 'return 1',
    }), '/tmp/review-changes.workflow.json', 'review-changes')).toThrow(/must match meta.name/)
  })

  it('rejects unknown envelope fields', () => {
    expect(() => parseDefinitionFile(JSON.stringify({
      meta: { name: 'a', description: 'x' }, script: 'return 1', extra: true,
    }), '/tmp/a.workflow.json', 'a')).toThrow(/unknown envelope field/)
  })

  it('rejects invalid JSON', () => {
    expect(() => parseDefinitionFile('{', '/tmp/a.workflow.json', 'a')).toThrow(/not valid JSON/)
  })
})

describe('isWorkflowName', () => {
  it('accepts kebab-case and rejects the rest', () => {
    expect(isWorkflowName('review-changes')).toBe(true)
    expect(isWorkflowName('a')).toBe(true)
    expect(isWorkflowName('a-b-2')).toBe(true)
    expect(isWorkflowName('Review')).toBe(false)
    expect(isWorkflowName('-a')).toBe(false)
    expect(isWorkflowName('a-')).toBe(false)
    expect(isWorkflowName('a_b')).toBe(false)
  })
})

describe('WorkflowRegistry discovery', () => {
  async function setup(): Promise<{ home: string; project: string }> {
    const base = await mkdtemp(join(tmpdir(), 'dsh-wf-registry-'))
    const home = join(base, 'home')
    const project = join(base, 'project')
    await mkdir(join(home, 'workflows'), { recursive: true })
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(project, '.dsh', 'workflows'), { recursive: true })
    return { home, project }
  }

  it('discovers project and user roots with project precedence', async () => {
    const { home, project } = await setup()
    await writeFile(join(project, '.dsh', 'workflows', 'shared.workflow.json'), JSON.stringify({
      meta: { name: 'shared', description: 'project copy' }, script: 'return "project"',
    }))
    await writeFile(join(home, 'workflows', 'shared.workflow.json'), JSON.stringify({
      meta: { name: 'shared', description: 'user copy' }, script: 'return "user"',
    }))
    await writeFile(join(home, 'workflows', 'user-only.workflow.json'), JSON.stringify({
      meta: { name: 'user-only', description: 'user only' }, script: 'return 1',
    }))
    const ctx = new Context()
    await ctx.plugin(WorkflowRegistry, { enabled: true, dshHome: home, watch: false })
    const summaries = await ctx.workflows.list({ cwd: project })
    expect(summaries.map(s => s.name)).toEqual(['shared', 'user-only'])
    const shared = await ctx.workflows.get('shared', { cwd: project })
    expect(shared?.script).toBe('return "project"')
    expect(shared?.scope).toBe('project')

  })

  it('fails loud on a malformed definition file', async () => {
    const { home, project } = await setup()
    await writeFile(join(project, '.dsh', 'workflows', 'bad.workflow.json'), '{ not json')
    const ctx = new Context()
    await ctx.plugin(WorkflowRegistry, { enabled: true, dshHome: home, watch: false })
    await expect(ctx.workflows.list({ cwd: project })).rejects.toThrow(/bad\.workflow\.json/)

  })
})
