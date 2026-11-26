# Subagent Legacy

进程内委派：把「谁来干、给什么权限、怎么等结果」交给插件，内核只保留机制。

**这是旧的那一半。** 名字里的 `subagent` 现在指 `plugins/subagent`——把活交给一条**独立
的 mica 会话**（自己的进程、自己的上下文，能一直追问、能并行、跑完会自己报到）。本插件
仍在做的只有进程内的委派：子代理活在父会话的进程里，共享父会话的模型与工具，一轮一轮跑完
就把结果带回来。两件事不冲突，可以同时启用；需要「独立环境 / 长时间盯着 / 反复追问」时用
`subagent`，需要「拆开一段推理、并行几份只读调研」时用本插件的 `agent` 工具。

## 三块能力面

- **类型**（`ctx.subagents.registerType`）：7 种内置类型（`general-purpose` / `Explore` /
  `Implementer` / `Reviewer` / `Tester` / `Planner` / `Proposal`），声明工具白黑名单、
  默认上下文模式、写策略（`none` / `owned_paths` / `proposal` / `unrestricted`）与迭代上限。
- **工具**（`ctx.tools.register`，`primaryAgentOnly`）：`agent`，支持
  `run` / `list` / `read` / `kill` / `restart` / `await` / `run_many` / `join`，参数与文案在本目录。
- **prompt**（`ctx.prompt.section`，id `delegation`）：只保留委派倾向、合适场景、所有权、
  自包含任务与结果核实策略；类型与参数、前后台执行、等待、并发上限与重启用法统一在工具描述中。
  段落保留，已有开关与自定义正文继续生效。

设置项 `delegationMode` 决定委派倾向：`proactive`（默认，能拆就拆、优先并行）或
`on-request`（只有用户 / AGENT.md / skill 明确要求时才开子代理）。改完下一轮生效。

## 与宿主的分工

宿主（`ctx.subagents`）负责建子代理、拼父会话上下文、跑、记用量、管后台任务与
路径租约、完成后回注通知；插件只描述「有哪些类型、工具长什么样、什么情况下委派」。
停用本插件，`agent` 工具、这些类型与这段 prompt 一起消失。

文件写入严格按 `owned_paths` 原路径检查。shell 的 cwd 可在租约内，或在工作区里包含租约的目录中；只分配单个文件时也能从工作区根运行测试。外部 checkout 以上溯遇到的 `.git` 文件或目录为祖先上界，独立外部路径的祖先只到直接父目录；无关兄弟目录仍拒绝。cwd 检查不等于 shell 文件系统沙箱，命令仍须遵守写策略，不能因能在工作区根执行而修改租约外文件。

`list` / `read` / `kill` / `restart` / `await` / `join` 都按调用所属的主代理隔离任务。
`run_many` 先校验整批任务再启动；`max_parallel` 是滚动执行名额，不是同一波任务数量上限，
ready 队列会在任一任务真正结束并释放执行资源后继续派发。依赖只有在宿主报告 `completed`
后才放行，失败、被中止或未完成的依赖会使下游任务显示 `skipped`；无依赖的独立分支继续执行。
有重叠 `owned_paths` 的任务必须用依赖声明顺序（或使用 `max_parallel=1`）。父请求中止后不再派发后续任务。
等待后台依赖的完成确认同样能立即取消，不必等子代理处理完中断才释放父调用。
子代理输出中的 JSON 状态不能把宿主记录的失败或部分完成改成成功。
结果中的未闭合 JSON、代码块和超长无分隔文本按线性扫描处理；父代理回显的正文与路径节选有长度上限。

## 失败与重试

- 单次模型请求的重试在 provider 层（`withRetry`：任何没正常结束的请求都重发，10 次）。
  前台 `run` 不再整轮重跑：请求级重试用完之后仍失败，说明这条链路当下确实不通，重来一遍
  只会把已经执行过的工具再跑一次；是重试还是换个做法由父代理判断。
- 任务的重试由父代理决定：先 `read` 查看错误与活动，判断原因，不盲目重试用户主动停止的任务。`restart` 携带原任务与最近活动创建新任务 ID，不是断点续跑；可写任务先确认旧任务已结束并检查已有改动，再用新 ID `await` / `read`。
- `run_many` 中某条任务启动失败（租约冲突、并发已满、宿主拒绝）只把这一条结算成 `failed`，
  同批其余任务继续执行，批次末尾给出 `completed / partial / failed / skipped / running` 统计；
  父请求中止时整批立即停止，不再派发后续任务。
- 宿主报告的失败原因单独成 `## Error` 段，不跟着 `## Raw result` 一起被长度上限截断
  （错误总在长输出的结尾，混进 raw 会被整段丢掉）。
- 前台结果同样带 `task_id`，失败后可以用 `operation=read` 取回用量与活动记录。

## 状态与等待

- 任务状态是 `running` / `completed` / `partial` / `failed` / `killed`。跑满 `maxTurns` 的
  子代理是 `partial`：它没完成任务，但已有部分成果可用，任务表、`read` 与 `join` 统计都按
  「部分完成」呈现，不降级成失败。
- `await` / `join` 默认 `wait_mode: "all"`，省略 `timeout_ms` 时最多等 10 分钟，超时先返回当前状态并提示可再次等待；
  `wait_mode: "any"` 在任一任务进入终态后立即返回所有请求任务的当前快照，不取消其它任务。
  `timeout_ms: 0` 是立即看一眼。不设上限的等待一旦遇上跑飞的子代理，只能靠用户中止。
- 路径租约冲突在宿主建子代理与任务记录之前就拒绝，不会留下 0 用量、从未跑过的失败任务。

## 文件

- `definitions.ts` 类型清单与查找；`AgentTool.ts` 工具；`prompt.ts` 委派策略；
- `orchestration.ts` `run_many` 拓扑排序与无序 `owned_paths` 冲突检查；`runManyScheduler.ts` 负责滚动调度；
- `result.ts` 子代理输出的结构化解析与父代理可读的格式化。
