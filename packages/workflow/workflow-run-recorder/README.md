# @deepseek-ai/dsh-workflow-run-recorder

English | [中文](README.zh.md)

Source-neutral durable Chat projection for supervised workflows. A consumer explicitly wraps one independently presented launch with `ctx.workflowRunRecorder.launch(session, start)`. The recorder attributes the supervisor's logical run and member lifecycle to that exact Session; supervisor launches outside the callback remain dashboard-only.

## Attribution and lifecycle

The callback must start exactly one top-level run and return its `WorkflowLaunched` value. Synchronous lifecycle emitted before `start()` returns is attributed through async-local launch state, so publication does not depend on the returned promise winning a race. The stable logical run id remains the record key across pause and resume attempts. Root model-tool launches and Host command launches use this API; nested tool dispatch and internal supervisor operations call the supervisor directly.

The recorder appends `tool-workflow/run-start`, paired `tool-workflow/agent-start` and `tool-workflow/agent-end` events, then one `tool-workflow/run-end`. These historical event names remain the durable Session vocabulary consumed by the existing Chat node; they do not imply that the model tool owns the record. Browser-safe payload declarations live at `@deepseek-ai/dsh-workflow-run-recorder/types`.

Session recording is observational and best-effort. The first failed append or impossible lifecycle disables later recording for that logical run, logs a warning, and leaves either no record or a legal continuous prefix without changing workflow execution. The package invariant rejects duplicate starts, unpaired member endings, a terminal with open members, and updates after a terminal event on both restored and live Session logs.

## Reload and restart recovery

On Agent creation and recorder reload, the service folds open durable prefixes and asks the supervisor for one atomic retained lifecycle snapshot. Missing member starts and endings are repaired in sequence order with the supervisor's exact label, phase, child Session, and terminal status. Lifecycle emitted while the snapshot is read stays buffered until repair finishes, preventing orphan endings during hot reload.

A retained terminal row closes the Chat record with its persisted stop reason. Process recovery converts active manifests to Interrupted; persisted member outcomes remain exact, while a Session-open member absent from the retained roster closes as Cancelled. An absent supervisor row after successful recovery closes the orphan prefix as Interrupted. Infrastructure or storage failures only warn and release buffered live events; they do not fabricate a terminal state. A fully closed Session trace is never reopened or duplicated.

## Composition

Load this singleton after `workflow-supervisor` and before consumers that launch attributed runs. The base composition provides it to `tool-workflow` and `command-workflows`; `ui-workflow-run` consumes only its browser-safe event types.

## Model Experience

### Durable recording

#### What the model sees

Nothing. The service appends observation-only `tool-workflow/*` Session events for durable human Chat rendering and registers no prompt, tool schema, request content, or model-visible result. Supervisor-owned completion delivery remains separate.

#### Token effect

No model-request tokens are added.

#### KV Cache effect

The package does not alter model requests or their reusable prefixes.

## Known Limitations and Deferred Work

- Recording is not a transaction with external workflow effects; an append failure intentionally leaves an incomplete legal prefix while the run continues.
- Recovery can repair only lifecycle retained by the supervisor and Session. Cross-process workflow execution remains non-resumable and appears as Interrupted.
