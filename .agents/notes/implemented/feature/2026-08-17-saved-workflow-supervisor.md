# Agent Note: Saved workflows, slash commands, and the background run supervisor

Status: implemented

English | [中文](2026-08-17-saved-workflow-supervisor.zh.md)

## Problem

The dynamic-workflow seam launched a model-written script inline and blocked the parent turn until it settled. Three Grok-build-shaped capabilities stayed deferred: saved workflow definitions on disk, human slash-command entry, and a background run lifecycle with a live roster, display-name handles, pause/resume, and stop/save. The Web Chat renderer (`ui-workflow-run`) showed durable top-level run history but no controls, and nothing outside an agent read a workflow run — so the engine lived in a preset-scoped realm.

## Decision

Saved workflows, slash commands, and run supervision became three host-plane additions plus a widened engine, mounted in the Web composition.

### Saved definitions (`dsh-workflow-registry`)

A definition is one JSON envelope `<name>.workflow.json` with `{ meta, script }`: meta is validated as data beside the body (never evaluated), the filename must equal `meta.name` (kebab-case), and unknown meta fields fail loud. Discovery scans three roots in precedence order — bundled > project (`.dsh/workflows`) > user (`<dshHome>/workflows`) — keyed by `meta.name`, with a chokidar watcher invalidating the catalog and emitting `workflows/change`. `ctx.workflows` serves sorted summaries and full definitions; a malformed file fails discovery loud with its path and reason.

### Run supervisor (`dsh-workflow-supervisor`)

`ctx.workflowSupervisor` owns every live `WorkflowRun` handle, so a launch returns immediately. Runs key by a session-unique display name — `meta.name` for the first live/retained run, then `meta.name-2`, `meta.name-3` — never by internal id; numbered handles are for humans, not definition names. A launch writes an editable `script.js` projection plus a `scratch/` directory under `<dshHome>/workflow-runs/<dir-id>`. Child-agent results are journaled in call order from the new `workflow/agent-result` event, project-scoped: `workflow/start|phase|log|gate|agent-start|agent-end|agent-result|end` are the observe-only wire the supervisor folds into a live roster view, pushed to the browser as whole-set `session/workflow-runs` frames (the `session/jobs` posture).

### Pause / resume / stop / save

- `pause` cancels the run and marks it `paused`, retaining the committed journal. `resume` re-executes the original immutable script, args, and budget with the journal replayed (replayed `agent()` calls return committed results and spend no budget).
- A script-level `await_user(kind, message)` parks the alive worker and resume continues past it; `pause(kind, message)` re-fires on every resume. Gates surface as `Needs input`.
- `stop` cancels and marks `cancelled`; a process exit marks active runs `interrupted`, not resumable.
- `save` writes the run's script projection back into project/user definitions; it refuses built-ins and numbered handles.
- Completion injects a parent-visible notice with the result through `agent.inject`, so the report is not buried in the dashboard.

### Slash commands (`dsh-command-workflows`)

Host-plane `/workflow` (launch + `pause|resume|stop|save` grammar), `/workflows` (bare success; the client opens the dashboard on `command/executed`), `/create-workflow` (steers the model into the bundled `create-workflow` skill), and one launch command per saved `meta.name`, refreshed on `workflows/change` and silently yielding the bare name to built-in collisions. No internal id ever reaches command text.

### Engine widening (`dsh-workflow-worker-thread`)

The script surface gained `complete(value)`, `pause`/`await_user`, `budget()`, `write_scratch_file`/`read_scratch_file`, a `parallel([...job maps])` overload, journal replay, and `validate_only` (canned `agent()` results, no children, no record). The engine moved to the host plane because the supervisor and commands read it from outside any agent's realm.

### Web dashboard (`dsh-client-ui-workflows`)

A fullscreen `shell.overlay` entry reads `workflowRunsBySession` from the runtime mirror; Pause/Resume/Stop/Save execute the `/workflow` command through the commands Remote. The in-chat `workflow-run` node remains the durable surface; the dashboard is additional.

## Verification

Package tests cover envelope parsing and discovery precedence, the supervisor display-name allocator, journal re-run, save rejection, interrupted-on-exit, and the `/workflow` grammar. Worker-thread tests cover every new hook through the in-process MessageChannel (complete, budget, gates, journal replay, parallel maps, scratch, validate_only). The browser smoke covers the assembled slash menu, a background launch, the dashboard roster, and a pause/resume cycle.

## Alternatives considered

**A projection-key dashboard over session-projections.** Rejected: run state is process-local, rich, and changes many times per run; the whole-set `session/workflow-runs` frame mirrors `session/jobs` exactly and keeps the dashboard a read-only projection of the supervisor.

**Per-preset supervisor with host-plane commands.** Rejected: the api-proxy could not read a preset-realm supervisor to push frames, and commands could not resolve the run registry.

**Keeping foreground tool semantics and bolting a poll on top.** Rejected: the supervisor owning the live run is what makes background launch, cancellation, and the completion notice correct without a second lifecycle owner.

## Consequences

Workflow runs now survive as background, pauseable, resumable, stoppable work with a live dashboard, while the durable `tool-workflow/*` Chat record and the generic tool card stay unchanged. Definitions are ordinary files a team can share in git. Journal replay is never exactly-once for external effects whose result was not committed before pause; effectful steps must stay idempotent, and cross-process resume is deliberately unsupported (active runs become `Interrupted`).