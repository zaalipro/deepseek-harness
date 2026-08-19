# Run workflows

English | [中文](workflows.zh.md)

Saved workflows run multi-agent tasks in the background while you continue using Chat. This guide assumes the Web UI is running and you have opened a session in the workspace that owns the workflow.

## Create a workflow

Enter `/create-workflow` in Chat and describe the task you want to automate. The authoring turn guides the model through writing, smoke-testing, and saving the definition.

On Windows, the shipped local filesystem provider cannot perform the required no-follow reads and writes. Saved-definition discovery and saving, including `/create-workflow`, and workflow `script_path` launch fail with `FS_IO_ERROR`; configure another filesystem provider for those operations. Inline-script launches remain available.

## Launch a saved workflow

Start a saved definition by its name:

```
/workflow release-audit
```

Every saved definition also gets a launch alias. When its name is free, the alias is the shorter form:

```
/release-audit
```

When a name conflicts with another command, that command keeps the bare name and the saved workflow uses `/workflow-release-audit`; the slash menu adds another `workflow-` prefix if that name is also occupied. Aliases update as definitions and commands change. Every form launches the run in the background and returns its display name. The launch also opens a durable workflow record in Chat that follows member statuses and survives refresh; use the dashboard for logs, results, artifacts, and controls. `/workflow <name>` always remains available; it also accepts one optional JSON object after the name.

## Monitor a run

Enter `/workflows` to open the dashboard for the current session. `/workflows` is a browser action, so opening it does not submit a Host command or add a Host-command row to Chat.

- **Runs** lists active and retained historical runs with their status, phase, agent budget, and elapsed time.
- **Agents** lists the workflow members. Select one to inspect its script-visible outcome or open its child session when available.
- The inspector provides **Agent outcome**, **Logs**, **Run result**, and **Artifacts** views. Artifact content is loaded on demand from the run's scratch files.

## Control a run

The dashboard shows only the actions valid for the selected run. Use a button or its unmodified keyboard shortcut while focus is outside a text field:

| Action | Shortcut | Effect |
|---|---|---|
| **Pause** | `P` | Stop the current attempt after cleanup and keep the logical run available to resume. |
| **Resume** | `R` | Continue a paused or input-gated run. |
| **Stop** | `X` | End the logical run permanently. |
| **Save** | `S` | Publish the editable script as a saved project or user definition. Bundled, numbered, and recovered runs cannot be saved. |

Press `Esc` to close the dashboard.

### Resume after an agent-budget limit

A **Budget limited** run cannot resume from the dashboard. Ask the model to resume that run; it must call the `workflow` tool with `resume_from_run_id` and an `agent_budget` higher than the run's current absolute budget. The configured maximum still applies.

## Recovery and retention

After a process restart, formerly active runs recover as terminal **Interrupted** rows for inspection. They cannot resume or be saved because cross-process resume is unavailable.

Run history is bounded. Retention may remove older terminal runs and member outcomes. In the dashboard, **Logs** reports how many earlier lines were evicted from the retrievable window, and **Artifacts** reports how many scratch-file names were omitted from the retained roster. These notices distinguish retention loss from a run that produced no data.
