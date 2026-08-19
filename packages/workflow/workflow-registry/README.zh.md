# @deepseek-ai/dsh-workflow-registry

[English](README.md) | 中文

已保存工作流定义注册表（`ctx.workflows`）：发现 JSON 封套定义，将 `meta` 作为脚本之外的数据校验，提供以 `meta.name` 为键的排序摘要与完整定义，并在变化时失效。

## 文件格式

一种仓库一致的封套：`<name>.workflow.json`，位于某个发现根目录下。

```json
{ "meta": { "name": "review-changes", "description": "…", "whenToUse": "…",
  "phases": [{ "title": "Review", "detail": "…" }] },
  "script": "// plain JS body, top-level await, complete(value) or return" }
```

文件名必须等于 `<meta.name>.workflow.json`；`meta.name` 为 kebab-case。未知 meta 字段会大声失败。`meta` 作为 JSON 数据校验——脚本体从不被求值。

## 发现与优先级

| 作用域 | 根目录 |
|---|---|
| `bundled` | `config.bundledDir`（可选） |
| `project` | `<projectRoot>/.dsh/workflows` |
| `user` | `<dshHome>/workflows` |

`projectRoot` 是包含 `.git` 的最近上层目录（没有则是 cwd）。优先级是 bundled > project > user；重名解析到最高优先级作用域。

## 服务契约

`list(options)` 返回排序的调用无关摘要。`get(name, options)` 加载完整定义（meta + script + path + scope）。查找对 cwd 敏感且可中止。每个封套都通过 `ctx.fs.readBytesNoFollow` 打开，因此最终链接拒绝、普通文件验证和完整的字节有界读取共享同一个提供方对象。`save(envelope, options)` 使用带防护的 `ctx.fs.writeTextNoFollow`；创建／版本验证与最终条目发布保留在同一个提供方操作内，因此被替换的最终链接绝不会被跟随。无法提供任一保证的提供方会明确以 `FS_IO_ERROR` 失败。格式错误的定义文件会在发现阶段带着路径与原因大声失败。chokidar 监视器会使目录失效并发 `workflows/change`。

生成的 `workflowDefinitions/list` Remote 接受会话 id 和可选的取消信号。Host 通过 Session lookup 解析该 id，只使用已解析会话记录的 cwd 选择发现目录；缺少 cwd 的会话会被拒绝，而不会回退到 Host 进程 cwd。其 `WorkflowDefinitionSummaryView` 结果仅包含 `name`、`description`、可选的 `whenToUse` 和 `scope`；该 Remote 不返回文件系统路径、阶段元数据或脚本。

## 模型体验

间接地通过 [`workflow` 工具](../tool-workflow/README.md)与 `/workflow` 命令，它们针对本注册表解析 `name` 并拥有任何已启动运行的结果。

#### KV Cache effect

无直接失效；命名的消费方拥有任何请求前缀变化。

## 已知限制与搁置工作

- 只读取扁平 `.workflow.json` 封套；目录捆绑（`<name>/workflow.json` + `script.js`）不读取。
- 完整定义在每次 `get()` 时重新从磁盘读取；注册表只缓存摘要。
- 本地 Windows 文件系统提供方无法提供原子的最终组件不跟随读写。使用该提供方时，发现和 `save()` 会以 `FS_IO_ERROR` 明确失败；Windows 部署需要提供基于原生句柄等价操作的提供方。
