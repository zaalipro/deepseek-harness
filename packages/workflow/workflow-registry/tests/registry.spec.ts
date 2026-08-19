import { describe, expect, it, vi } from 'vitest'
import { lstat, mkdtemp, writeFile, mkdir, readFile, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { isWorkflowName, parseDefinitionFile, WorkflowRegistry } from '../src/index.ts'

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
    expect(isWorkflowName('2-a')).toBe(false)
    expect(isWorkflowName('pause')).toBe(false)
    expect(isWorkflowName('con')).toBe(false)
    expect(isWorkflowName(`a${'b'.repeat(64)}`)).toBe(false)
    expect(isWorkflowName('Review')).toBe(false)
    expect(isWorkflowName('-a')).toBe(false)
    expect(isWorkflowName('a-')).toBe(false)
    expect(isWorkflowName('a_b')).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('WorkflowRegistry discovery', () => {
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
    await ctx.plugin(LocalFileSystem, { cwd: project })
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
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { enabled: true, dshHome: home, watch: false })
    await expect(ctx.workflows.list({ cwd: project })).rejects.toThrow(/bad\.workflow\.json/)

  })

  it('atomically saves a validated project definition and emits an explicit change', async () => {
    const { home, project } = await setup()
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { enabled: true, dshHome: home, watch: false })
    let changes = 0
    ctx.on('workflows/change', () => { changes += 1 })
    const path = await ctx.workflows.save({
      meta: { name: 'safe-save', description: 'Saved safely' },
      script: 'complete({ ok: true })',
    }, { cwd: project, scope: 'project' })
    expect(path).toBe(join(project, '.dsh', 'workflows', 'safe-save.workflow.json'))
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      meta: { name: 'safe-save', description: 'Saved safely' },
      script: 'complete({ ok: true })',
    })
    expect((await lstat(path)).isFile()).toBe(true)
    expect(changes).toBe(1)
  })

  it('refuses final-component symlinks when saving or discovering', async () => {
    const { home, project } = await setup()
    const outside = join(project, 'outside.json')
    await writeFile(outside, 'sentinel')
    const linked = join(project, '.dsh', 'workflows', 'linked.workflow.json')
    await symlink(outside, linked)
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { enabled: true, dshHome: home, watch: false })
    await expect(ctx.workflows.save({
      meta: { name: 'linked', description: 'must not follow' },
      script: 'return 1',
    }, { cwd: project, scope: 'project' })).rejects.toThrow(/symbolic link/)
    await expect(ctx.workflows.list({ cwd: project })).rejects.toThrow(/symbolic-link definitions/)
    expect(await readFile(outside, 'utf8')).toBe('sentinel')
  })

  it('reads a definition through the descriptor opened before a final-link substitution', async () => {
    const { home, project } = await setup()
    const path = join(project, '.dsh', 'workflows', 'stable.workflow.json')
    await writeFile(path, JSON.stringify({
      meta: { name: 'stable', description: 'opened definition' }, script: 'complete("opened")',
    }))
    const outside = join(project, 'outside.workflow.json')
    await writeFile(outside, JSON.stringify({
      meta: { name: 'stable', description: 'substituted definition' }, script: 'complete("substituted")',
    }))
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { enabled: true, dshHome: home, watch: false })
    const localFs = ctx.fs as LocalFileSystem
    localFs.internals.inspectReadBytesNoFollowAfterOpen = async () => {
      await rename(path, `${path}.opened`)
      await symlink(outside, path)
    }

    await expect(ctx.workflows.get('stable', { cwd: project })).resolves.toMatchObject({
      description: 'opened definition',
      script: 'complete("opened")',
    })
  })

  it('rejects a final-link substitution at save publication without changing its target', async () => {
    const { home, project } = await setup()
    const path = join(project, '.dsh', 'workflows', 'raced.workflow.json')
    await writeFile(path, JSON.stringify({
      meta: { name: 'raced', description: 'old definition' }, script: 'complete("old")',
    }))
    const outside = join(project, 'outside.json')
    await writeFile(outside, 'sentinel')
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { enabled: true, dshHome: home, watch: false })
    const localFs = ctx.fs as LocalFileSystem
    localFs.internals.inspectTemp = async () => {
      await rename(path, `${path}.opened`)
      await symlink(outside, path)
    }

    await expect(ctx.workflows.save({
      meta: { name: 'raced', description: 'new definition' }, script: 'complete("new")',
    }, { cwd: project, scope: 'project' })).rejects.toThrow(/regular file|symbolic link/)
    expect(await readFile(outside, 'utf8')).toBe('sentinel')
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
  })

  it('rejects a project workflow root that escapes through an ancestor symlink', async () => {
    const { home, project } = await setup()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-workflow-outside-'))
    await mkdir(join(outside, 'workflows'))
    await writeFile(join(outside, 'workflows', 'escaped.workflow.json'), JSON.stringify({
      meta: { name: 'escaped', description: 'outside the project' }, script: 'return 1',
    }))
    await rm(join(project, '.dsh'), { recursive: true })
    await symlink(outside, join(project, '.dsh'))
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { enabled: true, dshHome: home, watch: false })

    await expect(ctx.workflows.list({ cwd: project })).rejects.toThrow(/symbolic-link ancestor/)
    await expect(ctx.workflows.save({
      meta: { name: 'escaped', description: 'must stay in the project' },
      script: 'return 2',
    }, { cwd: project, scope: 'project' })).rejects.toThrow(/symbolic-link ancestor/)
    expect(await readFile(join(outside, 'workflows', 'escaped.workflow.json'), 'utf8')).toContain('outside the project')
  })

  it('discovers bundled, project, and user definitions with declared precedence', async () => {
    const { home, project } = await setup()
    const bundled = join(project, 'bundled')
    await mkdir(bundled)
    for (const [root, description] of [
      [join(home, 'workflows'), 'user copy'],
      [join(project, '.dsh', 'workflows'), 'project copy'],
      [bundled, 'bundled copy'],
    ] as const) {
      await writeFile(join(root, 'shared.workflow.json'), JSON.stringify({
        meta: { name: 'shared', description }, script: `return ${JSON.stringify(description)}`,
      }))
    }
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { dshHome: home, bundledDir: bundled, watch: false })

    await expect(ctx.workflows.get('shared', { cwd: project })).resolves.toMatchObject({
      scope: 'bundled', description: 'bundled copy', script: 'return "bundled copy"',
    })
  })

  it('returns empty reads when disabled and undefined for an invalid lookup name', async () => {
    const { home, project } = await setup()
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { enabled: false, dshHome: home, watch: false })

    await expect(ctx.workflows.list()).resolves.toEqual([])
    await expect(ctx.workflows.snapshot()).resolves.toEqual({ definitions: [], complete: true })
    await expect(ctx.workflows.get('Bad_Name')).resolves.toBeUndefined()
  })

  it('resolves constructor defaults outside the schema-normalized plugin path', async () => {
    const { project } = await setup()
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })

    const registry = new WorkflowRegistry(ctx, { enabled: false })

    await expect(registry.list()).resolves.toEqual([])
  })

  it('falls back to cwd when no ancestor is a git root', async () => {
    const { home, project } = await setup()
    await rm(join(project, '.git'), { recursive: true })
    await writeFile(join(project, '.dsh', 'workflows', 'local.workflow.json'), JSON.stringify({
      meta: { name: 'local', description: 'cwd-scoped' }, script: 'return 1',
    }))
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { dshHome: home, watch: false })

    await expect(ctx.workflows.list({ cwd: project })).resolves.toContainEqual(
      expect.objectContaining({ name: 'local', scope: 'project' }),
    )
  })

  it('uses process cwd when a lookup omits cwd and accepts execution-world Windows paths', async () => {
    const { home, project } = await setup()
    await writeFile(join(project, '.dsh', 'workflows', 'implicit.workflow.json'), JSON.stringify({
      meta: { name: 'implicit', description: 'implicit cwd' }, script: 'return 1',
    }))
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { dshHome: home, watch: false })
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(project)

    await expect(ctx.workflows.list()).resolves.toContainEqual(
      expect.objectContaining({ name: 'implicit' }),
    )
    cwd.mockRestore()
    await expect(ctx.workflows.list({ cwd: 'C:\\workspace\\project' }))
      .rejects.toThrow(/workflow root escapes its project scope/)
  })

  it('rejects invalid envelope values and fields', () => {
    for (const raw of ['null', '[]', '1', '"text"']) {
      expect(() => parseDefinitionFile(raw, '/tmp/a.workflow.json', 'a')).toThrow(/JSON object/)
    }
    expect(() => parseDefinitionFile(JSON.stringify({
      meta: { name: 'a', description: 'x' }, script: 1,
    }), '/tmp/a.workflow.json', 'a')).toThrow(/script.*string/)
    expect(() => parseDefinitionFile(JSON.stringify({
      meta: { name: 'Bad_Name', description: 'x' }, script: 'return 1',
    }), '/tmp/Bad_Name.workflow.json', 'Bad_Name')).toThrow(/invalid meta.*kebab-case/)
  })

  it('keeps optional metadata in summaries and remote-safe data', async () => {
    const { home, project } = await setup()
    await writeFile(join(project, '.dsh', 'workflows', 'rich.workflow.json'), JSON.stringify({
      meta: {
        name: 'rich',
        description: 'rich metadata',
        whenToUse: 'before merge',
        phases: [{ title: 'Inspect', detail: 'read files' }],
      },
      script: 'return 1',
    }))
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { dshHome: home, watch: false })

    await expect(ctx.workflows.snapshot({ cwd: project })).resolves.toEqual({
      complete: true,
      definitions: [expect.objectContaining({
        name: 'rich',
        whenToUse: 'before merge',
        phases: [{ title: 'Inspect', detail: 'read files' }],
      })],
    })
  })

  it('rejects workflow roots and entries that are not regular directories and files', async () => {
    const first = await setup()
    await rm(join(first.project, '.dsh', 'workflows'), { recursive: true })
    await writeFile(join(first.project, '.dsh', 'workflows'), 'not a directory')
    const firstCtx = new Context()
    await firstCtx.plugin(LocalFileSystem, { cwd: first.project })
    await firstCtx.plugin(WorkflowRegistry, { dshHome: first.home, watch: false })
    await expect(firstCtx.workflows.list({ cwd: first.project })).rejects.toThrow(/root must be a directory/)

    const second = await setup()
    await mkdir(join(second.project, '.dsh', 'workflows', 'nested.workflow.json'))
    const secondCtx = new Context()
    await secondCtx.plugin(LocalFileSystem, { cwd: second.project })
    await secondCtx.plugin(WorkflowRegistry, { dshHome: second.home, watch: false })
    await expect(secondCtx.workflows.list({ cwd: second.project })).rejects.toThrow(/regular file/)
  })

  it('rejects a symbolic-link workflow root within its allowed base', async () => {
    const { home, project } = await setup()
    const realRoot = join(project, 'real-workflows')
    await mkdir(realRoot)
    await rm(join(project, '.dsh', 'workflows'), { recursive: true })
    await symlink(realRoot, join(project, '.dsh', 'workflows'))
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { dshHome: home, watch: false })

    await expect(ctx.workflows.list({ cwd: project })).rejects.toThrow(/symbolic-link workflow roots/)
  })

  it('rejects an invalid UTF-8 definition', async () => {
    const { home, project } = await setup()
    await writeFile(join(project, '.dsh', 'workflows', 'invalid.workflow.json'), Buffer.from([0xff]))
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { dshHome: home, watch: false })

    await expect(ctx.workflows.list({ cwd: project })).rejects.toThrow(/not valid UTF-8/)
  })

  it('rejects a root with too many definitions', async () => {
    const { home, project } = await setup()
    for (const name of ['a', 'b']) {
      await writeFile(join(project, '.dsh', 'workflows', `${name}.workflow.json`), JSON.stringify({
        meta: { name, description: name }, script: 'return 1',
      }))
    }
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { dshHome: home, watch: false, maxDefinitionsPerRoot: 1 })

    await expect(ctx.workflows.list({ cwd: project })).rejects.toThrow(/found 2.*maximum is 1/)
  })

  it('validates save input and both complete envelope and script byte caps', async () => {
    const { home, project } = await setup()
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { dshHome: home, watch: false, maxDefinitionBytes: 180 })

    await expect(ctx.workflows.save({
      meta: { name: 'bad-script', description: 'bad' }, script: 1 as unknown as string,
    }, { cwd: project, scope: 'project' })).rejects.toThrow(/script must be a string/)
    await expect(ctx.workflows.save({
      meta: { name: 'script-cap', description: 'large' }, script: 'x'.repeat(181),
    }, { cwd: project, scope: 'project' })).rejects.toThrow(/script exceeds.*180-byte/)
    await expect(ctx.workflows.save({
      meta: { name: 'envelope-cap', description: 'd'.repeat(130) }, script: 'return 1',
    }, { cwd: project, scope: 'project' })).rejects.toThrow(/definition exceeds.*180-byte/)
  })

  it('replaces an existing file and saves user-scoped definitions', async () => {
    const { home, project } = await setup()
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { dshHome: home, watch: false })
    await ctx.workflows.save({
      meta: { name: 'replace-me', description: 'first' }, script: 'return 1',
    }, { cwd: project, scope: 'project' })
    const replaced = await ctx.workflows.save({
      meta: { name: 'replace-me', description: 'second' }, script: 'return 2',
    }, { cwd: project, scope: 'project' })
    expect(JSON.parse(await readFile(replaced, 'utf8'))).toMatchObject({ script: 'return 2' })

    const userPath = await ctx.workflows.save({
      meta: { name: 'user-copy', description: 'user scoped' }, script: 'return 3',
    }, { cwd: project, scope: 'user', signal: new AbortController().signal })
    expect(userPath).toBe(join(home, 'workflows', 'user-copy.workflow.json'))
  })

  it('rejects non-directory save roots and non-file destinations', async () => {
    const first = await setup()
    await rm(join(first.project, '.dsh', 'workflows'), { recursive: true })
    await writeFile(join(first.project, '.dsh', 'workflows'), 'not a directory')
    const firstCtx = new Context()
    await firstCtx.plugin(LocalFileSystem, { cwd: first.project })
    await firstCtx.plugin(WorkflowRegistry, { dshHome: first.home, watch: false })
    await expect(firstCtx.workflows.save({
      meta: { name: 'invalid-root', description: 'invalid' }, script: 'return 1',
    }, { cwd: first.project, scope: 'project' })).rejects.toThrow(/root must be a directory/)

    const second = await setup()
    await mkdir(join(second.project, '.dsh', 'workflows', 'destination.workflow.json'))
    const secondCtx = new Context()
    await secondCtx.plugin(LocalFileSystem, { cwd: second.project })
    await secondCtx.plugin(WorkflowRegistry, { dshHome: second.home, watch: false })
    await expect(secondCtx.workflows.save({
      meta: { name: 'destination', description: 'invalid' }, script: 'return 1',
    }, { cwd: second.project, scope: 'project' })).rejects.toThrow(/definition must be a regular file/)

  })

  it('rejects a symbolic-link save root and honors an explicit save signal', async () => {
    const { home, project } = await setup()
    const realRoot = join(project, 'real-workflows')
    await mkdir(realRoot)
    await rm(join(project, '.dsh', 'workflows'), { recursive: true })
    await symlink(realRoot, join(project, '.dsh', 'workflows'))
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { dshHome: home, watch: false })
    const signal = new AbortController().signal

    await expect(ctx.workflows.save({
      meta: { name: 'linked-root', description: 'invalid' }, script: 'return 1',
    }, { cwd: project, scope: 'project', signal })).rejects.toThrow(/symbolic-link workflow roots/)
  })

  it('uses process cwd for save when cwd is omitted', async () => {
    const { home, project } = await setup()
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { dshHome: home, watch: false })
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(project)

    const path = await ctx.workflows.save({
      meta: { name: 'implicit-save', description: 'implicit cwd' }, script: 'return 1',
    }, { scope: 'project' })

    cwd.mockRestore()
    expect(path).toBe(join(project, '.dsh', 'workflows', 'implicit-save.workflow.json'))
  })

  it('watches definition creation, mutation, removal, and a missing root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-wf-registry-watch-'))
    const home = join(base, 'missing-home')
    const project = join(base, 'project')
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(project, '.dsh'), { recursive: true })
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    const plugin = await ctx.plugin(WorkflowRegistry, {
      dshHome: home,
      watch: true,
      watchStabilityThresholdMs: 10,
      watchPollIntervalMs: 5,
    })
    let changes = 0
    ctx.on('workflows/change', () => { changes += 1 })

    await expect(ctx.workflows.list({ cwd: project })).resolves.toEqual([])
    await vi.waitFor(() => { expect(changes).toBeGreaterThan(0) }, { timeout: 3_000 })
    const root = join(project, '.dsh', 'workflows')
    await mkdir(root, { recursive: true })
    const path = join(root, 'watched.workflow.json')
    await writeFile(path, JSON.stringify({
      meta: { name: 'watched', description: 'first' }, script: 'return 1',
    }))
    const afterReady = changes
    await vi.waitFor(() => { expect(changes).toBeGreaterThan(afterReady) }, { timeout: 3_000 })

    const afterAdd = changes
    await new Promise(resolve => setTimeout(resolve, 50))
    await writeFile(path, JSON.stringify({
      meta: { name: 'watched', description: 'second' }, script: 'return 2',
    }))
    await vi.waitFor(() => { expect(changes).toBeGreaterThan(afterAdd) }, { timeout: 3_000 })
    const afterChange = changes
    await rm(path)
    await vi.waitFor(() => { expect(changes).toBeGreaterThan(afterChange) }, { timeout: 3_000 })
    await rm(root, { recursive: true })

    await plugin.dispose()
    await plugin.dispose()
  })

  it('coalesces change listeners and contains synchronous and asynchronous failures', async () => {
    const { home, project } = await setup()
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { dshHome: home, watch: true })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    let completed = 0
    ctx.on('workflows/change', () => { throw new Error('sync listener') })
    ctx.on('workflows/change', () => Promise.reject(new Error('async listener')) as never)
    ctx.on('workflows/change', () => { throw { toString(): never { throw new Error('unrenderable') } } })
    ctx.on('workflows/change', () => { completed += 1 })

    await ctx.workflows.list({ cwd: project })
    await vi.waitFor(() => {
      expect(completed).toBeGreaterThan(0)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener threw'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener rejected'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[unrenderable thrown value]'))
    })
  })

  it('bounds watched projects while retaining shared roots', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-wf-registry-lru-'))
    const home = join(base, 'home')
    const first = join(base, 'first')
    const second = join(base, 'second')
    for (const project of [first, second]) {
      await mkdir(join(project, '.git'), { recursive: true })
      await mkdir(join(project, '.dsh', 'workflows'), { recursive: true })
    }
    await mkdir(join(home, 'workflows'), { recursive: true })
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: first })
    const plugin = await ctx.plugin(WorkflowRegistry, {
      dshHome: home,
      watch: true,
      watchMaxProjects: 1,
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    await ctx.workflows.list({ cwd: first })
    const internals = ctx.workflows as unknown as {
      watchedProjects: Map<string, Set<string>>
      watchedRoots: Map<string, { readonly close: () => Promise<void> }>
    }
    const firstRoot = join(first, '.dsh', 'workflows')
    const firstState = internals.watchedRoots.get(firstRoot)
    expect(firstState).toBeDefined()
    if (firstState === undefined) throw new Error('first watcher did not attach')
    internals.watchedRoots.set(firstRoot, {
      close: () => firstState.close().then(() => Promise.reject(new Error('eviction close failed'))),
    })
    await ctx.workflows.list({ cwd: second })
    expect([...internals.watchedProjects.keys()]).toEqual([second])
    expect(internals.watchedRoots.has(firstRoot)).toBe(false)
    expect(internals.watchedRoots.has(join(second, '.dsh', 'workflows'))).toBe(true)
    expect(internals.watchedRoots.has(join(home, 'workflows'))).toBe(true)
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('watcher close failed'))
    })
    await plugin.dispose()
  })

  it('fences stale watcher callbacks and contains watcher failures', async () => {
    const { home, project } = await setup()
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    const plugin = await ctx.plugin(WorkflowRegistry, { dshHome: home, watch: true })
    await ctx.workflows.list({ cwd: project })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    interface WatchState {
      readonly watcher: {
        emit(event: string, ...args: unknown[]): boolean
        listeners(event: string): Array<(...args: unknown[]) => void>
      }
      readonly close: () => Promise<void>
    }
    const internals = ctx.workflows as unknown as {
      watchedRoots: Map<string, WatchState>
      watchedProjects: Map<string, Set<string>>
      ensureWatcher(path: string): void
      reopenWatcher(path: string, state: WatchState): void
      queueChange(): void
    }
    const root = join(project, '.dsh', 'workflows')
    const state = internals.watchedRoots.get(root)
    expect(state).toBeDefined()
    if (state === undefined) throw new Error('watcher did not attach')
    internals.ensureWatcher(root)
    const errorListener = state.watcher.listeners('error')[0]
    const readyListener = state.watcher.listeners('ready')[0]
    state.watcher.emit('add', join(root, 'ignored.txt'))
    state.watcher.emit('error', new Error('watch failed'))
    internals.queueChange()
    internals.queueChange()
    state.watcher.emit('addDir', root)
    state.watcher.emit('unlinkDir', root)
    await vi.waitFor(() => {
      expect(internals.watchedRoots.get(root)).toBeDefined()
      expect(internals.watchedRoots.get(root)).not.toBe(state)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('watch failed'))
    })
    internals.reopenWatcher(root, state)
    const reopened = internals.watchedRoots.get(root)
    expect(reopened).toBeDefined()
    if (reopened === undefined) throw new Error('watcher did not reopen')
    reopened.watcher.emit('unlinkDir', root)

    const failingPath = join(project, 'failing-watch')
    const failingState: WatchState = {
      watcher: { emit: () => false, listeners: () => [] },
      close: () => Promise.reject(new Error('close failed')),
    }
    internals.watchedRoots.set(failingPath, failingState)
    internals.watchedProjects.set('failing-project', new Set([failingPath]))
    internals.reopenWatcher(failingPath, failingState)
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('watcher refresh failed'))
    })
    const detachedPath = join(project, 'detached-watch')
    const detachedState: WatchState = {
      watcher: { emit: () => false, listeners: () => [] },
      close: () => Promise.resolve(),
    }
    internals.watchedRoots.set(detachedPath, detachedState)
    internals.reopenWatcher(detachedPath, detachedState)
    await state.close()
    await state.close()
    errorListener?.(new Error('closed watcher error'))
    readyListener?.()
    state.watcher.emit('change', join(root, 'closed.workflow.json'))
    await plugin.dispose()
  })

  it('recognizes a linked-worktree .git file as the project marker', async () => {
    const { home, project } = await setup()
    const nested = join(project, 'packages', 'app')
    await mkdir(nested, { recursive: true })
    await rm(join(project, '.git'), { recursive: true })
    await writeFile(join(project, '.git'), 'gitdir: /tmp/example-worktree\n')
    await writeFile(join(project, '.dsh', 'workflows', 'root.workflow.json'), JSON.stringify({
      meta: { name: 'root', description: 'found at the worktree root' }, script: 'return 1',
    }))
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: nested })
    await ctx.plugin(WorkflowRegistry, { enabled: true, dshHome: home, watch: false })

    await expect(ctx.workflows.list({ cwd: nested })).resolves.toEqual([
      expect.objectContaining({ name: 'root', scope: 'project' }),
    ])
  })

  it('honors cancellation and rejects definitions above the configured byte limit', async () => {
    const { home, project } = await setup()
    await writeFile(join(project, '.dsh', 'workflows', 'large.workflow.json'), JSON.stringify({
      meta: { name: 'large', description: 'too large' }, script: 'x'.repeat(100),
    }))
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { enabled: true, dshHome: home, watch: false, maxDefinitionBytes: 32 })
    await expect(ctx.workflows.list({ cwd: project })).rejects.toThrow(/32-byte limit/)
    const aborted = new AbortController()
    aborted.abort(new Error('stop discovery'))
    await expect(ctx.workflows.list({ cwd: project, signal: aborted.signal })).rejects.toThrow('stop discovery')
  })

})

describe('WorkflowRegistry local Win32 no-follow limitation', () => {
  async function setup(): Promise<{ ctx: Context; project: string }> {
    const base = await mkdtemp(join(tmpdir(), 'dsh-wf-registry-win32-'))
    const home = join(base, 'home')
    const project = join(base, 'project')
    await mkdir(join(home, 'workflows'), { recursive: true })
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(project, '.dsh', 'workflows'), { recursive: true })
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: project })
    await ctx.plugin(WorkflowRegistry, { enabled: true, dshHome: home, watch: false })
    const localFs = ctx.fs as LocalFileSystem
    localFs.internals.platform = 'win32'
    return { ctx, project }
  }

  it('fails definition discovery loud without a safe no-follow read', async () => {
    const { ctx, project } = await setup()
    await writeFile(join(project, '.dsh', 'workflows', 'audit.workflow.json'), JSON.stringify({
      meta: { name: 'audit', description: 'unsupported' }, script: 'return 1',
    }))

    await expect(ctx.workflows.list({ cwd: project }))
      .rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })

  it('fails definition save loud without a safe guarded no-follow publication', async () => {
    const { ctx, project } = await setup()

    await expect(ctx.workflows.save({
      meta: { name: 'audit', description: 'unsupported' }, script: 'return 1',
    }, { cwd: project, scope: 'project' }))
      .rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })
})
