# Agent Note: Saved workflows, slash commands, and the background run supervisor

Status: implemented

English | [中文](2026-08-17-saved-workflow-supervisor.zh.md)

## Problem

The dynamic-workflow seam provided holder-owned script execution, but the ordinary tool collected each run in the launching turn. Definitions could not be shared as files, humans had no command entry, and the browser had no bounded control and inspection API for background work. A useful detached lifecycle also had to distinguish one logical run from its engine attempts, survive process restart as inspectable history without claiming that execution resumed, and deliver completion to the exact launching Agent without creating an unbounded sequence of model turns.

## Decision

Saved definitions, a session-owned supervisor, Host launch commands, and a browser-owned dashboard form one workflow product path in the Web composition.

### Saved definitions

`dsh-workflow-registry` discovers `<name>.workflow.json` envelopes containing `{ meta, script }` from bundled, project (`.dsh/workflows`), and user (`<dshHome>/workflows`) roots with bundled > project > user precedence. Metadata is validated as data, the filename must match the kebab-case `meta.name`, and unknown fields or malformed definitions fail with the owning path. The registry re-reads on each lookup; its watcher emits `workflows/change` as a refresh hint rather than as the sole source of freshness. Project and user saves use the filesystem capability with link refusal and concurrent-publication guards.

### Logical runs and engine attempts

`dsh-workflow-supervisor` owns each accepted live `WorkflowRun`, so `start()` returns after durable publication with a stable logical `runId`, a session-unique display handle, and the editable script path. The logical id spans pause, gate, and budget-resume attempts; each engine attempt retains its separate engine run id. Member sequences and cumulative `agentsStarted` continue across attempts. `WorkflowJournalEntry.ordinal` records one gap-free commit-publication order across attempts, while stable call identity and its request fingerprint determine replay correspondence instead of launching the same child again.

The first retained run for a workflow name uses that name as its display handle; later runs use monotonic numbered handles. A run directory contains a private `script.js` projection and `scratch/`. `pause` cancels and disposes the current attempt before parking the logical run with its journal. `await_user()` keeps the current worker parked and continues after its attempt-fenced question is acknowledged, while `pause()` re-fires its condition after resume. A budget-limited run resumes only when the caller supplies a higher absolute budget; an ordinary paused or needs-input run rejects a changed budget. `stop` publishes one terminal cancellation. `save` reads the bounded editable projection through the definition registry and rejects bundled or numbered runs.

### Retained manifests and bounded Remote reads

Each Session has a bounded manifest roster containing display-name ordinals, run heads, budget and member summaries, a log tail, gate presentation, a bounded result projection, and scratch-artifact metadata. Recovery commits every formerly active row as terminal `interrupted` before returning it. It restores inspection state but no `Agent`, engine attempt, script, args, journal, or resume authority; a recovered row therefore has no editable `scriptPath` and cannot be saved. Retention eviction removes the matching in-memory terminal row and run directory, so recovery and the live roster cannot produce duplicate rows.

The Typert `workflowRuns` Remote is the browser authority. `list` returns a bounded page with a process epoch and per-Session revision; `detail`, `members`, `memberDetail`, `logs`, `result`, `artifacts`, and `artifact` load selected data on demand; `control` applies Pause, Resume, Stop, or Save with an optional expected-run-revision check. Opaque cursors bind to one collection revision and fail when stale. List rows contain bounded counts, collection revisions, and `allowedActions`, never complete members or output. Script-visible member outcomes and final values distinguish `pending`, `available`, `not-produced`, and `evicted`; scratch files are read as paged UTF-8 chunks.

`workflows/run-change` carries one `upsert` or `remove`, a per-Session `invalidate`, or `invalidate-all` when the carrier drops queued Session changes. Every addressed change carries the epoch and next Session revision, so clients refetch on a gap or epoch mismatch rather than merging uncertain state.

### Completion delivery and quiescence

One terminal publication produces at most one UTF-8-bounded notice for the exact launching Agent object. Runs reserved before delivery join one completion cohort. Below the consecutive completion-wake limit, the first delivered notice in each cohort uses `followup` regardless of the owner's current status, while the remaining cohort notices use `inject`; later cohorts may open more turns until the limit. Only claimed human input resets the owner's wake count. The notice retains the dashboard recovery direction and, when present, the conventional `scratch/report.md` reference inside the byte limit.

`whenOwnerQuiescent()` reaches a fixed point over reserved starts, running attempts, durable terminal publication, completion delivery, and turns woken by completion. Human gates, user pauses, and budget-limited runs are parked and therefore quiescent. This lets one-shot compositions wait for owned background work without treating a parked run as active execution.

### Commands, durable Chat, and the dashboard

`dsh-command-workflows` owns `/workflow`, `/create-workflow`, and cwd-scoped saved-definition aliases. An existing command keeps a colliding bare name; the workflow alias repeats the `workflow-` qualifier until free, while every definition reserves its own bare name and `/workflow <name>` remains canonical. Alias reconciliation follows definition and command-registry changes. `/create-workflow` enters the deterministic bundled authoring skill through the standard user-explicit skill path. `/workflows` is a browser-owned client action: opening the overlay performs no Host command execution and appends no command lifecycle row.

`dsh-workflow-run-recorder` wraps exactly one explicitly attributed supervisor launch for each human launch command or root `workflow` tool call and projects one durable Chat lifecycle under the stable logical run id. Nested, internal, and unattributed launches remain dashboard-only. Member events from every engine attempt join that record, while a pause, input gate, or budget stop does not close it. The browser's `WorkflowRunsController` lazily subscribes to the selected Session, applies revisioned bounded heads, refetches gaps, and leaves details and outputs on demand. Dashboard controls call the typed Remote directly. Child transcript links refresh the direct-child catalog and open only an exact healthy one-shot child, whether that child is still running or already settled.

## Verification

Package coverage pins manifest decoding and retention, recovery-to-interrupted state, duplicate-row eviction, stable logical identity across attempts, cumulative budget and journal replay, stale controls and cursors, paged value and artifact reads, gate fencing, exact-owner completion delivery, wake limits, owner quiescence, explicit command and tool attribution, and restart reconciliation of orphan Chat records. Runtime tests pin baseline/change ordering, epoch and revision gaps, reconnect and removal fencing, and on-demand operations. The assembled workflow replay pins background launch, the later completion turn, and the durable logical lifecycle; the Web smoke pins the client-owned `/workflows` action and real dashboard controls.

## Alternatives considered

**Whole-set `session/workflow-runs` frames.** Rejected because complete rosters and outputs grow with retained history and force every change through one eager mirror. Bounded heads plus revisioned invalidation keep the forwarded event small and make expensive collections explicit reads.

**Host execution for `/workflows` and dashboard controls.** Rejected because opening a browser view is not a Host command, and controls already have an authorized, revision-checked Remote. Browser ownership avoids false command transcript rows and a second parser for the same actions.

**Restoring active execution from manifests.** Rejected because a durable view does not contain the live Agent, engine resources, immutable inputs, or committed replay journal needed to continue correctly. Recovery reports interruption and preserves inspection rather than manufacturing resume authority.

**Completion by Session id or an unrestricted follow-up.** Rejected because a replacement Agent must not inherit another instance's completion, and repeated completion cohorts could recursively spend turns. Exact-object routing plus one wake per cohort and a consecutive wake cap preserves delivery without an unbounded loop.

## Consequences

Workflows are background, inspectable, controllable logical runs with shareable definitions and durable retained views. The cost is explicit revision, retention, and recovery machinery plus separate logical and attempt identities. Journal replay is not exactly-once for an external effect whose result was not committed before cancellation, so effectful workflow steps remain idempotent. Process restart preserves bounded inspection and marks active work Interrupted; it does not support cross-process resume or saving a recovered script projection.
