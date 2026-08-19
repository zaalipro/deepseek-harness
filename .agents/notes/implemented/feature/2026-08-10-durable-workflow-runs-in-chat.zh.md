# Agent Note: Chat 中的持久工作流运行

Status: implemented

[English](2026-08-10-durable-workflow-runs-in-chat.md) | 中文

## 问题

普通工作流工具行拥有模型调用与最终工具结果，但这两条记录无法说明哪些成员真正开始、如何分组、各成员是完成、失败还是取消，也无法说明进程停止时哪些工作尚未结束。实时 `workflow/*` 事件只存在于当前进程，因此刷新或稍后重新打开 Session 会丢失运行历史。

Web Client 已经能够从持久 Session 事件组装由业务拥有的 Conversation Node。工作流历史因此需要：能够把一次已接受运行关联到调用 Session 的生产方、作为前缀也始终有意义的最小持久协议，以及不夺走现有工具卡所有权的独立 renderer。

## 决策

`dsh-workflow-run-recorder` 把一条显式归因的顶层逻辑运行投影到调用 Agent 的 Session。人类工作流命令与根 workflow 工具调用各自恰好包装一次 supervisor 启动；嵌套、内部与未归因的启动仅出现在 dashboard。`tool-workflow/run-start` 记录稳定的受监督 `runId` 与显示名称；来自每次引擎尝试的匹配逻辑成员事件记录累计成员序号、精确标签、可选精确阶段、子 Session id 与结果。暂停、等待输入与预算受限结算会让记录保持开放；只有终态尝试 dispose 后，`tool-workflow/run-end` 才恰好一次记录逻辑停止原因。发起后台工作的 Turn 或 Step 关闭不会中断它。

记录只供观察。任一次 Session append 首次失败后，本运行会停止所有后续写入、只记录一次告警，并且绝不改变取消、结果映射或 dispose。每种失败位置都留下空记录或合法连续前缀：已开始运行可以缺少后续成员或运行终点，已开始成员也可以缺少成员终点。包 invariant 会在冷加载与实时 append 时拒绝重复运行 start、无效或复用的正成员序号、无配对或重复成员 end、仍有开放成员时结束运行，以及运行结束后的任何更新。

workflow 包通过 `@deepseek-ai/dsh-workflow/types` 提供浏览器安全的运行与观察词汇；包含活跃 `Agent` 的请求和控制句柄继续只属于 Host。`@deepseek-ai/dsh-workflow-run-recorder/types` 拥有四类 Session 事件 payload，并保留既有 `tool-workflow/*` 事件名。Client 只导入这些类型 face，因此 Host 与 Client TypeScript 程序共享持久合同，而不会合并 Host Cordis Context。

`ui-workflow-run` 注册一个 `workflow-run` Conversation Definition 和一个 keyed Chat renderer。每条事件都能独立给出同一 `runId`；run-start 初始化 State，后续事件按日志顺序更新；只有 update 的历史尾页会保持 pending，直到 prepend 补入唯一 start。最终节点保留引擎拥有的 key，并以 run-start 锚定在原工具调用之后，从运行中到终态始终保留同一个 React 父级。

renderer 为每一层分配不同视觉职责。运行使用 32 像素 module-platform 背景行，常驻向右／向下 chevron，并以内联状态点加状态文字表达结局，不使用胶囊。阶段使用 32 像素 disclosure 行，在可伸缩主区显示标题与成员数，在固定尾部精确显示聚合状态且不重复状态点。成员使用 16 像素状态点槽、可省略名称区和固定 64 像素状态列。阶段只在成员真正开始时出现，并按精确阶段字符串分组；字段缺省与空字符串保留不同身份和本地化名称。成员结算只改变状态，不删除或重排成员。只有持久逻辑终点会结算后台记录；已加载的 Session location 关闭，合法未完成后缀又没有实时延续时，缺失终点会显示为已中断。[状态驱动的工作流 disclosure](2026-08-11-workflow-run-status-driven-disclosure.md)拥有这些事实变化时运行与阶段内容的可见性。

导航从持久 child id 与当前权威直接子项目录派生。只有刷新后的目录证明同一 id 是当前父 Session 下健康的直接 one-shot 子项时，运行中或已结算的成员行才可交互。带下划线的成员文字是唯一可见提示；键盘聚焦时，名称区显示 2 像素 business-primary 焦点环，固定状态列继续只表达生命周期，而不写动作说明。注入操作解析并打开该目录地址；它绝不回退到未经检查的 `sessions.open(id)`。诊断、可继续、远程、父级不符、缺失或过期条目继续可见，但保持静态。

[七状态 Figma 参考](https://www.figma.com/design/tguwzZRmHCjbq58mfsqT0M?node-id=5-2)固定运行展开／收起、完成历史／展开、失败与取消、恢复后中断以及暗色窄列的信息层级。仓库的 `DisclosureRow`、`StateDot`、图标、语义 token 和 keyed-node 行为仍是实现权威；参考稿不引入运行时字段或状态 owner。

## 验证

包测试覆盖命令与工具归因、排除嵌套与未归因启动、跨尝试的稳定逻辑 id、零成员与并发运行、先 dispose 终态尝试再写终点的顺序、重启协调、合法 append 失败前缀，以及冷／实时 invariant 拒绝。Conversation 测试比较完整 replace、只有 update 的 prepend 和实时 append，并覆盖后台工作跨越发起 Turn 关闭、精确阶段身份、终态与中断状态、disclosure 状态、受目录约束的运行中与已结算子项导航，以及 HMR 移除与重新注册。发布的 Web replay 驱动真实 worker 与 spawn provider、Session 持久化、后续完成轮次、终态保留、原工具行并存和刷新重建。

## 曾考虑的替代方案

**把工作流内容附加到现有工具卡。** 拒绝，因为 `ui-tool` 与工具定义拥有该行的展示和交互。工作流专属 appendix 会耦合两个独立 keyed 业务生命周期，并恢复已移除的工具后附加模型。

**从监督器 manifest 或工作流运行 Remote 构建 Chat 行。** 拒绝，因为模型可见的 Chat 记录必须能从父 Session 日志重建。有界 Remote 负责 dashboard 检查与控制；把它用作 Chat 历史会产生第二个持久 owner，并让回放依赖保留运行是否被驱逐。

**展示声明阶段，或从脚本文本推断静态工作流图。** 拒绝，因为只有成员 start 事件能证明工作真正发生。`meta.phases`、`phase()` 叙述、分支和脚本语法都不是一次运行的权威拓扑。

**仅凭持久 child id 打开子项。** 拒绝，因为历史身份不证明当前可访问性或直接父子关系。因此，无论运行中还是已结算导航，都要求当前目录授权该精确、健康的 one-shot 子项。

## 后果

工作流进度与父对话保存在同一日志中，能跨刷新与进程恢复；监督器拥有执行，原工具卡保持不变。来源中立的 recorder 拥有四类小事件及其 invariant；首次写入失败会刻意牺牲后续观察，而不是牺牲工作流正确性。浏览器 State 按已加载窗口派生，状态驱动的 disclosure 生命周期把复盘选择留在本地，导航会随目录事实出现或消失。Chat 节点只展示真实运行成员与状态，把输出、日志、控制和保留运行详情留给有界 dashboard Remote。
