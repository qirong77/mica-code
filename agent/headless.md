# Headless 与 app-server

## Turn 执行

- `HeadlessTurnExecutor` 不触碰 Ink/UI；每轮顺序：取 lease → `refreshFromStore()` → 应用输入配置 → await `turn:prepare` → `reserveRunId()` → 保存用户输入；取锁失败返回 `busy-remote`。`turn:prepare` 给插件受当前 lease 保护的 `compactHistory` 能力，将当前压缩结果落盘并同步展示记录；只在持久会话触发。排队输入只在上一轮**完成**后才接着跑，中止/失败把它留在队列里可撤回（与 `message-queue` 插件的 `turn:after` 同一条规则）——否则点了停止会先停、再把排队的话发出去、再停一次。桌面宿主的 abort 强杀兜底只针对发起中止的那一轮（`run.aborting` + turn id），不能杀中止之后新起的轮次。
- 桌面端点停止是「撤回排队 + 中断」一次动作：`chat:abort` 先经 `mica/queue/recall`（和本地 after_turn 槽）把排队消息取出来，随结果回给页面放回输入框，再发中断。取不到（已注入 / host 不响应）就留在队列里，中止后仍可按 Shift+← 撤回。
- 每轮都发 `turn:finish`，结果只有 completed / aborted / error；排队轮次同样逐轮取 lease。query resolve 后、异步 `turn:beforePersist` 后都复查 runId；失效统一进入 aborted 收尾。终态 finalizer 幂等：保存状态 → 释放租约/收尾子代理 → `turn:after` → `turn:finish`，终态 hook 抛错也不能漏发或重复发 finish。
- 每轮在取 lease 前建立独立取消标记，不能只依赖会被 refresh/prepare/重试改变的 Agent runId。取 lease 后先 refresh，以便准备期失败/中止也按最新历史收尾；图片解析、配置应用、`turn:prepare`、`turn:before`、`prompt:build` 及每次 reserve/run 前后复查取消。停止后即使准备 Promise 晚到也不再 reserve/run，仍走同一幂等 aborted finalizer；排队输入保留，下一轮使用新标记。不抢先释放仍在 await 的准备操作所持租约。
- 请求级和整轮级重试都经 `turn:retrying` 通知客户端并保存 `/retry` notice；次数与延迟取对应层实际策略，请求级重试不回放已执行的工具。重试后的那次请求跑通（`AgentRuntime` 的 `onRequestEnd` 报 `completed`）就把**同一条** notice 就地改写成 `variant: 'success'` 的「重试成功（第 n/m 次）」，次数与错误原因原样留着：一条红条留在会话里会让成功的回合看着是坏的。改写走 `notices.show`（落盘 + `mica/notice/updated`），位置不动。

## 装配

- `HeadlessPluginHost` 是 exec / app-server 共用的插件装配层；MCP 显式初始化，不注册输入框与命令 UI。用户插件（`$MICA_HOME/plugins`）只在常驻宿主装：`createHeadlessPluginHost({ loadUserPlugins: true })` 交出「重新扫描用户插件」的加载器（app-server 传 true、exec 不传），面板与桌面入口都靠它；加载与 `plugin-status.json` 的写入都由 manager 按 `pluginStateSync` 完成，启停走同一条路。
- 历史会话回查与适用记忆统一由官方 Memory 提供，宿主不再另装 `builtin.command-memory`。会话自治只保留 `session_peers` 与动态并发提醒；工具已有的静态用法不再单独注入。
- 应用独立托管的插件 MCP 不由 `HeadlessPluginHost` 再注册工具；桌面/Web 启动会话宿主时经 `--mcp-config` 传入同端口 `/plugin/<id>/mcp`，按普通 MCP 连接。TUI / exec 不自动启动应用服务，可显式配置已有 URL。
- `attachPluginLayer()` 同步替换 executor queue，避免插件写入与 loop 读取不同实例。
- `mica/turn/input`（`MICA_TURN_NOTIFICATIONS.input`）在插件发起的轮次启动**之前**发出，带展示文本；晚于 `turn/started` 会让页面把上一轮的文本当成本轮用户消息。

## 协议

- `mica app-server` 是每会话常驻进程；stdin/stdout 使用 Codex v2 JSONL。framing 在 `mica-runtime/codexProtocol.ts`，事件投影在 `runtime/CodexProjector.ts`。
- 客户端模型解析前重读磁盘 providers（不重置会话 model/effort）；删除的服务商与非法模型选择报错，不能把旧选择静默发往其他服务商。统一 pi 历史支持在现有会话中跨协议切换模型，不再按旧 wire 历史限制切换。turn 即使没有模型参数也刷新并验证当前服务商。
- `--parent <sessionId>` 标记这条会话由谁派生（子会话、fork 分支），写进会话文件的 `parentSessionId`。只对新建会话生效：resume 时以文件里记的那条为准。`thread/start` 的 `parentSessionId` 同样只被尚未落盘的会话采纳，且已有值时幂等——重复 startNewSession 会换掉会话 id，客户端手里那份 thread 就对不上落盘文件名了。
- `mica/*` 扩展通知直接送 renderer，不进 turn 重放缓冲：queue、tasks、BTW、history、capabilities、turn retrying、host maintenance。
- `mica/notice/updated` 在 `ctx.ui.notice` 的展示记录保存后即时推送 `{ threadId, notice: { role: 'notice', content, variant?, command?, status? }, replace: boolean, noticeIndex: number }`；`HeadlessPluginHost.onNotice` 是内部可选回调，exec 不传，第二参数为 `{ replace?, noticeIndex }`。`noticeIndex` 是保存后 `noticeLog().compose()` 中所有 `role: 'notice'` 行的 0-based 派生 slot，不是持久字段，也不改变持久结构或需要迁移。桌面端将其投影为普通 `notice` 事件（`text/variant/command/status/replace`，仅安全非负整数时带 `noticeIndex`），直接推送 renderer、不进 turn 缓冲；历史行按相同口径派生 slot，upsert 优先按 slot 幂等更新，既避免恢复期间 pending 终态与磁盘行重复，又保留同一 command 的多次历史。更新不重读会话、不轮询，也不借 `historyReplaced` 结束正文流。持久形态与插件 API 不变。命令型 notice（`ctx.ui.notice`）与执行器自己的 `/retry` 提示共用同一条写入口（`turnNotices.ts` 的 `publishTurnNotice`，宿主侧是 `HeadlessPluginHost.notices.show`），所以「在重试 → 重试成功」这种就地改写也会即时推到客户端。
- `mica/capabilities/get|set` 读写会话能力；运行中 set 返回 `ok:false`。get 额外返回 `prompt`（来源分段 / 下一轮预览 / 最近实际发送，段落 `label` 与可选 `pluginName` 提供可读展示，不改控制键和 XML）、`plugins`（当前 manager 装配记录与工具 / 技能 / 提示词归属）和 `mcpTools`（完整工具描述及 schema）；这些按需读取，不加入高频 capabilities 通知。全局提示词控制经配置页 API 写入 `prompt-controls.json`，不通过 set 改会话存档。
- `mica/input/activity` 是「用户在输入框敲了字」（不是提交）：宿主只把它翻成运行期事件 `input:activity`，由插件决定要不要动作。桌面端在 `ChatView` 里节流 2s 发出，没有常驻进程时 host 直接吞掉（绝不为几个按键 spawn 一个）；TUI 与 `mica exec` 不发。自动压缩不订阅它——轮次之外不压，只当「人在不在」的通用信号。
- `mica/input/focus` 是「焦点回到了输入框」（还没敲字）：同样只翻成运行期事件 `input:focus`。桌面端在 `ChatComposer` 获得焦点时发，并且只在会话没在跑（本页或其他进程都没在跑）时发。与 `input/activity` 一样，当前没有插件消费它。
- `turn/start` / `mica/turn/editMessage` 可传 role，由 host 在启动 turn 前应用；edit 时必须在 `loadSnapshot()` 之后应用。角色缺失只 warning 并保留原角色，不为切角色重建 host。
- `mica/sessionState/get|set` 读写**某个插件的会话级状态**（`pluginState[pluginId]`）。内核不解析那份 JSON：笔记这类形状由插件自己定义，桌面卡片与插件自己的 `ctx.sessionState` 读写同一份。落盘跟随本轮 checkpoint，不在 handler 里抢占 lease。
- `mica/session/cwd` 换本会话的工作目录（页面右下角那个项目路径）。宿主自己 `process.chdir` 并按新目录改已落盘的那份：盘上的 `cwd` 是 `process.cwd()` 的快照，页面直接改文件会被下一轮保存覆盖回去、那一轮也还在旧目录里跑。运行中拒绝（这一轮已按旧目录起了工具与 prompt）；`updatedAt` 不动（换目录不是会话活动，否则会话会被顶到 Recent 最前面）。桌面端 `chat:set-cwd` 优先交给这条会话的宿主，没人持锁才直接写文件，草稿（还没落盘的会话）不写。
- `mica/subagentTasks/list|detail|kill|restart` 管子代理任务：`list` 与每秒一次的 `mica/subagentTasks/updated` 快照只用于列表、且**只带运行中的任务**（`mica-common/subagentVisibility.ts`），`detail` 才带完整 timeline 并按任务记录回答，结束的任务照样查得到；`restart` 只在任务已停下、且能确认原执行进程已退出时接受（见 `agents.md`）。桌面端详情弹窗的「重启」按钮就发这一条。
- `mica/pluginPanel/view|action` 读一块插件面板的视图、转发一次动作（`pluginId + action/key/values`）；面板处理器活在常驻会话宿主里（插件就在那个进程），没有宿主时桌面端按需起一个。
- stdin 持续解析，请求由 `appServerRequestQueue.ts` 调度：写操作仍按到达顺序串行；只有明确只读的 `mica/pluginPanel/view` 可在维护窗口中越过当前耗时操作（最多 4 个并发），不能越过更早排队的写操作。后续写操作等已启动的视图完成，避免切会话时旧视图读到新身份；EOF / shutdown 等已接收请求结算后再释放宿主。面板查询和菜单动作的限频 `app-server/request.slow` 分开记录排队与执行耗时，不将压缩期间的等待归给插件视图。
- `mica/ask/updated` + `mica/ask/answer` 是插件「问用户一个问题」的那一对：前者推当前待回答的选择题（`ask` 为 `null` 表示已经结束），后者回 `{ askId, optionIds, custom? }`，宿主把它 resolve 给还在 await 的那个工具。**答题不产生 turn**，也不进事件缓冲——它只是让同一次迭代继续跑；`askId` 对不上（已超时 / 已被中止）回 `ok:false`。`turn/interrupt` 与轮次结束都会把还在等的问题按 `aborted` 结掉，界面上的卡片跟着撤掉。等待期间宿主把会话文件顶部的 `awaitingInput` 写成 `summary`，侧栏据此在列表里提醒。
- `mica/sessionMenu/run` 转发一次会话右键菜单动作（`pluginId + action`），插件回 `{ copyText?, message? }`；处理器与面板一样活在常驻会话宿主里，没有宿主时桌面端按需起一个。
- 改名先找常驻 host 调 `SessionController.renameCurrent`；无 host 且无其他进程 lease 时才直接写盘。
- 新对话（还没有会话）改名 = 这条会话此刻就要存在：桌面端按需起常驻 host 让它把空会话连同手动标题落盘，回包里的 `sessionId` 立刻绑到页签上。手动标题（`titleSource === 'manual'`）的空会话不按草稿删——`saveCurrent` 与 `discardCurrentIfEmpty` 都跳过它，否则侧栏里刚命名的会话会在换会话/落盘时凭空消失。
- `mica/turn/editMessage` 把 provider history 截断到目标用户消息之前，再用新文本重跑；定位共用 `mica-common/promptText.ts`。启动失败恢复原快照。
- `mica exec` 默认人读文本，`--json` 为 Codex ThreadEvent JSONL；保留 codex-family 参数兼容（`--cd`、`-c`、`--` 与裸 prompt）。
- resume / chdir / MCP 初始化失败降级继续；只有 resume 失败发 Codex error。unhandledRejection 记 warning，uncaughtException 发 error 后退出。JSON-RPC 的明确拒绝和 dispatch 异常另记 `request.failed`，仅固定 method、阶段、随机关联 ID、错误码和分类，不复制 params、客户端 ID、错误正文或堆栈。
