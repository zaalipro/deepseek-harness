# `@deepseek-ai/dsh-headless`

[English](README.md) | 中文

dsh 一次性任务组合包。[`cordis.patch.yml`](cordis.patch.yml) 直接叠加在 [`dsh-base`](../base/README.md) 之上：提供编码 persona 和工具模式、禁用 HMR（热模块替换）、将 Code Mode 的 worker 作为核心执行能力挂载，并插入本包的 `headless-runner` 插件（配置为 `{task}`，从注入的 `headlessStartup` 提供方解析）。它不挂载任何 Host、HTTP server、Web runtime 或浏览器插件。

Loader 结算后，runner 读取共享的 [`ctx.agentDefaultModel`](../../core/agent-default-model/README.md)，通过 `ctx.agents` 创建一个全新的持久化 Agent（智能体），将任务作为普通用户消息提交，并等待完全停稳。它会等待该 Agent 持有且处于活动状态的后台工作流，以及完成通知触发的对话轮次，然后对 Session 执行 flush 并汇总自身持有的持久化事件区间。它将最后一条非空 assistant 文本写入 stdout，再经启动器提供的 `ctx.appExit` 宿主钩子（[`dsh-cmdline`](../../boot/cmdline/README.md)）请求退出（最终 `turn/end` 完成 → 0，否则为 1）。最终结束原因为 `error` 时，还会将 code 与 message 写入 stderr；成功运行时 stderr 保持为空。进程不会打开监听端口。任务文本就是这个应用的命令行：普通 `headless-startup` 提供方（[`src/startup.ts`](src/startup.ts)）注入 `ctx.cmdlineArgs`（[`dsh-cmdline`](../../boot/cmdline/README.md)），读取 `dsh --profile headless "task"` 的位置参数、打印应用自己的 `--help`，并提供 `headlessStartup`；runner 注入该服务，再从惰性配置中读取任务。缺失或只有空白的任务会在 runner 激活前被拒绝。

## 模型体验

无影响，因为 runner 把任务作为普通用户消息提交；提示词与工具由 base 和 headless 组合包中的相应条目提供。

#### KV Cache 影响

无；runner 不向请求前缀添加任何内容。

## 已知限制与暂缓事项

- **只提交一个任务**：runner 没有用于交互式后续输入的 surface；它会等待该任务触发的 Agent 工作与处于活动状态的受监督工作流，并打印完整区间内最后一条非空 assistant 消息。处于暂停、等待输入或预算受限状态的工作流属于已完全停稳的停放状态；它不会让进程持续等待，而会在一次性 Agent 退出时被中断。
- **`ctx.appExit` 由启动器持有**：在 `dsh` 启动器之外启动 headless profile 会在激活时明确报错，直到宿主提供该退出请求。
