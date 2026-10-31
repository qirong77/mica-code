# Subagent

子代理委派：把「谁来干、给什么权限、怎么等结果」交给插件，内核只保留机制。

## 三块能力面

- **类型**（`ctx.subagents.registerType`）：7 种内置类型（`general-purpose` / `Explore` /
  `Implementer` / `Reviewer` / `Tester` / `Planner` / `Proposal`），声明工具白黑名单、
  默认上下文模式、写策略（`none` / `owned_paths` / `proposal` / `unrestricted`）与迭代上限。
- **工具**（`ctx.tools.register`，`primaryAgentOnly`）：`agent`，支持
  `run` / `list` / `read` / `kill` / `await` / `run_many` / `join`，参数与文案在本目录。
- **prompt**（`ctx.prompt.section`，id `delegation`）：只说什么时候该委派、怎么划分
  所有权、结果怎么验收；`context_mode`、`owned_paths`、后台与等待的用法留给工具描述。

设置项 `delegationMode` 决定委派倾向：`proactive`（默认，能拆就拆、优先并行）或
`on-request`（只有用户 / AGENT.md / skill 明确要求时才开子代理）。改完下一轮生效。

## 与宿主的分工

宿主（`ctx.subagents`）负责建子代理、拼父会话上下文、跑、记用量、管后台任务与
路径租约、完成后回注通知；插件只描述「有哪些类型、工具长什么样、什么情况下委派」。
停用本插件，`agent` 工具、这些类型与这段 prompt 一起消失。

`list` / `read` / `kill` / `await` / `join` 都按调用所属的主代理隔离任务。
`run_many` 先校验整批任务再启动；依赖只有在宿主报告 `completed` 后才放行，失败、
被中止或未完成的依赖会使下游任务显示 `skipped`。父请求中止后不再派发后续任务。
等待后台依赖的完成确认同样能立即取消，不必等子代理处理完中断才释放父调用。
子代理输出中的 JSON 状态不能把宿主记录的失败或部分完成改成成功。
结果中的未闭合 JSON、代码块和超长无分隔文本按线性扫描处理；父代理回显的正文与路径节选有长度上限。

## 失败与重试

- 单次模型请求的重试在 provider 层（`withRetry`，只在还没有文本 / 工具输出时重发）。
- 前台 `run` 在整轮失败后由本插件再补一次：只有不落盘的类型（`write_mode` 为 `none` /
  `proposal`）、未被中止、且宿主报告的原因是**可重试**的（429 / 5xx / 超时 / 网络）才重跑；
  可写类型失败后不自动重跑，避免把已经做过一半的写入再执行一遍。重跑过的结果带 `attempts: 2`。
- 后台任务的重试由父代理决定：失败会以 `failed` 结算并回注通知，可以按需重新提交。
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
- `await` / `join` 省略 `timeout_ms` 时最多等 10 分钟，超时先返回当前状态并提示可再次等待；
  `timeout_ms: 0` 是立即看一眼。不设上限的等待一旦遇上跑飞的子代理，只能靠用户中止。
- 路径租约冲突在宿主建子代理与任务记录之前就拒绝，不会留下 0 用量、从未跑过的失败任务。

## 文件

- `definitions.ts` 类型清单与查找；`AgentTool.ts` 工具；`prompt.ts` 委派策略；
- `orchestration.ts` `run_many` 拓扑排序与同波 `owned_paths` 冲突检查；
- `result.ts` 子代理输出的结构化解析与父代理可读的格式化。
