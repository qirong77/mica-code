# Headless 与 app-server

## Turn 执行

- `HeadlessTurnExecutor` 不触碰 Ink/UI；每轮顺序：取 lease → `refreshFromStore()` → `reserveRunId()`；取锁失败返回 `busy-remote`。排队输入只在上一轮**完成**后才接着跑，中止/失败把它留在队列里可撤回（与 `message-queue` 插件的 `turn:after` 同一条规则）——否则点了停止会先停、再把排队的话发出去、再停一次。桌面宿主的 abort 强杀兜底只针对发起中止的那一轮（`run.aborting` + turn id），不能杀中止之后新起的轮次。
- 桌面端点停止是「撤回排队 + 中断」一次动作：`chat:abort` 先经 `mica/queue/recall`（和本地 after_turn 槽）把排队消息取出来，随结果回给页面放回输入框，再发中断。取不到（已注入 / host 不响应）就留在队列里，中止后仍可按 Shift+← 撤回。
- 每轮都发 `turn:finish`，结果只有 completed / aborted / error；排队轮次同样逐轮取 lease。

## 装配

- `HeadlessPluginHost` 是 exec / app-server 共用的插件装配层；MCP 显式初始化，不注册输入框与命令 UI。用户插件（`$MICA_HOME/plugins`）只在常驻宿主装：`createHeadlessPluginHost({ loadUserPlugins: true })` 交出「重新扫描用户插件」的加载器（app-server 传 true、exec 不传），面板与桌面入口都靠它；加载与 `plugin-status.json` 的写入都由 manager 按 `pluginStateSync` 完成，启停走同一条路。
- `attachPluginLayer()` 同步替换 executor queue，避免插件写入与 loop 读取不同实例。
- `mica/turn/input`（`MICA_TURN_NOTIFICATIONS.input`）在插件发起的轮次启动**之前**发出，带展示文本；晚于 `turn/started` 会让页面把上一轮的文本当成本轮用户消息。

## 协议

- `mica app-server` 是每会话常驻进程；stdin/stdout 使用 Codex v2 JSONL。framing 在 `mica-runtime/codexProtocol.ts`，事件投影在 `runtime/CodexProjector.ts`。
- 客户端模型解析前重读磁盘 providers（不重置会话 model/effort）；删除的服务商及非空会话协议变更报错，不能把旧选择静默发往其他服务商。turn 即使没有模型参数也刷新并验证当前服务商。
- `--parent <sessionId>` 标记这条会话由谁派生（子会话、fork 分支），写进会话文件的 `parentSessionId`。只对新建会话生效：resume 时以文件里记的那条为准。`thread/start` 的 `parentSessionId` 同样只被尚未落盘的会话采纳，且已有值时幂等——重复 startNewSession 会换掉会话 id，客户端手里那份 thread 就对不上落盘文件名了。
- `mica/*` 扩展通知直接送 renderer，不进 turn 重放缓冲：queue、tasks、BTW、history、capabilities、turn retrying、host maintenance。
- `mica/capabilities/get|set` 读写会话能力；运行中 set 返回 `ok:false`。
- `mica/input/activity` 是「用户在输入框敲了字」（不是提交）：宿主只把它翻成运行期事件 `input:activity`，由插件决定要不要动作。桌面端在 `ChatView` 里节流 2s 发出，没有常驻进程时 host 直接吞掉（绝不为几个按键 spawn 一个）；TUI 与 `mica exec` 不发。自动压缩不订阅它——轮次之外不压，只当「人在不在」的通用信号。
- `mica/input/focus` 是「焦点回到了输入框」（还没敲字）：同样只翻成运行期事件 `input:focus`。桌面端在 `TerminalComposer` 获得焦点时发，并且只在会话没在跑（本页或其他进程都没在跑）时发。与 `input/activity` 一样，当前没有插件消费它。
- `turn/start` / `mica/turn/editMessage` 可传 role，由 host 在启动 turn 前应用；edit 时必须在 `loadSnapshot()` 之后应用。角色缺失只 warning 并保留原角色，不为切角色重建 host。
- `mica/sessionState/get|set` 读写**某个插件的会话级状态**（`pluginState[pluginId]`）。内核不解析那份 JSON：笔记这类形状由插件自己定义，桌面卡片与插件自己的 `ctx.sessionState` 读写同一份。落盘跟随本轮 checkpoint，不在 handler 里抢占 lease。
- `mica/session/cwd` 换本会话的工作目录（页面右下角那个项目路径）。宿主自己 `process.chdir` 并按新目录改已落盘的那份：盘上的 `cwd` 是 `process.cwd()` 的快照，页面直接改文件会被下一轮保存覆盖回去、那一轮也还在旧目录里跑。运行中拒绝（这一轮已按旧目录起了工具与 prompt）；`updatedAt` 不动（换目录不是会话活动，否则会话会被顶到 Recent 最前面）。桌面端 `chat:set-cwd` 优先交给这条会话的宿主，没人持锁才直接写文件，草稿（还没落盘的会话）不写。
- `mica/subagentTasks/list|detail|kill|restart` 管子代理任务：`list` 与每秒一次的 `mica/subagentTasks/updated` 快照只用于列表，`detail` 才带完整 timeline；`restart` 只在任务已停下、且能确认原执行进程已退出时接受（见 `agents.md`）。桌面端详情弹窗的「重启」按钮就发这一条。
- `mica/pluginPanel/view|action` 读一块插件面板的视图、转发一次动作（`pluginId + action/key/values`）；面板处理器活在常驻会话宿主里（插件就在那个进程），没有宿主时桌面端按需起一个。
- `mica/ask/updated` + `mica/ask/answer` 是插件「问用户一个问题」的那一对：前者推当前待回答的选择题（`ask` 为 `null` 表示已经结束），后者回 `{ askId, optionIds, custom? }`，宿主把它 resolve 给还在 await 的那个工具。**答题不产生 turn**，也不进事件缓冲——它只是让同一次迭代继续跑；`askId` 对不上（已超时 / 已被中止）回 `ok:false`。`turn/interrupt` 与轮次结束都会把还在等的问题按 `aborted` 结掉，界面上的卡片跟着撤掉。等待期间宿主把会话文件顶部的 `awaitingInput` 写成 `summary`，侧栏据此在列表里提醒。
- `mica/sessionMenu/run` 转发一次会话右键菜单动作（`pluginId + action`），插件回 `{ copyText?, message? }`；处理器与面板一样活在常驻会话宿主里，没有宿主时桌面端按需起一个。
- 改名先找常驻 host 调 `SessionController.renameCurrent`；无 host 且无其他进程 lease 时才直接写盘。
- 新对话（还没有会话）改名 = 这条会话此刻就要存在：桌面端按需起常驻 host 让它把空会话连同手动标题落盘，回包里的 `sessionId` 立刻绑到页签上。手动标题（`titleSource === 'manual'`）的空会话不按草稿删——`saveCurrent` 与 `discardCurrentIfEmpty` 都跳过它，否则侧栏里刚命名的会话会在换会话/落盘时凭空消失。
- `mica/turn/editMessage` 把 provider history 截断到目标用户消息之前，再用新文本重跑；定位共用 `mica-common/promptText.ts`。启动失败恢复原快照。
- `mica exec` 默认人读文本，`--json` 为 Codex ThreadEvent JSONL；保留 codex-family 参数兼容（`--cd`、`-c`、`--` 与裸 prompt）。
- resume / chdir / MCP 初始化失败降级继续；只有 resume 失败发 Codex error。unhandledRejection 记 warning，uncaughtException 发 error 后退出。
