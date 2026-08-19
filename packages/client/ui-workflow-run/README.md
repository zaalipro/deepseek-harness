# @deepseek-ai/dsh-client-ui-workflow-run

English | [中文](README.zh.md)

The browser plugin that reconstructs durable top-level workflow runs as independent Chat nodes. It consumes the four historical `tool-workflow/*` Session events owned by [`dsh-workflow-run-recorder`](../../workflow/workflow-run-recorder/README.md), registers one `ConversationNodeDefinition`, and renders through the keyed `conversation.chat.node` slot without changing the existing workflow tool card.

## Durable state and replay

`tool-workflow/run-start` creates one Context keyed by `runId`; member starts, member endings, and the run ending update that Context in log order. A history tail containing only updates remains pending until an older page supplies the unique start, after which prepend, complete replay, and live append produce the same state. A background run remains running when its launching Turn or Step closes and settles only from its logical `tool-workflow/run-end` event.

Phase groups come only from members that actually started. Exact phase strings share a group, an omitted phase is distinct from the empty string, and settlement changes status without removing or reordering members.

## Presentation and navigation

The run and each phase derive disclosure control from their current lifecycle facts. The run stays expanded while its own status is running, failed, cancelled, or interrupted, or while any phase contains such a member; each affected phase also stays expanded. Forced-open headers are static expanded rows without button, keyboard, or `aria-expanded` promises. A phase folds once when every member completes, and the run folds once when it and every phase complete. Each clean layer then exposes an ordinary disclosure control whose local choice survives clean rerenders; new activity takes control again, and a remount derives the initial state from current data. The run uses a 32-pixel `--dsw-alias-bg-module-platform` row with persistent right/down chevrons and an inline state dot plus status text, without a badge. Phases use 32-pixel disclosure rows with title and member count in the flexible main area and a fixed precise aggregate-status tail, without another dot. Members use a 16-pixel dot slot, a truncating name area, and a fixed 64-pixel status column.

A running or settled member opens its child Session only when the current direct-child catalog contains an exact healthy one-shot entry for that child under the workflow's parent Session. Underlined member text is the only visible navigation affordance; keyboard focus draws a two-pixel business-primary ring around the name area, while status copy keeps the member's actual state. The injected action refreshes and rechecks that catalog before opening the addressed child. Diagnostic, continuable, wrong-parent, missing, and stale entries remain non-interactive; the component never falls back to an unchecked ordinary `sessions.open(id)` call.

## Composition

The package registers its Definition, locale dictionary, and `workflow-run` renderer as Cordis effects. Removing the client entry retracts all three contributions. The shipped Web bundle includes the plugin after `ui-conversation` and `ui-tool`.

## Model Experience

None, as this package renders durable Session facts for humans and adds no prompt, tool schema, request content, or model-visible result.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Only launches explicitly attributed through `ctx.workflowRunRecorder` produce these records; nested/internal launches and direct `WorkflowEngine` consumers do not.
- The node shows run, phase, member identity, and status only; scripts, outputs, errors, logs, usage, static topology, and controls remain outside this surface.
