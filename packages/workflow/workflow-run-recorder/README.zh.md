# @deepseek-ai/dsh-workflow-run-recorder

[English](README.md) | 中文

为受监督工作流提供与启动来源无关的持久 Chat 投影。消费者使用 `ctx.workflowRunRecorder.launch(session, start)` 显式包装一个独立展示的启动。记录器把 supervisor 的逻辑运行和成员生命周期归属到该精确 Session；回调之外的 supervisor 启动只进入仪表盘。

## 归属与生命周期

回调必须恰好启动一个顶层运行并返回其 `WorkflowLaunched` 值。`start()` 返回前同步发布的生命周期通过异步本地启动状态完成归属，因此发布不依赖返回 Promise 的竞态结果。稳定的逻辑运行 id 在暂停和恢复尝试之间始终作为记录键。根模型工具启动和 Host 命令启动使用此 API；嵌套工具分发和内部 supervisor 操作直接调用 supervisor。

记录器依次追加 `tool-workflow/run-start`、成对的 `tool-workflow/agent-start` 与 `tool-workflow/agent-end`，以及一个 `tool-workflow/run-end`。这些历史事件名继续作为现有 Chat 节点消费的持久 Session 词汇；它们并不表示模型工具拥有该记录。浏览器安全的载荷声明位于 `@deepseek-ai/dsh-workflow-run-recorder/types`。

Session 记录只用于观察，并采用尽力而为策略。第一次追加失败或不可能的生命周期会停用该逻辑运行的后续记录、写入警告，并留下空记录或合法的连续前缀，而不改变工作流执行。包 invariant 会在恢复和实时 Session 日志中拒绝重复开始、未配对的成员结束、仍有开放成员的终止，以及终止事件之后的更新。

## 重载与重启恢复

Agent 创建和记录器重载时，服务会折叠开放的持久前缀，并向 supervisor 请求一个原子的已保留生命周期快照。缺失的成员开始和结束会按序列顺序修复，并使用 supervisor 中精确的标签、阶段、子 Session 和终止状态。读取快照期间发布的生命周期会先缓冲，直到修复完成，从而避免热重载期间产生孤立的结束事件。

已保留的终止行会使用其持久停止原因关闭 Chat 记录。进程恢复会把活动清单转换为 Interrupted；已持久化的成员结果保持精确，而 Session 中开放但保留名单中缺失的成员会以 Cancelled 关闭。成功恢复后若 supervisor 行不存在，孤立前缀会以 Interrupted 关闭。基础设施或存储失败只会警告并释放已缓冲的实时事件，不会伪造终止状态。已经完整关闭的 Session 轨迹不会重新打开或重复记录。

## 组合

在 `workflow-supervisor` 之后、启动归属运行的消费者之前加载此单例。基础组合把它提供给 `tool-workflow` 和 `command-workflows`；`ui-workflow-run` 只消费其浏览器安全事件类型。

## 模型体验

### 持久记录

#### 模型可见内容

无。此服务只追加用于持久人类 Chat 渲染的观察型 `tool-workflow/*` Session 事件，不注册提示词、工具 schema、请求内容或模型可见结果。supervisor 拥有的完成投递保持独立。

#### Token 影响

不会增加模型请求 Token。

#### KV 缓存影响

此包不会改变模型请求或其可复用前缀。

## 已知限制与延后工作

- 记录不会与外部工作流效果组成事务；追加失败会有意留下不完整但合法的前缀，同时运行继续执行。
- 恢复只能修复 supervisor 和 Session 保留的生命周期。跨进程工作流执行仍不可恢复，并显示为 Interrupted。
