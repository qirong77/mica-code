# 多 Agent、压缩与循环

## Subagent

- 委派能力本身是插件 `plugins/subagent/`：`agent` 工具、7 种内置类型、委派 prompt 段落都在插件里；内核只留机制（`ctx.subagents`，实现在 `apps/cli/src/agents/PluginSubagentHost.ts` + `SubagentTaskManager.ts`）。停用该插件后既没有 `agent` 工具，也没有提示词里的委派指引。
- 内置类型：general-purpose、Explore、Implementer、Reviewer、Tester、Planner、Proposal；`maxTurns` 唯一默认值在 `plugins/subagent/definitions.ts`（999：截断一次要重做半成品，代价比多跑几轮高）。
- `SubagentTaskManager` 按 owner 隔离任务与 abort signal，任务记录带 `pluginId` 供 `ctx.subagents.tasks.*` 收窄；后台完成元数据回注 owner，结果显式 read/await。parent Ctrl+C 同步中止其运行中的子代理。
- 常驻宿主持久化子代理记录到 `$MICA_HOME/subagent-tasks/<sessionId>.json`（`mica-common/subagentState.ts`；旧形态单文件读一次即迁移），每轮按 owner 只写变过的那条。resume 时 `restore()` 把记录读回来供详情与重启使用，`status: running` 只在该进程确实已退出（`ESRCH`）时才降级成 failed——PID 复用与权限错误一律当作仍在跑。恢复的只是记录，执行句柄、abort signal 与 timeline 现场不恢复。
- 重启不是「继续上一次执行」，是**用原任务和最近活动作上下文新起一个任务**：`mica/subagentTasks/restart` → `SubagentTaskManager.restart()` → 插件的 restart handler 重新过工具白名单、写策略与路径租约，成功后才创建替代任务。跨进程只允许一个进程重启同一个任务：`claimSubagentRestart()` 用不可变世代文件 + 原子硬链接占位，`commitSubagentRestart()` 把完整替代任务记录与提交标记用一次 `link` 发布，`releaseSubagentRestart()` 只在确实失败时释放；持有进程崩溃的 claim 可被下一个进程接管，已提交或已释放的不能被再次占用。重启失败要释放已申请的租约并允许重试。
- 前台委派默认阻塞，同消息多个调用可并行；需要主流程继续时用 `run_in_background: true`；每 owner 合计并发上限 4。
- turn 结束即收尾它起的后台子代理（`killRunningForOwner(owner, 'Parent turn finished.')`）：这一轮已经交付，结果只能经 `agent operation=read` 取回，而下一轮的模型不会去读上个 turn 的 `task_id`。留着它们只会在状态栏挂一条永远 running 的条目并继续烧 token。收尾在 `turn:after` 之前（TUI 在 `LocalRuntimeController.runTurn` 的 finally，headless 在 `HeadlessTurnExecutor.emitTurnAfter`），且不发完成通知。
- `context_mode` 为 none/brief/recent/files，默认 brief；Implementer / Tester / Proposal 必填 `owned_paths`，写工具与 shell cwd 校验租约（判定唯一实现在 `mica-tools/utils/pathOwnership.ts`）。
- 委派倾向由插件设置 `delegationMode` 决定（`proactive` 默认 / `on-request`），prompt 段落每轮按设置重新渲染。
- 失败重试分两层：单次请求由 provider 的 `withRetry` 处理；整轮子代理失败只有不落盘的类型（`write_mode` 为 `none` / `proposal`）且错误可重试时由插件自动重跑一次，可写类型不自动重跑。`run_many` 中单条任务启动失败（租约冲突、并发已满）只结算该任务，批次末尾给出 completed/partial/failed/skipped/running 统计。宿主报告的失败原因单独成段，不跟着 `Raw result` 一起被截断。
- 内置子代理达到默认 `maxTurns` 后复用原实例和工具历史续跑最多两次，保留任务、租约与累计用量；显式请求的 `maxTurns` 是硬上限，其他类型通过 `maxTurnContinuations` 选择续跑。续跑不重放工具调用，但模型仍可能自行重复调用。
- 任务状态四态之外还有 `partial`：用完续跑预算或显式 `maxTurns` 的子代理有可用成果但没完成任务，任务记录、`tasks.get`、工具输出与 `join` 统计都用它，不要退化成一个 `failed`。`await` / `join` 省略 `timeout_ms` 时按 10 分钟上限等待，超时返回当前状态让模型自己决定继续等还是放弃——不设上限的等待只能靠用户中止。
- 路径租约在 `prepareSpawn` 里判定（`owned_paths` 解析之后、建子代理实例之前）：冲突直接抛错，不会白建一个子代理，也不会在任务表里留一条从未跑过、0 用量的失败记录。
- 非主请求都要记账：Agent 走 `recordSubagentUsage`；BTW、摘要等走 `recordSubagentTaskUsage` / `recordHelperSubagentUsage`；插件自己的模型请求走 `ctx.models.request`，宿主在发起时绑定会话 id，以 `origin: 'plugin'` + `pluginId` 记进原会话的 `subagentUsageHistory`（Stats 的 By source 卡片与会话详情可见），同时经 `createPluginModels` 的 `trace` 作为一条 `plugin-llm` helper 运行进观察流（没有会话可归属的一次性命令只记账、不进轨迹）；`ctx.subagents.run/background` 起的后台子代理也写 `pluginId`，主对话经工具委派的那条写 `origin: 'delegation'`。等待期间切换会话不改变归属，旧会话已删除则不重建。插件里不出现自己拼的模型 HTTP 客户端——那笔开销没人记。

## 压缩

| 入口                                                         | 行为                                       |
| ------------------------------------------------------------ | ------------------------------------------ |
| `/compact`、桌面快速压缩、`mica compact --tool-results-only` | 本地清理，不调用模型，可重复执行；结果已清空的轮次折成一行说明（工具名 + 指向性参数），不再逐条保留信封 |
| `/compact llm`、`mica compact --session`                     | 模型摘要 checkpoint，会重写历史            |
| `--prune-only`、loop 轮前压缩                                | 本地清理，无可清理内容时可丢最早轮次       |

- 本地清理替换工具结果、可识别媒体与工具参数正文；tool-call arguments 必须仍是合法 JSON，只裁正文/长命令，保留路径、pattern、name、offset。
- 裁剪规则集中在 `mica-context/CompactionService.ts`（正文/命令阈值 200/400），幂等标记 `[omitted `。
- 自动压缩是官方插件 `plugins/auto-compact/`：每次模型请求的迭代边界检查，先本地清理、仍超阈值再模型摘要；阈值 300k / 200k、各最多 999 次。`minIntervalMinutes`（默认 30）只约束**同一轮运行中**的重复压缩：`turn:before` 把本轮起点写进 `turnStartedAt`，上一轮留下的 `lastRunAt` 早于它就不构成冷却——用户发来下一句、上下文又超阈值时立刻压。**轮次之外（会话空闲、焦点回到输入框）一律不压**：`mica/input/activity` 与 `mica/input/focus` 仍然到达插件，但自动压缩不订阅它们。抢跑试过，代价大于收益——上下文远未到阈值时白扫几十 MB 历史，阈值之上时又会替用户把工具结果换成占位符并落盘；真实反馈是来回切几次焦点，对话里就排出一列「已快速压缩」。要压由用户手动触发：命令面板「快速压缩（本地）」、`/compact`、`/compact llm`。notice 全部带 `command: 'auto-compact'` 与 `replace: true`（状态型：同一 command 只留最新一条）。**轮次边界的本地清理不写 notice**——它一轮里可能跑几十次、又不改用户看到的对话，提示只留给真正改写历史的模型摘要。
- **任何占住会话的压缩都经 `ctx.agent.withMaintenance` 开窗口**（能力面见 `plugins.md`）：窗口里宿主发 `mica/host/maintenance`（`{ active, reason, label }`，`active: false` 只带 reason），客户端把这段时间的发送放进本地队列——条目带 `waitingFor: 'maintenance'`，排队行按窗口的 `label` 提示「自动压缩结束后发送」、可撤回——窗口结束后按宿主此刻的状态补发（还在跑就 steer 进当前 turn，已经空闲就 `turn/start`），中止中不补发（`chat.js` 的 `replayCompactionQueue` 只补发这一种，别的排队条目各有自己的时机）。轮内的模型摘要今天真的会开窗口（它就是几秒到几十秒的等待）；本地 quick 压缩不开——它很快、一轮里还可能几十次，开了只会在界面上闪出一堆排队提示。窗口按嵌套计数折叠：第一层进窗口才发 `active: true`，最后一层退出才发 `active: false`（`runAppServer` 的 `runMaintenance`），否则内层还在压而客户端已经补发。轮次之外的空闲压缩还会在 `active: false` **之前**补一条 `historyReplaced`（历史被改写、客户端要重载记录），顺序不能反。设置在插件 `settings`（每项都标 `perSession`，可在会话设置里按会话覆盖），计数与本轮起点在会话 `pluginState['auto-compact']`。模型那一路的摘要走清单 `llm`（「压缩摘要模型」面板）：默认复用当前会话模型，也能换成更便宜的独立接口，失败自动降级；插件只替换「谁写这段摘要」（`ctx.agent.compact` 的 `summarize`），分段、预算与重试仍归内核的 `CompactionService`。
- 自动压缩只在常驻会话生效：`mica exec` 是一次性运行（`agent.mode === 'one-shot'`），改变成本或输出的策略一律跳过。
- 压缩只改发给模型的历史，不改 `conversationMessages`；自动压缩失败只记 note，不中断 turn。
- 所有压缩保留 usage 记账；需要模型的 compact / review 走 subagent 或 exclusive task，不污染运行中的主 turn。插件自带摘要请求时（`compact(..., { summarize })`）走 `ctx.llm`，用量以 `origin: 'plugin'` 记进同一份 `subagentUsageHistory`。
- 会话笔记存在快照里，compact 改不到它，每轮由 `buildSystemPrompt()` 追加；rewind 随 checkpoint 回滚。

## 定时循环

- CLI / desktop 共用 `mica-common/loopArgs.ts`：省略间隔默认 30 分钟，最短 10 秒，最长一周。
- CLI `LoopController` 只活在 TUI 进程；每轮前 prune-only，失败提示但不中断；停止时移除 system prompt 指引。
- desktop 调度在 `host/loop-state.js` + `host/loops.js`（`userData/loops.json`），不在页面 setInterval；忙时 skip 不计次数，重启只追赶一轮。

## By The Way

- `/btw` 是官方插件 `plugins/btw/`：经 `ctx.commands.register({ allowDuringTurn: true })` 注册，靠 `ctx.subagents.thread()` 起一条可复用的隔离子代理线程，输出走 `ctx.ui.notice()`；停用该插件后命令消失。同一会话一次只答一条（再问如实拒绝），`-stop` 走 `AbortController` 中断并保留已流出的正文；不带 `-continue` 的新话题会 dispose 上一条线程。
- CLI 也把子代理的 `onText` / `onToolCall` / `onToolResult` 折成输入框上方的进度（正在调用什么工具、已出多少字、跑了多久，工具切换即时刷新、正文按 250ms 节流），完成后带耗时与本次请求数——终端里没有流式正文的位置，但「它还在动」必须看得见。
- 纯逻辑（主流程对话记录、system prompt 拼装、子代理线程构造）唯一实现在 `mica-builtin-commands/shared/btwThread.ts`，desktop「By The Way」抽屉与插件共用；headless 不导入 builtin commands 总出口，避免把 Ink/React 拖进进程。
- 子代理的 system prompt 是整体替换，必须显式带上：btw 规则、主会话角色名 + role prompt 全文、skills 索引、一次性主流程对话记录。工具集用 `btwToolFilter` 排除 `primaryAgentOnly`（插件侧由宿主线程提供的同名过滤兜底）。
- desktop `BtwThreadController` 立即 ack，结果经 `mica/btw/updated` 流式推送，不堵塞 interrupt / steer / recall。
- 同线程单子代理串行，允许一条排队与撤回；不同线程可并行。线程落盘 `$MICA_HOME/btw/<sessionId>.json`，共享路径在 `mica-common/btwState.ts`。
- 空线程（点了「+」还没提问）不落盘、不从磁盘恢复：`BtwThreads` 的 `exportState` / `restore` 与 `readBtwState` 都按 `entries.length > 0` 过滤，否则重启后抽屉里会多出一排「新线程」。抽屉对失败/被中断的条目给「重试」，Alt+↑/↓ 翻本线程问过的问题，Cmd/Ctrl+Shift+B 开关抽屉。
- 抽屉里的失败提示落在它自己那条通知栏里（`BtwDrawer` 的 `notice`），不写到主对话：抽屉开着时主对话那条 notice 在背后，用户只看得到「点了没反应」。抽屉关着时才走会话 notice。
- 线程上限唯一来源是 `mica-common/btwLimits.ts` 的 `BTW_MAX_THREADS`（host 与渲染层共用），当前 6：到上限时「+」直接禁用，`BtwThreads.open` 返回可展示的拒绝，**不再**悄悄淘汰最早的空闲线程——被淘汰的 tab 在客户端还在，点进去只会用一个 host 已不认识的 id 重建空线程，之前的问答就丢了。
- BTW 不进主对话上下文、不占主队列、不改 run 生命周期；用量单独记账（插件线程记 `origin: 'plugin'`，抽屉侧记 subagent `btw`）。

## 运行观察

- 运行观察走通用 `agent:observe` hook（`AgentObservationEvent`，owner/runId 关联）：运行开始/终态、请求边界（`request:start` / `request:end`：耗时、首字延迟、重试次数、tool 数）、最终 prompt、工具调用/结果、用量、重试、历史改写与压缩（`compaction`：策略 local/llm/idle、原因、前后条数与字符、是否真的改了历史）；委派运行带 `delegation: { type, parentSessionId }` 且 runId 取负数，与父运行分开。不在任何一轮里的工作同样在范围内：`createSubAgent` 与 `startHelperRun` 给它们补上负数 runId 的一对 run 事件、请求边界与用量。观察失败不得中断任务。
- 「这次回答没被接受」只认用户动作，不认模型自评：宿主把改写重跑、撤回排队消息翻成运行时事件 `input:corrected`（`kind: edit|recall`，撤回没取回时不发），插件自己决定怎么用。
- 不在任何一轮里的工作也算观察对象，只是分类不同：`run:start.helper: { kind, pluginId?, purpose? }` 标出压缩摘要（`compaction`）、旁问线程（`thread`，带 pluginId）、桌面 BTW（`btw`）、插件经 `ctx.llm` 问模型（`plugin-llm`）。它们与主运行一样有 `request:start` / `request:end` / `usage` / `run:finish`（`createSubAgent` 与 `startHelperRun` 都从同一条包装路径发事件），runId 取负数。归并成本必须按 `helper.kind` 分开：「自动压缩每次摘要 40 秒」和「某一轮慢」不是一件事。helper 运行不参与「用户重试同一任务」的推导——它的输入是压缩用的 transcript 或插件自己的文本，拿它跟上一轮用户输入比相似度必然误报。
- 插件自身的运行事件走 `plugin:observe` hook（`PluginObservationEvent`）：常驻任务抛错（`background:failed`）与钩子处理函数抛错（`hook:failed`，带本进程内该钩子的累计失败次数）由宿主 `hooks.notify`。它不属于任何一条 run，硬塞进去会让那条 run 的耗时与失败原因都变假。`agent:observe` 仍然只描述一次运行的起止与过程。
- 仍然**不覆盖**：插件装配结果（读 `plugin-status.json` 快照；装配失败与跳过是宿主事实，不是运行事件）。官方 `harness-review` 插件异步写 `$MICA_HOME/plugin-data/harness-review`，通过 `/harness-review list|report|prune|rebuild|assess` 和 `harness_review` 查看、导出、清理、重算、记录人工评估；按 cwd 复盘（helper 运行不进 Runs 表、单独按来源汇总；插件自身的失败是机器级事实、不随 cwd 过滤（失败次数因限流是下界）），不自动修改 harness。报告的「Waiting / first token」列读 `request:end`——老摘要没有它，如实显示 `—`，不要用整轮时长冒充。
- 问题信号的精度是这类插件的核心，宁可少报也不要误报：非零退出码按**命令语义**判定（`rg` 无匹配、`ls`/`test` 找不到、`diff` 有差异不算工具错误，计入 `expectedExits`；`rg` 退出 2、`bun test` 退出 1 仍是真错误），决定 `$?` 的是链式命令的最后一段与管道的最后一个命令；重复调用只在结果逐字节相同且中间没有写操作时报，轮询类工具整个排除。findings 是派生数据，实时写入与 `rebuild` 重放必须共用同一份推导逻辑，`CLASSIFIER_VERSION` 变化后常驻宿主自动重算一次；摘要记 `hostPid`，复盘前按进程存活（早期记录按摘要静默时长）把僵尸运行回收成 `interrupted`。
