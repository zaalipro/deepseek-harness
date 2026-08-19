# @deepseek-ai/dsh-workflow-supervisor

[English](README.md) | 中文

工作流运行监督器（`ctx.workflowSupervisor`）：会话作用域的显示句柄、存活 + 保留运行、后台启动、带主机调用日志（journal）的同进程暂停/恢复、停止、保存为定义，以及注入父对话的完成通知。

## 显示名

运行以会话唯一的显示名为键，从不用内部 id。某个定义名的首个存活/保留运行是 `meta.name`；后续启动把句柄编号为 `meta.name-2`、`meta.name-3`……人类把该句柄传给 `pause`/`resume`/`stop`/`save`。

## 生命周期

- `start(spec)` 在后台启动并立即返回 `{ displayName, runId, scriptPath, status: 'started' }`；监督器拥有存活的 `WorkflowRun` 句柄，并在 `<dshHome>/workflow-runs/<目录 id>` 下写出可编辑的 `script.js` 投影和一个 `scratch/` 目录。
- `validate(spec)` 冒烟检查一条罐头主机路径（`validate_only` 引擎模式）：无子代理、无运行记录、无面板行。
- `pause(displayName)` 取消运行并标记 `paused`，保留已提交的 `agent()` journal。`resume(displayName)` 用 journal 回放重新执行原来不可变的脚本、args 与预算（被回放的调用不花预算）。脚本级 `await_user()` 门控停放存活 worker，resume 越过它；`pause()` 门控在每次 resume 时重新触发。`markInterrupted()` 在进程退出时将活动运行标记为 `Interrupted`。
- `stop(displayName)` 取消并把运行标记为 `cancelled`。
- `save(displayName, agent, scope?)` 把运行脚本投影写为 project 或 user 作用域下的 `.workflow.json` 定义；它拒绝内置项与带编号句柄。

## Wire

`listRuns(agent)` 返回浏览器安全的 `WorkflowRunView`，由 api-proxy 作为整集 `session/workflow-runs` 帧推送；`workflows/run-change` 表示变化。`workflow/agent-result` 事件提供 journal。

## 配置

`enabled`（默认 true）、`dshHome`、`defaultAgentBudget`（128）、`maxAgentBudget`（1024）、`runsRoot`（`<dshHome>/workflow-runs`）、`saveScope`（`project`）。

## 模型体验

### Completion notice

#### What the model sees

一次后台启动除了 [`workflow` 工具](../tool-workflow/README.md)的 `{ status, displayName, runId, ... }` 结果外，不会再向模型返回任何内容。运行结束时，监督器把一条插件来源的用户通知（`workflow "<显示名>" completed …`）连同结果值注入父对话。

#### Token effect

完成通知把自己的简短用户文本块加入历史；运行本身在结束前不增加 token。

#### KV Cache effect

通知附加在可复用请求前缀之后，因此它扩展对话，而不是使助手自身的缓存失效。

## 已知限制与搁置工作

- journal 回放对外部副作用从不是恰好一次——其结果在暂停前未提交的副作用可能再次执行；有副作用的步骤必须保持幂等。
- 不支持跨进程恢复：进程退出时活动运行变为 `Interrupted`。
- 保留运行在整会话期间保留，没有保留上限。