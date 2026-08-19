# @deepseek-ai/dsh-workflow

[English](README.md) | 中文

由持有方负责的工作流引擎 seam（`ctx.workflowEngine`）。它校验并执行一段模型编写的编排脚本，公开一次活动尝试句柄，并发出分离的生命周期快照。它不负责已保存定义、分离逻辑身份、保留历史、浏览器控制或完成交付；[`dsh-workflow-supervisor`](../workflow-supervisor/README.md) 在一次或多次引擎尝试之上组合这些职责。

`@deepseek-ai/dsh-workflow-worker-thread` 是当前提供方。每次运行一个 worker thread，使同步脚本工作不阻塞 Host 事件循环并允许有界终止，但 worker 及其 vm 上下文都不是安全边界。

包根是 Host face。浏览器安全的身份、元数据、结果与仅供观察 payload 位于 `@deepseek-ai/dsh-workflow/types`；`WorkflowStartRequest`、`WorkflowJournalEntry` 与由持有方负责的 `WorkflowRun` 留在 Host face。

## 服务与尝试约定

当元数据、脚本语法、提供方路由、限制、journal 条目或累计花费无效时，`WorkflowEngine.start(request): WorkflowRun` 会在发布前拒绝。返回的句柄拥有一次引擎尝试。其 `result` 绝不 reject：脚本与基础设施失败以 `stopReason: 'error'` 兑现，取消则在提供方配置的宽限时间内以 `cancelled` 兑现。

持有方必须在每条路径上调用幂等的 `dispose()`。dispose 会取消未完成工作，并等待有界的脚本与子项清理。引擎插件卸载会阻止新启动，但不会撤销已接受句柄。

`WorkflowStartRequest` 携带脚本、元数据、args、父 Agent、可选提供方与 total-agent 限制、可选取消、scratch 目录、冒烟检查模式、累计 `initialAgentSpend` 和 `initialAgentSeq`，以及已提交 `WorkflowJournalEntry` 值。累计字段让逻辑运行 owner 跨尝试保持预算和唯一成员序号。每个 journal 条目通过类型、连续的提交发布序号、稳定 call id 和 fingerprint 标识一个已提交 Host 调用。并发调用在提交时确定顺序，因此已发布条目会跨尝试构成无空缺的严格递增序列；回放请求按该顺序提供条目。回放会返回已保留的子项或 scratch 读取结果、抑制重复观察器与 scratch 写入效果、恢复阶段状态、跳过已满足的人类 gate，并拒绝已变更调用。

`WorkflowRun` 公开 `id`、已校验 `meta`、不 reject 的 `result`、`cancel()`、活动 gate 的 `resume()` 与 `dispose()`。`WorkflowResult.agentsStarted` 是提供给该尝试并由它观察到的累计逻辑花费；`errorCode` 保留可机器路由的致命 `WorkflowError` 代码。

## 仅供观察的事件

每个 `workflow/*` payload 都是独立的无损 JSON 快照。监听器失败会被记录并隔离，任何监听器都无法修改引擎、持有方结果或另一监听器的 payload。

- `workflow/start` / `workflow/end` 为一次引擎尝试配对；结束事件省略结果值。
- `workflow/phase`、`workflow/log` 与 `workflow/gate` 报告脚本进度与停放。
- `workflow/agent-start` / `workflow/agent-end` 按尝试范围的成员序号为已发布子项配对。
- `workflow/journal-commit(info, entry)` 报告一个已提交 `WorkflowJournalEntry`；已回放调用不再发出新条目。

这些事件不授予取消、恢复或 dispose 权限。逻辑 owner 按尝试 id 关联它们，并决定持久化哪些内容。

## 失败纪律

致命 `WorkflowError` 代码总会逸出 `parallel()` 与 `pipeline()`，而不会变成普通逐项 `null`：解析与元数据失败、无效参数、不支持的选项或 schema、配置上限、提供方启动／结果故障、不可序列化值、journal 分歧和取消。子项若以非完成原因正常结算，仍属于普通子项失败，因此 `agent()` 返回 `null` 供脚本处理。

## 模型体验

间接影响，来自引擎启动的子 Agent 请求；消费方负责模型可见工具 schema、启动结果、持久记录与完成通知。

#### KV Cache 影响

无直接影响；模型可见消费方负责请求前缀与历史变化。

## 已知限制与延后工作

- 该 seam 拥有一次活动尝试，而不是分离运行注册表。需要后台生命周期的调用方应使用 `ctx.workflowSupervisor`，而不是留下无人负责的句柄。
- journal 为已提交 Host 调用结果建立检查点，不记录任意 JavaScript 状态或外部副作用。回放要求确定性调用身份，并要求未提交副作用保持幂等。
- 工作流脚本不能启动另一个工作流；它只能通过 `agent()` 组合子 Agent。
- 预算统计已准入子项启动数，不统计提供方 token。
