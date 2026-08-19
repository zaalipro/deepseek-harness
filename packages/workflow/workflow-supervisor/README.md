# @deepseek-ai/dsh-workflow-supervisor

English | [中文](README.zh.md)

Session-owned workflow supervision (`ctx.workflowSupervisor`): stable logical runs over holder-owned engine attempts, background launch, same-process journal resume, bounded retained manifests, the `workflowRuns` Typert Remote, exact-owner completion delivery, and owner quiescence.

## Identity and lifecycle

A successful `start()` durably publishes one logical run, then returns `{ status: 'started', displayName, runId, scriptPath }` without awaiting the script. The logical `runId` remains stable across pause, human-gate, and budget-resume attempts; each underlying `WorkflowRun.id` identifies only one engine attempt. Member sequences, journal call identities, and `agentsStarted` are cumulative across the logical run.

Display handles are unique within a Session's retained history. The first run for a definition uses `meta.name`; later runs use monotonic `meta.name-2`, `meta.name-3`, and so on. Each fresh run receives a private directory under `runsRoot` with an editable `script.js` and `scratch/`.

- `pause(displayName)` cancels and disposes the current attempt, then parks the logical run with committed `WorkflowJournalEntry` values retained. Resume re-executes the immutable script and args, passes cumulative spend and sequence state to the engine, and replays matching committed calls without spending budget again.
- `await_user()` parks the live attempt and continues past the attempt-fenced gate after acknowledgement; `pause()` re-fires its condition after resume. A stale gate answer cannot resume a replacement attempt.
- A budget-limited run resumes only with a higher absolute `agent_budget`, bounded by `maxAgentBudget`. Other parked states reject a changed budget.
- `stop()` publishes one terminal cancellation. Owner or service disposal publishes Interrupted after attempt cleanup.
- `save()` reads the bounded editable projection and atomically writes a project or user definition through `ctx.workflows`. Bundled definitions, numbered handles, and recovered rows without a live `scriptPath` cannot be saved.
- `validate()` collects one canned-host engine path without creating a logical run, child, dashboard row, manifest, or durable Chat record.

## Retained manifests and recovery

The store keeps at most `maxRetainedRunsPerSession` rows plus bounded display-name ordinals. A manifest retains the run head, budget, member summaries, a UTF-8-bounded log tail, gate presentation, a bounded terminal result projection, and scratch-artifact names and byte sizes. Large member outcomes are process-local and recover as `evicted`; values that never existed remain `not-produced` rather than JSON `null`.

Recovery addresses one Session manifest directly. Before returning, it commits every formerly active status as terminal Interrupted. It restores inspection state but no `Agent`, engine attempt, script, args, journal, question, or resume authority. Retention eviction removes the corresponding in-memory terminal row and its run directory, so a later recovery cannot duplicate an already loaded row.

`recordingSnapshot(agent, runId, signal?)` is the Host-only reconciliation read for event recorders. It recovers the exact Agent's Session first, then returns one atomic retention-bounded run, member, and optional terminal-result lifecycle snapshot. It returns `undefined` only when that run is absent after successful recovery; I/O, corruption, cancellation, and a known run belonging to another Session reject. This snapshot never crosses the browser wire.

## Browser Remote and change feed

The authoritative browser API is the bounded `workflowRuns` namespace:

| Method | Result |
|---|---|
| `list` | One retained run-head page with process epoch, Session revision, total, and revision-bound cursor. |
| `detail` | Selected run head plus bounded phases, gate, error, and live editable path when present. |
| `members` / `memberDetail` | Paged member summaries and one bounded script-visible outcome with its child Session id. |
| `logs` | One revision-bound page from the retained log tail. |
| `result` | The selected terminal value projection and error, independent of list rows. |
| `artifacts` / `artifact` | Bounded scratch metadata and paged UTF-8 content without following links. |
| `control` | Pause, Resume, Stop, or Save, optionally compare-and-set against `expectedRevision`. |

`WorkflowRunHead` contains bounded counts, `allowedActions`, one overall revision, and collection-specific revisions. Opaque cursors are bound to the addressed run or Session and collection revision; a stale cursor fails so the caller can refetch. `WorkflowRunValueView` distinguishes `pending`, complete or truncated `available`, `not-produced`, and `evicted`.

`workflows/run-change` forwards only a revisioned `upsert` or `remove`, a Session `invalidate`, or `invalidate-all`; it never carries full members, logs, values, or artifacts. Each addressed change includes the supervisor epoch and next Session revision. Clients refetch after an epoch mismatch, revision gap, pagination-invalidating update, reconnect, or carrier queue overflow.

## Completion delivery and quiescence

A logical terminal transition claims one completion token and reserves its completion cohort before probing scratch or delivering. The complete notice is bounded by `completionNoticeMaxBytes` in UTF-8, preserves the `/workflows` recovery direction, and references `scratch/report.md` only when that regular file exists. Delivery targets the exact launching `Agent` object once. Below `maxConsecutiveCompletionWakes`, the first delivered notice in each cohort uses `followup` regardless of the owner's current status; the remaining notices in that cohort use `inject`. Later cohorts may open more turns until the limit, and only claimed human input resets the counter.

`whenOwnerQuiescent(agent)` reaches a fixed point over reserved starts, live attempts, durable terminal publication, completion delivery, and turns woken by completion. Needs-input, paused, and budget-limited runs are parked and count as quiescent. The wait rejects when completion-driven work continues beyond the configured wake bound.

## Config

| Key | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Accept new supervisor operations. |
| `dshHome` | Harness home | Base used when `runsRoot` is omitted. |
| `runsRoot` | `<dshHome>/workflow-runs` | Private run directories and per-Session manifests. |
| `saveScope` | `project` | Default definition destination (`project` or `user`). |
| `defaultAgentBudget` | `128` | Absolute child-launch budget for an unspecified run. |
| `maxAgentBudget` | `1024` | Maximum absolute budget, including budget-resume raises. |
| `completionNoticeMaxBytes` | `16384` | UTF-8 ceiling for the complete model-visible notice. |
| `maxConsecutiveCompletionWakes` | `3` | Completion cohorts allowed to open owner turns before claimed human input resets the count. |
| `memberOutcomeMaxBytes` | `131072` | Ceiling for an available member outcome or terminal result projection. |
| `maxRetainedRunsPerSession` | `256` | Retained manifest rows per Session. |
| `maxWorkflowNamesPerSession` | `4096` | Display-name ordinal entries per Session. |
| `maxMembersPerRun` | `2048` | Member summaries retained for one logical run; must cover `maxAgentBudget`. |
| `maxManifestBytes` | `8388608` | Serialized per-Session manifest ceiling. |
| `maxActiveRunsPerSession` | `64` | Published plus reserved nonterminal runs for one Session. |
| `maxActiveRunsGlobal` | `1024` | Published plus reserved nonterminal runs for the supervisor. |
| `maxLogLines` | `1000` | Retained log-tail lines per run. |
| `maxLogLineBytes` | `16384` | UTF-8 head retained from one line. |
| `maxLogTotalBytes` | `1048576` | Live retained log text per run. |
| `maxRetainedArtifactsPerRun` | `256` | Scratch names retained in artifact listings. |
| `maxArtifactNameBytes` | `255` | UTF-8 artifact-name ceiling. |
| `maxGateKindBytes` | `64` | UTF-8 gate-kind ceiling. |
| `maxGateMessageBytes` | `4096` | UTF-8 retained gate-message ceiling. |
| `maxScriptProjectionBytes` | `1048576` | Editable script read/write ceiling. |
| `remotePageDefault` | `50` | Default list-page item count. |
| `remotePageMax` | `200` | Maximum list-page item count. |
| `artifactChunkDefaultBytes` | `32768` | Default scratch text chunk size. |
| `artifactChunkMaxBytes` | `131072` | Maximum scratch text chunk size. |
| `remoteHeadTextMaxBytes` | `4096` | UTF-8 ceiling for text embedded in a bounded head/detail. |
| `remoteDetailMaxPhases` | `64` | Phase declarations returned in selected-run detail. |

Relational config checks reject a default budget above the maximum, a per-Session active limit above the global limit, a member limit below the maximum budget, a log-line limit above the total log limit, or a default page/chunk above its maximum.

## Model Experience

### Completion notice

#### What the model sees

The launch result belongs to [`dsh-tool-workflow`](../tool-workflow/README.md). After terminal publication and attempt cleanup, the supervisor adds one plugin-sourced user notice for the exact launching Agent: it names the display handle, reports completion/failure/stop, includes a bounded result or reason, points to `/workflows`, and names `scratch/report.md` when available. Pauses, human gates, and budget-limited attempts produce no completion notice.

#### Token effect

One bounded user text block is appended per terminal logical run. Child-model tokens remain outside the parent's retained context.

#### KV Cache effect

The notice is append-only after the reusable request prefix. A waking `followup` creates another request; an injected notice waits for another wake source.

## Known Limitations and Deferred Work

- Journal replay cannot make an external effect exactly once when its result was not committed before cancellation; effectful steps remain idempotent.
- Execution is process-local. Restart preserves bounded inspection, marks active rows Interrupted, and provides neither resume nor Save for those recovered rows.
- Retention may evict old terminal rows, member outcomes, log prefixes, and artifact names; the Remote reports those distinctions rather than implying complete history.
