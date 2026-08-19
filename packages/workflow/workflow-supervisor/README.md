# @deepseek-ai/dsh-workflow-supervisor

English | [中文](README.zh.md)

Workflow run supervisor (`ctx.workflowSupervisor`): session-scoped display handles, live + retained runs, background launch, same-process pause/resume with a host-call journal, stop, save-into-definitions, and a completion notice into the parent conversation.

## Display names

Runs key by a session-unique display name, never an internal id. The first live/retained run for a definition name is `meta.name`; further launches number the handle `meta.name-2`, `meta.name-3`, …. Humans pass that handle to `pause`/`resume`/`stop`/`save`.

## Lifecycle

- `start(spec)` launches in the background and returns `{ displayName, runId, scriptPath, status: 'started' }` immediately; the supervisor owns the live `WorkflowRun` handle and writes an editable `script.js` projection plus a `scratch/` directory under `<dshHome>/workflow-runs/<dir-id>`.
- `validate(spec)` smoke-checks one canned-host path (`validate_only` engine mode): no children, no run record, no dashboard row.
- `pause(displayName)` cancels the run and marks it `paused`, retaining the committed `agent()` journal. `resume(displayName)` re-executes the original immutable script, args, and budget with the journal replayed (replayed calls spend no budget). A script-level `await_user()` gate parks the live worker and resume continues past it; a `pause()` gate re-fires on every resume. `markInterrupted()` marks active runs `Interrupted` on process exit.
- `stop(displayName)` cancels and marks the run `cancelled`.
- `save(displayName, agent, scope?)` writes the run's script projection as a `.workflow.json` definition under project or user scope; it rejects built-ins and numbered handles.

## Wire

`listRuns(agent)` returns browser-safe `WorkflowRunView`s the api-proxy pushes as whole-set `session/workflow-runs` frames; `workflows/run-change` signals the change. The `workflow/agent-result` event supplies the journal.

## Config

`enabled` (default true), `dshHome`, `defaultAgentBudget` (128), `maxAgentBudget` (1024), `runsRoot` (`<dshHome>/workflow-runs`), `saveScope` (`project`).

## Model Experience

### Completion notice

#### What the model sees

A launched background run returns nothing new to the model beyond the [`workflow` tool](../tool-workflow/README.md)'s `{ status, displayName, runId, ... }` result. When the run settles, the supervisor injects one plugin-sourced user notice (`workflow "<display-name>" completed …`) carrying the result value into the parent conversation.

#### Token effect

The completion notice adds its own short user text block to history; the run itself adds none until it settles.

#### KV Cache effect

The notice is appended after the reusable request prefix, so it extends the conversation rather than invalidating the assistant's own cache.

## Known Limitations and Deferred Work

- Journal replay is not exactly-once for external effects whose result was not committed before pause; effectful steps must stay idempotent.
- Cross-process resume is not supported: active runs become `Interrupted` on process exit.
- Retained runs are kept for the whole session with no retention cap.