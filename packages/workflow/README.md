# workflow/ — dynamic-workflow capability family

English | [中文](README.zh.md)

This family runs model-authored orchestration workflows over subagents and exposes general and fixed-policy tools to the model.

| Package | Role | ctx key |
|---|---|---|
| [`workflow/`](workflow/README.md) | Defines holder-owned engine attempts and observe-only lifecycle events | `ctx.workflowEngine` |
| [`workflow-worker-thread/`](workflow-worker-thread/README.md) | Runs workflow scripts in worker threads | registers on `ctx.workflowEngine` |
| [`workflow-registry/`](workflow-registry/README.md) | Discovers saved `.workflow.json` definitions | `ctx.workflows` |
| [`workflow-supervisor/`](workflow-supervisor/README.md) | Stable logical runs, bounded retained manifests, Remote controls, completion | `ctx.workflowSupervisor` |
| [`workflow-run-recorder/`](workflow-run-recorder/README.md) | Attributes explicit top-level launches to durable Chat records | `ctx.workflowRunRecorder` |
| [`workflow-user-questions/`](workflow-user-questions/README.md) | Resumes exact supervised gates from Web questions | consumes `ctx.userQuestions` |
| [`command-workflows/`](command-workflows/README.md) | `/workflow`, `/create-workflow`, and cwd-scoped `/<name>` aliases | `ctx.commands` |
| [`tool-workflow/`](tool-workflow/README.md) | Exposes general workflow execution to the model | registers on `ctx.tools` |
| [`tool-ralph/`](tool-ralph/README.md) | Exposes the fixed fresh-agent Ralph workflow | registers on `ctx.tools` |

Worker threads isolate workflow execution from the host event loop but are not a security boundary. See the [dynamic-workflow](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md) and [Ralph tool](../../.agents/notes/implemented/feature/2026-07-19-fresh-agent-ralph-workflow-tool.md) decisions.

The [workflow subsystem reference](../../docs/subsystems/workflow.md) owns engine and supervisor types, lifecycle semantics, the bounded browser Remote, and events. The [dynamic-workflows](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md), [saved-workflow supervisor](../../.agents/notes/implemented/feature/2026-08-17-saved-workflow-supervisor.md), [durable workflow Chat records](../../.agents/notes/implemented/feature/2026-08-10-durable-workflow-runs-in-chat.md), and [Ralph consumer](../../.agents/notes/implemented/feature/2026-07-19-fresh-agent-ralph-workflow-tool.md) Agent Notes own the decisions.
