# workflow/：动态工作流能力家族

[English](README.md) | 中文

本家族通过 subagent 运行由模型编写的编排工作流，并将通用工具与固定策略工具公开给模型。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`workflow/`](workflow/README.md) | 定义由持有方负责的引擎尝试与仅供观察的生命周期事件 | `ctx.workflowEngine` |
| [`workflow-worker-thread/`](workflow-worker-thread/README.md) | 在线程中运行工作流脚本 | 注册到 `ctx.workflowEngine` |
| [`workflow-registry/`](workflow-registry/README.md) | 发现已保存 `.workflow.json` 定义 | `ctx.workflows` |
| [`workflow-supervisor/`](workflow-supervisor/README.md) | 稳定逻辑运行、有界保留 manifest、Remote 控制与完成交付 | `ctx.workflowSupervisor` |
| [`workflow-run-recorder/`](workflow-run-recorder/README.md) | 把显式顶层启动归属到持久 Chat 记录 | `ctx.workflowRunRecorder` |
| [`workflow-user-questions/`](workflow-user-questions/README.md) | 从 Web 问题恢复精确的受监督 gate | 消费 `ctx.userQuestions` |
| [`command-workflows/`](command-workflows/README.md) | `/workflow`、`/create-workflow` 与 cwd 作用域的 `/<name>` 别名 | `ctx.commands` |
| [`tool-workflow/`](tool-workflow/README.md) | 向模型公开通用工作流执行 | 注册到 `ctx.tools` |
| [`tool-ralph/`](tool-ralph/README.md) | 公开使用全新 agent（智能体）的固定 Ralph 工作流 | 注册到 `ctx.tools` |

worker thread 将工作流执行与宿主事件循环隔离，但不构成安全边界。参见[动态工作流](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md)和 [Ralph 工具](../../.agents/notes/implemented/feature/2026-07-19-fresh-agent-ralph-workflow-tool.md)决策。

[工作流子系统参考](../../docs/subsystems/workflow.md)负责引擎与监督器类型、生命周期语义、有界浏览器 Remote 和事件。决策由[动态工作流](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md)、[已保存工作流监督器](../../.agents/notes/implemented/feature/2026-08-17-saved-workflow-supervisor.md)、[持久工作流 Chat 记录](../../.agents/notes/implemented/feature/2026-08-10-durable-workflow-runs-in-chat.md)与 [Ralph 消费方](../../.agents/notes/implemented/feature/2026-07-19-fresh-agent-ralph-workflow-tool.md) Agent Note 负责。
