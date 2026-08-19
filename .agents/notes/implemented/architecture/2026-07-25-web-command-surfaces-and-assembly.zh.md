# Agent Note: Web 命令业务面与装配（ui-commands / ui-skill / ui-subagent / client actions）

Status: implemented

[English](2026-07-25-web-command-surfaces-and-assembly.md) | 中文

> 范围：命令目录缓存与四型派发（ui-commands）、浏览器所属 action、popup 选择流、skill（技能） / subagent 两个引用源、fixture（测试前置数据）命令路由与装配验收（slash-flow 快照）。承载 wire 见[会话作用域 note](2026-07-25-web-client-session-scope-and-provide-channel.md)；触发、菜单和输入机器见[输入状态机 note](2026-07-25-web-input-machine-and-slash-pipeline.md)。

## 问题

流水线就绪但没有命令知识的落点：host 侧 `ctx.commands` 与 `ctx.skills` 完整而 web 通道无命令能力。业务层要回答：

- 命令 UI 不止一种形态（当场执行、弹选择框、回填后继续打参数）——业务包如何零骨架改动上架；
- 目录何时拉取：每次开菜单现拉太慢，常驻缓存就要有失效与重连故事；
- 会话始终由 agent（智能体）支撑（Session+Agent 同瞬出生），client 命令面通过什么地址访问 host 的逐 agent 有效目录；
- 装配级验收：拆开的各层合起来，用户可见主链如何钉住。

## 决策

### ui-commands：`CommandUiRuntime` + 按会话键控的 `CommandDirectory` + 逐会话 `PopupSelectController`

- 投影 `ClientSessionContext { sessionId }` 自持于 ui-input-trigger 约定（types.ts）：会话恒 agent-backed，会话身份即命令能力的全部投影；wire 以 `{sessionId}` 寻址（`command.list` / `command.execute` 均是；host 从会话 header 解析 Agent）。
- 目录按 `SessionId` 分区，per-key single-flight + epoch guard（旧拉取永不覆盖新态），`commands/changed` 全 key 软失效（旧快照继续服务、后台重拉）、`connection/reset` 全 key 硬失效并预热，Enter 必须等待当前 key 就绪、失败留草稿不降级。预热挂 source 的 `warm` 钩子——scope 出生时对全 roster 一次，即覆盖整个会话生命周期（会话能力自出生恒定）。
- `register(contribution)` 把 client 命令注册为 descriptor、`available(projection)` 与 `action` 或 `popupSelect` spec；候选合成会合并 Host 目录与可用 client contribution，再应用 query/position 过滤，Host/contribution 重名会 fail loud。`decorate(decoration)` 只给现有 Host 行添加裸调用 popup。
- 命令四型按 owner 与注册方式派生：Host descriptor 带 `input` = **leadingInput**（回填 `/name ␣` + claim，继续输入参数，仅限行首）；client popup spec = **popupSelect**（官方选择框壳，业务不提供外壳组件）；client action spec = **action**（不经 Host 执行而运行浏览器行为）；其余 Host descriptor = **execute**。
- 菜单可触发四型。Space 只认 leadingInput。Enter 仅在裸 token 时运行 execute、action 或 popupSelect，leadingInput 则容忍尾随参数。client action 按会话与命令名 single-flight，只在成功后消费精确的菜单 span 或裸 token，并把结算限定于准入它的会话 scope；失败时保留 token，并通知该 composer。除非业务回调明确调用另一项 Host API，否则 action 从不调用 `command.execute`，也不追加 `command/run`／`command/done` 事件。
- `popupFor(actx)` 的 popup：search 本地过滤、select single-flight、open 时捕获投影、onSelect 成功才经 consume-token 事件消 token、失败保留可重试、会话切换只隐藏。popup 壳是瞬态层（不进状态机）：框持焦点、Enter/↑↓/Escape 归它、点框外即 dismiss（点 textarea 同时归还焦点）。

### 引用源（只见投影 + 自家 apply 闭包的 root ctx）

- **ui-skill**：`skill.list({sessionId})` 按会话寻址（host 从会话 header 解析项目根）；目录缓存按 sessionId 键控 single-flight，`warm` 钩子出生预热、`connection/reset` 全清。pick 产出 text outcome（`/name ` 原文，纯文本引用决策）；`lexicon` 从 CatalogFetch 的 settled 快照给名录（未热 `undefined`），`subscribeLexicon` 在 settle 与失效时按会话通知监听者。无 match 钩子（引用不进命令裁决）。skill 引用以原文随普通提示词走（命令平面之外；tool-skill 不变，会话前缀目录提供协作关联）。
- **ui-subagent**：候选零 RPC（sessions.list 快照按 parentId/running 过滤）；pick 产出 text outcome（`@name ` 原文）；`lexicon` 同快照派生，`subscribeLexicon` 转发 list store 的变更通道（模型侧表示待业务立项）。

### fixture 命令路由与装配

- connection fixture 补命令路由（fixture + fake-api）：keyless 台架可跑完整命令流（目录、执行、popup 选择）。
- apps/cli 装配挂全部新包；tsconfig path map / reference 集补齐；catalog/docs 随 wire 与事件再生成。

### 装配级验收：slash-flow 快照

`apps/web/tests/slash-flow.snapshot.ts` 钉住用户可见主链（assembled keyless，包 mock 不替代装配后的 transcript（文本记录））：无会话时 composer 禁用 → 创建 Workspace 并进入已实体化的 blank 会话 → `/` 菜单选 `/echo` leadingInput → 命令执行但 blank 位不翻转、列表仍显示 `New Session` → 首条普通提示词成功受理后同一行转正；同一个会话绑定的 textarea 在 blank → active 转换期间保持不变。`workspace-flow.snapshot.ts` 另钉住 blank 行创建/复用、首条提示词遭拒后的回填，以及在发出首条提示词前切换 Workspace 时 draft 跨 input machine 搬运且旧 blank 行隐藏。

## 曾考虑的替代方案

| 弃案 | 一行理由 |
|---|---|
| 提示词内联派发（命令文本随消息进 host 解析） | 混淆命令/消息平面；命令执行独立于消息队列是既有 host 语义 |
| skill 物化为 command 的桥 | skill 自有目录；N 笔注册是绕路；标签形式天然避开命令平面 |
| `skill.invoke` RPC | host 无此操作；skill 引用是随提示词的普通文本 |
| 新 ContentBlock 引用类型 | 全链路成本（适配器/UI/压缩（compaction））；文本即真身 + 结构化 occurrence 记录已足够 |
| client 各包复制 Host 命令 descriptor | Host 行仍是 Host 行为的真源；contribution 是 client 自有行，撞名会明确失败而非遮蔽 |
| `requires: 'none' \| 'agent'` 判别轴（agentless 目录 + 双址查询） | 会话恒 agent-backed 后两栖命令无 owner；整轴弃置，待真需求重开 |
| 专用 commandresult / commandpanel slot | 结果走 notice；popup 壳是骨架内浮层；富结果卡入台账 |
| agent-type 目录做 `@` 源 | 无类型注册表；实时会话快照已覆盖 |
| PickAction/EnterCommand 类族（类继承 pick 产物） | 跨包运行时值破坏 client bundle 纯度；纯数据接口 + 闭包方法等价 |

## 后果

- Host 业务命令上架需要一笔 Host 注册与可选的 client popup decoration；execute／leadingInput 无需 client 注册。浏览器自有 action 或 popupSelect 只需一笔 client contribution，无需 Host 行。四型语义集中在 ui-commands，因此业务包无需修改骨架。
- 常驻目录缓存 + 推失效换来菜单零延迟与回车裁决可靠；代价是三条失效路径（change 帧、重连、epoch guard）都需测试钉住。
- sessionId 寻址让 host 的 per-agent 有效目录（全局 + scoped shadows）直接上 wire，client 原样呈现。
- 已知欠账：富结果卡与 roster 可配置性仍不属于命令 API。
