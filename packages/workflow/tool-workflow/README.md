# @deepseek-ai/dsh-tool-workflow

English | [中文](README.zh.md)

The model-facing **`workflow` tool** launches JavaScript orchestration scripts through `ctx.workflowSupervisor`. This package owns the model-facing schema, source resolution, and immediate launch result. It attributes root launches to [`ctx.workflowRunRecorder`](../workflow-run-recorder/README.md), whose source-neutral recorder owns the durable top-level Chat projection. Definition discovery, background execution, pause/resume, caps, retained results, and completion delivery remain behind the [workflow capability](../workflow/README.md).

## What the model sees

Exactly one launch source is required: `name` for a saved definition, `script` plus `meta` for an inline plain-JavaScript body, or `script_path` for a definition envelope or editable script. Saved names and relative file paths resolve from the calling Session's `cwd`; `script_path` uses `ctx.fs.readBytesNoFollow`, so final-link rejection, regular-file validation, and the bounded read share one provider-owned descriptor or equivalent object. Optional `args` is the JSON object exposed as the `args` global. `validate_only` smoke-checks one canned-host path without creating a run. `resume_from_run_id` resumes one same-process logical run and accepts a higher `agent_budget` only when the previous attempt reached its cap. The plugin also contributes a `tool:<toolName>` system-prompt section carrying the usage policy: use the tool only on an explicit workflow or large-orchestration request; prefer plain subagent calls for one or two delegations.

## Lifecycle

Launch is background work. A successful call returns `{ status: "started", displayName, runId, script_path? }` after the supervisor publishes the run; the parent turn does not await script completion. The supervisor owns cancellation, attempt disposal, completion delivery, and retained dashboard data. `validate_only` instead waits for the smoke-check result and creates no run, Chat node, or dashboard row.

For a root transport execution (`exec.parent` absent), the tool attributes its one supervisor start to the calling Agent's Session through `ctx.workflowRunRecorder.launch(...)`. The recorder projects the supervisor's logical lifecycle into that Session: the stable supervised run id opens one `tool-workflow/run-start`; logical member events from every pause/resume attempt append to that record; one `tool-workflow/run-end` arrives only after terminal attempt disposal. A paused, needs-input, or budget-limited attempt does not close the record. Process or owner interruption closes it with `stopReason: "interrupted"`. Nested transport calls execute normally but write no workflow record. The first failed Session append disables later recording for that run, emits one warning, and leaves either no record or a legal continuous prefix without changing execution.

The browser-safe `@deepseek-ai/dsh-workflow-run-recorder/types` subpath owns these four log-only event payloads and their `SessionEventMap` declaration. The recorder package invariant rejects duplicate starts, unpaired members, terminal events with open members, and updates after run-end on both cold load and live append while accepting missing terminal suffixes.

## Render intent

Decided up front (per the [render-intent Agent Note](../../../.agents/notes/implemented/architecture/2026-07-02-tool-render-intent-union.md)): a `generic` card titled from `args.name`, then `args.meta?.name`, then the fixed `workflow` fallback (presentation is a pure function of args and does not ask a provider to parse); the script text rides as `rawInput`. The result keeps the generic card.

## Config

| Key | Default | Meaning |
|---|---|---|
| `toolName` | `workflow` | The model-facing tool name to register. |
| `maxResultChars` | `50000` | Rendered validate-only result ceiling; longer JSON is truncated with a notice. |
| `maxDefinitionBytes` | `1048576` | Maximum UTF-8 bytes accepted from one inline script or `script_path`. |

## Model Experience

### System prompt

#### What the model sees

Every parent request in this plugin's registration scope receives the workflow guidance below. A scoped tool restriction can hide the schema without removing this independently registered guidance.

##### Workflow guidance

```markdown
Use the <toolName> tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.
```

#### Token effect

Small fixed guidance cost per request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Activation or disposal may invalidate reuse from this prompt section.

### Tool schema

#### What the model sees

When visible, the generated default [`workflow` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-workflow) carries the complete JavaScript hook and metadata contract; `toolName` can rename the definition, and the model submits script, metadata, and optional args.

#### Token effect

Substantial fixed schema cost on each request where the tool is visible.

#### KV Cache effect

Prefix-stable while `toolName`, definition, and visibility are unchanged. Renaming, plugin lifecycle, or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

The full model-written script, metadata, and args remain in the assistant tool call. A live launch renders compact JSON containing `status`, `displayName`, logical `runId`, and optional `script_path`; resume renders the same stable identity with `status: "resumed"`. The Host's slash-command acknowledgement remains human-readable and UUID-free. The supervisor later posts the terminal result or scratch report independently. A validate-only call reports the bounded smoke-check result. A call without an owning agent fails with `workflow tool requires a calling agent (exec.agent was undefined)`. Intermediate child messages are omitted.

#### Token effect

Call tokens can be large and remain until compaction. Validate-only rendering is capped by `maxResultChars`; child-model tokens are separate from the parent's retained context.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **`args` must be an object** — callers wrap top-level arrays or scalars in a field.
- **Validate-only follows one canned path** — it does not enumerate branches or exercise live child tools.
- **Cross-process resume is unavailable** — active runs recovered after restart are terminal Interrupted rows.
- **Durable records are top-level and observational** — nested transport dispatches are not recorded, and a recording failure intentionally degrades to an incomplete prefix rather than changing execution.
- **Local Windows file sources are unavailable** — the local provider cannot safely implement final-component no-follow reads on Windows, so `script_path` and registry-backed `name` sources fail loud with `FS_IO_ERROR`; inline `script` sources remain available.
