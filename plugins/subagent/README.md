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

## 文件

- `definitions.ts` 类型清单与查找；`AgentTool.ts` 工具；`prompt.ts` 委派策略；
- `orchestration.ts` `run_many` 拓扑排序与同波 `owned_paths` 冲突检查；
- `result.ts` 子代理输出的结构化解析与父代理可读的格式化。
