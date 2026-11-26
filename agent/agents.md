# 多 Agent、压缩与循环

## Subagent

- `plugins/subagent` 派生的独立 app-server 会话继承父 CLI 显式的 `--mcp-config`、`--strict-mcp-config` 与 `--mcp-init-timeout-ms`；配置路径按父启动 `--dir`（省略时为启动 cwd）绝对化，不随父会话之后换目录漂移，沿用原配置中的 owner，不生成新授权、不写用户配置。共享控制资源的委派须协调各自创建的窗口与终端；子会话仍不提供桌面专属插件能力面。
- subagent 不设任何自动限制：`subagent_drive` 没有 `max_turns` / `max_tokens` 参数，迭代轮数、token、并发数、嵌套层数都不限（也不写深度标记）。插件里没有会在别人干到一半时自动按下停止键的机制——停滞只提醒、空闲回收默认关（0 = 不收）。要停只能显式 `subagent_stop`（`interrupt` 打断这一轮 / `close` 收进程）；父会话/宿主退出时子进程会被一起收掉，但把 grace 留到 3 秒，让正在跑的那一轮有机会落盘。不设深度标记后，`resolveCliCommand` 只认 `apps/cli/**` 下的入口，避免 dev 下拿探针脚本当入口导致无限自我派生。
- 工具面是**四个动词、一个主语**（`session_id`）：`subagent_drive`（不给 id 新建、给 id 接管任意已落盘会话或追加一句，拒绝接管当前会话自己）/ `inspect`（状态与 `full` 收尾视图、`view: turns|grep|transcript` 三档内容；`session_ids` 可批量，`full` 与 `view` 同用时再附一份收尾投影）/ `wait` / `stop`（`interrupt|close`；`interrupt` 等到这一轮真的停下才回报，`close` 里 `all` 选全集、`idle` 只收跑完的，给了 id 就只在那几条里挑）。同一件事的不同力度用参数表达，不按实现分层摊成一排工具名——工具 schema 进每次请求的前缀；也没有另一套「按会话 ID 通用控制」的工具族。真实链路里模型会把 schema 里的字段全部填满（`view` 与 `session_ids` 同传、`full` 与 `view` 同传），所以这些组合必须**可用**而不是被拒：拒绝一次它就会用同样的参数重试。
- `subagent_wait` 的多目标等待**默认任意一个满足就返回**（`all: true` 才等全部）：并行派三个时第一个跑完/失败/退出的结果直接回到模型手里，附带其余「还在跑/已失败」的一行状态，模型据此决定重启失败的那个还是继续等。工具描述、SKILL 与这里使用同一套说法。
- 子会话动态不只在下一轮 prompt 里出现：一轮结束 / 进程退出 / 停滞 / 后台等待成立时，父会话**空闲**就经 `ctx.runtime.submit(text, { source: 'system' })` 自动开一轮把事件送回来（`mica exec` 的 one-shot 宿主禁用；`startAsSubmit` 尊重 `source`，插件发起的轮次不推 `mica/turn/input`，客户端不会补一条乐观用户气泡；会话记录仍按 provider 历史把这条系统输入投影成一条消息）；父会话**正在跑**就攒到 `turn:after` 再送。同一批 800ms 内合并成一条，用户输入框有草稿或已有排队消息时不抢，送达成功才从事件队列摘掉（`peekEvents` / `dropEvents`）。`turn:after` 在 0ms 后 flush，等 headless 的 `running` 退出循环；此时若还有 running 的子会话，写一条「还有 N 个在跑、跑完会自动回来」的 notice。插件设置 `wake`（默认开）关掉后事件仍走下一轮 prompt 段落。

- 进程内委派是插件 `plugins/subagent-legacy/`：`agent` 工具、7 种内置类型、委派 prompt 段落都在插件里；内核只留机制（`ctx.subagents`，实现在 `apps/cli/src/agents/PluginSubagentHost.ts` + `SubagentTaskManager.ts`）。停用该插件后既没有 `agent` 工具，也没有提示词里的委派指引。要「独立环境 / 长时间盯着 / 反复追问」用 `plugins/subagent`（独立会话），要「拆开一段推理、并行几份只读调研」用这条进程内委派。
- 内置类型：general-purpose、Explore、Implementer、Reviewer、Tester、Planner、Proposal；`maxTurns` 唯一默认值在 `plugins/subagent-legacy/definitions.ts`（999：截断一次要重做半成品，代价比多跑几轮高）。
- `SubagentTaskManager` 按 owner 隔离任务与 abort signal，任务记录带 `pluginId` 供 `ctx.subagents.tasks.*` 收窄；后台完成元数据回注 owner，结果显式 read/await。parent Ctrl+C 同步中止其运行中的子代理。
- 常驻宿主持久化子代理记录到 `$MICA_HOME/subagent-tasks/<sessionId>/<taskId>.json`（`mica-common/subagentState.ts`），每轮按 owner 只写变过的那条。旧单文件数组不再读取，由 Evolution 的 `subagent-task-files` 拆分并归档。resume 时 `restore()` 把记录读回来供详情与重启使用，`status: running` 只在该进程确实已退出（`ESRCH`）时才降级成 failed——PID 复用与权限错误一律当作仍在跑。恢复的只是记录，执行句柄、abort signal 与 timeline 现场不恢复。
- 重启不是「继续上一次执行」，是**用原任务和最近活动作上下文新起一个任务**：`mica/subagentTasks/restart` → `SubagentTaskManager.restart()` → 插件的 restart handler 重新过工具白名单、写策略与路径租约，成功后才创建替代任务。跨进程只允许一个进程重启同一个任务：`claimSubagentRestart()` 用不可变世代文件 + 原子硬链接占位，`commitSubagentRestart()` 把完整替代任务记录与提交标记用一次 `link` 发布，`releaseSubagentRestart()` 只在确实失败时释放；持有进程崩溃的 claim 可被下一个进程接管，已提交或已释放的不能被再次占用。重启失败要释放已申请的租约并允许重试。
- 恢复任务的刷新不依赖内存已有 restored 条目：空集启动后 Evolution 才迁出任务文件也要在目录指纹改变时发现。相同指纹跳过全文读取，切换会话时清掉 owner 的指纹缓存，当前本地执行句柄不会被磁盘投影替代。
- 前台委派默认阻塞，同消息多个调用可并行；需要主流程继续时用 `run_in_background: true`；每 owner 合计并发上限 4。
- turn 结束即收尾它起的后台子代理（`killRunningForOwner(owner, 'Parent turn finished.')`）：这一轮已经交付，结果只能经 `agent operation=read` 取回，而下一轮的模型不会去读上个 turn 的 `task_id`。留着它们只会在状态栏挂一条永远 running 的条目并继续烧 token。收尾在 `turn:after` 之前（TUI 在 `LocalRuntimeController.runTurn` 的 finally，headless 在 `HeadlessTurnExecutor.emitTurnAfter`），且不发完成通知。
- `context_mode` 为 none/brief/recent/files，默认 brief；Implementer / Tester / Proposal 必填 `owned_paths`。文件写入按租约原路径校验；shell cwd 可在租约内，也可在包含租约的目录中运行，上界是任务工作区根。租约指向外部 checkout 时以上溯遇到的 `.git` 文件或目录为界，独立外部路径的祖先只到直接父目录。不能用无关兄弟目录或工作区外的祖先；cwd 只是执行位置，不是 shell 文件系统沙箱，命令仍须遵守写策略。判定唯一实现在 `mica-tools/utils/pathOwnership.ts`；前台、后台与 `wait_for(kind=command)` 都先按进程目录解析默认 / 相对 cwd，再用同一绝对目录做校验和执行。
- **租约只说明「允许写哪里」，不说明「这些 diff 是谁写的」**。评审子代理改动时，租约外的文件不等于「我的子代理越界」——同 cwd 可能还有别的会话或用户自己在改，`git status` / `git diff` 都不带作者。看到不认识的改动先查 `session_peers`（同 cwd 会话 + 它们本轮写过的文件），判断不了就报告给用户，不要整文件还原；租约内的文件同理，一个文件里可能混着几方的改动，整文件覆盖会连带删掉别人的工作。
- 委派倾向由插件设置 `delegationMode` 决定（`proactive` 默认 / `on-request`），prompt 段落每轮按设置重新渲染。
- 重试只有一层：单次请求由 provider 的 `withRetry` 处理（10 次，任何没正常结束的请求都重发）。子代理整轮失败后不自动重跑——写操作已经执行过一半的回合重来一遍更危险；要重试由父代理先 `read` 看清错误再决定。`run_many` 以 `max_parallel` 作为滚动执行名额，ready 队列在任务真正结束并释放执行资源后继续派发；无序重叠 `owned_paths` 必须用依赖声明顺序或串行批次。单条任务启动失败（租约冲突、并发已满）只结算该任务，批次末尾给出 completed/partial/failed/skipped/running 统计。宿主报告的失败原因单独成段，不跟着 `Raw result` 一起被截断。
- 内置子代理达到默认 `maxTurns` 后复用原实例和工具历史续跑最多两次，保留任务、租约与累计用量；显式请求的 `maxTurns` 是硬上限，其他类型通过 `maxTurnContinuations` 选择续跑。续跑不重放工具调用，但模型仍可能自行重复调用。
- 任务状态四态之外还有 `partial`：用完续跑预算或显式 `maxTurns` 的子代理有可用成果但没完成任务，任务记录、`tasks.get`、工具输出与 `join` 统计都用它，不要退化成一个 `failed`。`await` / `join` 默认 `wait_mode: all`，也支持 `wait_mode: any` 在任一任务终态时返回全部当前快照；省略 `timeout_ms` 时按 10 分钟上限等待，超时返回当前状态让模型自己决定继续等还是放弃——不设上限的等待只能靠用户中止。
- 路径租约在 `prepareSpawn` 里判定（`owned_paths` 解析之后、建子代理实例之前）：冲突直接抛错，不会白建一个子代理，也不会在任务表里留一条从未跑过、0 用量的失败记录。
- 非主请求都要记账：Agent 走 `recordSubagentUsage`；BTW、摘要等走 `recordSubagentTaskUsage` / `recordHelperSubagentUsage`；插件自己的模型请求走 `ctx.models.request`，宿主在发起时绑定会话 id，以 `origin: 'plugin'` + `pluginId` 记进原会话的 `subagentUsageHistory`（Stats 的 By source 卡片与会话详情可见），同时经 `createPluginModels` 的 `trace` 作为一条 `plugin-llm` helper 运行进观察流（没有会话可归属的一次性命令只记账、不进轨迹）；`ctx.subagents.run/background` 起的后台子代理也写 `pluginId`，主对话经工具委派的那条写 `origin: 'delegation'` 并同样带 `pluginId`（类型提供者，通常是 `subagent-legacy`）。**每条记录都要能回答「哪个插件发起的」**：Stats 的 By source 按这个字段把请求挂到插件（父级）下面，老记录缺的这部分由 `evolution` 的 `usage-source-owner` 迁移补齐（内置委派类型 → `subagent`（随后由 `subagent-plugin-rename` 归到改名后的 `subagent-legacy`），`btw` / `commit` / `memory-curator` → 各自插件），所以界面没有「没有归属」的兜底分支。插件经 `ctx.agent.compactIdleHistory` 触发、又没配自己的摘要模型时，宿主把插件 id 透传进摘要子代理，那笔开销记在插件名下（`origin: 'plugin'`）；内核自己压的（`/compact`、`mica compact`）没有插件可归属，仍是 `helper`。等待期间切换会话不改变归属，旧会话已删除则不重建。插件里不出现自己拼的模型 HTTP 客户端——那笔开销没人记。

## 压缩

| 入口                                                         | 行为                                       |
| ------------------------------------------------------------ | ------------------------------------------ |
| `/compact`、桌面快速压缩、`mica compact --tool-results-only` | 本地清理，不调用模型，可重复执行；压缩区里全部工具调用与结果聚合成「一条调用 + 一条结果」的占位说明（工具名 × 次数），思考一并丢弃 |
| `/compact llm`、`mica compact --session`                     | 模型摘要 checkpoint，会重写历史            |
| `--prune-only`、loop 轮前压缩                                | 本地清理，无可清理内容时可丢最早轮次       |

- 快速压缩（`toolResultsOnly`）只动「压缩区」（受保护区之前的历史）：工具调用与结果聚合成一对 `call_id: mica_compact` 的占位消息，参数为 `{}`，说明文本形如 `[Mica compact] Placeholder for 42 collapsed tool calls (not a real result): read_file × 18, bash × 12, …; re-run or re-read if needed.`；压缩区的思考（Responses `reasoning` 条目、Chat `reasoning_content`）一律丢弃——call_id 全变了，留着就是无效引用。
- 会话压缩是官方插件 `plugins/session-compact/`，有两个手动入口（会话右键菜单）；模型配置变更后下一次发送前自动快速压缩，没有阈值、次数与定时触发：
  - 快速压缩 → `agent.compactIdleHistory({ mode: 'quick' })`，与 `/compact` 同一条实现（`toolResultsOnly`）：工具过程聚合成一条占位调用、思考与媒体清掉，用户与助手的正文原样保留、顺序不变。不调模型；压完这一区的工具过程不再能原样重放（只剩工具名与次数），要细节就重新读文件、重跑命令。
  - 模型压缩 → `agent.compactIdleHistory({ mode: 'model', summarize })`，历史折成 checkpoint 摘要 + 最近几轮。摘要请求只带用户与助手的对话（`summaryInput: 'dialogue'`：工具调用、工具结果、思考都不进摘要输入，它们占九成篇幅却不进结论），走清单 `llm`（「压缩摘要模型」面板）：默认复用当前会话模型，也能换成更便宜的独立接口，失败自动降级；插件只决定「谁写这段摘要」，分段、预算与截断仍归内核的 `CompactionService`。
- 轮次之外的压缩会改写已落盘的会话历史（`compactIdleSessionHistory`：拿到 turn lease → 压内存里的快照 → 根据当前压缩结果生成 `conversationMessages`，连同 notice 落盘）。界面完整展示当前持久化记录，模型压缩后旧历史会随之变为摘要加最近几轮，不另外保留永不变化的原始展示历史。会话正忙（这一轮在跑、另一个进程持有 lease）时宿主回 `busy`，插件只提示「等这一轮结束再压」，不排队、不插进正在跑的请求。
- 这条通路整段跑在宿主的**维护窗口**里（`runAppServer` 的 `runIdleTask` → `runMaintenance({ reason: 'compaction', label: '压缩' })`）：客户端把这几秒的发送留在排队行里（`waitingFor: 'maintenance'`），压完再补发；窗口在 `active: false` **之前**补一条 `historyReplaced`，页面先同步当前落盘的压缩记录再收排队那条，顺序不能反。
- 迭代重写句柄的 `compact(messages, options)` 只压传入的请求历史副本；`compactIdleHistory` 与 `turn:prepare` 的 `compactHistory` 则将当前压缩结果落盘并同步 `conversationMessages`，展示与持久化记录一致。
- 写盘被拒不算压缩成功：`compactIdleSessionHistory` 把 `saveCurrent` 返回 false（或写盘抛错）当失败——先退回压缩前的快照，再把错误交出去。否则内存里是压过的历史、磁盘上还是旧的，下一轮 `refreshFromStore()` 照磁盘把压缩结果整份丢掉，看起来就是「压了又回去」。
- 压缩失败只提示、不牵动这一轮：轮次之外的菜单动作把错误折成一句 `message`；轮前的 `turn:prepare` 处理器自己 catch（`failPolicy: 'continue'` 会把异常吞成一条插件日志，用户只看到「什么都没发生」），写一条 `variant: 'compact'` 的 warning notice 说明原因，这一轮照常发送；被这一轮的中止带出的 `AbortError` / `AgentAbortError` 不算压缩失败，不写 notice。跳过的原因（`empty`：没有可清理的工具过程）只进插件日志 `compact.turn-prepare`，不打扰对话。
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
- BTW 可以按用户当前请求直接修改代码和文件，包括与主流程有关的任务；隔离的是主会话控制、队列与历史，不是共享工作区。并发操作工作区时须检查现状、保留已有改动。
- desktop `BtwThreadController` 立即 ack，结果经 `mica/btw/updated` 流式推送，不堵塞 interrupt / steer / recall。
- 同线程单子代理串行，允许一条排队与撤回；不同线程可并行。线程落盘 `$MICA_HOME/btw/<sessionId>.json`，共享路径在 `mica-common/btwState.ts`。
- 空线程（点了「+」还没提问）不落盘、不从磁盘恢复：`BtwThreads` 的 `exportState` / `restore` 与 `readBtwState` 都按 `entries.length > 0` 过滤，否则重启后抽屉里会多出一排「新线程」。抽屉对失败/被中断的条目给「重试」，Alt+↑/↓ 翻本线程问过的问题，Cmd/Ctrl+Shift+B 开关抽屉。
- 抽屉里的失败提示落在它自己那条通知栏里（`BtwDrawer` 的 `notice`），不写到主对话：抽屉开着时主对话那条 notice 在背后，用户只看得到「点了没反应」。抽屉关着时才走会话 notice。
- 线程上限唯一来源是 `mica-common/btwLimits.ts` 的 `BTW_MAX_THREADS`（host 与渲染层共用），当前 6：到上限时「+」直接禁用，`BtwThreads.open` 返回可展示的拒绝，**不再**悄悄淘汰最早的空闲线程——被淘汰的 tab 在客户端还在，点进去只会用一个 host 已不认识的 id 重建空线程，之前的问答就丢了。
- BTW 不进主对话上下文、不占主队列、不改 run 生命周期；用量单独记账（插件线程记 `origin: 'plugin'`，抽屉侧记 subagent `btw`）。

## 运行观察

- 运行观察走通用 `agent:observe` hook（`AgentObservationEvent`，owner/runId 关联）：运行开始/终态、请求边界（`request:start` / `request:end`：耗时、首字延迟、重试次数、tool 数）、最终 prompt、工具调用/结果、用量、重试、历史改写与压缩（`compaction`：策略 local/llm/idle、原因、前后条数与字符、是否真的改了历史）；委派运行带 `delegation: { type, parentSessionId }` 且 runId 取负数，与父运行分开。不在任何一轮里的工作同样在范围内：`createSubAgent` 给委派与 helper 子代理补上负数 runId 的一对 run 事件、请求边界、工具调用/结果与用量（每次 `query` 包裹当时的工具回调，保留宿主活动跟踪回调，不把子工具算进父运行）；`startHelperRun` 给直接模型请求补 run 事件、请求边界与用量。观察失败不得中断任务。
- 「这次回答没被接受」只认用户动作，不认模型自评：宿主把改写重跑、撤回排队消息翻成运行时事件 `input:corrected`（`kind: edit|recall`，撤回没取回时不发），插件自己决定怎么用。
- 不在任何一轮里的工作也算观察对象，只是分类不同：`run:start.helper: { kind, pluginId?, purpose? }` 标出压缩摘要（`compaction`）、旁问线程（`thread`，带 pluginId）、桌面 BTW（`btw`）、插件经 `ctx.llm` 问模型（`plugin-llm`）。它们与主运行一样有 `request:start` / `request:end` / `usage` / `run:finish`（`createSubAgent` 与 `startHelperRun` 都从同一条包装路径发事件），runId 取负数。归并成本必须按 `helper.kind` 分开：「一次模型压缩花了 40 秒」和「某一轮慢」不是一件事。helper 运行不参与「用户重试同一任务」的推导——它的输入是压缩用的 transcript 或插件自己的文本，拿它跟上一轮用户输入比相似度必然误报。
- 插件自身的运行事件走 `plugin:observe` hook（`PluginObservationEvent`）：常驻任务抛错（`background:failed`）与钩子处理函数抛错（`hook:failed`，带本进程内该钩子的累计失败次数）由宿主 `hooks.notify`。它不属于任何一条 run，硬塞进去会让那条 run 的耗时与失败原因都变假。`agent:observe` 仍然只描述一次运行的起止与过程。
- 插件装配快照仍来自 `plugin-status.json`；装配/卸载、非会话动作等时间线另由通用 `operation.start/finish` 记录，不伪造 Agent run。官方 `harness-review` 异步写 `$MICA_HOME/plugin-data/harness-review`，通过原有 list/report/prune/rebuild/assess 入口复盘：运行按 cwd 过滤、真实 startedAt 选取后限额，helper 单独汇总；工具健康按失败率和覆盖说明判断。机器级插件失败与系统/操作/体验日志旁证不随 cwd 伪造归属。失败计数不因详细事件限流而丢失，flush/dispose 补尾；进程强杀、轮转及旧记录仍可能使历史计数为下界。list 的 JSON 上限 24000 字符，完整证据由 reportPath 导出；摘要/轨迹派生使用有界签名缓存，不长期持有日志正文，搬目录后只读当前 root 的证据。状态刷新重活不持发布锁，自动争用跳过。报告的首字等待只认 `request:end`，缺失显示 `—`，运行完成不代表用户验收。
- 问题信号的精度是这类插件的核心，宁可少报也不要误报：非零退出码按**命令语义**判定（`rg` 无匹配、`test` 条件不满足、`which` / `type` 找不到、`diff` 有差异、`git config --get` / `--get-all` 未设值不算工具错误，计入 `expectedExits`；`ls` / `stat` / `find` 退出 1、`rg` 退出 2、`bun test` 退出 1 仍是真错误）。顺序命令与普通管道由最后一个命令决定退出码，`&&` / `||` 可能短路；无法确定返回 1 的来源时明确记为未知，不能按最后一段误报，也不能当成功或预期退出。浏览器截图 / 脚本超过明确毫秒上限、provider 连续无流数据触发看门狗，均按超时分类。重复调用只在结果逐字节相同且中间没有写操作时报，轮询类工具整个排除。findings 是派生数据，实时写入与 `rebuild` 重放必须共用同一份推导逻辑，`CLASSIFIER_VERSION` 变化后常驻宿主自动重算一次；摘要记 `hostPid`，复盘前按进程存活（早期记录按摘要静默时长）把僵尸运行回收成 `interrupted`。
- Harness 的复盘、健康表与重建共用工具分类：完整配对轨迹派生 `findings`、`toolErrors`、`expectedExits`；坏文件前缀、未结束、丢事件、缺少类别或调用配对的运行不参与健康率，`toolHealthCoverage` 说明覆盖缺口，不把未知算成成功。`ls` / `stat` / `find` 的退出码 1 可能表示路径错误，按工具错误计；`test` / `[` 的条件不成立、`which` / `type` 找不到仍是预期退出。运行达到 1000 个不同调用键或 100 个 finding 上限时，摘要保存漏记数量，`list` / `report` 明示分析不完整；旧摘要缺少计数且轨迹不可完整重放时标为未知，不能把没有 finding 当作没有问题。`review` / `rebuild` 从完整轨迹重算。用户纠正收到即持久化，只有主运行能原子认领；摘要落盘后确认消费，helper / 委派也不能覆盖用户输入槽位。人工评估追加进 `decisions/<key>/<uuid>.json`，记录可见证据基线；`validated` / `dismissed` 后的新证据只产生 `reviewNeeded`，不改人工状态，`regressed` 和基线缺失同样提示复核。旧评估单文件由 Evolution 迁移，不保留运行期旧格式回退。
