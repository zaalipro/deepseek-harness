# @deepseek-ai/dsh-tool-workflow

[English](README.md) | 中文

面向模型的 **`workflow` 工具**通过 `ctx.workflowSupervisor` 启动 JavaScript 编排脚本。本包负责面向模型的 schema、来源解析与即时启动结果。它将根启动归因给 [`ctx.workflowRunRecorder`](../workflow-run-recorder/README.md)，由这个与来源无关的 recorder 负责顶层运行在 Chat 中的持久投影。定义发现、后台执行、暂停／恢复、上限、保留结果与完成通知仍位于[工作流能力](../workflow/README.md)之后。

## 模型看到的内容

启动必须且只能提供一个来源：`name` 表示已保存定义，`script` 加 `meta` 表示内联纯 JavaScript 脚本体，`script_path` 表示定义包络或可编辑脚本。已保存名称和相对文件路径基于调用 Session 的 `cwd` 解析；`script_path` 使用 `ctx.fs.readBytesNoFollow`，因此最终链接拒绝、普通文件验证和有界读取共享同一个提供方描述符或等价对象。可选 `args` 是以全局变量 `args` 公开的 JSON 对象。`validate_only` 使用罐装 host 对单条路径做冒烟检查，不创建运行。`resume_from_run_id` 恢复同一进程中的一个逻辑运行；只有上一次尝试达到上限时，才能同时提高 `agent_budget`。插件还会贡献一个 `tool:<toolName>` 系统提示词段，其中包含使用策略：只有用户明确要求工作流或大型编排时才使用该工具；一两项委派优先使用普通 subagent 调用。

## 生命周期

启动是后台工作。成功调用会在 supervisor 发布运行后返回 `{ status: "started", displayName, runId, script_path? }`；父级轮次不会等待脚本完成。supervisor 负责取消、尝试 dispose、完成通知与 dashboard 保留数据。`validate_only` 则等待冒烟检查结果，并且不创建运行、Chat 节点或 dashboard 行。

对于根 transport 执行（`exec.parent` 缺省），工具通过 `ctx.workflowRunRecorder.launch(...)` 将它唯一一次 supervisor start 归因给调用 Agent 的 Session。recorder 把 supervisor 的逻辑生命周期投影到该 Session：稳定的受监管运行 ID 写入一次 `tool-workflow/run-start`；所有暂停／恢复尝试产生的逻辑成员事件都会追加到同一记录；只有终态尝试 dispose 后才写入一次 `tool-workflow/run-end`。暂停、等待输入或预算受限的尝试不会关闭记录。进程或所有者中断会以 `stopReason: "interrupted"` 关闭记录。嵌套 transport 调用照常执行，但不写工作流记录。任一次 Session append 首次失败后，本运行会停止后续记录并只告警一次，留下空记录或合法连续前缀，同时不改变执行。

浏览器安全的 `@deepseek-ai/dsh-workflow-run-recorder/types` 子路径拥有这四类 log-only 事件 payload 及其 `SessionEventMap` 声明。recorder 包的 invariant 会在冷加载和实时追加时拒绝重复 start、未配对成员、仍有开放成员的终点和 run-end 后更新，同时允许缺失终态后缀的连续前缀。

## 渲染意图

渲染意图预先确定（见[渲染意图 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-02-tool-render-intent-union.md)）：使用一个 `generic` 卡片，标题依次从 `args.name`、`args.meta?.name` 与固定 `workflow` 回退值派生（呈现是参数的纯函数，不要求提供方解析）；脚本文本作为 `rawInput` 携带。结果继续使用 generic 卡片。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `toolName` | `workflow` | 要注册的面向模型工具名称。 |
| `maxResultChars` | `50000` | `validate_only` 渲染结果上限；更长的 JSON 会被截断并附上提示。 |
| `maxDefinitionBytes` | `1048576` | 单个内联脚本或 `script_path` 可接受的最大 UTF-8 字节数。 |

## 模型体验

### 系统提示词

#### 模型看到的内容

在该插件的注册作用域内，每个父级请求都会收到下方的工作流指导。作用域工具限制可以隐藏 schema，而不移除这段独立注册的指导。

##### 工作流指导

```markdown
Use the <toolName> tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.
```

#### Token 影响

插件启用期间，每个请求都会产生少量固定的指导 token 开销。

#### KV Cache 影响

只要插件作用域和指导文本不变，前缀就保持稳定。启用或 dispose 可能会使从该提示词段起的缓存复用失效。

### 工具 schema

#### 模型看到的内容

工具可见时，已生成的默认 [`workflow` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-workflow) 包含完整的 JavaScript 钩子与元数据约定；`toolName` 可以重命名该定义，模型会提交脚本、元数据和可选 args。

#### Token 影响

工具可见时，每个请求都会产生较大的固定 schema token 开销。

#### KV Cache 影响

只要 `toolName`、定义和可见性不变，前缀就保持稳定。重命名、插件生命周期或作用域限制可能会使从该 schema 起的缓存复用失效。

### 工具调用历史与结果

#### 模型看到的内容

由模型编写的完整脚本、元数据和 args 会保留在 assistant 工具调用中。实时启动会渲染紧凑 JSON，其中包含 `status`、`displayName`、逻辑 `runId` 和可选 `script_path`；恢复会用 `status: "resumed"` 渲染同一个稳定身份。Host 的斜杠命令确认仍采用适合人类阅读且不含 UUID 的文本。supervisor 随后独立发布终态结果或 scratch 报告。`validate_only` 调用会报告有界的冒烟检查结果。没有所属 agent 的调用会以 `workflow tool requires a calling agent (exec.agent was undefined)` 失败。中间子 agent 消息会被省略。

#### Token 影响

调用 token 可能很多，并会保留到压缩（compaction）为止。`validate_only` 渲染受 `maxResultChars` 限制；子模型 token 与父级保留的上下文相互独立。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **`args` 必须是对象**：调用方应把顶层数组或标量包装到字段中。
- **`validate_only` 只跟随一条罐装路径**：它不会枚举分支，也不会使用实时子 agent 工具。
- **不支持跨进程恢复**：重启后恢复到的活跃运行会成为终态 Interrupted 行。
- **持久记录只覆盖顶层且只供观察**：嵌套 transport dispatch 不记录；记录故障会刻意退化为不完整前缀，而不改变执行。
- **本地 Windows 文件来源不可用**：本地提供方无法在 Windows 上安全实现最终组件不跟随读取，因此 `script_path` 和由 registry 支持的 `name` 来源会以 `FS_IO_ERROR` 明确失败；内联 `script` 来源仍可用。
