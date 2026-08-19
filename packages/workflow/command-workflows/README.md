# @deepseek-ai/dsh-command-workflows

English | [中文](README.zh.md)

Workflow slash commands: `/workflow` launch/control grammar, `/workflows` dashboard opener, `/create-workflow` authoring skill entry, and one launch command per saved definition name, refreshed on `workflows/change`.

## Grammar

```
/workflow <name> [<json-args>]
/workflow pause <display-name>
/workflow resume <display-name>
/workflow stop <display-name>
/workflow save <display-name>
```

`<json-args>` must be one JSON object (wrap arrays/scalars in a field). Launch is background — the command returns the display handle and points the user at `/workflows`. Pause/resume/stop/save address a RUN by display name, never an internal id. A launch colliding with a built-in keeps the built-in's bare name and stays reachable via `/workflow <name>`.

## `/workflows` and `/create-workflow`

`/workflows` returns a bare success; the browser dashboard listens for the local `command/executed` acknowledgment and opens the overlay. `/create-workflow` steers the model into the bundled `create-workflow` skill (registered here as a `user-invocable` runtime skill whose description names the command).

## Model Experience

### `/create-workflow` command

#### What the model sees

One steered user message naming the `create-workflow` skill (plus any user-provided detail) becomes the next turn's input; the authoring conversation is model-owned while the command plane owns the entry itself. Every other command resolves in the command plane and never reaches the model.

#### Token effect

Bare `/workflow`, `/workflows`, and the control verbs add no model tokens. `/create-workflow` costs the same history tokens as submitting its steered text directly; a launched run's completion notice arrives later through the supervisor.

#### KV Cache effect

The steered message is append-only conversation growth; the command catalog itself never enters a request.

## Known Limitations and Deferred Work

- The `/workflow save <name>` path writes to the default scope; per-command scope selection is deferred.