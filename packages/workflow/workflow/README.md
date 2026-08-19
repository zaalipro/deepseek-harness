# @deepseek-ai/dsh-workflow

English | [中文](README.zh.md)

The holder-owned workflow engine seam (`ctx.workflowEngine`). It validates and executes one model-written orchestration script, exposes a live attempt handle, and emits detached lifecycle snapshots. It does not own saved definitions, detached logical identity, retained history, browser controls, or completion delivery; [`dsh-workflow-supervisor`](../workflow-supervisor/README.md) composes those responsibilities over one or more engine attempts.

`@deepseek-ai/dsh-workflow-worker-thread` is the current provider. One worker thread keeps synchronous script work off the Host event loop and permits bounded termination, but the worker and its vm context are not security boundaries.

The package root is the Host face. Browser-safe identities, metadata, results, and observe-only payloads live at `@deepseek-ai/dsh-workflow/types`; `WorkflowStartRequest`, `WorkflowJournalEntry`, and the holder-owned `WorkflowRun` remain on the Host face.

## Service and attempt contract

`WorkflowEngine.start(request): WorkflowRun` rejects before publication when metadata, script syntax, provider routing, limits, journal entries, or cumulative spend are invalid. A returned handle owns one engine attempt. Its `result` never rejects: script and infrastructure failures resolve with `stopReason: 'error'`, and cancellation resolves with `cancelled` within the provider's configured grace.

The holder must call idempotent `dispose()` on every path. Disposal cancels unfinished work and waits for bounded script and child cleanup. Engine-plugin unload prevents new starts without revoking accepted handles.

`WorkflowStartRequest` carries script, metadata, args, parent Agent, optional provider and total-agent limit, optional cancellation, scratch directory, smoke-check mode, cumulative `initialAgentSpend` and `initialAgentSeq`, and committed `WorkflowJournalEntry` values. Cumulative fields let a logical-run owner preserve budgets and unique member sequences across attempts. Each journal entry identifies one committed host call by kind, consecutive commit-publication ordinal, stable call id, and fingerprint. Concurrent calls are ordered when they commit, so published entries form one gap-free increasing sequence across attempts; a replay request supplies that order. Replay returns retained child or scratch-read results, suppresses repeated observer and scratch-write effects, restores phase state, skips satisfied human gates, and rejects a changed call.

`WorkflowRun` exposes `id`, validated `meta`, non-rejecting `result`, `cancel()`, live-gate `resume()`, and `dispose()`. `WorkflowResult.agentsStarted` is the cumulative logical spend supplied to and observed by the attempt; `errorCode` preserves a machine-routable fatal `WorkflowError` code.

## Observe-only events

Every `workflow/*` payload is an independent lossless-JSON snapshot. Listener failure is logged and contained, and one listener cannot mutate the engine, the holder's result, or another listener's payload.

- `workflow/start` / `workflow/end` pair one engine attempt; the ending omits the result value.
- `workflow/phase`, `workflow/log`, and `workflow/gate` report script progress and parking.
- `workflow/agent-start` / `workflow/agent-end` pair a published child by attempt-wide member sequence.
- `workflow/journal-commit(info, entry)` reports one committed `WorkflowJournalEntry`; replayed calls emit no new entry.

These events grant no cancellation, resume, or disposal authority. A logical owner correlates them by the attempt id and decides what persists.

## Failure discipline

Fatal `WorkflowError` codes always escape `parallel()` and `pipeline()` instead of becoming an ordinary item `null`: parse and metadata failures, invalid arguments, unsupported options or schemas, configured caps, provider start/result faults, unserializable values, journal divergence, and cancellation. A child that settles normally with a non-completed reason remains an ordinary child failure, so `agent()` returns `null` for script-level handling.

## Model Experience

Indirectly, through child Agent requests started by the engine; consumers own model-visible tool schemas, launch results, durable records, and completion notices.

#### KV Cache effect

No direct effect; model-visible consumers own request-prefix and history changes.

## Known Limitations and Deferred Work

- The seam owns one live attempt, not a detached run registry. Callers needing background lifecycle use `ctx.workflowSupervisor` rather than leaving handles unowned.
- Journals checkpoint committed host-call results, not arbitrary JavaScript state or external side effects. Replay requires deterministic call identity and idempotent uncommitted effects.
- A workflow script cannot launch another workflow. It composes child Agents through `agent()` only.
- Budget counts admitted child launches, not provider tokens.
