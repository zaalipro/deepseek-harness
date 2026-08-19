# @deepseek-ai/dsh-command-workflows

[English](README.md) | 中文

工作流 Host 命令：`/workflow` 启动/控制语法、`/create-workflow` 创作技能入口，以及每个已保存定义名一个启动命令。定义变更会刷新这些别名；命令注册表变更会把撞名别名移入或移出限定名。Web 客户端的 [`ui-workflows`](../../client/ui-workflows/README.md) 包以客户端 action 形式拥有 `/workflows`。

## 语法

```
/workflow <name> [<json-args>]
/workflow pause <display-name>
/workflow resume <display-name>
/workflow stop <display-name>
/workflow save <display-name>
```

`<json-args>` 必须是一个 JSON 对象（把数组/标量包进一个字段）。启动是后台的——命令返回显示句柄并引导用户打开 `/workflows`。pause/resume/stop/save 以显示名寻址一个运行，从不用内部 id。已保存名称与其他命令撞名时，该命令保留 `/<name>`，已保存工作流则以 `/workflow-<name>` 出现在目录中。若第一个限定名仍被占用，Host 会继续添加 `workflow-` 前缀；每个已保存定义的裸名也会为该定义保留。规范形式 `/workflow <name>` 始终可用。

规范形式和逐定义启动都会通过 [`ctx.workflowRunRecorder`](../workflow-run-recorder/README.md) 归属其唯一的顶层 supervisor start。因此 Host 命令启动与根模型工具启动都拥有相同的来源无关持久 Chat 记录；控制和非启动命令不会创建工作流记录。

示例：

```
/workflow review-changes {"target":"origin/main...HEAD"}
/workflow pause review-changes
/workflow resume review-changes
/workflow stop review-changes-2
/workflow save review-changes
```

在终端和无头客户端中，裸 `/workflow` 会输出这套语法与示例。在 Web 中，现有裸命令 decoration 会先拦截 `/workflow` 并打开已保存定义选择器；带尾随空格的 `/workflow ` 仍以 leading input 进入完整语法。

## `/create-workflow`

`/create-workflow` 会引导一条用户显式技能手势。技能注入边界加载胜出的 `create-workflow` 正文；产品拥有的 provider 优先于同名的项目与用户技能，因此工作区内容无法替换这个 Host 命令背后的创作流程。打开 `/workflows` 从不到达此 Host 插件，因此不会产生 `command/run` 或 `command/done` 事件。

## 模型体验

### `/create-workflow` 命令

#### What the model sees

一条引导用户消息会把 `/create-workflow` 和用户提供的任何细节一起带入下一轮次。标准用户显式技能边界把捆绑指令追加到该步骤；创作对话由模型拥有，入口本身则由命令平面拥有。其余所有命令都在命令平面解析，从不进入模型。

#### Token effect

裸 `/workflow` 与各控制动词不增加模型 token。客户端自有的 `/workflows` action 也不增加模型 token 或 Session 事件。`/create-workflow` 的成本与直接提交其引导文本相同；一次启动运行的完成通知之后经监督器到达。

#### KV Cache effect

引导消息是纯追加的对话增长；命令目录本身从不进入请求。

## 已知限制与搁置工作

- `/workflow save <name>` 路径写入默认作用域；按命令选择作用域被搁置。
