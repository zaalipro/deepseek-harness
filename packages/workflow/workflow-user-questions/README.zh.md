# @deepseek-ai/dsh-workflow-user-questions

[English](README.md) | 中文

受监督工作流的人类输入 Consumer。共享 base 组合会在 `ctx.workflowSupervisor` 与 `ctx.userQuestions` 旁挂载本插件。Web 提供活动的问题 provider，并在浏览器中展示 workflow gate；headless profile 没有 provider，因此请求会明确失败，workflow 保持停放，直到一次性 owner 处置时将其中断，而不会持续占用进程。

## 行为

每个当前的 `workflows/gate-request` 都会在运行所属的精确父 Session 中打开一个问题。问题显示工作流展示名与脚本提供的消息，并提供 **Resume workflow** 确认项。用户接受后，插件会以逻辑运行 id、引擎执行 id、gate id 和精确父 Agent 调用 `resumeGate()`，因此在停止、手动恢复、执行替换、所有者 teardown 或服务 teardown 之后才到达的答案无法恢复另一段执行。

回答后，`await_user()` 会越过其 gate 继续执行。`pause()` 会在恢复后再次执行同一次调用，因此只要条件没有变化，就会再次显示问题。关闭问题会让运行保持 **Needs input**；它不会停止或恢复工作流。

当目标 gate 不再是当前 gate 时，监督器的请求 signal 会撤回问题。插件 teardown 也会中止并等待所有待处理问题，之后其 fiber 才会完成。

## 模型体验

### 工作流输入确认

#### 模型看到的内容

`workflows/gate-request` 不会直接产生模型可见内容。问题显示期间工作流脚本保持停放；后续结果或完成通知由工作流工具与监督器负责。

#### Token 影响

直接 token 影响为零。确认不会追加到模型历史，其文本也不会返回脚本。

#### KV Cache 影响

没有影响。显示或回答问题都不会改变模型请求前缀。

## 已知限制与延后工作

- **答案仅用于确认，不向脚本提供数据**——`await_user()` 与 `pause()` 不返回答案值，因此脚本必须在启动前收集可变输入，并仅将这些 hook 用于人工检查点。
- **关闭后不会重建 composer 请求**——关闭问题会让运行保持停放；除非工作流发出另一个 gate occurrence，否则用户需要从面板或斜杠控制恢复。
