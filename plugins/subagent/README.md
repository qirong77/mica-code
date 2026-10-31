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

## 文件

- `definitions.ts` 类型清单与查找；`AgentTool.ts` 工具；`prompt.ts` 委派策略；
- `orchestration.ts` `run_many` 拓扑排序与同波 `owned_paths` 冲突检查；
- `result.ts` 子代理输出的结构化解析与父代理可读的格式化。
