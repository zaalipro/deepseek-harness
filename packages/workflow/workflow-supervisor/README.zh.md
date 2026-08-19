# @deepseek-ai/dsh-workflow-supervisor

[English](README.md) | 中文

会话所属的工作流监督（`ctx.workflowSupervisor`）：在持有方负责的引擎尝试之上提供稳定逻辑运行、后台启动、同进程 journal 恢复、有界保留 manifest、`workflowRuns` Typert Remote、精确所有者完成交付与所有者完全停稳。

## 身份与生命周期

`start()` 成功时先持久发布一个逻辑运行，再返回 `{ status: 'started', displayName, runId, scriptPath }`，不会等待脚本完成。逻辑 `runId` 在暂停、人类 gate 与预算恢复尝试之间保持稳定；底层每个 `WorkflowRun.id` 只标识一次引擎尝试。成员序号、journal 调用身份与 `agentsStarted` 在整个逻辑运行内累计。

显示句柄在一个 Session 的保留历史中唯一。某定义的首个运行使用 `meta.name`；后续运行使用单调编号的 `meta.name-2`、`meta.name-3` 等。每个新运行在 `runsRoot` 下获得私有目录，包含可编辑 `script.js` 与 `scratch/`。

- `pause(displayName)` 取消并 dispose 当前尝试，然后带已提交 `WorkflowJournalEntry` 停放逻辑运行。恢复会重新执行不可变脚本与 args，把累计花费和序号状态传给引擎，并回放匹配的已提交调用而不再次花费预算。
- `await_user()` 停放活动尝试，并在带尝试 fence 的 gate 得到确认后越过它继续；`pause()` 在恢复后重新触发其条件。过期 gate 答案无法恢复替换后的尝试。
- 预算受限运行只有在获得更高的绝对 `agent_budget` 时才能恢复，并受 `maxAgentBudget` 限制。其他停放状态会拒绝变更预算。
- `stop()` 发布一次终态取消。所有者或服务 dispose 会在尝试清理后发布 Interrupted。
- `save()` 读取有界的可编辑投影，再通过 `ctx.workflows` 原子写入 project 或 user 定义。bundled 定义、带编号句柄，以及没有活动 `scriptPath` 的恢复行都不能保存。
- `validate()` 收集一条罐装 Host 引擎路径，不创建逻辑运行、子项、dashboard 行、manifest 或持久 Chat 记录。

## 保留 manifest 与恢复

存储最多保留每个 Session `maxRetainedRunsPerSession` 行，并保留有界显示名序号。manifest 包含运行摘要、预算、成员摘要、UTF-8 有界日志尾部、gate 展示、有界终态结果投影，以及 scratch 产物名称与字节数。大型成员结果只存在于进程内，恢复后显示为 `evicted`；从未产生的值保持 `not-produced`，而不是 JSON `null`。

恢复会直接寻址一个 Session manifest。返回前，它把所有原活动状态提交为终态 Interrupted。恢复只还原检查状态，不还原 `Agent`、引擎尝试、脚本、args、journal、问题或恢复权限。保留驱逐会删除对应的内存终态行及其运行目录，因此后续恢复不会复制已经加载的行。

`recordingSnapshot(agent, runId, signal?)` 是供事件 recorder 使用的 Host-only 协调读取。它首先恢复精确 Agent 的 Session，再返回一个原子且受保留上限约束的运行、成员与可选终态结果生命周期快照。只有成功恢复后仍不存在该运行时才返回 `undefined`；I/O、损坏、取消，以及已知属于另一 Session 的运行都会拒绝。该快照绝不跨越浏览器 wire。

## 浏览器 Remote 与变更 feed

权威浏览器 API 是有界的 `workflowRuns` namespace：

| 方法 | 结果 |
|---|---|
| `list` | 一页保留运行摘要，带进程 epoch、Session revision、总数与绑定 revision 的 cursor。 |
| `detail` | 选中运行摘要，加有界 phase、gate、错误，以及存在时的活动可编辑路径。 |
| `members` / `memberDetail` | 分页成员摘要，以及一个有界脚本可见结果和它的子 Session id。 |
| `logs` | 来自保留日志尾部、绑定 revision 的一页。 |
| `result` | 与列表行分离的选中终态值投影与错误。 |
| `artifacts` / `artifact` | 有界 scratch 元数据，以及不跟随链接的分页 UTF-8 内容。 |
| `control` | Pause、Resume、Stop 或 Save，可选择以 `expectedRevision` 作 compare-and-set。 |

`WorkflowRunHead` 包含有界计数、`allowedActions`、一个总体 revision 与各 collection revision。不透明 cursor 绑定到所寻址的运行或 Session 及 collection revision；过期 cursor 会失败，让调用方重新读取。`WorkflowRunValueView` 区分 `pending`、完整或截断的 `available`、`not-produced` 与 `evicted`。

`workflows/run-change` 只转发带 revision 的 `upsert` 或 `remove`、Session `invalidate` 或 `invalidate-all`；它绝不携带完整成员、日志、值或产物。每项有地址的变更都包含监督器 epoch 与下一个 Session revision。客户端遇到 epoch 不匹配、revision 缺口、使分页失效的更新、重连或载体队列溢出时重新读取。

## 完成交付与完全停稳

逻辑终态转换会在探测 scratch 或交付前认领一个完成 token，并为它预留完成批次。完整通知受 `completionNoticeMaxBytes` UTF-8 限制，保留 `/workflows` 恢复指引，并且仅在 `scratch/report.md` 是普通文件时引用它。通知只向精确的发起 `Agent` 对象交付一次。在低于 `maxConsecutiveCompletionWakes` 时，每个批次中第一条交付的通知都使用 `followup`，不受所有者当前状态影响；该批次其余通知使用 `inject`。后续批次可在达到上限前继续打开轮次，且只有已认领的人类输入会重置该计数。

`whenOwnerQuiescent(agent)` 对已预留启动、活动尝试、持久终态发布、完成交付和由完成唤醒的轮次求固定点。等待输入、暂停与预算受限运行属于已停放状态，因此视为完全停稳。如果由完成驱动的工作超过已配置唤醒上限，等待会拒绝。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `enabled` | `true` | 接受新的监督器操作。 |
| `dshHome` | Harness home | 省略 `runsRoot` 时使用的基准。 |
| `runsRoot` | `<dshHome>/workflow-runs` | 私有运行目录与逐 Session manifest。 |
| `saveScope` | `project` | 默认定义目标（`project` 或 `user`）。 |
| `defaultAgentBudget` | `128` | 未指定运行的绝对子项启动预算。 |
| `maxAgentBudget` | `1024` | 绝对预算上限，包括预算恢复提高。 |
| `completionNoticeMaxBytes` | `16384` | 完整模型可见通知的 UTF-8 上限。 |
| `maxConsecutiveCompletionWakes` | `3` | 已认领的人类输入重置计数前，可打开所有者轮次的完成批次数。 |
| `memberOutcomeMaxBytes` | `131072` | 可用成员结果或终态结果投影上限。 |
| `maxRetainedRunsPerSession` | `256` | 每个 Session 的保留 manifest 行数。 |
| `maxWorkflowNamesPerSession` | `4096` | 每个 Session 的显示名序号条目数。 |
| `maxMembersPerRun` | `2048` | 每个逻辑运行保留的成员摘要数；必须覆盖 `maxAgentBudget`。 |
| `maxManifestBytes` | `8388608` | 序列化逐 Session manifest 上限。 |
| `maxActiveRunsPerSession` | `64` | 单个 Session 已发布加已预留的非终态运行数。 |
| `maxActiveRunsGlobal` | `1024` | 监督器已发布加已预留的非终态运行数。 |
| `maxLogLines` | `1000` | 每次运行保留的日志尾部行数。 |
| `maxLogLineBytes` | `16384` | 单行保留的 UTF-8 头部。 |
| `maxLogTotalBytes` | `1048576` | 每次运行活动保留的日志文本。 |
| `maxRetainedArtifactsPerRun` | `256` | 产物列表保留的 scratch 名称数。 |
| `maxArtifactNameBytes` | `255` | UTF-8 产物名称上限。 |
| `maxGateKindBytes` | `64` | UTF-8 gate kind 上限。 |
| `maxGateMessageBytes` | `4096` | UTF-8 保留 gate 消息上限。 |
| `maxScriptProjectionBytes` | `1048576` | 可编辑脚本读写上限。 |
| `remotePageDefault` | `50` | 默认列表分页条目数。 |
| `remotePageMax` | `200` | 最大列表分页条目数。 |
| `artifactChunkDefaultBytes` | `32768` | 默认 scratch 文本块大小。 |
| `artifactChunkMaxBytes` | `131072` | 最大 scratch 文本块大小。 |
| `remoteHeadTextMaxBytes` | `4096` | 嵌入有界摘要／详情的文本 UTF-8 上限。 |
| `remoteDetailMaxPhases` | `64` | 选中运行详情返回的 phase 声明数。 |

关联配置检查会拒绝：默认预算高于最大值、逐 Session 活动上限高于全局上限、成员上限低于最大预算、单行日志上限高于总日志上限，或默认分页／分块大于对应最大值。

## 模型体验

### 完成通知

#### 模型看到的内容

启动结果属于 [`dsh-tool-workflow`](../tool-workflow/README.md)。终态发布与尝试清理后，监督器会为精确的发起 Agent 添加一条插件来源用户通知：它命名显示句柄，报告完成／失败／停止，包含有界结果或原因，指向 `/workflows`，并在可用时命名 `scratch/report.md`。暂停、人类 gate 与预算受限尝试不会产生完成通知。

#### Token 影响

每个终态逻辑运行追加一个有界用户文本块。子模型 token 不进入父级保留上下文。

#### KV Cache 影响

通知仅追加在可复用请求前缀之后。唤醒型 `followup` 会产生另一个请求；注入通知等待其他唤醒来源。

## 已知限制与延后工作

- 如果外部副作用的结果在取消前尚未提交，journal 回放无法让它恰好执行一次；有副作用的步骤仍须保持幂等。
- 执行只存在于进程内。重启会保留有界检查状态、把活动行标记为 Interrupted，并且不为这些恢复行提供 resume 或 Save。
- 保留机制可能驱逐旧终态行、成员结果、日志前缀和产物名称；Remote 会报告这些差异，而不会暗示历史完整。
