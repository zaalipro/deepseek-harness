# @deepseek-ai/dsh-command-workflows

[English](README.md) | 中文

工作流斜杠命令：`/workflow` 启动/控制语法、`/workflows` 面板打开入口、`/create-workflow` 创作技能入口，以及每个已保存定义名一个启动命令，随 `workflows/change` 刷新。

## 语法

```
/workflow <name> [<json-args>]
/workflow pause <display-name>
/workflow resume <display-name>
/workflow stop <display-name>
/workflow save <display-name>
```

`<json-args>` 必须是一个 JSON 对象（把数组/标量包进一个字段）。启动是后台的——命令返回显示句柄并引导用户打开 `/workflows`。pause/resume/stop/save 以显示名寻址一个运行，从不用内部 id。与内置命令撞名的启动保留内置命令的裸名，仍可通过 `/workflow <name>` 到达。

## `/workflows` 与 `/create-workflow`

`/workflows` 返回空成功；浏览器面板监听本地的 `command/executed` 确认并打开覆盖层。`/create-workflow` 引导模型进入内置的 `create-workflow` 技能（在本包注册为 `user-invocable` 运行时技能，其描述指明该命令）。

## 模型体验

### `/create-workflow` 命令

#### What the model sees

一条命名 `create-workflow` 技能的引导用户消息（加上用户提供的任何细节）成为下一轮次的输入；创作对话由模型拥有，入口本身则由命令平面拥有。其余所有命令都在命令平面解析，从不进入模型。

#### Token effect

裸 `/workflow`、`/workflows` 以及各控制动词不增加模型 token。`/create-workflow` 的成本与直接提交其引导文本相同；一次启动运行的完成通知之后经监督器到达。

#### KV Cache effect

引导消息是纯追加的对话增长；命令目录本身从不进入请求。

## 已知限制与搁置工作

- `/workflow save <name>` 路径写入默认作用域；按命令选择作用域被搁置。