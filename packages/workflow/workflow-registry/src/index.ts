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

import { join, posix, resolve, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsDirEntry } from '@deepseek-ai/dsh-fs'
import type { Session } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { isWorkflowName, validateMeta } from '@deepseek-ai/dsh-workflow'
import chokidar from 'chokidar'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { WORKFLOW_SCOPE_PRECEDENCE } from './types.ts'
import type {
  WorkflowCatalogSnapshot,
  WorkflowDefinition,
  WorkflowDefinitionEnvelope,
  WorkflowDefinitionSummary,
  WorkflowDefinitionSummaryView,
  WorkflowLookupOptions,
  WorkflowSaveOptions,
  WorkflowScope,
} from './types.ts'

export type {
  WorkflowCatalogSnapshot,
  WorkflowDefinition,
  WorkflowDefinitionEnvelope,
  WorkflowDefinitionSummary,
  WorkflowDefinitionSummaryView,
  WorkflowLookupOptions,
  WorkflowSaveOptions,
  WorkflowSaveScope,
  WorkflowScope,
} from './types.ts'
export { isWorkflowDisplayName, isWorkflowName } from '@deepseek-ai/dsh-workflow'
export { WORKFLOW_SCOPE_PRECEDENCE } from './types.ts'

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
  /** Maximum complete UTF-8 bytes in one definition envelope (default 1048576). */
  maxDefinitionBytes?: number
  /** Maximum matching definition files accepted from one root (default 256). */
  maxDefinitionsPerRoot?: number
  /** Maximum distinct project roots retained in the watcher set (default 128). */
  watchMaxProjects?: number
  /** Milliseconds a changed definition must remain stable before invalidation (default 200). */
  watchStabilityThresholdMs?: number
  /** Chokidar stability probe interval in milliseconds (default 100). */
  watchPollIntervalMs?: number
}

export const Config: Schema<Config> = z.object({
  enabled: z.boolean().default(true),
  dshHome: z.string(),
  bundledDir: z.string(),
  watch: z.boolean().default(true),
  maxDefinitionBytes: z.natural().min(1).default(1024 * 1024),
  maxDefinitionsPerRoot: z.natural().min(1).default(256),
  watchMaxProjects: z.natural().min(1).default(128),
  watchStabilityThresholdMs: z.natural().min(1).default(200),
  watchPollIntervalMs: z.natural().min(1).default(100),
})

/** One discovered root and its precedence scope. */
interface WorkflowRoot {
  readonly path: string
  /** Canonical containment owner for ancestor-link escape checks. */
  readonly basePath: string
  readonly scope: WorkflowScope
}

interface RootWatchState {
  readonly watcher: ReturnType<typeof chokidar.watch>
  readonly close: () => Promise<void>
}

/** Select path operations from the execution-world spelling, not the Host OS. */
function executionPath(path: string): typeof posix {
  return path.includes('\\')
    ? win32
    : posix
}

/** Render any thrown value for a discovery failure without trusting coercion. */
function renderThrown(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/** Walk upward from `cwd` to the nearest ancestor containing `.git`; fall back to `cwd`. */
async function findProjectRoot(cwd: string, fileSystem: FileSystem, signal?: AbortSignal): Promise<string> {
  const pathApi = executionPath(cwd)
  const initial = pathApi.resolve(cwd)
  let current = initial
  while (true) {
    signal?.throwIfAborted()
    const marker = await fileSystem.lstat(pathApi.join(current, '.git'), {}, signal)
    if (marker?.type === 'directory' || marker?.type === 'file') return current
    const parent = pathApi.dirname(current)
    if (parent === current) return initial
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
async function readDefinition(
  fileSystem: FileSystem,
  rootPath: string,
  entry: FsDirEntry,
  scope: WorkflowScope,
  maxDefinitionBytes: number,
  signal?: AbortSignal,
): Promise<WorkflowDefinition> {
  const filePath = executionPath(rootPath).join(rootPath, entry.name)
  let bytes: Uint8Array
  try {
    bytes = await fileSystem.readBytesNoFollow(filePath, {}, signal, maxDefinitionBytes)
  } catch (error: unknown) {
    if (error instanceof FsError) {
      switch (error.code) {
        case 'FS_NOT_REGULAR_FILE':
          throw new Error(
            `${filePath}: workflow definition must be a regular file; symbolic-link definitions are not allowed`,
            { cause: error },
          )
        case 'FS_TOO_LARGE':
          throw new Error(`${filePath}: definition exceeds the ${maxDefinitionBytes}-byte limit`, { cause: error })
        default:
          throw error
      }
    }
    throw error
  }
  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error(`${filePath}: definition is not valid UTF-8`, { cause: error })
  }
  const name = entry.name.slice(0, -'.workflow.json'.length)
  const definition = parseDefinitionFile(raw, filePath, name)
  return { ...definition, scope }
}

/** Discover every `.workflow.json` file under one root; a missing root contributes nothing. */
async function discoverRoot(
  fileSystem: FileSystem,
  root: WorkflowRoot,
  maxDefinitions: number,
  maxDefinitionBytes: number,
  signal?: AbortSignal,
): Promise<WorkflowDefinition[]> {
  signal?.throwIfAborted()
  const resolveOptions = signal === undefined ? {} : { signal }
  const [baseTarget, rootTarget] = await Promise.all([
    fileSystem.resolve(root.basePath, resolveOptions),
    fileSystem.resolve(root.path, resolveOptions),
  ])
  if (!fileSystem.contains(baseTarget, rootTarget)) {
    throw new Error(`${root.path}: workflow root escapes its ${root.scope} scope through a symbolic-link ancestor`)
  }
  const pathInfo = await fileSystem.lstat(root.path, {}, signal)
  if (pathInfo === undefined) return []
  if (pathInfo.type === 'symlink') throw new Error(`${root.path}: symbolic-link workflow roots are not allowed`)
  if (pathInfo.type !== 'directory') throw new Error(`${root.path}: workflow root must be a directory`)
  const entries = (await fileSystem.listDir(rootTarget, signal))
    .filter(entry => entry.name.endsWith('.workflow.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
  if (entries.length > maxDefinitions) {
    throw new Error(`${root.path}: found ${entries.length} workflow definitions; maximum is ${maxDefinitions}`)
  }
  const definitions: WorkflowDefinition[] = []
  for (const entry of entries) {
    signal?.throwIfAborted()
    definitions.push(await readDefinition(fileSystem, root.path, entry, root.scope, maxDefinitionBytes, signal))
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
    path: definition.path,
  }
}

/**
 * Saved-workflow definition registry (`ctx.workflows`). Discovery re-reads the
 * roots on every call so a watcher miss cannot pin a stale catalog; the
 * watcher only fires `workflows/change` as a faster refresh hint. A malformed
 * definition file fails discovery loud with its path and reason.
 */
export class WorkflowRegistry extends TypertRemoteService {
  static inject = ['fs']

  static Config = Config

  private readonly enabled: boolean
  private readonly dshHome: string
  private readonly bundledDir: string | undefined
  private readonly watch: boolean
  private readonly maxDefinitionBytes: number
  private readonly maxDefinitionsPerRoot: number
  private readonly watchMaxProjects: number
  private readonly watchStabilityThresholdMs: number
  private readonly watchPollIntervalMs: number
  private readonly watchedRoots = new Map<string, RootWatchState>()
  private readonly watchedProjects = new Map<string, Set<string>>()
  private invalidationQueued = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'workflows', { namespace: 'workflowDefinitions' })
    this.enabled = config.enabled !== false
    this.dshHome = resolveDshHome(config.dshHome)
    this.bundledDir = config.bundledDir === undefined ? undefined : resolve(config.bundledDir)
    this.watch = config.watch !== false
    this.maxDefinitionBytes = config.maxDefinitionBytes ?? 1024 * 1024
    this.maxDefinitionsPerRoot = config.maxDefinitionsPerRoot ?? 256
    this.watchMaxProjects = config.watchMaxProjects ?? 128
    this.watchStabilityThresholdMs = config.watchStabilityThresholdMs ?? 200
    this.watchPollIntervalMs = config.watchPollIntervalMs ?? 100
    ctx.effect(() => async () => {
      const watchers = [...this.watchedRoots.values()]
      this.watchedRoots.clear()
      this.watchedProjects.clear()
      await Promise.all(watchers.map(watcher => watcher.close()))
    }, 'workflow-registry: watchers')
  }

  /** Resolve the roots for one workspace (project + user + bundled), in precedence order. */
  private async roots(cwd: string | undefined, signal?: AbortSignal): Promise<{ roots: WorkflowRoot[]; projectRoot: string }> {
    const projectRoot = await findProjectRoot(cwd === undefined ? process.cwd() : cwd, this.ctx.fs, signal)
    const roots: WorkflowRoot[] = []
    if (this.bundledDir !== undefined) {
      const bundledPath = resolve(this.bundledDir)
      roots.push({ path: bundledPath, basePath: bundledPath, scope: 'bundled' })
    }
    roots.push({
      path: executionPath(projectRoot).join(projectRoot, '.dsh', 'workflows'),
      basePath: projectRoot,
      scope: 'project',
    })
    roots.push({ path: join(this.dshHome, 'workflows'), basePath: this.dshHome, scope: 'user' })
    return { roots, projectRoot }
  }

  /** Discover all roots for one workspace; discovery always re-reads the roots so a watcher miss cannot pin a stale catalog. */
  private async discover(cwd: string | undefined, signal?: AbortSignal): Promise<readonly WorkflowDefinition[]> {
    if (!this.enabled) return []
    const { roots, projectRoot } = await this.roots(cwd, signal)
    const results = await Promise.all(roots.map(root => discoverRoot(
      this.ctx.fs,
      root,
      this.maxDefinitionsPerRoot,
      this.maxDefinitionBytes,
      signal,
    )))
    if (this.watch) this.observeRoots(projectRoot, roots)
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
    const definitions = await this.discover(options.cwd, options.signal)
    options.signal?.throwIfAborted()
    return definitions.map(summarize)
  }

  /**
   * List browser-safe summaries for the exact session workspace selected by
   * the Remote Session lookup. The caller cannot supply or override a cwd.
   * @param session - resolved Session whose recorded cwd selects discovery.
   * @param signal - cancellation for a superseded Client read.
   * @returns sorted winning summaries without filesystem paths or scripts.
   * @throws when the resolved session has no recorded cwd.
   */
  @Remote('list')
  async listForClient(session: Session, signal: AbortSignal): Promise<readonly WorkflowDefinitionSummaryView[]> {
    signal.throwIfAborted()
    const cwd = session.header.cwd
    if (cwd === undefined) throw new Error('workflow definition listing requires a session cwd')
    const definitions = await this.list({ cwd, signal })
    return definitions.map(definition => ({
      name: definition.name,
      description: definition.description,
      ...definition.whenToUse === undefined ? {} : { whenToUse: definition.whenToUse },
      scope: definition.scope,
    }))
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
    const definitions = await this.discover(options.cwd, options.signal)
    options.signal?.throwIfAborted()
    return definitions.find(definition => definition.name === name)
  }

  /**
   * Atomically create or replace one project/user definition through the
   * filesystem capability. Final-component links are refused during initial
   * validation and guarded provider publication; the required create/version
   * intent stays inside the path-shaped publication operation.
   * @param envelope - metadata plus JavaScript body to persist.
   * @param options - destination scope, workspace selector, and cancellation.
   * @returns the filesystem provider's display path for the committed file.
   */
  async save(envelope: WorkflowDefinitionEnvelope, options: WorkflowSaveOptions): Promise<string> {
    options.signal?.throwIfAborted()
    const meta = validateMeta(envelope.meta)
    if (typeof envelope.script !== 'string') throw new TypeError('workflow definition script must be a string')
    const encodedBytes = new TextEncoder().encode(envelope.script).byteLength
    if (encodedBytes > this.maxDefinitionBytes) {
      throw new Error(`workflow script exceeds the ${this.maxDefinitionBytes}-byte limit`)
    }
    const cwd = options.cwd === undefined ? process.cwd() : options.cwd
    const projectRoot = await findProjectRoot(cwd, this.ctx.fs, options.signal)
    const rootPath = options.scope === 'project'
      ? executionPath(projectRoot).join(projectRoot, '.dsh', 'workflows')
      : join(this.dshHome, 'workflows')
    const rootInfo = await this.ctx.fs.lstat(rootPath, {}, options.signal)
    if (rootInfo?.type === 'symlink') throw new Error(`${rootPath}: symbolic-link workflow roots are not allowed`)
    if (rootInfo !== undefined && rootInfo.type !== 'directory') throw new Error(`${rootPath}: workflow root must be a directory`)

    const filePath = executionPath(rootPath).join(rootPath, `${meta.name}.workflow.json`)
    const pathInfo = await this.ctx.fs.lstat(filePath, {}, options.signal)
    if (pathInfo?.type === 'symlink') throw new Error(`${filePath}: refusing to replace a symbolic link`)
    if (pathInfo !== undefined && pathInfo.type !== 'file') throw new Error(`${filePath}: workflow definition must be a regular file`)
    const resolveOptions = options.signal === undefined ? {} : { signal: options.signal }
    const [baseTarget, rootTarget] = await Promise.all([
      this.ctx.fs.resolve(options.scope === 'project' ? projectRoot : this.dshHome, resolveOptions),
      this.ctx.fs.resolve(rootPath, resolveOptions),
    ])
    if (!this.ctx.fs.contains(baseTarget, rootTarget)) {
      throw new Error(`${rootPath}: workflow root escapes its ${options.scope} scope through a symbolic-link ancestor`)
    }
    const content = `${JSON.stringify({ meta, script: envelope.script }, null, 2)}\n`
    if (new TextEncoder().encode(content).byteLength > this.maxDefinitionBytes) {
      throw new Error(`workflow definition exceeds the ${this.maxDefinitionBytes}-byte limit`)
    }
    const expected = pathInfo === undefined
      ? { kind: 'createIfAbsent' as const }
      : { kind: 'replaceIfVersion' as const, version: pathInfo.version }
    await this.ctx.fs.writeTextNoFollow(filePath, {}, content, expected, options.signal, {
      mode: options.scope === 'project' ? 'workspace-write' : 'danger-full-access',
      workspaceRoot: options.scope === 'project' ? projectRoot : this.dshHome,
    })
    this.emitChange()
    return filePath
  }

  /** Retain shared roots and a bounded LRU of project-specific roots. */
  private observeRoots(projectRoot: string, roots: readonly WorkflowRoot[]): void {
    const paths = new Set(roots.map(root => root.path))
    this.watchedProjects.delete(projectRoot)
    this.watchedProjects.set(projectRoot, paths)
    for (const path of paths) this.ensureWatcher(path)
    while (this.watchedProjects.size > this.watchMaxProjects) {
      const oldest = this.watchedProjects.entries().next()
      /* v8 ignore next -- loop condition proves an entry exists. */
      if (oldest.done) break
      const [evictedProject, evictedPaths] = oldest.value
      this.watchedProjects.delete(evictedProject)
      for (const path of evictedPaths) {
        if ([...this.watchedProjects.values()].some(retained => retained.has(path))) continue
        const watcher = this.watchedRoots.get(path)
        this.watchedRoots.delete(path)
        void watcher?.close().catch((error: unknown) => {
          this.ctx.logger.warn(`workflow-registry: watcher close failed: ${renderThrown(error)}`)
        })
      }
    }
  }

  /** Open one narrow watcher. Chokidar follows a missing path from its nearest existing ancestor. */
  private ensureWatcher(path: string): void {
    if (this.watchedRoots.has(path)) return
    let closed = false
    const watcher = chokidar.watch(path, {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      followSymlinks: false,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: this.watchStabilityThresholdMs,
        pollInterval: this.watchPollIntervalMs,
      },
    })
    const state: RootWatchState = {
      watcher,
      close: async () => {
        if (closed) return
        closed = true
        await watcher.close()
      },
    }
    this.watchedRoots.set(path, state)
    const definitionChanged = (changedPath: string): void => {
      if (!closed && changedPath.endsWith('.workflow.json')) this.queueChange()
    }
    watcher.on('add', definitionChanged)
    watcher.on('change', definitionChanged)
    watcher.on('unlink', definitionChanged)
    watcher.on('addDir', () => { this.reopenWatcher(path, state) })
    watcher.on('unlinkDir', () => { this.reopenWatcher(path, state) })
    watcher.on('error', (error) => {
      if (!closed) this.ctx.logger.warn(`workflow-registry: failed to watch ${path}: ${renderThrown(error)}`)
    })
    // Discovery completed before the watcher attached. One refetch after its
    // baseline is ready closes that missed-change window.
    watcher.once('ready', () => { if (!closed) this.queueChange() })
  }

  /** Reattach after the watched root itself appears or disappears. */
  private reopenWatcher(path: string, state: RootWatchState): void {
    if (this.watchedRoots.get(path) !== state) return
    this.watchedRoots.delete(path)
    void state.close().then(() => {
      if ([...this.watchedProjects.values()].some(paths => paths.has(path))) this.ensureWatcher(path)
      this.queueChange()
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`workflow-registry: watcher refresh failed for ${path}: ${renderThrown(error)}`)
    })
  }

  /** Coalesce a synchronous filesystem event burst into one catalog change. */
  private queueChange(): void {
    if (this.invalidationQueued) return
    this.invalidationQueued = true
    queueMicrotask(() => {
      this.invalidationQueued = false
      this.emitChange()
    })
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
