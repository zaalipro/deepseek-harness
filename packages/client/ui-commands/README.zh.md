# @deepseek-ai/dsh-client-ui-commands

[English](README.md) | 中文

客户端命令 API（`ctx.commandUi`）：以会话为 key 的命令目录缓存、带 `matchSpace`／`matchEnter` 决策钩子的 `/` 命令 source、四类派发（`action`／`execute`／`popupSelect`／`leadingInput`），以及面向业务包的客户端 contribution 或 Host decoration 注册。[Web 命令 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-25-web-command-surfaces-and-assembly.md) 记录了这项决策。

`src/client/contract.ts` 是固定的业务 API：`CommandUiContract.register(contribution)` 与 `decorate(decoration)` 是业务包消费的全部内容。contribution 是客户端自有命令，其 `CommandUiSpec` 可以是 `action` 或 `popupSelect`；与 Host 命令同名会明确报错。action 不经 `command.execute` 或 Session 事件运行客户端回调，按会话与命令名 single-flight，并且只在成功后消费精确的菜单 span 或裸 token。失败时保留 token，并在 composer 报错。结算只作用于准入它的确切会话 scope。popup 的选项数据自包含，外壳归本包所有。decoration 只为现有 Host 命令添加裸调用 popup：Host 保留目录行、参数 claim、执行与生命周期记账；被装饰的名字若不在会话目录中，就永不触发。带 `input` 的 Host descriptor 是 `leadingInput`，其余 Host 行是 `execute`。

`CommandDirectory`（`src/client/directory.ts`）是唯一的 wire 派生缓存，以会话为 key。普通会话通过 `command.list({sessionId})` 拉取，source 的 scope 出生 `warm` 钩子会预热该会话的缓存项。由目录寻址的可继续子代理会在客户端解析为空命令目录：`command.list` 绑定 Agent，若预热它，就会仅因查看持久化历史而激活子代理。缓存项由转发的 owner 事件 `commands/change` 软失效（重拉在途期间旧快照继续服务），也由转发的 `agent-preset/selected` 对该会话单独软失效（重组 agent 不产生任何注册，注册表级信号不会为它触发），由 `connection/reset` 硬失效，并以 epoch 把关，被取代的旧拉取永远无法覆盖更新的结果。`matchSpace` 只凭该缓存同步应答；`matchEnter` 在 SubmitAttempt 信号上强等缓存，预热失败即拒绝——`/` 开头的一行绝不会被静默降级为普通提示词。

目录解析完成后，每个非空 `/` 行都会留在命令平面。未知名称或向仅允许裸命令的命令传入参数时，草稿会保留，composer 会显示错误，且该行不会进入模型输入 sink；已知的 `leadingInput` 命令仍会把完整行提交给 Host，由命令自身的解析器处理错误参数。

已匹配的 Host `command.execute` 结算后，当前浏览器会发布本地 `command/executed(sessionId, name, result)`，供 Session 日志导出等浏览器副作用使用。其他客户端会收到持久命令节点，但不会收到此确认。监听器失败会被隔离，不能改变命令准入。客户端 action 从不发布此事件。

菜单查询会按顺序且不区分大小写地模糊匹配命令名的子序列。前缀排名最高；其余匹配项按分隔符边界优先、相邻字符优先、间隔越短越优先的规则排序，若仍同分，则以目录顺序和贡献项顺序打破平局。此行为只影响命令发现：space 和 Enter 仍要求命令名精确匹配。原理：[Web 斜杠命令模糊发现](../../../.agents/notes/implemented/feature/2026-08-04-web-slash-command-fuzzy-discovery.md)。

`PopupSelectController`（`src/client/popup.ts`）是不含界面的外壳状态：`PopupSelectView` 自行注册进 `conversation.input.overlay`（SlotMap key 归 ui-conversation 所有；本包只以 type-only 导入引入该声明——没有运行时依赖边）。壳是打开期间持有焦点的瞬态层；onSelect 之后的 token 片段消费在两条分支上都经 `consumeTokenSegment` 执行（菜单路径做 span CAS，回车路径做裸 token 相等比较），作用于接线层经 `bindDraft` 绑定的草稿表层。

`/client` 入口导出插件主体（`apply`／`inject`）、`CommandUiRuntime`、目录类和 popup 类及其状态类型，以及固定的约定类型；外层组件本身是 overlay 注册的内部实现。

## 模型体验

间接影响：Host `execute` 与 `leadingInput` handler 可能修改由其他包投影进下一次模型请求的状态；客户端 `action`、popup 渲染与 notice 本身不添加模型输入。

#### KV Cache 影响

无直接影响；该包既不组装也不发送提供方请求。Host 命令 handler 或业务回调可能改变其归属包对下一次请求的贡献，相应 token 与缓存行为由那些包拥有。

## 已知限制与暂缓事项

- 客户端 action 与脱离式准入失败只通知发起会话的 composer；若失败在该会话 scope 销毁后才结算，产品内不会保留 notice。
