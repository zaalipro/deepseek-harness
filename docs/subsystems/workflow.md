# Workflow

English | [中文](workflow.zh.md)

The workflow capability separates one holder-owned engine attempt from a supervised logical run. The Service Definition [dsh-workflow](../../packages/workflow/workflow) provides `ctx.workflowEngine`; [dsh-workflow-worker-thread](../../packages/workflow/workflow-worker-thread) executes each attempt in a worker thread; [dsh-workflow-supervisor](../../packages/workflow/workflow-supervisor) owns detached logical identity, retries, retained manifests, browser reads, controls, and completion delivery. [dsh-workflow-run-recorder](../../packages/workflow/workflow-run-recorder) adds a durable Chat record only when a Consumer explicitly attributes a top-level supervisor launch, and [dsh-tool-workflow](../../packages/workflow/tool-workflow) is the general model-facing Consumer. Worker isolation keeps script work off the Host event loop but is not a security boundary.

Saved definitions live behind `ctx.workflows` in [dsh-workflow-registry](../../packages/workflow/workflow-registry). [dsh-command-workflows](../../packages/workflow/command-workflows) owns Host launch/control commands and dynamically assigns collision-free definition aliases; another command keeps a colliding bare name while the workflow receives repeated `workflow-` qualification as needed. The canonical `/workflow <name>` form remains available. The Web dashboard owns `/workflows` as a browser action. The [dynamic-workflows](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md), [saved-workflow supervisor](../../.agents/notes/implemented/feature/2026-08-17-saved-workflow-supervisor.md), and [durable Chat record](../../.agents/notes/implemented/feature/2026-08-10-durable-workflow-runs-in-chat.md) Agent Notes own the decisions.

Sources: engine vocabulary in [`packages/workflow/workflow/src/types.ts`](../../packages/workflow/workflow/src/types.ts) and [`runtime-types.ts`](../../packages/workflow/workflow/src/runtime-types.ts); browser-safe supervisor vocabulary in [`packages/workflow/workflow-supervisor/src/types.ts`](../../packages/workflow/workflow-supervisor/src/types.ts); durable Chat event payloads in [`packages/workflow/workflow-run-recorder/src/types.ts`](../../packages/workflow/workflow-run-recorder/src/types.ts).

## Saved definitions

A saved definition is a validated `<name>.workflow.json` envelope containing `{ meta, script }` under a bundled, project (`.dsh/workflows`), or user (`<dshHome>/workflows`) root. Precedence is bundled > project > user. The filename must equal the kebab-case `meta.name`; metadata remains data and unknown fields fail. `ctx.workflows.list()` returns sorted summaries, `get()` loads the winning definition, and `save()` atomically publishes project or user definitions through the filesystem capability. Discovery re-reads its roots; `workflows/change` is a refresh hint rather than the sole freshness source.

## Logical supervision and recovery

`ctx.workflowSupervisor.start()` durably publishes a logical run, then returns its stable logical `runId`, Session-unique display handle, and editable `scriptPath`. The first retained run for a definition uses `meta.name`; later handles use monotonic numeric suffixes. The logical id spans engine attempts created by pause or budget resume. Member sequences, cumulative agent spend, and committed journal results also span those attempts.

Pause cancels and disposes the active attempt before the logical run becomes parked. Resume re-executes the immutable script and args with the committed journal. A budget-limited run requires a higher absolute budget; a paused or needs-input run rejects a changed budget. `await_user()` remains on its live attempt and resumes only from an exact attempt-and-gate acknowledgement; `pause()` re-fires its condition. Stop publishes one terminal cancellation. Save reads the bounded editable projection and rejects bundled or numbered runs.

Per-Session manifests retain a bounded run roster, display-name ordinals, member summaries, log tail, gate presentation, terminal-result projection, and scratch-artifact metadata. Recovery first turns every formerly active row into terminal Interrupted, then restores inspection state without an Agent, engine attempt, script, args, journal, or resume authority. A recovered row has no `scriptPath` and cannot be saved. Retention eviction removes the corresponding in-memory terminal row and run directory, preventing a recovered row from appearing twice.

### Recorder reconciliation

`WorkflowSupervisor.recordingSnapshot()` performs Session recovery, then returns one atomic Host-only view so an event recorder can reconcile lifecycle events missed during reload. Its member roster and optional terminal facts are bounded by supervisor retention. An absent run returns `undefined` only after successful recovery; I/O, corruption, cancellation, and known cross-Session access reject. This type is not part of the browser Remote.

```ts type-equiv
/** Atomic retained lifecycle state used to reconcile Host-side event recorders. */
interface WorkflowRunRecordingSnapshot {
  readonly info: SupervisedWorkflowRunInfo
  readonly run: WorkflowRunHead
  readonly members: readonly SupervisedWorkflowMemberLifecycleInfo[]
  readonly result?: SupervisedWorkflowResultInfo
}
```

## Engine attempt types

### Start request

`WorkflowStartRequest` starts one engine attempt. A logical owner supplies cumulative spend, highest member sequence, and committed journal entries when replaying. `parent` remains required for child attribution; `validateOnly` uses canned results and creates no children or journal commits.

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
  /** Cumulative agent budget already spent by earlier attempts of the same logical run. */
  initialAgentSpend?: number
  /** Highest member sequence issued by earlier attempts; keeps retry members distinct. */
  initialAgentSeq?: number
  /** Committed host calls to replay instead of repeating results or effects; omitted for a fresh start. */
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

### Journal entry

The journal covers every host call whose repetition would duplicate a result, observer effect, scratch effect, or satisfied human gate: `agent()`, `phase()`, `log()`, `read_scratch_file()`, `write_scratch_file()`, and `await_user()`. Each entry carries a consecutive commit-publication ordinal, deterministic call identity, and fingerprint of its kind and effective arguments. Concurrent calls are ordered when they commit, so published entries form one gap-free increasing sequence across attempts; a logical owner supplies that order on resume. Replay returns retained results, suppresses committed effects, restores phase state without repeating narration, skips satisfied gates, and rejects divergence.

```ts type-equiv
/**
 * One committed host call replayed on a same-process resume. Result-producing
 * calls return their retained value; committed effects are suppressed; phase
 * replay still restores the worker's current phase without emitting duplicate
 * observer narration.
 */
type WorkflowJournalEntry = WorkflowJournalBase & (
  | {
    /** A settled `agent()` call. */
    readonly kind: 'agent'
    /** Monotonic member sequence assigned to the original launched child. */
    readonly seq: number
    /** The committed script-visible result (text, structured object, or `null` for a failed child). */
    readonly result: JsonValue
  }
  | {
    /** A committed `phase()` observer effect. */
    readonly kind: 'phase'
    /** The phase title restored on replay and emitted only on the first attempt. */
    readonly title: string
  }
  | {
    /** A committed `log()` observer effect. */
    readonly kind: 'log'
    /** The log line emitted only on the first attempt. */
    readonly message: string
  }
  | {
    /** A committed `read_scratch_file()` result. */
    readonly kind: 'scratch-read'
    /** File content; absent means the file did not exist. */
    readonly content?: string
  }
  | {
    /** A committed `write_scratch_file()` effect. */
    readonly kind: 'scratch-write'
  }
  | {
    /** A satisfied `await_user()` gate that must not re-fire on a later journal resume. */
    readonly kind: 'await-user'
  }
)
```

### Workflow metadata

`WorkflowMeta` is validated JSON beside the script, never evaluated from script text. Phase declarations are progress annotations; they impose no execution order.

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

### Attempt result

`WorkflowRun.result` never rejects. `errorCode` preserves a fatal workflow code, and `agentsStarted` is cumulative logical spend rather than a count reset for this attempt.

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
  value: JsonValue
  /** Why the run settled. */
  stopReason: WorkflowStopReason
  /** The failure message (present iff `stopReason` is not `completed`). */
  error?: string
  /** Machine-routable fatal code when the error came from a WorkflowError. */
  errorCode?: WorkflowErrorCode
  /**
   * Cumulative logical-agent spend, including earlier attempts supplied by a
   * same-process supervisor. Graceful settlement counts admitted live calls;
   * termination degrades to earlier spend plus host-observed starts because
   * calls still queued inside a terminated script are unknowable.
   */
  agentsStarted: number
}
```

### Live attempt handle

A `WorkflowRun` is holder-owned. The holder may cancel it or resume its current live gate and must dispose it on every path; disposal waits for bounded script and child cleanup.

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

## Bounded workflow-run Remote

The Typert `workflowRuns` namespace is the browser authority for retained runs. `list` returns bounded heads; `detail`, `members`, `memberDetail`, `logs`, `result`, `artifacts`, and `artifact` fetch selected collections on demand; `control` performs Pause, Resume, Stop, or Save with an optional expected-revision check. Opaque cursors bind to one owner and collection revision and fail when stale.

### List row and baseline

`WorkflowRunHead` contains only bounded text, budget, counts, allowed controls, and overall plus collection-specific revisions. The list baseline adds a process epoch and Session revision; clients refetch after an epoch mismatch or revision gap.

```ts type-equiv
/** One bounded run row used by list responses and change notifications. */
interface WorkflowRunHead {
  readonly runId: SupervisedWorkflowRunId
  readonly displayName: string
  readonly name: string
  readonly description: string
  readonly status: WorkflowRunStatus
  readonly phase?: string
  readonly budget: { readonly total: number; readonly spent: number; readonly remaining: number }
  readonly memberCounts: WorkflowRunMemberCounts
  readonly startedAt: number
  readonly settledAt?: number
  readonly allowedActions: readonly WorkflowRunAction[]
  /** Compare-and-set token for controls and cache invalidation. */
  readonly revision: number
  readonly detailRevision: number
  readonly membersRevision: number
  readonly logsRevision: number
  readonly resultRevision: number
  readonly artifactsRevision: number
}
```

```ts type-equiv
/** Bounded page of run-list rows for one exact Session. */
interface WorkflowRunListPage {
  readonly epoch: WorkflowRunFeedEpoch
  readonly sessionRevision: number
  readonly items: readonly WorkflowRunHead[]
  readonly nextCursor?: WorkflowRunCursor
  readonly total: number
}
```

### On-demand values

Member outcomes and the terminal result distinguish absence from JSON `null`. An available value is either complete JSON or a UTF-8-bounded serialized preview; `evicted` means a committed value existed but retention dropped it, while `not-produced` means no value was committed.

```ts type-equiv
/** A complete JSON value or an explicitly truncated serialized preview. */
type WorkflowRunAvailableValue =
  | {
    readonly state: 'available'
    readonly content: { readonly kind: 'value'; readonly value: JsonValue }
    readonly totalBytes: number
    readonly truncated: false
  }
  | {
    readonly state: 'available'
    readonly content: { readonly kind: 'preview'; readonly text: string }
    readonly totalBytes: number
    readonly truncated: true
  }
```

```ts type-equiv
/** On-demand script-visible value with absence distinct from JSON `null`. */
type WorkflowRunValueView =
  | { readonly state: 'pending' }
  | { readonly state: 'not-produced' }
  | { readonly state: 'evicted' }
  | WorkflowRunAvailableValue
```

### Revisioned changes

The forwarded event carries one bounded row change or invalidation. `invalidate-all` has no Session address because it means the carrier dropped queued changes globally. Complete members, logs, values, and artifacts never enter this event.

```ts type-equiv
/** One bounded incremental change forwarded to browser controllers. */
type WorkflowRunChange =
  | {
    /** The carrier dropped per-Session changes and every baseline is stale. */
    readonly kind: 'invalidate-all'
  }
  | {
    readonly kind: 'upsert'
    readonly sessionId: SessionId
    readonly epoch: WorkflowRunFeedEpoch
    readonly sessionRevision: number
    readonly head: WorkflowRunHead
  }
  | {
    readonly kind: 'remove'
    readonly sessionId: SessionId
    readonly epoch: WorkflowRunFeedEpoch
    readonly sessionRevision: number
    readonly runId: SupervisedWorkflowRunId
  }
  | {
    readonly kind: 'invalidate'
    readonly sessionId: SessionId
    readonly epoch: WorkflowRunFeedEpoch
    readonly sessionRevision: number
  }
```

## Engine events and durable Chat

`workflow/*` events describe one engine attempt and carry detached snapshots, never control handles. `workflow/journal-commit(info, entry)` reports a complete `WorkflowJournalEntry`; replayed calls emit nothing. Listener failures are isolated and cannot change execution or starve peers.

`ctx.workflowRunRecorder` wraps exactly one explicitly attributed top-level supervisor launch and logs its logical lifecycle into the parent Session. Human workflow commands and root workflow tool calls use the recorder; nested, internal, and unattributed launches remain dashboard-only. One `tool-workflow/run-start` uses the stable supervised id; member events from every attempt join that record; a pause, input gate, or budget-limited attempt does not close it. `tool-workflow/run-end` appears exactly once after terminal attempt disposal. Restart reconciliation cancels members left open and closes the orphan run as interrupted, while a same-process reload leaves a live run open. The launching Turn may close while the background record remains running. The Chat renderer opens a running or settled child only after the current direct-child catalog verifies the exact healthy one-shot relationship.

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

Source: [`packages/workflow/workflow/src/index.ts:142`](../../packages/workflow/workflow/src/index.ts)

<a id="ctxworkflowrunrecorder--workflowrunrecorder"></a>

### `ctx.workflowRunRecorder` — `WorkflowRunRecorder`

Records the logical lifecycle of launches that a Consumer explicitly attributes to a parent Session.

Recording is best-effort: the first failed append disables that run's later events and logs a warning without changing workflow execution. Each launch call claims at most one synchronously published run identity. Later member and terminal events use that stable identity across pause/resume attempts.

```ts cordis-catalog
/**
 * Attribute the one logical run started by `start` to `session`.
 *
 * The callback owns execution and may reject unchanged. Lifecycle recording
 * failures are contained. Callers must use this only for an independently
 * presented top-level run; nested and internal launches call the supervisor
 * directly.
 *
 * @param session - exact parent Session that owns the durable Chat record.
 * @param start - one callback that starts and returns the attributed run.
 * @returns the supervisor's launch result unchanged.
 */
launch(session: Session, start: () => Promise<WorkflowLaunched>): Promise<WorkflowLaunched>
```

Types: [Session](session.md)

Source: [`packages/workflow/workflow-run-recorder/src/index.ts:94`](../../packages/workflow/workflow-run-recorder/src/index.ts)

<a id="ctxworkflows--workflowregistry"></a>

### `ctx.workflows` — `WorkflowRegistry`

Saved-workflow definition registry (`ctx.workflows`). Discovery re-reads the roots on every call so a watcher miss cannot pin a stale catalog; the watcher only fires `workflows/change` as a faster refresh hint. A malformed definition file fails discovery loud with its path and reason.

```ts cordis-catalog
/**
 * List invocation-neutral summaries for one workspace.
 * @param options - `cwd` selects the project root; `signal` cancels discovery.
 * @returns sorted winning summaries.
 */
async list(options: WorkflowLookupOptions = {}): Promise<WorkflowDefinitionSummary[]>

/**
 * List browser-safe summaries for the exact session workspace selected by
 * the Remote Session lookup. The caller cannot supply or override a cwd.
 * @param session - resolved Session whose recorded cwd selects discovery.
 * @param signal - cancellation for a superseded Client read.
 * @returns sorted winning summaries without filesystem paths or scripts.
 * @throws when the resolved session has no recorded cwd.
 */
@Remote('list') async listForClient(session: Session, signal: AbortSignal): Promise<readonly WorkflowDefinitionSummaryView[]>

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

/**
 * Atomically create or replace one project/user definition through the
 * filesystem capability. Final-component links are refused during initial
 * validation and guarded provider publication; the required create/version
 * intent stays inside the path-shaped publication operation.
 * @param envelope - metadata plus JavaScript body to persist.
 * @param options - destination scope, workspace selector, and cancellation.
 * @returns the filesystem provider's display path for the committed file.
 */
async save(envelope: WorkflowDefinitionEnvelope, options: WorkflowSaveOptions): Promise<string>
```

Types: [Session](session.md)

Source: [`packages/workflow/workflow-registry/src/index.ts:297`](../../packages/workflow/workflow-registry/src/index.ts)

<a id="ctxworkflowsupervisor--workflowsupervisor"></a>

### `ctx.workflowSupervisor` — `WorkflowSupervisor`

Logical workflow-run supervisor.

```ts cordis-catalog
/**
 * Recover one Session roster and interrupt process-owned rows.
 * @param agent - exact Session owner used for authorization.
 * @param signal - optional cancellation while reading durable state.
 */
async recoverSession(agent: Agent, signal?: AbortSignal): Promise<void>

/**
 * Launch one logical run and return after durable background publication.
 * @param spec - selected source, budget, exact owner, and optional cancellation.
 * @returns the stable logical id, display handle, and editable script path.
 */
async start(spec: { definition?: WorkflowDefinition script?: string meta?: WorkflowMeta args?: unknown agentBudget?: number parent: Agent signal?: AbortSignal }): Promise<WorkflowLaunched>

/**
 * Smoke-check one selected path with canned hosts and no logical run.
 * @param spec - selected source, budget, exact owner, and optional cancellation.
 * @returns the validation result without retaining a run.
 */
async validate(spec: { definition?: WorkflowDefinition script?: string meta?: WorkflowMeta args?: unknown agentBudget?: number parent?: Agent signal?: AbortSignal }): Promise<WorkflowValidation>

/**
 * Quiesce a running attempt for journal-replay pause.
 * @param displayName - Session-local run handle.
 * @param agent - exact live owner.
 * @param signal - optional cancellation for the caller's wait.
 */
async pause(displayName: string, agent: Agent, signal?: AbortSignal): Promise<void>

/**
 * Resume one live human gate or quiescent journal-replay pause.
 * @param displayName - Session-local run handle.
 * @param agent - exact live owner.
 */
resume(displayName: string, agent: Agent): void

/**
 * Resume by logical id, optionally raising a budget-limited cap.
 * @param runId - stable logical run id.
 * @param agent - exact live owner.
 * @param higherBudget - replacement absolute budget for a budget-limited run.
 * @param signal - optional cancellation before a new attempt starts.
 * @returns the Session-local display handle.
 */
resumeById( runId: SupervisedWorkflowRunId | string, agent: Agent, higherBudget?: number, signal?: AbortSignal, ): string

/**
 * Resume one question only while all logical, attempt, and gate ids remain current.
 * @param runId - stable logical run id.
 * @param executionId - current engine-attempt id.
 * @param gateId - current gate occurrence id.
 * @param agent - exact live owner.
 * @returns whether the fenced gate was resumed.
 */
resumeGate( runId: SupervisedWorkflowRunId, executionId: WorkflowRunId, gateId: WorkflowGateId, agent: Agent, ): boolean

/**
 * Stop one nonterminal logical run and wait for attempt disposal.
 * @param displayName - Session-local run handle.
 * @param agent - exact live owner.
 * @param signal - optional cancellation for the caller's wait.
 */
async stop(displayName: string, agent: Agent, signal?: AbortSignal): Promise<void>

/**
 * Save the current editable projection through the definition registry.
 * @param displayName - unnumbered, non-built-in run handle.
 * @param agent - exact live owner.
 * @param scope - optional destination overriding the configured default.
 * @param signal - optional cancellation while reading and writing.
 * @returns the saved definition path.
 */
async save( displayName: string, agent: Agent, scope?: WorkflowSaveScope, signal?: AbortSignal, ): Promise<string>

/**
 * Return one bounded member outcome after exact Session authorization.
 * @param agent - Session used for authorization.
 * @param request - logical run and member ids.
 * @returns bounded member metadata and outcome.
 */
memberDetail(agent: Agent, request: WorkflowRunMemberRequest): WorkflowRunMemberDetail

/**
 * Return one atomic, retention-bounded lifecycle snapshot after Session
 * recovery. Host recorders use it to reconcile events missed during reload.
 * @param agent - exact Session owner used for authorization and recovery.
 * @param runId - stable logical run id.
 * @param signal - optional cancellation while durable state is recovered.
 * @returns the retained run state, or `undefined` when successful recovery confirms that the run is absent.
 * @throws When recovery fails, cancellation wins, or the id belongs to another recovered Session.
 */
async recordingSnapshot( agent: Agent, runId: SupervisedWorkflowRunId, signal?: AbortSignal, ): Promise<WorkflowRunRecordingSnapshot | undefined>

/**
 * Reach a fixed point for background work owned by one exact Agent. Running
 * attempts, starts that reserved capacity, durable terminal publication,
 * completion delivery, and completion-woken Agent turns are all included.
 * Human gates, user pauses, and budget-limited runs are quiescent parked
 * states. A completion turn may launch more workflows; the fixed-point loop
 * follows at most the configured consecutive completion-wake budget.
 * @param agent - exact workflow owner whose work must reach quiescence.
 * @param signal - optional cancellation for the wait only.
 */
async whenOwnerQuiescent(agent: Agent, signal?: AbortSignal): Promise<void>

/**
 * List one bounded retained-run page for the resolved Agent Session.
 * @param agent - Remote-resolved Session owner.
 * @param request - page size and optional revision-fenced cursor.
 * @param signal - cancellation for a superseded Remote read.
 * @returns bounded run heads and an optional next-page cursor.
 */
@Remote('list') async listForClient( agent: Agent, request: WorkflowRunListRequest, signal: AbortSignal, ): Promise<WorkflowRunListPage>

/**
 * Load bounded selected-run metadata for the resolved Agent Session.
 * @param agent - Remote-resolved Session owner.
 * @param request - selected logical run id.
 * @param signal - cancellation for a superseded Remote read.
 * @returns bounded detail for the selected run.
 */
@Remote('detail') async detailForClient( agent: Agent, request: WorkflowRunRequest, signal: AbortSignal, ): Promise<WorkflowRunDetail>

/**
 * Load one bounded member-summary page for a selected run.
 * @param agent - Remote-resolved Session owner.
 * @param request - selected run, page size, and optional cursor.
 * @param signal - cancellation for a superseded Remote read.
 * @returns bounded member heads and an optional next-page cursor.
 */
@Remote('members') async membersForClient( agent: Agent, request: WorkflowRunMembersRequest, signal: AbortSignal, ): Promise<WorkflowRunMemberPage>

/**
 * Load one selected member's bounded committed outcome.
 * @param agent - Remote-resolved Session owner.
 * @param request - selected logical run and member ids.
 * @param signal - cancellation for a superseded Remote read.
 * @returns bounded member detail.
 */
@Remote('memberDetail') async memberDetailForClient( agent: Agent, request: WorkflowRunMemberRequest, signal: AbortSignal, ): Promise<WorkflowRunMemberDetail>

/**
 * Load one bounded retained log page for a selected run.
 * @param agent - Remote-resolved Session owner.
 * @param request - selected run, page size, and optional cursor.
 * @param signal - cancellation for a superseded Remote read.
 * @returns bounded retained log lines and an optional next-page cursor.
 */
@Remote('logs') async logsForClient( agent: Agent, request: WorkflowRunLogsRequest, signal: AbortSignal, ): Promise<WorkflowRunLogPage>

/**
 * Load a selected run's bounded terminal-result projection.
 * @param agent - Remote-resolved Session owner.
 * @param request - selected logical run id.
 * @param signal - cancellation for a superseded Remote read.
 * @returns bounded result state and revision.
 */
@Remote('result') async resultForClient( agent: Agent, request: WorkflowRunRequest, signal: AbortSignal, ): Promise<WorkflowRunResultView>

/**
 * Load one bounded scratch-artifact metadata page.
 * @param agent - Remote-resolved Session owner.
 * @param request - selected run, page size, and optional cursor.
 * @param signal - cancellation for the directory read.
 * @returns bounded artifact metadata and an optional next-page cursor.
 */
@Remote('artifacts') async artifactsForClient( agent: Agent, request: WorkflowRunArtifactsRequest, signal: AbortSignal, ): Promise<WorkflowRunArtifactPage>

/**
 * Read one UTF-8-safe scratch-artifact chunk without following links.
 * @param agent - Remote-resolved Session owner.
 * @param request - selected run, artifact, byte limit, and optional cursor.
 * @param signal - cancellation for the file read.
 * @returns bounded UTF-8 text with byte offsets and an optional cursor.
 */
@Remote('artifact') async artifactForClient( agent: Agent, request: WorkflowRunArtifactRequest, signal: AbortSignal, ): Promise<WorkflowRunArtifactChunk>

/**
 * Execute one revision-checked dashboard control to settlement.
 * @param agent - Remote-resolved exact run owner.
 * @param request - run id, action, and optional expected revision.
 * @param signal - cancellation for the control operation.
 * @returns the authoritative run head after settlement.
 */
@Remote('control') async controlForClient( agent: Agent, request: WorkflowRunControlRequest, signal: AbortSignal, ): Promise<WorkflowRunControlResult>

/** Cancel every process-owned nonterminal run as Interrupted. */
markInterrupted(): void
```

Types: [Agent](core.md)

Source: [`packages/workflow/workflow-supervisor/src/index.ts:655`](../../packages/workflow/workflow-supervisor/src/index.ts)

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

Source: [`packages/workflow/workflow/src/index.ts:100`](../../packages/workflow/workflow/src/index.ts)

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

Source: [`packages/workflow/workflow/src/index.ts:89`](../../packages/workflow/workflow/src/index.ts)

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

Source: [`packages/workflow/workflow/src/index.ts:120`](../../packages/workflow/workflow/src/index.ts)

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

Source: [`packages/workflow/workflow/src/index.ts:79`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowjournal-commit--emit"></a>

#### `workflow/journal-commit` — emit

One host call appended to the logical journal in consecutive commit-publication order. A same-process resume matches the stable call identity and replays the entry instead of repeating its result or effect. Replayed calls emit nothing.

```ts cordis-catalog
/**
 * One host call appended to the logical journal in consecutive
 * commit-publication order. A same-process resume matches the stable call
 * identity and replays the entry instead of repeating its result or effect.
 * Replayed calls emit nothing.
 * @param info - the run's identity snapshot.
 * @param entry - committed call identity, fingerprint, kind, and optional result.
 * @mode emit
 */
'workflow/journal-commit'(info: WorkflowRunInfo, entry: WorkflowJournalEntry): void
```

Source: [`packages/workflow/workflow/src/index.ts:110`](../../packages/workflow/workflow/src/index.ts)

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

Source: [`packages/workflow/workflow/src/index.ts:70`](../../packages/workflow/workflow/src/index.ts)

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

Source: [`packages/workflow/workflow/src/index.ts:63`](../../packages/workflow/workflow/src/index.ts)

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

Source: [`packages/workflow/workflow/src/index.ts:55`](../../packages/workflow/workflow/src/index.ts)

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

Source: [`packages/workflow/workflow-registry/src/index.ts:71`](../../packages/workflow/workflow-registry/src/index.ts)

<a id="workflowsgate-request--emit"></a>

#### `workflows/gate-request` — emit

One live workflow attempt parked for human input.

```ts cordis-catalog
/**
 * One live workflow attempt parked for human input.
 * @mode emit
 * @param request - attempt-fenced {@link WorkflowGateRequest} and exact owner.
 */
'workflows/gate-request'(request: WorkflowGateRequest): void
```

Source: [`packages/workflow/workflow-supervisor/src/index.ts:200`](../../packages/workflow/workflow-supervisor/src/index.ts)

<a id="workflowsmember-end--emit"></a>

#### `workflows/member-end` — emit

One launched child settled within its logical workflow run.

```ts cordis-catalog
/**
 * One launched child settled within its logical workflow run.
 * @mode emit
 * @param info - stable {@link SupervisedWorkflowRunInfo} identity.
 * @param member - settled {@link SupervisedWorkflowMemberLifecycleInfo} including its child Session id.
 */
'workflows/member-end'(info: SupervisedWorkflowRunInfo, member: SupervisedWorkflowMemberLifecycleInfo): void
```

Source: [`packages/workflow/workflow-supervisor/src/index.ts:187`](../../packages/workflow/workflow-supervisor/src/index.ts)

<a id="workflowsmember-start--emit"></a>

#### `workflows/member-start` — emit

One child launch joined a published logical workflow run.

```ts cordis-catalog
/**
 * One child launch joined a published logical workflow run.
 * @mode emit
 * @param info - stable {@link SupervisedWorkflowRunInfo} identity.
 * @param member - launched {@link SupervisedWorkflowMemberLifecycleInfo} including its child Session id.
 */
'workflows/member-start'(info: SupervisedWorkflowRunInfo, member: SupervisedWorkflowMemberLifecycleInfo): void
```

Source: [`packages/workflow/workflow-supervisor/src/index.ts:180`](../../packages/workflow/workflow-supervisor/src/index.ts)

<a id="workflowsrun-change--emit"></a>

#### `workflows/run-change` — emit

One bounded supervisor change for one owning Session.

```ts cordis-catalog
/**
 * One bounded supervisor change for one owning Session.
 * @mode emit
 * @param change - revisioned row update, removal, or baseline invalidation.
 */
'workflows/run-change'(change: WorkflowRunChange): void
```

Source: [`packages/workflow/workflow-supervisor/src/types.ts:311`](../../packages/workflow/workflow-supervisor/src/types.ts)

<a id="workflowsrun-end--emit"></a>

#### `workflows/run-end` — emit

One logical workflow run reached its exact-once terminal publication.

```ts cordis-catalog
/**
 * One logical workflow run reached its exact-once terminal publication.
 * @mode emit
 * @param info - stable {@link SupervisedWorkflowRunInfo} identity.
 * @param result - bounded {@link SupervisedWorkflowResultInfo} without the result value.
 */
'workflows/run-end'(info: SupervisedWorkflowRunInfo, result: SupervisedWorkflowResultInfo): void
```

Source: [`packages/workflow/workflow-supervisor/src/index.ts:194`](../../packages/workflow/workflow-supervisor/src/index.ts)

<a id="workflowsrun-start--emit"></a>

#### `workflows/run-start` — emit

One logical workflow run was durably published before its first member.

```ts cordis-catalog
/**
 * One logical workflow run was durably published before its first member.
 * @mode emit
 * @param info - stable {@link SupervisedWorkflowRunInfo} identity.
 */
'workflows/run-start'(info: SupervisedWorkflowRunInfo): void
```

Source: [`packages/workflow/workflow-supervisor/src/index.ts:173`](../../packages/workflow/workflow-supervisor/src/index.ts)
<!-- END GENERATED cordis-surface -->
