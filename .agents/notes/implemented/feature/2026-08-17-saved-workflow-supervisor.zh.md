# Agent Note: 已保存的工作流、斜杠命令与后台运行监督器

Status: implemented

[English](2026-08-17-saved-workflow-supervisor.md) | 中文

## 问题

动态工作流 seam 提供了由持有方负责的脚本执行，但普通工具会在发起轮次中收集每次运行。定义无法作为文件共享，人类没有命令入口，浏览器也没有用于后台工作的有界控制与检查 API。可用的分离生命周期还必须区分一个逻辑运行与它的各次引擎尝试，在进程重启后保留可检查历史而不声称执行得到恢复，并把完成结果交付给精确的发起 Agent，同时不能制造无界的模型轮次序列。

## 决策

已保存定义、会话所属的监督器、Host 启动命令，以及浏览器所属的 dashboard 在 Web 组合中形成一条工作流产品路径。

### 已保存定义

`dsh-workflow-registry` 从 bundled、project（`.dsh/workflows`）和 user（`<dshHome>/workflows`）根目录发现包含 `{ meta, script }` 的 `<name>.workflow.json` 封套，优先级为 bundled > project > user。元数据按数据校验，文件名必须匹配 kebab-case 的 `meta.name`，未知字段或格式错误定义会连同所属路径明确失败。注册表每次 lookup 都会重新读取；监视器发出的 `workflows/change` 是刷新提示，而不是唯一的新鲜度来源。project 与 user 保存通过文件系统能力执行，并带链接拒绝和并发发布保护。

### 逻辑运行与引擎尝试

`dsh-workflow-supervisor` 拥有每个已接受的活动 `WorkflowRun`，因此 `start()` 在持久发布后返回稳定逻辑 `runId`、会话唯一显示句柄和可编辑脚本路径。逻辑 id 跨越暂停、gate 和预算恢复尝试；每次引擎尝试保留自己独立的引擎运行 id。成员序号和累计 `agentsStarted` 跨尝试继续增长。`WorkflowJournalEntry.ordinal` 记录一个跨尝试且无空缺的提交发布顺序，而稳定调用身份及其请求指纹决定回放对应关系，而不会再次启动同一个子项。

某工作流名称的首个保留运行直接使用该名称作为显示句柄；后续运行使用单调编号句柄。每个运行目录包含私有 `script.js` 投影和 `scratch/`。`pause` 会先取消并 dispose 当前尝试，再带 journal 停放逻辑运行。`await_user()` 保持当前 worker 停放，并在带尝试 fence 的问题得到确认后继续；`pause()` 则在恢复后重新触发其条件。预算受限运行只有在调用方提供更高的绝对预算时才能恢复；普通暂停或等待输入的运行会拒绝预算变化。`stop` 发布一次终态取消。`save` 通过定义注册表读取有界的可编辑投影，并拒绝 bundled 或带编号运行。

### 保留 manifest 与有界 Remote 读取

每个 Session 都有一个有界 manifest 名册，保存显示名序号、运行摘要、预算与成员摘要、日志尾部、gate 展示、一个有界结果投影和 scratch 工件元数据。恢复返回前，会把所有原活动行提交为终态 `interrupted`。恢复只还原检查状态，不还原 `Agent`、引擎尝试、脚本、args、journal 或恢复权限；因此恢复行没有可编辑 `scriptPath`，也不能保存。保留驱逐会删除匹配的内存终态行和运行目录，因此恢复数据与活动名册不会产生重复行。

Typert `workflowRuns` Remote 是浏览器的权威来源。`list` 返回带进程 epoch 与逐 Session revision 的有界分页；`detail`、`members`、`memberDetail`、`logs`、`result`、`artifacts` 和 `artifact` 按需加载选中数据；`control` 通过可选的预期运行 revision 检查执行 Pause、Resume、Stop 或 Save。不透明 cursor 绑定到一个 collection revision，过期时失败。列表行只含有界计数、collection revision 和 `allowedActions`，绝不含完整成员或输出。脚本可见的成员结果与最终值区分 `pending`、`available`、`not-produced` 和 `evicted`；scratch 文件按 UTF-8 安全的分页块读取。

`workflows/run-change` 携带一项 `upsert` 或 `remove`、逐 Session 的 `invalidate`，或载体丢弃已排队 Session 变更时的 `invalidate-all`。每个有地址的变更都携带 epoch 与下一个 Session revision，因此客户端遇到缺口或 epoch 不匹配时会重新读取，而不是合并不确定状态。

### 完成交付与完全停稳

一次终态发布最多为精确的发起 Agent 对象产生一条受 UTF-8 字节限制的通知。交付前已预留的运行会加入同一完成批次。在低于连续完成唤醒上限时，每个批次中第一条交付的通知都使用 `followup`，不受所有者当前状态影响，该批次其余通知使用 `inject`；后续批次可在达到上限前继续打开轮次。只有已认领的人类输入会重置该所有者的唤醒计数。通知会在字节上限内保留 dashboard 恢复指引，并在存在时保留约定的 `scratch/report.md` 引用。

`whenOwnerQuiescent()` 会对已预留启动、运行中尝试、持久终态发布、完成交付和由完成唤醒的轮次求固定点。人类 gate、用户暂停和预算受限运行属于已停放状态，因此视为完全停稳。这使 one-shot 组合可以等待所属后台工作，而不会把已停放运行当作活动执行。

### 命令、持久 Chat 与 dashboard

`dsh-command-workflows` 拥有 `/workflow`、`/create-workflow` 和 cwd 作用域的已保存定义别名。现有命令保留冲突的裸名；工作流别名会重复添加 `workflow-` 限定直到名称可用，同时每个定义保留自己的裸名，`/workflow <name>` 仍是规范形式。定义或命令注册表变化时会重新协调别名。`/create-workflow` 通过标准 user-explicit skill 路径进入确定性的 bundled 编写 skill。`/workflows` 是浏览器所属的 client action：打开 overlay 不执行 Host 命令，也不追加命令生命周期行。

`dsh-workflow-run-recorder` 为每条人类启动命令或根 `workflow` 工具调用恰好包装一次显式归因的 supervisor 启动，并以稳定逻辑运行 id 投影一条持久 Chat 生命周期。嵌套、内部与未归因启动仅出现在 dashboard。来自每次引擎尝试的成员事件都会加入同一记录，而暂停、输入 gate 或预算停止不会关闭它。浏览器的 `WorkflowRunsController` 惰性订阅选中的 Session，应用带 revision 的有界摘要，遇到缺口时重新读取，并把详情与输出留作按需访问。dashboard 控制直接调用 typed Remote。子 transcript 链接会刷新直接子项目录，并且仅打开精确、健康的 one-shot 子项，无论该子项仍在运行还是已经结算。

## 验证

包级覆盖钉住 manifest 解码与保留、恢复为 interrupted、重复行驱逐、跨尝试的稳定逻辑身份、累计预算与 journal 回放、过期控制与 cursor、分页值与工件读取、gate fence、精确所有者完成交付、唤醒上限、所有者完全停稳、显式命令与工具归因，以及孤立 Chat 记录的重启协调。运行时测试钉住 baseline／change 顺序、epoch 与 revision 缺口、重连与移除 fence，以及按需操作。组装后的工作流回放钉住后台启动、后续完成轮次与持久逻辑生命周期；Web 冒烟测试钉住 client 所属的 `/workflows` action 和真实 dashboard 控制。

## 曾考虑的替代方案

**整集 `session/workflow-runs` 帧。** 被拒绝，因为完整名册与输出会随保留历史增长，并迫使每项变更都经过一个 eager 镜像。有界摘要加带 revision 的失效通知能保持转发事件很小，并把昂贵 collection 变成显式读取。

**让 `/workflows` 与 dashboard 控制执行 Host 命令。** 被拒绝，因为打开浏览器视图不是 Host 命令，而且控制已有经过授权、带 revision 检查的 Remote。由浏览器负责可避免错误的命令 transcript 行，也避免为同一操作维护第二个解析器。

**从 manifest 恢复活动执行。** 被拒绝，因为持久视图不包含正确继续所需的活动 Agent、引擎资源、不可变输入或已提交回放 journal。恢复报告中断并保留检查能力，而不会凭空制造恢复权限。

**按 Session id 交付完成或允许无限 follow-up。** 被拒绝，因为替换后的 Agent 不应继承另一个实例的完成，而且连续完成批次可能递归消耗轮次。按精确对象路由、每批次仅唤醒一次并限制连续唤醒，在交付与无界循环之间取得明确约束。

## 后果

工作流成为带共享定义、可后台、可检查、可控制的逻辑运行，并拥有持久保留视图。代价是显式 revision、保留和恢复机制，以及逻辑身份与尝试身份的分离。journal 回放无法为取消前尚未提交结果的外部副作用提供恰好一次保证，因此有副作用的工作流步骤仍须保持幂等。进程重启会保留有界检查数据并把活动工作标记为 Interrupted；它不支持跨进程恢复，也不能保存恢复行的脚本投影。
