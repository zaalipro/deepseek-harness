# @deepseek-ai/dsh-command-workflows

English | [中文](README.zh.md)

Workflow host commands: `/workflow` launch/control grammar, `/create-workflow` authoring skill entry, and one launch command per saved definition name. Definition changes refresh the aliases; command-registry changes move collisions to or from a qualified alias. The Web client's [`ui-workflows`](../../client/ui-workflows/README.md) package owns `/workflows` as a client action.

## Grammar

```
/workflow <name> [<json-args>]
/workflow pause <display-name>
/workflow resume <display-name>
/workflow stop <display-name>
/workflow save <display-name>
```

`<json-args>` must be one JSON object (wrap arrays/scalars in a field). Launch is background — the command returns the display handle and points the user at `/workflows`. Pause/resume/stop/save address a RUN by display name, never an internal id. When a saved name collides with another command, that command keeps `/<name>` and the saved workflow is advertised as `/workflow-<name>`. The host repeats the `workflow-` prefix if the first qualified name is occupied; it also reserves every saved definition's bare name for that definition. The canonical `/workflow <name>` form always remains available.

Canonical and per-definition launches attribute their one top-level supervisor start through [`ctx.workflowRunRecorder`](../workflow-run-recorder/README.md). The same source-neutral durable Chat record is therefore available for Host command and root model-tool launches; controls and non-launch commands create no workflow record.

Examples:

```
/workflow review-changes {"target":"origin/main...HEAD"}
/workflow pause review-changes
/workflow resume review-changes
/workflow stop review-changes-2
/workflow save review-changes
```

In terminal and headless clients, bare `/workflow` prints this grammar and the examples. In Web, the existing bare-command decoration intercepts `/workflow` and opens the saved-definition picker instead; `/workflow ` with a trailing space still enters the full grammar as leading input.

## `/create-workflow`

`/create-workflow` steers a user-explicit skill gesture. The skill injection boundary loads the winning `create-workflow` body; the product-owned provider outranks same-name project and user skills, so workspace content cannot replace the authoring procedure behind this host command. Opening `/workflows` never reaches this Host plugin and therefore creates no `command/run` or `command/done` event.

## Model Experience

### `/create-workflow` command

#### What the model sees

One steered user message carries `/create-workflow` plus any user-provided detail into the next turn. The standard user-explicit skill boundary appends the bundled instructions to that step; the authoring conversation is model-owned while the command plane owns the entry itself. Every other command resolves in the command plane and never reaches the model.

#### Token effect

Bare `/workflow` and the control verbs add no model tokens. The client-owned `/workflows` action also adds no model tokens or Session events. `/create-workflow` costs the same history tokens as submitting its steered text directly; a launched run's completion notice arrives later through the supervisor.

#### KV Cache effect

The steered message is append-only conversation growth; the command catalog itself never enters a request.

## Known Limitations and Deferred Work

- The `/workflow save <name>` path writes to the default scope; per-command scope selection is deferred.
