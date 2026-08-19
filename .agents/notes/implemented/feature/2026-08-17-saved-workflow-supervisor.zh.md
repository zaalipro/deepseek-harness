# Agent Note：已保存的工作流、斜杠命令与后台运行监督器

Status: implemented

[English](2026-08-17-saved-workflow-supervisor.md) | 中文

## 问题

动态工作流 seam 一开始是内联执行模型编写的脚本，并在父轮次里阻塞等待其结束。三项贴近 Grok Build 形态的能力一直处于搁置：磁盘上的已保存工作流定义、人类斜杠命令入口，以及带实时名册、显示名句柄、暂停/恢复与停止/保存的后台运行生命周期。Web 聊天渲染器（`ui-workflow-run`）只展示了持久的顶层运行历史而没有控制能力，且代理之外没有任何东西读取工作流运行——因此引擎一直待在 preset 作用域里。

## 决策

已保存工作流、斜杠命令与运行监督被拆成三个 Host-plane 新增组件，加上一个被拓宽的引擎，全部挂载在 Web 组合里。

### 已保存定义（`dsh-workflow-registry`）

一个定义就是一个 JSON 封套 `<name>.workflow.json`，含 `{ meta, script }`：meta 作为脚本旁边的数据被校验（从不求值），文件名必须等于 `meta.name`（kebab-case），未知 meta 字段会大声失败。发现按优先级扫描三个根——bundled > project（`.dsh/workflows`）> user（`<dshHome>/workflows`）——以 `meta.name` 为键，chokidar 监视器会使目录失效并发 `workflows/change`。`ctx.workflows` 提供排序后的摘要与完整定义；格式错误文件会在发现阶段带着路径与原因大声失败。

### 运行监督器（`dsh-workflow-supervisor`）

`ctx.workflowSupervisor` 拥有每一个存活的 `WorkflowRun` 句柄，因此启动可以立即返回。运行以会话唯一的显示名作为键——首个存活/保留运行用 `meta.name`，之后是 `meta.name-2`、`meta.name-3`——从不用内部 id；带编号的句柄是给人用的，不是定义名。一次启动会在 `<dshHome>/workflow-runs/<目录 id>` 下写出可编辑的 `script.js` 投影和一个 `scratch/` 目录。子代理结果按调用顺序从新的 `workflow/agent-result` 事件记入日志（journal），项目作用域为：`workflow/start|phase|log|gate|agent-start|agent-end|agent-result|end` 是监督器折叠成实时名册视图的只观察 wire，再以整集 `session/workflow-runs` 帧推送到浏览器（与 `session/jobs` 同一姿势）。

### 暂停 / 恢复 / 停止 / 保存

- `pause` 取消运行并标记为 `paused`，保留已提交 journal。`resume` 用 journal 回放重新执行原来不可变的脚本、args 与预算（被回放的 `agent()` 调用返回已提交结果且不花预算）。
- 脚本级 `await_user(kind, message)` 停放存活的 worker，resume 会越过它；`pause(kind, message)` 在每次 resume 时重新触发。门控显示为 `Needs input`。
- `stop` 取消并标记 `cancelled`；进程退出会把活动运行标记为 `interrupted`，不可恢复。
- `save` 把运行的脚本投影写回 project/user 定义；它拒绝内置项与带编号句柄。
- 完成时通过 `agent.inject` 注入包含结果的父可见通知，使报告不埋在面板里。

### 斜杠命令（`dsh-command-workflows`）

Host-plane 的 `/workflow`（启动 + `pause|resume|stop|save` 语法）、`/workflows`（空成功；客户端在 `command/executed` 时打开面板）、`/create-workflow`（引导模型进入内置的 `create-workflow` 技能），以及每个已保存 `meta.name` 一个启动命令，随 `workflows/change` 刷新，与内置命令撞名时静默让出裸名。命令文本中从不出现在何内部 id。

### 引擎拓宽（`dsh-workflow-worker-thread`）

脚本表面新增 `complete(value)`、`pause`/`await_user`、`budget()`、`write_scratch_file`/`read_scratch_file`、`parallel([...job maps])` 重载、journal 回放与 `validate_only`（罐头 `agent()` 结果、无子代理、无记录）。因为监督器与命令从任何代理作用域之外读取它，引擎移到了 Host plane。

### Web 面板（`dsh-client-ui-workflows`）

一个全屏 `shell.overlay` 条目从运行时镜像读取 `workflowRunsBySession`；暂停/恢复/停止/保存通过命令 Remote 执行 `/workflow` 命令。聊天内的 `workflow-run` 节点仍是持久表面；面板是额外的。

## 验证

包测试覆盖封套解析与发现优先级、监督器显示名分配、journal 重跑、保存拒绝、退出即中断，以及 `/workflow` 语法。worker 线程测试通过进程内 MessageChannel 覆盖每一个新钩子（complete、budget、门控、journal 回放、parallel 映射、scratch、validate_only）。浏览器烟雾测试覆盖组装后的斜杠菜单、一次后台启动、面板名册与一次暂停/恢复循环。

## 备选方案

**基于 session-projection 键的面板。** 被否：运行状态是进程本地的、内容多、每次运行变化多次；整集 `session/workflow-runs` 帧与 `session/jobs` 完全一致，让面板保持为监督器的只读投影。

**Per-preset 监督器 + Host-plane 命令。** 被否：api-proxy 无法读取 preset 作用域的监督器来推帧，命令也无法解析运行注册表。

**保留前台工具语义再叠一层轮询。** 被否：由监督器拥有存活运行，才能在不引入第二个生命周期 Owner 的前提下正确做到后台启动、取消与完成通知。

## 后果

工作流运行现在以可后台、可暂停、可恢复、可停止的工作存在，并带实时面板；持久的 `tool-workflow/*` 聊天记录与通用工具卡保持不变。定义是可放进 git 分享的普通文件。journal 回放对外部副作用从不是恰好一次——其结果在暂停前未提交的副作用可能再次执行；有副作用的步骤必须保持幂等，且跨进程恢复被有意不支持（活动运行变为 `Interrupted`）。