# @deepseek-ai/dsh-client-ui-workflows

[English](README.md) | 中文

全屏工作流运行面板：`/workflows` 覆盖层，带实时名册、阶段轨道、按启动阶段分组的成员、日志行、最终结果，以及暂停/继续/停止/保存控制。

## 组合

插件注册一个 `shell.overlay` 条目（`kind: list`，root 作用域），完全从 `workflowRunsBySession` 镜像读取当前会话的运行——api-proxy 的整集 `session/workflow-runs` 帧落到运行时对象层；插件不发读 RPC。`/workflows` 宿主命令返回空成功，插件在本地的 `command/executed` 确认时打开覆盖层。

控制通过命令 Remote 执行宿主命令——`/workflow pause|resume|stop|save <display-name>`——因此权限保持在常规命令路径上，且内置项与带编号重复句柄隐藏保存按钮。键盘：`p`/`r`/`x`/`s`，`Escape` 关闭。

## 样式

组件 CSS 使用 `ui-theme` 的 `--dsw-alias-*` 语义 token；桌面与窄/移动端堆叠布局共享同一覆盖层。

## 模型体验

无，本包为人类渲染宿主计算的监督器状态，不接触提示、消息、schema、流或工具结果。控制通过现有命令通道发出宿主斜杠命令；模型对这些运行的视角留在 [`dsh-workflow-supervisor`](../../workflow/workflow-supervisor/README.md) 与 [`workflow` 工具](../../workflow/tool-workflow/README.md) 中。

#### KV Cache effect

无；本包从不组装或发送提供商请求。

## 已知限制与搁置工作

- 预算受限的恢复拒绝通过命令失败文本呈现；面板内还没有内联原因。
- 名册列出该会话所有保留运行，没有保留上限或裁剪。