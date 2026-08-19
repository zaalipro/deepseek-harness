# Workflow

English | [中文](workflow.zh.md)

The workflow seam lets an agent run a model-written orchestration SCRIPT that starts subagents. Like [subagent](subagent.md) it is **one optional capability**, not part of the agent loop, so its types and operations live here rather than in [core.md](core.md). Like bash, it permits ONE engine implementation per context to provide `ctx.workflowEngine`; there is no named-provider registry (a second engine replaces the first through plugin configuration rather than running beside it).

Service Definition: [dsh-workflow](../../packages/workflow/workflow) (`ctx.workflowEngine` + the vocabulary below). The Service Provider is [dsh-workflow-worker-thread](../../packages/workflow/workflow-worker-thread) (a `node:worker_threads` engine — one worker per run, the script's vm context inside it); the model-facing Consumer is [dsh-tool-workflow](../../packages/workflow/tool-workflow). Saved definitions live in [dsh-workflow-registry](../../packages/workflow/workflow-registry) (`ctx.workflows`), the background run lifecycle lives in [dsh-workflow-supervisor](../../packages/workflow/workflow-supervisor) (`ctx.workflowSupervisor`), and [dsh-command-workflows](../../packages/workflow/command-workflows) registers the `/workflow` slash commands. The proposal and rationale: [the dynamic-workflows Agent Note](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md) and [saved workflows and the run supervisor](../../.agents/notes/implemented/feature/2026-08-17-saved-workflow-supervisor.md).

Sources: browser-safe vocabulary in [`packages/workflow/workflow/src/types.ts`](../../packages/workflow/workflow/src/types.ts), Host request and live-run handles in [`runtime-types.ts`](../../packages/workflow/workflow/src/runtime-types.ts).

## Saved definitions

A saved workflow is a JSON envelope `<name>.workflow.json` under project (`.dsh/workflows`), user (`<dshHome>/workflows`), or a bundled root, discovered with bundled > project > user precedence. The envelope is `{ meta, script }`: `meta` is validated as data beside the body, the filename must equal `meta.name` (kebab-case), and unknown meta fields fail loud. `ctx.workflows.list()` serves sorted summaries; `get(name)` loads the full definition. A chokidar watcher invalidates the catalog and emits `workflows/change`.

## Runs, display names, and the supervisor

`ctx.workflowSupervisor.start()` launches a run in the background and returns a session-unique **display name** — `meta.name` for the first live/retained run, then `meta.name-2`, `meta.name-3` — never an internal id. The supervisor owns the live `WorkflowRun` handle, writes an editable `script.js` projection and a `scratch/` directory per run, journals committed `agent()` results in call order, and projects the run into the browser as a whole-set `session/workflow-runs` frame. `pause` cancels with the journal retained; `resume` re-executes the immutable script/args/budget with the journal replayed; a script-level `pause()`/`await_user()` gate shows `Needs input`; `stop` cancels, `save` writes the projection back into definitions (rejecting built-ins and numbered handles), and process exit marks active runs `Interrupted`.

## The start request

What a caller asks for when starting a run. The ordinary workflow tool builds this from the model's `{ script, meta, args }` call plus the calling agent; specialized consumers may also select one engine-wide `subagentProvider` and lower `maxTotalAgents` for the run, but the script cannot observe or replace either policy. `meta` and `args` are plain JSON DATA (the engine validates `meta` against its schema and rejects loud BEFORE anything runs — no script text is ever evaluated to obtain it). `parent` is REQUIRED — every child the script starts is attributed to it, and cwd, lineage, and depth pass through the [subagent seam](subagent.md).

```ts type-equiv
/**
 * What a caller asks for when starting a workflow run. `meta` and `args` are
 * plain JSON data by the seam contract. `parent` is required because every
 * `agent()` spawned by the script is attributed to that live Agent.
 */
interface WorkflowStartRequest {
  /** The plain-JS script body (top-level await allowed; ends with `return <json-value>`). */
  script: string
  /** The workflow's identity block, as plain JSON data (shape-validated by the engine). */
  meta: WorkflowMeta
  /** Optional input exposed verbatim to the script as the `args` global. */
  args?: unknown
  /** Optional engine-wide child-provider override for this run. */
  subagentProvider?: string
  /** Optional per-run total-child ceiling. */
  maxTotalAgents?: number
  /** Committed host-call results to replay instead of relaunching children; omitted for a fresh start. */
  journal?: readonly WorkflowJournalEntry[]
  /** Absolute run directory owning per-run scratch files; omitted when scratch is unavailable. */
  scratchDir?: string
  /** Smoke-check mode: canned `agent()` results, no children, no journal persistence. */
  validateOnly?: boolean
  /** The agent on whose behalf the run executes (parent of every child). */
  parent: Agent
  /** Cancels the run when aborted. */
  signal?: AbortSignal
}
```

## The workflow's identity: `WorkflowMeta`

The identity block carried as data on the start request (the tool's `meta` parameter; the field vocabulary matches the Claude Code dynamic-workflows meta block). `phases` is progress vocabulary only: `phase()` calls match titles for observers; no execution structure is implied.

```ts type-equiv
/**
 * The script's identity block, provided as plain JSON data alongside the
 * script body (the model-facing tool carries it as its `meta` parameter) and
 * validated by the engine before the body runs. `name`/`description` are
 * required; the rest is optional annotation. The field vocabulary matches the
 * Claude Code dynamic-workflows meta block.
 */
interface WorkflowMeta {
  /** Short kebab-case workflow name (display + persistence key). */
  name: string
  /** One-line description of what the workflow does. */
  description: string
  /** Optional guidance on when this workflow applies (shown in listings). */
  whenToUse?: string
  /** Optional phase declarations matched by `phase()` calls. */
  phases?: WorkflowPhase[]
}
```

## The terminal result: `WorkflowResult`

The outcome of one run, resolved by `WorkflowRun.result`. `value` is the script's materialized return value — plain host-realm JSON data (`null` when the script returned nothing) — meaningful only for `completed`. `stopReason` is a CLOSED union (engine-owned; consumers may exhaust it): `completed` | `cancelled` | `error`. A non-`completed` reason carries the failure in `error`, and the consumer maps it to an `isError` tool result rather than reporting partial output as success.

```ts type-equiv
/**
 * The outcome resolved by a live workflow run. `value` is
 * the script's materialized return value (plain host-realm JSON data; `null`
 * when the script returned `undefined`) — meaningful only for `completed`.
 * A non-`completed` reason carries the failure in `error`; the consumer maps
 * it to an `isError` tool result rather than reporting partial output.
 */
interface WorkflowResult {
  /** The script's return value (host JSON data; `null` for no return). */
  value: unknown
  /** Why the run settled. */
  stopReason: WorkflowStopReason
  /** The failure message (present iff `stopReason` is not `completed`). */
  error?: string
  /**
   * How many `agent()` calls the run accepted over its whole lifetime. On a
   * graceful settlement this is the script-side count (calls still queued for
   * a concurrency slot included); on a termination path (grace force-settle,
   * worker death) it degrades to the host-observed count — calls queued
   * inside a terminated script are unknowable then.
   */
  agentsStarted: number
}
```

## A live run: `WorkflowRun`

The handle the consumer holds while a script executes. The consumer awaits `result`, may `cancel` mid-flight, and MUST `dispose` on every path. `result` does NOT reject — a script failure resolves with `stopReason: 'error'` — and once the run is cancelled it SETTLES within the engine's bounded grace even if the script itself never settles (the engine force-settles `cancelled`; the worker-thread engine then terminates the script's worker), so a consumer awaiting `result` is never wedged past a cancellation. `dispose()` = cancel + that bounded settle + child quiescence; it never hangs on a stuck script.

```ts type-equiv
/**
 * Holder-owned live workflow. `result` never rejects; consumers may cancel,
 * resume a parked gate, and must call idempotent `dispose()` to await script
 * and child quiescence.
 */
interface WorkflowRun {
  readonly id: WorkflowRunId
  /** The validated meta block available before the script body runs. */
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>
  /** Cancel the run and its children. */
  cancel(reason?: string): void
  /** Resume a parked `pause()`/`await_user()` gate; a no-op when not parked. */
  resume(): void
  /** Cancel if needed and await bounded settlement and cleanup. */
  dispose(): Promise<void>
}
```

## Failure discipline: `WorkflowError.fatal`

Hook misuse inside a script — bad arguments, unknown/deferred `agent()` options, a schema outside the [structured-output subset](../../packages/core/tools/README.md), a tripped cap, a seam start failure, cancellation — throws a `WorkflowError` with `fatal: true`. The `parallel()`/`pipeline()` combinators RE-THROW fatal errors instead of mapping the item to `null`: a typo'd option must kill the script loudly, never dissolve into something that reads as an ordinary child failure. The per-item `null` is reserved for child-run failures (a non-`completed` stop reason) and ordinary in-stage script errors.

## Events

The `workflow/*` events (`workflow/start`, `workflow/phase`, `workflow/log`, `workflow/agent-start`, `workflow/agent-end`, `workflow/end` — see the [events catalog](#cordis-surface)) are **observe-only** emits carrying DATA SNAPSHOTS: every payload starts with `WorkflowRunInfo` (id + meta), never the live `WorkflowRun`, so a subscriber cannot gain `cancel`/`dispose`, and `workflow/end` deliberately omits the result value (a listener observing outcomes must not receive a mutable alias of the caller's result). Every emit is per-listener contained — a throwing subscriber is logged, never propagated, and cannot starve the listeners registered after it — and every listener receives its own payload clone, so mutating it corrupts neither the engine nor other listeners; the containment mirrors `subagent/start`/`subagent/end`.

## Durable Chat records

The top-level `dsh-tool-workflow` consumer projects display facts into its calling parent Session without changing execution ownership. It writes `tool-workflow/run-start` after a run is accepted, pairs member start and end by `runId + seq`, and writes `tool-workflow/run-end` only after the result is known and disposal reaches quiescence. Nested transport calls write no record. The first append failure disables later writes for that run, so the log remains empty or a legal continuous prefix and the tool result is unchanged.

`dsh-tool-workflow/invariant` validates the same protocol before live commit and when a Session is loaded: one start per run, positive unique member sequences, paired member endings, no run ending with open members, and no updates after the run ending. A missing member ending or run ending at the log tail is valid interruption evidence rather than corruption.

`dsh-client-ui-workflow-run` folds the four events through the Conversation Node engine into one `workflow-run` Chat node anchored at the run-start sequence, after the original workflow tool node. Phase groups come only from actual member starts and preserve exact strings, including the distinction between an omitted phase and `''`. Closed Locations turn missing terminal facts into interrupted presentation. The [UI package README](../../packages/client/ui-workflow-run/README.md) owns disclosure, status, and same-parent local navigation behavior.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworkflowengine--workflowengine-abstract-seam"></a>

### `ctx.workflowEngine` — `WorkflowEngine` (abstract seam)

Workflow Service Definition contract. Invalid requests throw before publication; a live run is holder-owned, its result never rejects, cancellation and disposal are bounded, and disposal waits for child cleanup within that bound. Lifecycle listener failures are contained, and `workflow/end` fires exactly once as the result settles.

```ts cordis-catalog
/**
 * Parse and execute a workflow script.
 * @param request - the script, its `args`, the parent agent, and an
 *   optional cancel signal.
 * @returns the live run; its `result` resolves when the script settles.
 */
abstract start(request: WorkflowStartRequest): WorkflowRun
```

Source: [`packages/workflow/workflow/src/index.ts:135`](../../packages/workflow/workflow/src/index.ts)

<a id="ctxworkflows--workflowregistry"></a>

### `ctx.workflows` — `WorkflowRegistry`

Saved-workflow definition registry (`ctx.workflows`). Discoveries are cached per project root + root set; `workflows/change` invalidates them. A malformed definition file fails discovery loud with its path and reason.

```ts cordis-catalog
/**
 * List invocation-neutral summaries for one workspace.
 * @param options - `cwd` selects the project root; `signal` cancels discovery.
 * @returns sorted winning summaries.
 */
async list(options: WorkflowLookupOptions = {}): Promise<WorkflowDefinitionSummary[]>

/**
 * Observe the current catalog and whether discovery completed within a stable revision.
 * @param options - `cwd` selects the project root; `signal` cancels discovery.
 * @returns sorted definitions plus the completion flag.
 */
async snapshot(options: WorkflowLookupOptions = {}): Promise<WorkflowCatalogSnapshot>

/**
 * Load and validate the full definition for one name (the winning scope's file).
 * @param name - kebab-case workflow name.
 * @param options - `cwd` selects the project root; `signal` cancels discovery.
 * @returns the full definition, or `undefined` when no scope supplies it.
 */
async get(name: string, options: WorkflowLookupOptions = {}): Promise<WorkflowDefinition | undefined>
```

Source: [`packages/workflow/workflow-registry/src/index.ts:208`](../../packages/workflow/workflow-registry/src/index.ts)

<a id="ctxworkflowsupervisor--workflowsupervisor"></a>

### `ctx.workflowSupervisor` — `WorkflowSupervisor`

Run supervisor. Background launch returns the display handle immediately; the supervisor owns the returned `WorkflowRun`, routes `workflow/*` events into each run's live view, and posts a completion notice to the parent session. Same-process pause saves the committed host-call journal; resume replays it under the original immutable script, args, and budget.

```ts cordis-catalog
/**
 * Launch one workflow run in the background (or smoke-check it).
 * @param spec - the run source, args, budget, and parent agent.
 * @returns the display handle and started status immediately.
 */
async start(spec: { definition?: WorkflowDefinition | undefined script?: string | undefined meta?: WorkflowMeta | undefined args?: unknown agentBudget?: number parent: Agent }): Promise<WorkflowLaunched>

/**
 * Smoke-check one path with canned hosts; never starts a live run.
 * @param spec - the run source, args, and parent agent.
 * @returns `ok: true` with the smoke result, or `ok: false` with the failure.
 */
async validate(spec: { definition?: WorkflowDefinition | undefined script?: string | undefined meta?: WorkflowMeta | undefined args?: unknown parent?: Agent | undefined }): Promise<WorkflowValidation>

/**
 * Pause a running run: cancel it and keep the committed journal for resume.
 * @param displayName - the run's session display handle.
 * @param agent - the session-owning agent fencing the run.
 */
pause(displayName: string, agent: Agent): void

/**
 * Resume a parked gate (alive worker) or a paused run (journal replay).
 * @param displayName - the run's session display handle.
 * @param agent - the session-owning agent fencing the run.
 */
resume(displayName: string, agent: Agent): void

/**
 * Resume by internal run id (the model-facing tool path). Returns the display handle.
 * @param runId - the engine-minted run id returned by a launch.
 * @param agent - the session-owning agent fencing the run.
 * @returns the resumed run's display handle.
 */
resumeById(runId: string, agent: Agent): string

/**
 * Stop a run: cancel it and mark it cancelled.
 * @param displayName - the run's session display handle.
 * @param agent - the session-owning agent fencing the run.
 */
stop(displayName: string, agent: Agent): void

/**
 * Save the run's script projection as a project or user definition.
 * @param displayName - the run's session display handle.
 * @param agent - the session-owning agent fencing the run.
 * @param scope - target scope (`project` or `user`); defaults to the config value.
 * @returns the written `.workflow.json` path.
 */
async save(displayName: string, agent: Agent, scope?: WorkflowSaveScope): Promise<string>

/**
 * List every retained run for one agent's session, live-first.
 * @param agent - the reading agent; a non-agent caller sees nothing.
 * @returns the session's run views in start order (live runs first).
 */
listRuns(agent?: Agent | undefined): WorkflowRunView[]

/** Mark every live run interrupted on process exit (called via beforeExit hook). */
markInterrupted(): void
```

Types: [Agent](core.md)

Source: [`packages/workflow/workflow-supervisor/src/index.ts:174`](../../packages/workflow/workflow-supervisor/src/index.ts)

<a id="workflow-events"></a>

### `workflow/*` events

<a id="workflowagent-end--emit"></a>

#### `workflow/agent-end` — emit

One `agent()` call settled (clean result, child failure, or run cancellation). Paired with Events['workflow/agent-start'] by `agent.seq`, exactly once per started call on every stop path — on an engine termination path (a worker killed past its grace) the end is engine-synthesized with outcome `'cancelled'`.

```ts cordis-catalog
/**
 * One `agent()` call settled (clean result, child failure, or run
 * cancellation). Paired with {@link Events['workflow/agent-start']} by
 * `agent.seq`, exactly once per started call on every stop path — on an
 * engine termination path (a worker killed past its grace) the end is
 * engine-synthesized with outcome `'cancelled'`.
 * @param info - the run's identity snapshot.
 * @param agent - the call identity plus its outcome.
 * @mode emit
 */
'workflow/agent-end'(info: WorkflowRunInfo, agent: WorkflowAgentEndInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts:93`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowagent-result--emit"></a>

#### `workflow/agent-result` — emit

One committed `agent()` result, in call order — the journal a same-process resume replays instead of relaunching the child. Emitted only for live calls (journal-replayed calls emit nothing).

```ts cordis-catalog
/**
 * One committed `agent()` result, in call order — the journal a same-process
 * resume replays instead of relaunching the child. Emitted only for live
 * calls (journal-replayed calls emit nothing).
 * @param info - the run's identity snapshot.
 * @param seq - the 1-based agent() call sequence the result commits to.
 * @param result - the script-visible result (text, structured object, or `null`).
 * @mode emit
 */
'workflow/agent-result'(info: WorkflowRunInfo, seq: number, result: unknown): void
```

Source: [`packages/workflow/workflow/src/index.ts:103`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowagent-start--emit"></a>

#### `workflow/agent-start` — emit

One `agent()` call established a published child run. Paired with Events['workflow/agent-end'] by `agent.seq`. A call that never receives a published run from the provider emits neither event in this pair.

```ts cordis-catalog
/**
 * One `agent()` call established a published child run. Paired with
 * {@link Events['workflow/agent-end']} by `agent.seq`. A call that never
 * receives a published run from the provider emits neither
 * event in this pair.
 * @param info - the run's identity snapshot.
 * @param agent - the call's sequence number, label, phase, and child id.
 * @mode emit
 */
'workflow/agent-start'(info: WorkflowRunInfo, agent: WorkflowAgentInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts:82`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowend--emit"></a>

#### `workflow/end` — emit

A workflow run settled (any stop reason). Fired when WorkflowRun.result resolves. Paired with Events['workflow/start'].

```ts cordis-catalog
/**
 * A workflow run settled (any stop reason). Fired when
 * {@link WorkflowRun.result} resolves. Paired with
 * {@link Events['workflow/start']}.
 * @param info - the run's identity snapshot.
 * @param result - the outcome data (stop reason, error, agent count) —
 *   deliberately WITHOUT the result value (see {@link WorkflowResultInfo}).
 * @mode emit
 */
'workflow/end'(info: WorkflowRunInfo, result: WorkflowResultInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts:113`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowgate--emit"></a>

#### `workflow/gate` — emit

The script parked the run on a human gate (a `pause()`/`await_user()` call). `resumable` distinguishes a gate resume passes (`await_user`) from one it re-fires (`pause`).

```ts cordis-catalog
/**
 * The script parked the run on a human gate (a `pause()`/`await_user()`
 * call). `resumable` distinguishes a gate resume passes (`await_user`)
 * from one it re-fires (`pause`).
 * @param info - the run's identity snapshot.
 * @param gate - the gate kind, message, and resumability.
 * @mode emit
 */
'workflow/gate'(info: WorkflowRunInfo, gate: WorkflowGateInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts:72`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowlog--emit"></a>

#### `workflow/log` — emit

The script emitted a narration line (a `log(message)` call).

```ts cordis-catalog
/**
 * The script emitted a narration line (a `log(message)` call).
 * @param info - the run's identity snapshot.
 * @param message - the logged message, verbatim.
 * @mode emit
 */
'workflow/log'(info: WorkflowRunInfo, message: string): void
```

Source: [`packages/workflow/workflow/src/index.ts:63`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowphase--emit"></a>

#### `workflow/phase` — emit

The script entered a phase (a `phase(title)` call) — progress grouping for observers; no execution semantics.

```ts cordis-catalog
/**
 * The script entered a phase (a `phase(title)` call) — progress grouping
 * for observers; no execution semantics.
 * @param info - the run's identity snapshot.
 * @param title - the phase title, verbatim.
 * @mode emit
 */
'workflow/phase'(info: WorkflowRunInfo, title: string): void
```

Source: [`packages/workflow/workflow/src/index.ts:56`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowstart--emit"></a>

#### `workflow/start` — emit

A workflow run started — the script's meta block validated, the body about to execute. Paired with Events['workflow/end'].

```ts cordis-catalog
/**
 * A workflow run started — the script's meta block validated, the body
 * about to execute. Paired with {@link Events['workflow/end']}.
 * @param info - the run's identity snapshot (id + meta).
 * @mode emit
 */
'workflow/start'(info: WorkflowRunInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts:48`](../../packages/workflow/workflow/src/index.ts)

<a id="workflows-events"></a>

### `workflows/*` events

<a id="workflowschange--emit"></a>

#### `workflows/change` — emit

A workflow definition root changed (file added, removed, or rewritten), or the registry's own root set changed. Unfiltered: consumers refetch the catalog for their own lookup options.

```ts cordis-catalog
/**
 * A workflow definition root changed (file added, removed, or rewritten),
 * or the registry's own root set changed. Unfiltered: consumers refetch
 * the catalog for their own lookup options.
 * @mode emit
 */
'workflows/change'(): void
```

Source: [`packages/workflow/workflow-registry/src/index.ts:59`](../../packages/workflow/workflow-registry/src/index.ts)

<a id="workflowsrun-change--emit"></a>

#### `workflows/run-change` — emit

One supervised run's visible set changed (start, progress, park, settle, pause, resume, stop, save). Unfiltered; consumers re-read `listRuns`.

```ts cordis-catalog
/**
 * One supervised run's visible set changed (start, progress, park, settle,
 * pause, resume, stop, save). Unfiltered; consumers re-read `listRuns`.
 * @mode emit
 */
'workflows/run-change'(): void
```

Source: [`packages/workflow/workflow-supervisor/src/index.ts:63`](../../packages/workflow/workflow-supervisor/src/index.ts)
<!-- END GENERATED cordis-surface -->
