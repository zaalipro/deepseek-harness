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

`list(options)` 返回排序的调用无关摘要。`get(name, options)` 加载完整定义（meta + script + path + scope）。查找对 cwd 敏感且可中止。格式错误的定义文件会在发现阶段带着路径与原因大声失败。chokidar 监视器会使目录失效并发 `workflows/change`。

## 模型体验

间接地通过 [`workflow` 工具](../tool-workflow/README.md)与 `/workflow` 命令，它们针对本注册表解析 `name` 并拥有任何已启动运行的结果。

#### KV Cache effect

无直接失效；命名的消费方拥有任何请求前缀变化。

## 已知限制与搁置工作

- 只读取扁平 `.workflow.json` 封套；目录捆绑（`<name>/workflow.json` + `script.js`）不读取。
- 完整定义在每次 `get()` 时重新从磁盘读取；注册表只缓存摘要。