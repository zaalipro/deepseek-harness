/**
 * Saved-workflow definition registry: discovers `.workflow.json` envelopes
 * under the project (`.dsh/workflows`), user (`<dshHome>/workflows`), and
 * optional bundled roots, validates each envelope as data, and serves sorted
 * summaries plus full definitions keyed by `meta.name`. Precedence is
 * bundled > project > user. A chokidar watcher invalidates the catalog and
 * emits `workflows/change` on any root mutation.
 *
 * File format (one repo-consistent envelope; a directory bundle is NOT read):
 *
 *     review-changes.workflow.json
 *     { "meta": { "name": "review-changes", ... }, "script": "// JS body" }
 *
 * The filename must equal `<meta.name>.workflow.json`. Meta is validated as
 * JSON data through `validateMeta` — script text is never evaluated.
 *
 * @module @deepseek-ai/dsh-workflow-registry
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { unwatchFile, watchFile } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { validateMeta } from '@deepseek-ai/dsh-workflow'
import chokidar from 'chokidar'
import { WORKFLOW_SCOPE_PRECEDENCE, isWorkflowName } from './types.ts'
import type {
  WorkflowCatalogSnapshot,
  WorkflowDefinition,
  WorkflowDefinitionSummary,
  WorkflowLookupOptions,
  WorkflowScope,
} from './types.ts'

export type {
  WorkflowCatalogSnapshot,
  WorkflowDefinition,
  WorkflowDefinitionSummary,
  WorkflowLookupOptions,
  WorkflowScope,
} from './types.ts'
export { WORKFLOW_SCOPE_PRECEDENCE, isWorkflowName } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflows: WorkflowRegistry
  }

  interface Events {
    /**
     * A workflow definition root changed (file added, removed, or rewritten),
     * or the registry's own root set changed. Unfiltered: consumers refetch
     * the catalog for their own lookup options.
     * @mode emit
     */
    'workflows/change'(): void
  }
}

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** Whether the registry serves any roots (default true). */
  enabled?: boolean
  /** Harness home whose `workflows/` child is the user root. */
  dshHome?: string
  /** Optional packaged/bundled workflows directory. */
  bundledDir?: string
  /** Whether chokidar watches the roots and invalidates the catalog (default true). */
  watch?: boolean
}

export const Config: Schema<Config> = z.object({
  enabled: z.boolean().default(true),
  dshHome: z.string(),
  bundledDir: z.string(),
  watch: z.boolean().default(true),
})

/** One discovered root and its precedence scope. */
interface WorkflowRoot {
  readonly path: string
  readonly scope: WorkflowScope
}

/** Render any thrown value for a discovery failure without trusting coercion. */
function renderThrown(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/** Whether `path` exists as a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Walk upward from `cwd` to the nearest ancestor containing `.git`; fall back to `cwd`. */
async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd)
  while (true) {
    if (await isDirectory(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/** A definition whose scope the discovering root supplies. */
type ParsedDefinition = Omit<WorkflowDefinition, 'scope'>

/**
 * Parse and validate one `.workflow.json` envelope against the saved-definition
 * contract. Throws with the offending path and reason on any violation.
 * @param raw - raw file text.
 * @param path - absolute file path (for error messages).
 * @param expectedName - filename-derived name the envelope's `meta.name` must equal.
 * @returns the validated, normalized definition (scope filled by the caller).
 */
export function parseDefinitionFile(raw: string, path: string, expectedName: string): ParsedDefinition {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${path}: not valid JSON — ${renderThrown(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: a workflow envelope must be a JSON object with { meta, script }`)
  }
  const record = parsed as Record<string, unknown>
  const unknown = Object.keys(record).filter(key => key !== 'meta' && key !== 'script')
  if (unknown.length > 0) throw new Error(`${path}: unknown envelope field(s) ${unknown.join(', ')} (expected { meta, script })`)
  if (typeof record.script !== 'string') throw new Error(`${path}: envelope "script" must be a string`)
  const meta = validateMeta(record.meta)
  if (meta.name !== expectedName) {
    throw new Error(`${path}: filename "${expectedName}.workflow.json" must match meta.name "${meta.name}"`)
  }
  if (!isWorkflowName(meta.name)) {
    throw new Error(`${path}: meta.name "${meta.name}" is not a kebab-case workflow name`)
  }
  return {
    name: meta.name,
    description: meta.description,
    ...meta.whenToUse !== undefined ? { whenToUse: meta.whenToUse } : {},
    ...meta.phases !== undefined ? { phases: meta.phases } : {},
    script: record.script,
    path,
  }
}

/** Read one definition file and fill its scope from the owning root. */
async function readDefinition(filePath: string, scope: WorkflowScope): Promise<WorkflowDefinition> {
  const raw = await readFile(filePath, 'utf8')
  const name = filePath.slice(filePath.lastIndexOf('/') + 1, -'.workflow.json'.length)
  const definition = parseDefinitionFile(raw, filePath, name)
  return { ...definition, scope }
}

/** Discover every `.workflow.json` file under one root; a missing root contributes nothing. */
async function discoverRoot(root: WorkflowRoot): Promise<WorkflowDefinition[]> {
  if (!(await isDirectory(root.path))) return []
  const entries = await readdir(root.path)
  const files = entries.filter(entry => entry.endsWith('.workflow.json')).sort()
  const definitions: WorkflowDefinition[] = []
  for (const file of files) {
    definitions.push(await readDefinition(join(root.path, file), root.scope))
  }
  return definitions
}

/** Merge discovered definitions: first scope in precedence order wins a name. */
function merge(definitions: WorkflowDefinition[]): Map<string, WorkflowDefinition> {
  const merged = new Map<string, WorkflowDefinition>()
  for (const scope of WORKFLOW_SCOPE_PRECEDENCE) {
    for (const definition of definitions) {
      if (definition.scope !== scope) continue
      if (!merged.has(definition.name)) merged.set(definition.name, definition)
    }
  }
  return merged
}

/** Summary view of one definition. */
function summarize(definition: WorkflowDefinition): WorkflowDefinitionSummary {
  return {
    name: definition.name,
    description: definition.description,
    ...definition.whenToUse !== undefined ? { whenToUse: definition.whenToUse } : {},
    ...definition.phases !== undefined ? { phases: definition.phases } : {},
    scope: definition.scope,
    ...definition.path !== undefined ? { path: definition.path } : {},
  }
}

/**
 * Saved-workflow definition registry (`ctx.workflows`). Discovery re-reads the
 * roots on every call so a watcher miss cannot pin a stale catalog; the
 * watcher only fires `workflows/change` as a faster refresh hint. A malformed
 * definition file fails discovery loud with its path and reason.
 */
export class WorkflowRegistry extends Service {
  static inject = []

  static Config = Config

  private readonly enabled: boolean
  private readonly dshHome: string
  private readonly bundledDir: string | undefined
  private readonly watch: boolean

  constructor(ctx: Context, config: Config) {
    super(ctx, 'workflows')
    this.enabled = config.enabled ?? true
    this.dshHome = resolveDshHome(config.dshHome)
    this.bundledDir = config.bundledDir === undefined ? undefined : resolve(config.bundledDir)
    this.watch = config.watch ?? true
    if (this.enabled && this.watch) {
      void this.startWatcher()
    }
  }

  /** Resolve the roots for one workspace (project + user + bundled), in precedence order. */
  private async roots(cwd: string | undefined): Promise<WorkflowRoot[]> {
    const projectRoot = await findProjectRoot(cwd ?? process.cwd())
    const roots: WorkflowRoot[] = []
    if (this.bundledDir !== undefined) roots.push({ path: resolve(this.bundledDir), scope: 'bundled' })
    roots.push({ path: join(projectRoot, '.dsh', 'workflows'), scope: 'project' })
    roots.push({ path: join(this.dshHome, 'workflows'), scope: 'user' })
    return roots
  }

  /** Discover all roots for one workspace; discovery always re-reads the roots so a watcher miss cannot pin a stale catalog. */
  private async discover(cwd: string | undefined): Promise<readonly WorkflowDefinition[]> {
    if (!this.enabled) return []
    const roots = await this.roots(cwd)
    const results = await Promise.all(roots.map(discoverRoot))
    const merged = merge(results.flat())
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * List invocation-neutral summaries for one workspace.
   * @param options - `cwd` selects the project root; `signal` cancels discovery.
   * @returns sorted winning summaries.
   */
  async list(options: WorkflowLookupOptions = {}): Promise<WorkflowDefinitionSummary[]> {
    options.signal?.throwIfAborted()
    const definitions = await this.discover(options.cwd)
    options.signal?.throwIfAborted()
    return definitions.map(summarize)
  }

  /**
   * Observe the current catalog and whether discovery completed within a stable revision.
   * @param options - `cwd` selects the project root; `signal` cancels discovery.
   * @returns sorted definitions plus the completion flag.
   */
  async snapshot(options: WorkflowLookupOptions = {}): Promise<WorkflowCatalogSnapshot> {
    return { definitions: await this.list(options), complete: true }
  }

  /**
   * Load and validate the full definition for one name (the winning scope's file).
   * @param name - kebab-case workflow name.
   * @param options - `cwd` selects the project root; `signal` cancels discovery.
   * @returns the full definition, or `undefined` when no scope supplies it.
   */
  async get(name: string, options: WorkflowLookupOptions = {}): Promise<WorkflowDefinition | undefined> {
    if (!isWorkflowName(name)) return undefined
    options.signal?.throwIfAborted()
    const definitions = await this.discover(options.cwd)
    options.signal?.throwIfAborted()
    return definitions.find(definition => definition.name === name)
  }

  /**
   * Start a watcher per root: an existing root is watched directly; a missing
   * root is polled with `fs.watchFile` (no broad recursion, so a deep ancestor
   * never spans unrelated siblings) and attached once it appears.
   */
  private async startWatcher(): Promise<void> {
    const roots = await this.roots(process.cwd())
    const stops = roots.map(root => this.watchRoot(root.path))
    this.ctx.effect(() => () => { for (const stop of stops) stop() }, 'workflow-registry: watcher')
  }

  /** Watch one root path, re-attaching chokidar when a missing root appears. */
  private watchRoot(path: string): () => void {
    let watcher: ReturnType<typeof chokidar.watch> | undefined
    let stopPoll: (() => void) | undefined
    let closed = false

    const invalidate = (): void => { this.emitChange() }
    const detach = (): void => {
      stopPoll?.()
      stopPoll = undefined
      void watcher?.close()
      watcher = undefined
    }
    const attach = (): void => {
      if (closed) return
      if (statSync(path, { throwIfNoEntry: false })?.isDirectory() === true) {
        // Leaf exists: watch it directly (a narrow directory, depth 0).
        watcher = chokidar.watch(path, {
          ignoreInitial: true,
          depth: 0,
          awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
        })
        watcher.on('add', invalidate)
        watcher.on('unlink', invalidate)
        watcher.on('change', invalidate)
        watcher.on('unlinkDir', () => {
          invalidate()
          detach()
          // The root vanished; fall back to polling for its return.
          armPoll()
        })
        return
      }
      armPoll()
    }
    const armPoll = (): void => {
      if (closed || stopPoll !== undefined) return
      const onPoll = (): void => {
        invalidate()
        // The root appeared (or its mtime moved): attach a real watcher.
        detach()
        attach()
      }
      watchFile(path, { persistent: false, interval: 250 }, onPoll)
      stopPoll = () => { unwatchFile(path, onPoll) }
    }
    attach()
    return () => {
      closed = true
      detach()
    }
  }

  /** Dispatch the change event while containing each listener failure. */
  private emitChange(): void {
    for (const callback of this.ctx.events.dispatch('emit', ['workflows/change'])) {
      try {
        const returned: unknown = callback()
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`workflow-registry: workflows/change listener rejected: ${renderThrown(error)}`)
        })
      } catch (error) {
        this.ctx.logger.warn(`workflow-registry: workflows/change listener threw: ${renderThrown(error)}`)
      }
    }
  }
}

export default WorkflowRegistry
