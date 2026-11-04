# Desktop

## 三层边界与装配

| 层                    | 职责                                                                    |
| --------------------- | ----------------------------------------------------------------------- |
| `src/host/`           | chat、terminal、files、git、stats、配置、loop、共享状态等业务           |
| `src/server/index.js` | 自包含 Node HTTP 运行时，托管 renderer，`POST /api/invoke` + SSE 事件流 |
| `src/main/index.js`   | Electron 容器：启动运行时、窗口导航、未读徽标、窗口状态                 |
| `src/renderer/`       | 页面；`transport.js` 统一实现 `window.mica` 与平台差异                  |

- 外壳不注册通用业务 IPC、不加 preload；页面始终通过 HTTP + SSE 访问运行时。主进程只保留三项业务例外：受控浏览器、终端控制、系统检查（TCC 权限状态只属于有 app 身份的那个进程，运行时进程拿不到）。
- 运行时构建保持 `ssr.noExternal: true`，只 external Node 内置模块与 node-pty。新增依赖后跑 `npm run build:server && npm test`。
- `package.json` 的 `dependencies` 只放主进程/运行时真正 require 的包；renderer 依赖全部归 `devDependencies`。
- `electron.vite.config.mjs` 的 `resolve.dedupe: ['react', 'react-dom']` 不能删。
- `tablerIconDeepImports()` 只影响 build，新增图标无需同步清单。
- 页面根节点必须套 `renderer/src/ErrorBoundary.jsx`。按需视图统一用 `renderer/src/lazy-view.jsx` 的 `lazyView(loader, name)`：校验导出、局部捕获失败，重试时重建 lazy 实例；外层仍由 `Suspense` 提供加载占位，单个视图失败不能卸掉整个对话页面。
- 运行时启动即 `stripContainerEnv()`；受控浏览器与终端 socket 只在 `will-quit` 关闭。
- 同一时刻只起一个 Electron 实例；验证时串行。

## 共享状态与路由

- 运行时只有一份 workspace / drafts / layout / rightTerms / terminalOpenByChat / cwd / Git 偏好，落盘 `userData/ui-state.json`；语义在 `mica-web-shared/ui-state.ts`。老版本单独存的 `workspace.json` 只在 ui-state 还不存在时导入一次、落盘后删除；ui-state 已存在就不再读它（否则用户清空过的工作区会被搬回来）。
- 条目补丁用 `setUiStateEntries`，null 表示删除；回声在 store 的 `applyRemote` 认领一次，组件不得各自认领。
- 同一 session 在所有页面是同一 node、run、终端；`dedupeSessionNodes` 合并重复页签。
- 默认 `0.0.0.0:8787`，没有账号体系，只有一道可选的口令；README 保留风险说明。非回环（且不在 `MICA_DESKTOP_TRUSTED_CLIENTS` 里）的连接**只公开别人手上那条分享链接**：`/share?session=<存在的会话>`，其余页面、`/remote/*`、`/mcp/*` 回 404 或登录页，**`/api/*` 没有凭据也回 404/401**（它等于整台机器）。唯一例外是探活指纹 `GET /api/health`（只回 `{ ok, app, access }`）：侧栏 Connections 连另一台机器必须先探通它，`access` 说明对方要不要口令，没开时由卡片直接给出可操作的提示而不是打开一个 404 窗口。路径分类唯一实现在 `host/access-core.js` 的 `classifyRemotePath`，放行判定在 `host/remote-access-core.js` 的 `remoteAccessDecision`，不要另写第二份白名单。
- 端口常量唯一出口 `mica-web-shared/runtime-port.js`；页面路径约定唯一出口 `app-paths.ts`。
- 单端口路由：`/`、`/mica-web`、`/share`、`/terminal-control`、`/mcp/browser`、`/mcp/terminal`、`/api/*`、`/remote/control/*`、`/remote/terminal/*`。编辑器与评审都是主应用里的视图，不占额外页面。
- 受控浏览器与终端服务走 `userData` 下的 Unix socket；`apps/config-web` 是独立宿主（默认 13987）。
- `shareView` 只影响呈现，不是权限边界；`access-core.js` 校验 Origin / Host 防跨站与 DNS rebinding。
- 分享地址用 `access:info.shareBaseUrl`，不以本机 `location.origin` 兜底；链接形如 `/share?session=<id>`。
- 切换服务器：页面 origin 即当前服务器；由 host 探活后开新窗口/标签页，不做代理或跨源 API 层。探活与打开都用**完整入口**（`@packages/mica-web-shared` 的 `probeRuntime`）：中转机链接丢了 `?t=` 只是台没人认识的域名，外壳会把它当外链丢给系统浏览器；中转机窗口的身份是「origin + t」，所以同一台中转机后面的两台机器各开一个窗口。
- 运行时里的用户终端面板与主进程终端控制是两套，不复用会话。
- 终端里手跑的 `mica` 一轮结束时按**那条 PTY** 记未读（`host/notifyServer.js`，terminalId 是 `<终端条目 id>:<pane>`），main 的 dock 徽标数的是它的总数。标记已读必须用回这个 terminalId：按条目拼一个 `<条目 id>:mica` 会打到不存在的终端上，未读永远清不掉（徽标点不掉的来源）。PTY 级状态归并成条目视图只给界面用（`renderer/src/notify-state.js`），清未读只能对未读的那条 PTY 发；对话底部终端（点标签、在面板里敲字/滚动、焦点回到窗口时它就在屏幕上）与编辑器终端都要发出这条「看过了」的信号，否则那条会话的提醒除了重开终极端口没有别的出路。
- 两处**提示音**都在 `renderer/src/notification-sound.js`（WebAudio 现场合成，不带音频文件，`unlockAudio()` 在第一次手势时唤醒）：一轮结束是两声上行（`completed`），插件抛出选择题是下行再重复一遍（`ask`，与前者刻意反着，听一耳朵能区分）。结束音挂在 PTY 的 `turn.completed` 上（`App.jsx` 的 `useNotifications`），问句音挂在 `chat:ask` 上（`useAskChime`，按 `ask.id` 去重，宿主重推同一道题不再响）。两者都不看窗口是否在前台——提醒的意义就在于用户可能正在别处。

## 对话与输入

- chat run 按 nodeId 存于 `host/chat.js`；请求级发送错误走 `chat:queue-error`，回滚乐观消息并恢复草稿。host 进程在应答 `turn/start` 之前就退出时走同一条路径（`chat-host-requests.js` 结算未应答请求）：那一轮从未跑过，气泡必须撤回，否则消息看起来已发送、会话里却不存在，双击编辑只会得到「找不到要编辑的消息」。
- 常驻宿主预热：渲染层每换到一个节点调一次 `chat:warm`，宿主侧只保证「App 开着就至少有一个宿主」（`chat-warm.js` 的 `resolveWarmAction`，已有活着的宿主就跳过，切页签不会各自养一个进程）。插件只载在会话宿主里，而宿主是按需 spawn 的——没有预热时重启桌面端后不发消息就没有宿主，桥与定时循环停摆，手机端显示「暂时不可用」。
- 闲置宿主回收（`chat-idle.js` 的 `resolveIdleReap`，每分钟扫一次）：开着不用的页签会一直占着 app-server（一个 50–270MB），一天下来能堆到几百 MB。判定只收「没在干活」的：有轮次 / 压缩 / 中止进行中、`hostPending` 或本地排队里有消息、btw 线程在跑的一律不动；按最近活动时间留最新的一个（插件只活在会话宿主里，收干净会让手机桥与定时循环停摆）；默认闲置 30 分钟才收，`MICA_CHAT_IDLE_REAP_MS` 可调。另有一条硬上限 `IDLE_MAX_KEEP = 3`：排在前 3 之外的宿主不看闲置时长、只要空着就收——进程数量本身就是代价，而插件只活在最近活动的那个里。收掉之后用户再发消息由 `startRun` 按需 spawn 并带原 sessionId 续跑，只多一次冷启动，历史不受影响。
- 队列唯一投影 `chat-queue.js.mergeQueuedItems`：host after_iteration 在前，本地 after_turn 在后；宿主占着会话时（轮次之外的会话压缩）条目带 `waitingFor: 'maintenance'` 与 `waitingLabel`，排队行据此说「<label>结束后发送」而不是等迭代边界。
- 宿主报告 `mica/host/maintenance active` 期间（会话压缩占着会话：压缩期间宿主读不到 stdin，模型摘要是几秒到几十秒的等待——两种都不能让发送插进去）新输入走 `startRun` 的维护窗口分支：第一条进本地队列并如实回 `queued`，已有排队就按单槽就地拒绝。窗口关闭（`active: false`）时 `replayMaintenanceQueue` 只补发 `waitingFor: 'maintenance'` 的那一条，按宿主此刻状态分流——这一轮还在跑就 steer 进当前 turn（排队行原地变成「工具调用结束后发送」），已经空闲才 `turn/start`；`run.aborting` 时只刷新队列、不替用户发出去。渲染层拿到 `queued` 时若这一条本来没在排队，要把乐观的「正在运行」收回去——它确实还没跑。
- 排队消息只在输入框上方的 dock 里出现（`ChatView` 的 `transcriptMessages` 过滤带 `queued` 的行），每条一张卡片：头部是编号 / 「排队中」/ 时机芯片 / 右侧「撤回并编辑 ⇧←」，正文两行截断、悬停看全文；整卡双击与按钮同为一次撤回。时机芯片按 `items[0]` 取文案（`queueSendTiming`）：维护窗口 → 「<label>结束后发送」、轮次已结束 → 「下一轮开始时发送」、`after_iteration` → 「工具调用结束后发送」、其余 → 「本轮结束后发送」。文案是中文（与其它排队提示一致），不要再写成整句英文加 `shift + ← or double click to re-edit` 那种会折行的长句。
- `mica/queue/hold` 冻结待撤回条目，结果由 `chat-recall.js.resolveQueueRecall` 判定为回输入框 / 已发送 / 保留。
- `run.events` / `run.prompt` 每轮重置；恢复先用 `historyBeforeRunReplay` 裁掉本轮已保存回答再重放。
- 每次模型请求后立即转发 usage；实时 usage 不改 turnState / updatedAt。
- 阶段文案与计时读 `statusLinePhase`；`mica/turn/retrying` 让状态行显示 `retrying n/5`。
- 文件补全 CLI / desktop 共用 `mica-file-mentions`；`@` 与 `/` skill 补全只在词首触发，选中只插文本（文件插 `@路径`，skill 插 `[skill:name](SKILL.md 绝对路径)`）。
- `/` 浮层混排 skill、MCP server 与插件清单声明的条目（`completions`，类型标记「指令」）；前两类插入的是一枚 markdown 链接：`[skill:name](SKILL.md 绝对路径)`、`[mcp:name](接口地址)`（http 的 server 才有地址，stdio 退回 `config.json`），第三类插入清单里写好的那段提示词（`insert`）。目标含空白或括号时整条包进 `<…>`（CommonMark 允许），**不**做百分号编码——那会让模型读到一个要再解一次才成路径的东西。消息体里这类引用由 `splitTextByCapabilityRefs` 收成 `skill:name` 一枚短标签，点开仍是完整目标（原文一个字不改，编辑重发靠它定位）。两边都包含**内置能力**，不需要用户配置：skill 来自磁盘扫描 + 插件发布的 `$MICA_HOME/plugin-skills` 索引 + **插件清单声明的 skill 目录**（后者只解析 `plugin.json`、不导入插件代码，所以第一次打开就看得见随包 skill，不用等插件 setup 过一次；`skills-core.js`；索引里声明了角色的条目按会话当前角色过滤，`skills:list` 的 `role` 参数就是它，取输入条上还未发送的 `activeRole`），MCP 来自 `config.json` + 运行时按 socket 能力算出的 `mica-browser` / `mica-terminal`（`mcp-candidates-core.js`）；插入文本与普通条目一致。
- 每行是「名称 | 说明 | 类型 | 来源」四列，列数必须与行内子元素一一对应（多出来的子元素会掉到第二行，浮层看起来就是歪的）。类型标记写 `skill` / `MCP`（`@` 文件补全的 `file` 不画，一整屏都是文件时标一排只是噪声）；来源标记是 `source: { kind, label, detail? }`，kind 取 `builtin` / `plugin` / `project` / `user` / `config`：插件带的写「插件 <id>」、项目目录写 `.mica/skills` 这样的相对路径、用户目录写 `$MICA_HOME/skills` / `~/.agents/skills`、MCP 写「内置」或 `config.json`；`detail`（SKILL.md 路径、`config.json` 路径、插件 id）放悬停提示。来源由 host 两个扫描器给，渲染层只做白名单校验（不认识的 kind 整条丢掉），`label` 同时参与查询匹配但没有高亮——说明列只讲「这东西干什么」。
- desktop composer 不分派斜杠命令；输入历史只由 Alt+↑/↓（CLI 另支持 Ctrl+P/N）翻。
- ⌘/Ctrl+P 在主区顶部打开会话快速搜索（`SessionQuickOpen`，VS Code quick open 那种：标题 / 路径 / 分组匹配，不搜对话正文）；文件视图里同一组合归编辑器的文件快速搜索（`QuickSearch`），两处由 `disabled` 按视图分工，不要同时抢这个键。
- ⌘/Ctrl+K 聚焦侧栏搜索：焦点在对话输入框里也要能用（「刚敲完一句想翻旧会话」是最常见的入口），终端、编辑器与别处的输入框不抢，macOS 上只接管 ⌘K（Ctrl+K 在文本里是「删到行尾」）。侧栏收着（桌面折叠 / 手机抽屉）时先露出来再聚焦——快捷键与焦点规则在 `App.jsx`，输入框在 `SessionTree`。
- 从 ⌘P 点开一条会话后侧栏会自动把它露出来：`session-reveal.js` 的 `planSessionReveal` 只算「要展开什么」（分区 / 分组祖先 / 父会话祖先 / Recent 分页），`SessionTree` 负责展开、`scrollIntoView` 与 `.session-row-flash` 闪一下。搜索态占着列表时请求先挂着，查询清掉才落地（那时树才画出来）。
- 输入框内容变化会节流 2s 发一次 `chat:input-activity` → `mica/input/activity`（空输入不发）：它只服务「这个人回来了」这类提前量，当前没有插件消费（会话压缩只在右键时动手），没有常驻进程时直接丢弃，不回包也不影响输入。
- 输入框获得焦点发一次 `chat:input-focus` → `mica/input/focus`（只在会话没在跑时发）：同样是提前量。两条都只在已有常驻 host 时转发，不为一次焦点去 spawn。
- 粘贴共用 `composer-paste.js`：图片转 `[Image](路径)`，文件插绝对路径。
- 角色入口在输入条箭头，随下一次发送/编辑的 role 参数持久化。
- 对话右键菜单里的「耗时分析」（`TurnTimingDialog`，入口**不在**「+」里：它是一份只读报告，不是往对话里加东西的动作）：一轮按「等模型 / 输出 / 跑工具」首尾相接切成区间，界面先给三类合计条 + 图例（占比、次数、累计耗时）与工具耗时排行，再按发生顺序列出每段的开始偏移、内容与耗时。切分、聚合与落盘形态的唯一实现在 `packages/mica-common/turnTiming.ts`；`AppRuntime` 每轮跑完把记录写进会话快照（`snapshot.turnTimings`，最近 50 轮，新的在后；fork / 新会话清空），所以重开应用、换进程也看得到历史轮次。桌面端的弹窗读这份记录 + 正在跑的那一轮（它还没落盘，由 `ChatView` 现场传进来，`renderer/src/turn-timing.js` 只做 Codex 事件 → 通用事件的适配），视图本身（`@mica-config-ui/web` 的 `TurnTimingView`）与会话详情的「耗时」页签共用一份。没有记录时如实说「还没有记录」，不要用当前事件流空跑一份冒充。
- 输入条齿轮与时钟打开 `SessionSettingsDialog`：会话能力（Tools / Skills / MCP 三页签）/ 定时任务 / 插件。声明了 `perSession` 的插件是左侧导航「插件」下面的子项，内容区只画选中的那一个；按会话可调的项就在这里，默认值仍在配置页 Plugins。插件声明 `llm` 的字段由 `LlmSettingsSection` 按会话渲染（与配置页同一组件，摘要写会话当前模型、逐字段可「跟随默认」），不要在会话设置里另写一套模型表单。
- 顶栏的「会话笔记」入口由官方插件 `session-notes` 声明（清单 `desktop.entry.placement: "header"` + 插件目录的 `desktop.jsx`），内核没有笔记专属界面：停用插件后图标与编辑器一起消失，工具与 prompt 段落也一起撤下。卡片经 `api.session.state` 读写会话快照，700ms 防抖、无保存按钮。
- 插件入口是**输入框正上方那排胶囊按钮**（`PluginQuickBar`，来自清单 `desktop.panel.shortcuts`）：`action` 类按钮点一下直接调插件动作（立即返回，不在页面里跑外部命令或等模型），`section` 类按钮打开盖在对话区右侧的抽屉并展开那一块（`PluginPanels`，宽 340、不挤窄对话），`items` / `menu` 类按钮悬停（停 140ms 才展开，划过不算）或点击展开一层子项。`menu` 的子项是本地事实、由插件现算（这个会话涉及哪些分支），所以**不能等悬停才去要**：页面挂载后先预热一次视图，条目按会话缓存在 `renderer/src/plugin-panels.js`（60s TTL、过期也先画旧的再后台刷新），抽屉复用同一份整块视图（30s）开局——点开看到的必须是内容而不是一句「正在读取」，只有真没有缓存时才画骨架（不写「正在读取」这种像在等网络的字）。请求失败重试一次再放弃；`prunePluginPanelCache(nodeId)` 在换会话时丢掉别的会话的条目（分支属于那条会话）。这一排是横向滚动容器，子项菜单因此画在 body 上（`createPortal` + 按钮矩形定位），不要塞回按钮里；抽屉折叠状态与 ChatView 的 `pluginPanelOpen` / `pluginPanelSection` 共用。哪些插件有面板、`roles` 门槛、是否停用都从 `readPluginsDetails` 拿（用户插件也在里面），规则在 `renderer/src/plugin-panels.js`；RPC 走 `window.mica.chat.pluginPanels.view|action` → `chat:plugin-panel-view|action`。host 侧返回的载荷在 `hostTaskRequest` 的信封里，必须过 `unwrapHostResult`，否则页面只看到 `{ok:true}`、视图全 undefined。
- 清单 `desktop.panel.status: true` 的插件额外给一行**常驻状态行**（视图返回 `statusBar`，画在输入框正上方、面板关着也在），用来说「这个能力此刻生效没有」。宿主里快捷栏与抽屉各存一份视图，抽屉的动作改完要经 `plugin-panels.js` 的 `notifyPluginPanelStatusChanged()` 广播一次，状态行立刻跟着变，不要等 30 秒轮询。
- 输入框动作区只有一个「+」按钮：展开后是添加附件 / By The Way / 定时任务 / 每个插件面板（按清单顺序，标签取 `desktop.panel.label`；声明了 `open` 的入口点下去是把那个动作交给插件——手机访问因此直接弹二维码，不打开抽屉）。只读的分析与详情不进这里（耗时分析、会话详情都在对话右键菜单）。面板入口在这里也有，所以配置类插件不必为「能被打开」而声明一个常驻胶囊；宿主不认识任何具体插件 id，列表来自 `readPluginsDetails`。「添加附件」是文件按钮（`host/attachments.js` 把文件存进 `$MICA_HOME/attachments/` 并插入绝对路径，图片同样走这条路），不是只选图片。
- 双击用户消息就地编辑，仅空闲且非空时提交，经 `chat:edit-message` 截断重跑；失败保留编辑文本。
- **会话详情只有一个组件**：`mica-config-ui` 的 `SessionDetailView`（头部 + 对话记录 / Context 分析 / 耗时 / 系统提示词，原始文件自动保存；「耗时」页签读会话快照里的 `turnTimings`，与「耗时分析」弹窗共用 `@mica-config-ui/web` 的 `TurnTimingView`）。配置页 Sessions 页、Stats 的会话详情弹窗（额外带「用量」页签）与状态栏上下文弹窗都渲染它，桌面端只包一层 `.mica-config-ui.is-embed` 的外壳与 `chat-modal-session-detail` 尺寸；**弹窗壳传 `bare`**，不画自己的标题 / meta——会话身份（标题、路径、事实）只由详情头部给出，两处各画一遍就是四行表头压在一屏内容上。原始 JSON 不是页签而是标签条右端那个开关（再点一次回到刚才那个视图）；对话记录 / 系统提示词 / 原始 JSON 三个 pane 共用 `.session-pane-toolbar`。不要再写第二套会话详情或上下文分组，上下文分类 / 信封 / 差额的唯一计算在 `mica-config-ui/src/server/contextBreakdown.ts`。
- 「系统提示词」页签读 `snapshot.systemPrompt`（按需 `readSessionSystemPrompt`，不跟着 2 秒轮询），用 `web/promptView.ts` 的 `analyzePrompt()` 切成「段 → markdown 标题」的大纲（顶层是角色 / 项目说明 / skills / 环境信息 / 其它注入，段内再按 `#` 递归；代码围栏里的 `#` 与 `<tag>` 不算结构，插件注入了哪个角色 / 段落由 `<injection>` 的属性标出来）。**导航只有一份**：左栏是这棵树（每行一条占全文的占比条，可按体积排序、可按节点正文搜索并标出命中次数），选中任一行即换右侧编辑器内容，工具栏显示所选模块的字符 / ≈tokens / 行数并提供复制，点行尾的定位把该节滚到编辑器对应行；不要退回「下拉 + 按模块查看 + 展开模块统计」那三件套（下拉还必须用 `SelectMenu`，原生 `<select>` 一律不写）。窄容器用 `@container session-detail` 改成上下排（同一个组件既在整页也在几百像素宽的弹窗里，不能按视口折）。刷新通过 refreshToken 更新数据，页签 key 只按 sessionId 区分，避免运行中反复卸载。对话记录与 Context 分析里那条 System 也用同一份记录（没有记录时才回落到角色提示词），三处口径一致。
- 会话详情的「用量」页签（桌面端 `stats/SessionDetailModal.jsx`）是 KPI + 来源堆叠条 + 逐次请求堆叠柱 + 逐条表格四段：柱子按「缓存输入 / 未缓存输入 / 输出」三段堆叠（颜色与图例同源 `stats/usage-series.js` 的 `USAGE_TOKEN_PARTS`，缓存用中性灰、未缓存用 info 蓝、输出用 accent，别把占比 98% 的缓存段调成最淡的 ghost，那会让柱子看起来是空的），可在「总量 / 输入 / 输出」之间切视图；请求投影、按来源归并与「每次 482」这类派生数字全部在 `stats/usage-series.js`（纯函数，有单测），组件只画。
- 工具抛出的选择题（`ctx.ask`，官方插件 `ask`）默认画在输入框上方的 dock 里（`AskDock`，与排队行同一位置）：标题带问号徽标与「3 个方案 · 单选」这行元信息，选项是扁平卡片（选中只改边色 + 浅底），下面一个「或者直接说你的想法…」输入框，底部一条独立的「已选 A · ↵ · 确定」——输入框默认就在，单选点一下即提交（自己写的按回车，打了字之后底部会多出「确定」），多选才需要先攒齐再点确定。`presentation: 'modal'` 换成浮层（同一份组件，只换容器）给「不决定就没法继续」的场景；`display` 逐项开关元素，不传按数据推导，元素少了高度就矮。答案是给还在 await 的那个工具用的，**不开新一轮**；成功后卡片靠宿主推来的 `mica/ask/updated`（`ask: null`）关掉，本地不抢先关——宿主没收到时界面会显示「已选」而工具一直卡着。`chat:is-running` 一并回带 `ask`，中途附着上来的页签据此补上未答的卡片；`chat:exit` 一到就清掉（宿主崩掉时来不及推 null）。等待期间会话文件顶部带 `awaitingInput`，侧栏那一行显示强调色圆点（`session-state.js` 的 `awaiting` 排在 running 之前）——判定要同时满足「文件里有标记 + 这一轮还在跑 + 真有进程持租约」，崩溃残留的 running 不会一直喊「等你选」；大会话按 30 秒的重读节奏，提醒最多晚半分钟亮。

## 统计页

- 统计页和编辑器一样是**整窗的一层**（`App.jsx` 的 `viewOwnsWindow`）：进页面时会话列表整个让出（侧栏宽度归 0、左上留出红绿灯的位置、侧栏开关不画、手机抽屉收起），返回只走主区顶栏最左的「返回对话」，⌘K 在这两页里也是先回对话再聚焦搜索框。视图本身不写进 layout 的折叠偏好，退出后按用户原来那份复原。

- Stats 页（`renderer/src/stats/StatsView.jsx`）默认区间是**今天**（打开页面关心的是刚才这一轮花了多少，近 30 天是决策时才切过去看的），图表都画在 `charts.jsx`（`CalendarHeatmap` / `BarSeries`）之上：每日柱可在 Tokens / 请求数 / 按来源三种维度间切换（按来源是堆叠柱，取 `scope.js` 的 `bucketByDaySource`），模型排行带占比条，项目排行是按来源堆叠的条，会话表在 tokens 格背后铺一条相对最大值的条。日聚合、区间裁剪的唯一实现在 `scope.js`，颜色与顺序只认 `stats/usage-series.js` 的 `USAGE_KIND_COLORS` / `USAGE_KIND_ORDER`（与「Usage by source」卡同一份），不要再写第二套配色或聚合。
- 「By source」是**两层树**（`stats/source-groups.js`）：父行是「谁发起的」——主对话（App 自己）、某个插件；子行是它底下的具体请求，缩进一层挂在父行后面。所有请求都要经过 App，只摊成一串 `Implementer` / `compact` 时看不出这笔钱是谁花的，所以父级优先：组间顺序固定为「主对话 → 各插件（按组总量）→ 内核」，指标排序只作用在组内子项（分组是结构，不是排序）。父行数字是整组之和（插件自身请求、以及功能 id 就等于插件 id 的后台请求都并进父行，不单列成子项），卡片总量只累父行，展开时不重复计数；卡片因此不分页（分页会把父行与子项劈到两页）。
- **名字一律用插件自己的**：父行取清单里的 `name`（`By The Way`，不是「旁问」），子行用记账里原样的 id / 类型名（`Explore`、`btw`）。统计页不翻译、不起别名——同一个东西在插件页、日志与统计页叫三个名字时，用户对不上账。父级靠记账里的 `pluginId`（委派记录写类型提供者 `subagent`、插件触发的摘要写触发它的插件），老记录由 `evolution` 的 `usage-source-owner` 迁移一次性补齐（含 `auto-compact` → `session-compact` 改名），所以运行时不需要「没有归属」的回退分支；真正没有插件的只剩内核自带命令（`/compact`、`mica compact`），它按功能 id 自成一组，Type 写「内核」。来源的类别名只有一份（`mica-web-shared/usage-source` 的 `USAGE_SOURCE_LABELS`），表格、图例与会话详情共用；卡片底部图例解释四类各自是什么（`SOURCE_KIND_HINTS`）。
- 表格统一用 `@mica-config-ui/web` 的 `DataTable`（列定义、受控排序、内置翻页、窄容器退列）：统计页的 By source 与 By session 都用它，宿主负责包一层 `.mica-config-ui`。**不横向滚动**——卡片变窄时先让次要列退场（`narrow: 'secondary'` 在 ≤720px 退，`'tertiary'` 在 ≤540px 再退），表头在窄容器换 `narrowLabel`。规则按容器宽度写在 `styles.css` 的 `.data-table-scope` 下，不看视口；分页的页码夹紧与区间文案在 `dataTableModel.ts`（有单测）。

## 展示

- 主文本共用 `--chat-text-size`；用户块与回答使用不同底色。
- 自动链接唯一实现在 `mica-common/autolink.ts`：`splitAutolinkPunctuation` 管 markdown 一侧（desktop 的 remark 插件排在 `remarkGfm` / `remarkPathLinks` 之前，CLI 用 `splitTerminalLink`），`findAutolinks` 管纯文本一侧（用户消息、引用块、notice、思考经 `chat-paths.js` 的 `splitTextByLinksAndPaths` → `PathText` 渲染成 `.chat-link`；代码块不认链接）。尾部裁剪含 `*` / `_`，那两个是强调分隔符而不是地址的一部分。
- micromark 的 autolink literal 会一路吃到空白，把 URL 后面紧跟的 `**` 与其后的中文一起吞进链接，那对强调分隔符就再也配不上、页面上留下字面量 `**`（`**http://127.0.0.1:8877**（…）`）。解析阶段已经错了，mdast 上救不回来：`chat-autolink.js` 的 `protectEmphasisAutolinks` 在解析前把这种写法换成显式 autolink `<URL>`（`www.` 用 `[text](href)`），代码块与行内代码原样跳过。CLI 的 marked 不受影响。
- 路径识别在 `chat-paths.js` / `PathToken`；单击弹「在 Finder 中打开 / 在 Mica 中打开」菜单（⌘ 点击直接走 Mica），图片单击预览、失败给 notice。
- 行内代码（`inlineCode`）里的 URL 与路径同样可点：`remarkPathLinks` 把含它们的 `inlineCode` 换成 `<code>` 包着的管线节点（`data.hName`），样式仍是代码颜色。模型几乎总用反引号写 URL 和路径，这里不可点就等于「链接点不了」。围栏代码块不认 URL，路径交给 `CodeView`。
- 「在 Mica 中打开」由 `files:stat` 判类型：文件进编辑器、目录把文件树临时切到那里（`FilesView` 的 `rootOverride`，换会话即作废，树头有「返回工作区」）。任何新入口按路径打开都走 `FilesView.openPath`（第三个参数 `{ focus: true }` 只开编辑器），不要各自 read。
- 分支评审**复用编辑器**，不另写一套 diff：插件回 `openReview` 时宿主把 `cwd`/`base`/`head` 交给主区那一个编辑器视图（`App.jsx` 的 `reviewTarget`），主区直接切到编辑器并停在 Git 面板的这份对比上——**不另开窗口**（编辑器只有主窗口里的 files 视图这一个形态，顶栏那个图标也只是切视图）。编辑器因此有个「提交对提交」模式：`useGitWorkspace` 的 `compare` 非空时改读 `git:ref-summary`、不抓 `status`、不轮询，`FilesView` 把它传给 `GitComparePanel`（标题写「目标分支 · 相对 基线」，不再出现「工作区」）与 `useGitReview`（差异按 `git:file` 的 `refs` 模式读两边提交）；评审期间页面目录由这次评审定（`EditorWorkspace` 不让用户之前选过的目录顶掉它），换目录等于离开这份对比。Git 面板顶部是**两格选择框**：**原分支**（旧的一侧，`gitCompareBase`）与**目标分支**（右侧，`gitCompareHead`，缺省「工作区」＝以前唯一的那种比较）。评审时两格改的是 `reviewTarget` 本身（`onCompareBaseChange` / `onCompareHeadChange`），目标分支选回「工作区」＝评审结束、编辑器和页面目录回到会话自己的；平时它们只属于这一页——按仓库记在 ui-state 里，不写会话。`direct/合并` 只在工作区侧可用（提交对提交恒定按合并基点算）。`head` 允许只写在远端（`origin/<分支>`）：`git-compare.js` 的 `commitHash` 原名解析不到时会再试一次 `origin/<名字>`，标题里仍显示短名——评审别人的需求时本地没 checkout 过那条分支是最常见的情形。
- 用户消息超过 10 行默认折叠，含 `[Image]` 的不折叠；折叠态悬停用 `chat-hover-tooltip.jsx`，不用原生 `title`。
- 快速压缩折叠出来的工具调用说明（`[tool calls cleared during compact: …]`）在历史里是逐条助手文本，`chat/compact-notes.js` 把**连续**的说明并成一行「已清理 N 轮工具调用 · 工具 ×次数」再由 `CompactNoteRow` 按 notice 渲染，原文留在悬停浮层里。别按助手消息逐条渲染：每条都是 `●` + 截断的绝对路径，几百条能把对话顶掉好几屏。
- 回合日志（`TurnLogDock`）是停靠区：挂在滚动区外面、永远贴着输入条，**只在轮次运行中显示**——跑完就整块让位（`!running` 直接不渲），过程本身不进对话，位置还给对话。边界只有它自己那一行标题——整行可拖、双击回到跟内容走、箭头收起成一行（收起时高度由内容决定，不沿用拖出来的高度）。标题行右侧那句摘要（最近一条活动的原文 + 步数 / 耗时，`turnLogHeadSummary`）**只在收起时出现**：展开后下面每一行都在，标题行只留把手与标签，不重复一遍状态文案；标签运行中是「模型思考中」，每轮开跑时自动摊开。
- 思考与工具行保持**出现顺序**（`mergeTurnThinking`，`chat-turn-activity.js` 只合并同轮**相邻**的思考段：模型每调一次工具思考就断一次，跨工具行合并会把工具行全挤到末尾）。**轮次之间互不顶掉**：最新一轮摊开在下面，更早的各收成一行（`groupActivityRounds`，标签「轮次N」+ 最近一条活动 + 步数 / 耗时，点开摊开整轮、带 1px 描边），只留最近 `MAX_TURN_LOG_ROUNDS` 轮；**只有一轮时不分块**（没有历史就没有「轮次」这件事，直接平铺）。历史轮次固定在上方不随正文滚动，只有最新一轮的正文滚动——框画在滚动视口上（`.chat-turn-log.has-rounds .chat-turn-log-scroll`）而不是里面的内容上，所以滚的只是这一块、框不跟着滚走，也不会和上面的轮次目录连成一片。工具行单行省略，点行开 `ToolDetailDialog`；思考整段折行。
- 详情弹窗统一 `chat-modal.jsx` 的 `ModalShell`；`--chat-*` 变量要能穿过 portal。
- 代码块统一 `CodeView` + `code-highlight.js`，只读着色，不引编辑器运行时。
- 「在编辑器中打开」把内容作为只读虚拟文档放进应用里唯一的 monaco 实例。
- 轻量浮层统一用 `Popover`；会话级设置是弹窗而不是浮层。
- 电脑隐藏发送/排队按钮，移动端保留；后台任务/子代理 dock 只列运行项与需要看一眼的结束（判定唯一实现在 `mica-common/backgroundTaskVisibility.ts`：`killed` 是模型 kill 或宿主退出时的统一收尾，不占位置；失败、非零退出码、进程失踪才留着）。子代理同理走 `mica-common/subagentVisibility.ts`：`completed`、模型自己 kill 的、上一轮正常结束统一收尾的都不占位置；只有 `failed` / `partial` / **被中断**的留着——记录带 `interrupted`（点停止、宿主关闭、上一轮以中止收尾）的还能看最近活动、还能重启。

## 文件、Git 与侧栏

- Files / TerminalHost 按需挂载后保留实例；ref 未就绪的打开请求暂存，挂载后补开。
- shell 由 `shell-path.js.resolveDefaultShell` 按平台与存在性解析。
- 文件树尺寸沿用 VS Code：活动栏 48px、树行 22px、缩进 8px。
- 文件操作只重读受影响的父目录；目录结果合并到最新树状态，保留未变节点、子树与展开状态。手动刷新/恢复可见时保留已有树，目录请求按根与目录校验，过期结果不能恢复已删除或折叠的分支（`renderer/src/files-tree.js`）。
- 编辑器工作区由 `EditorWorkspace.jsx` 持有自己的目录与 Git 状态，底栏目录选择只更新该页面，不写 session cwd、聊天默认目录或 workspace 节点；顶栏的编辑器图标（`toggleFilesView`）与对话里的路径链接、插件评审都落到主窗口这同一个 files 视图，再点一次图标或顶栏左侧的「返回对话」回到对话。文件树向上导航、打开目录也通过 `onRootChange` 同步页面目录，文件搜索读取编辑器 `getRoot()`。
- 编辑器底部终端 `EditorTerminal.jsx` 复用 `TerminalHost`（`pane: 'terminal'`，一个标签页就是它的一个节点，PTY id 为 `<标签 id>:terminal`），不另写一套 xterm/PTY 装配：回放、失败重试、文件链接与对话底部终端完全同一份行为。开关与高度存 ui-state 的 `editorTerminal`，标签与 PTY 只属于页面。Ctrl+`与顶栏终端图标按视图分工——对话视图管会话终端、编辑器视图管编辑器终端，两处各装各的监听，不在同一处判断该切谁；右键文件树 / 资源管理器根节点的「在终端中打开」把目录递给面板，一个标签一个目录。关闭标签与关闭窗口前都用`terminal:foreground` 问一次前台在跑什么（`processRunning`是轮询出来的滞后标记，实时`ps`才拦得住刚起的命令），命中就二次确认。窗口关闭由外壳问页面：页面挂`window.\_\_micaConfirmClose`（`main/index.js`的`confirmWindowClose`经`executeJavaScript`调用，返回`false`或 resolve 成`false` 就不关）；外壳不认具体页面，退出应用时不问。页面卸载 / 刷新时把 PTY 一并 dispose——PTY 活在运行时里，页面没了它不会自己结束。
- Git 分暂存/工作区两段，写操作仅 stage/unstage/discard（含文件夹级 `git:discard-dir`），一律先确认；所有 Git 命令带 `GIT_OPTIONAL_LOCKS=0`。文件夹回退（`git-ops.js` 的 `discardDirectory`）让 git 自己枚举目录条目再 `restore --worktree`，所以被筛选隐藏的改动、还没进面板的未跟踪文件一并回退，删掉未跟踪的计数回给界面；恢复来源是**索引**而不是 HEAD（与单文件版一致），拒绝回退整个仓库。
- diff 编辑器的行悬停显示该行作者 / 提交 / 时间：`git:blame` 走 `git-blame.js`，`{ ref }` 查某个提交、`{ index: true }` 查索引、都不给查工作区（未提交的行如实说「未提交的更改」并给上一版提交），读不到时回 `{ error }` 而不是抛错。这一侧到底是哪份内容由 `git:file` 返回的 `blame` 说明，渲染层不按 mode 猜；模型与悬停的连接在 `renderer/src/git-blame-hover.js`（`bindBlameModel`），格式化与缓存去重在 `git-blame.js`（`buildBlameHover` / `createBlameResolver`）。
- Git 图谱是编辑器的独立整页（活动栏 `git-graph`，占满侧栏 + 编辑器）：`git:log`（提交历史，`--exclude=refs/notes/* --exclude=refs/stash` 后再 `--all`，笔记与 stash 不算历史）与 `git:commit`（元信息 + 相对第一个父提交的文件清单）在 `host/git-log.js`；泳道布局、搜索、增删统计是纯函数在 `renderer/src/git-graph.js`，页面 `GitGraphView.jsx` 只画。点文件用 `refs` 模式在页面内开 diff（根提交的基线是空树），不读工作区。
- Git 比较按仓库/基线/模式与 fingerprint 保存审阅状态；DiffEditor 统一只读，首次加载后保留实例。比较模型与滚动状态由 `renderer/src/git-diff-session.js` 按仓库/文件/基线缓存；换文件保留画面到新内容就绪，替换/释放模型前先解绑。无 fingerprint 的源代码管理轮询必须重读并比较全文，无变化保留模型，不能用增删行数判断内容未变。
- 仓库自身的变化不等轮询：页面用 `git:watch` 声明「我在看这个目录」，宿主对它起两条 `fs.watch`（`host/git-watch.js`）。`.git` 那一路只认 `HEAD` / `index` / `refs/**` / `packed-refs` 与各 `*_HEAD`，`objects/`、`logs/`、`*.lock` 一律忽略，去抖 120ms、同一仓库 600ms 内只推一次；工作区那一路覆盖「不写 `.git` 的改动」（agent 改文件、终端里跑命令、别的编辑器保存），任何一段命中 `node_modules` / `dist` / `out` / `build` / `coverage` / `temp` / `.backups` 这类目录就不看（一次构建或装依赖会在里面刷出几万个事件），去抖 500ms、两次推送的最小间隔按**上一次全树扫描的实测耗时**放大（`summaryScanCostOf` × 4，2–10s，见 `git-ops.js`），所以扫描占用的 CPU 有上限、空闲时零扫描。两路都只做 `noteWorktreeChange` + 广播 `git:changed`，页面按仓库根过滤后静默刷新（推送带的就是「确实变了」，会绕开「刚读过就不重复读」那条捷径）。主窗口自己也订阅当前会话的仓库（以前只有编辑器页订阅，不打开编辑器时提交 / 暂存只能等轮询）；订阅是引用计数，全部撤销后 60s 关掉 watcher，页面隐藏时撤销。
- Git 轮询只在可见且聚焦时进行，不重叠（它现在只是兜底：两条 watcher 都没覆盖到的情形，如工作区在非递归 watch 的平台上、事件被系统吞掉）：编辑器页自己的 `useGitWorkspace` 跑 `summary` + 分支对比 + `status`（3s），主窗口只为会话底栏与徽标取 `status`（10s）。编辑器页隐藏时停止轮询。
- 顶栏编辑器图标右边是工作区徽标（`+1.2k` 绿 / `−840` 红，精确行数与文件数在 tooltip）：取数走 `git:change-counts`，与 `git:summary` 共用 `sumLineChanges` 和同一份文件列表（含未跟踪），所以和 CHANGES 面板的合计永远一致；按 20s TTL 取、一轮跑完或收到 `git:changed` 时立刻强制刷一次。**切会话不算变化**：目录没变（同一个仓库下几条会话来回切）时 `App.jsx` 的 `refreshGit` 直接沿用手上这份（`GIT_REUSE_MS` 5s），只把 `terminalId` 换到新会话上——既不花 IPC，也不会把徽标清空再等它长回来；「同一目录沿用上一次数字」同样只看路径，不看 `terminalId`。千位以上缩写（向下取整）、为 0 的一侧不画、有文件但无行数变更退回落文件数、干净时不画，规则唯一实现在 `renderer/src/git-badge.js`。
- 全树扫描（`status -z` + `diff --numstat`）在 host 侧按仓库缓存 5s：`git-ops.js` 的 `cachedWorktreeRead`，键是 `<root, summary:<base>>`，`git:summary` 与 `git:change-counts` 共用同一份结果（徽标不再单独算一遍）。仓库身份（`git:status` 的根目录 / 分支 / 项目名）走同一条缓存，键 `workspace-status`——它每次都要 spawn 一次 `rev-parse`，而每个窗口都在轮询（编辑器 3s、主窗口 10s），开着多个窗口时实测每 4s 一次，不缓存就是纯浪费。`cachedWorktreeRead` 同时做 **in-flight 去重**：同一 `<root, key>` 在任一时刻只有一次真正在跑，并发调用共用同一个 promise（只缓存「跑完的结果」不够——轮询间隔比一次读取更快时，几个窗口会叠成 7 次全树扫描同时在跑，彼此抢 CPU 又让每次更慢）。失效只有三条——`.git/HEAD` 或其指向的 ref 变了（切换分支/提交/rebase），以及我们**自己**改过工作区（`stage/unstage/discard`、编辑器 `files:write` 都会 `noteWorktreeChange(root)`，`repositoryRootOf` 从目录往上找 `.git`），以及宿主的 watch 收到变化（`git-watch.js` 的 `.git` 与工作区两条路都调 `noteWorktreeChange`）。**不要**改成看工作区 mtime：任何进程在写文件都会让整棵重算，等于不缓存。用户主动刷新的 `refresh: true` 跳过缓存，也不搭别人那次没跑完的顺风车。
- Pinned / Projects / Recent 互斥，归属经 `stats:move-session`；拖放判定在 `session-dnd.js`（`rowDropPosition` 的分档唯一实现：中间一半 = 嵌套 / 进入，上下各四分之一 = 插到前后，不认修饰键；分组行不许嵌套时（拖到自己的父分组、或自己的子树）中间一半退回插到前后，任何一行都不做无反应的死区）。分组行与会话行同一套落点规则：拖到分组中间变成它的子分组、拖到会话中间成为它的子会话、分组拖到会话行等于挪进会话所在的分组，拖到上下边缘排序——分组顺序在 Projects 的 groups 数组里，会话的手动顺序在 `userData/session-sort.json`（`pinned` / `project:<groupId>` 各自一份，跨工作目录也能排）。Recent 按时间排、不参与手动排序，只接嵌套与「拖去别的分区 / 分组」。落点提示不用描边或单边高亮：进入用整行浅底（`bg-info/20!`，必须带 `!`——行自己的 `hover:bg-overlay` 优先级更高，不加就整行看不出变化），插到前后用行间一条圆角细条（`DropBar`）。
- 会话行共用操作列/图标列/名称栅格；状态优先级沿用 `session-state.js`，error 红点由后续 completed 清除。
- 侧栏筛选是**一档互斥的视图**，不是可叠加的条件：搜索框右侧的漏斗点开才激活，档位 `全部 / 4 小时 / 8 小时 / 12 小时 / 24 小时`（按时间从短到长排）；默认「全部」＝什么都不筛，列表照旧是 Pinned / Projects / Recent。其余四档把整份列表**平铺**（按 `updatedAt` 倒序、沿用 Recent 的今天 / 昨天 / 近七天分桶），分区与分组不参与，置顶会话靠行首图钉表明身份。收起漏斗＝退出筛选并回到「全部」，不记忆上次那一档——记住一个看不见的筛选，下次打开侧栏会以为会话丢了。判定唯一实现在 `renderer/src/session-filter.js`（`filterSessions` / `matchesSessionFilter`）：每一档都是**滚动窗口**而非本地日界（早上「今天」几乎等于空列表），`hours` 为 0 就是「全部」，时间戳缺失 / 非法一律不算最近。按钮按内容定宽（标签不换行）、侧栏宽时等分铺满、放不下时整行横向滚动（滚动条全局隐藏），所以再加一档也不用改布局。平铺行不接拖拽（没有可落的分区）、不画行尾目录名，超量按 30 条分页；搜索接管列表时筛选行收起但保留选择，清空搜索词即回到筛选态。
- 每个会话行右端都显示最近结束时间，只有 Recent 额外带目录名；Recent 之外的 Pinned / Projects 只在 24 小时内活跃过时给时间（`relative-time.js` 的 `activeTimeLabel`），否则整列都是 15d / 4d 的噪声。分组行只有**折叠时**才在右端留这个 24 小时内的相对时间（展开时下面每个子行各有自己的时间），从不画条数；分区标题右端两样都不画（条数与精确时刻只进 tooltip，`collectGroupDigests` 汇总子树）。
- 会话右键菜单 = 固定项（Fork / 改名 / 标记 / 删除等；Fork 复用 `chat:fork`）+ 插件动作：插件项来自清单 `desktop.sessionMenu`，由 `renderer/src/session-menu-plugins.js` 收集（读 `readPluginsDetails`，用户插件也在里面），页面只转发 `pluginId + pluginAction` 到 `window.mica.chat.sessionMenuRun` → `chat:session-menu-run` → `mica/sessionMenu/run`；插件回的 `copyText` 由页面写剪贴板（`transport.js` 的 `copyText`），`message` 进顶部通知。没开过标签页的会话按需起一个 app-server 取快照，不需要页面先有 chat run。
- 会话行右键与对话区右键（`ChatView` 的 `ChatContextMenu`）用的是同一份插件项和同一个执行器 `runSessionMenuPluginAction`：两处各写一遍会让同一个插件在两个入口表现不一样；哪一处出现哪一项由清单 `surface` 决定（`sidebar` 侧栏会话行 / `chat` 对话区，省略＝两处都出，取项时在 `session-menu-plugins.js` 里过滤，会话压缩的两项只标了 `chat`）。插件项默认插在「分享链接」之后、Clear 之前（危险项永远排最后），清单写了 `position: "top"` 的（会话压缩的快速压缩 / 模型压缩）反过来摆在菜单最上面、与其余项之间隔一条分隔线；没有会话时禁用。图标同理来自清单：每一项可以用 `icon` 声明自己的图标名（`session-menu-plugins.js` 传名字，`ChatContextMenu` 用 `resolvePluginIcon` 取组件），省略才回落到插件图标，都省略时用拼图占位。结果在对话里落一条 notice，侧栏那处进顶部通知。固定项里还有一个「查看详情」，和侧栏会话行的「查看详情」是同一个弹窗（按需加载的 `stats/SessionDetailModal`，含用量页签）；两个入口渲染同一个组件，不要为其中一处另写一份详情。
- 父子关系（`parentSessionId`）是会话树的唯一事实来源，只改渲染顺序，**不区分来源**：sidecar 子会话、fork 分支与手动拖出来的层级共用这一个字段，侧栏不给它们加标签或图标。父行在前、紧跟它的子树（`session-nesting.js` 的 `nestSessions`），父会话不在当前分区时子会话当顶层，环与自指都退化成顶层。折叠状态是页面内 Set，父行折叠时用 `mergeRowStates` 代显子行状态；子行继承父行的分区与搜索命中，也不参与手动排序——拖到会话行正中＝成为它的子会话（拖进自己的子树会被拒），拖到别处＝先解除父子关系再换分区。写盘走 `stats:set-session-parent`（`host/session-parent.js`）：空闲时独占 turn lease 改文件；这一轮正在跑（lease 被别人持有）也照改——活着的宿主每次保存都从盘上读回这个字段，不会用内存旧值顶回去，此时改成读前读后比一次文件身份（inode / size / mtime）、写完回读校验，撞上宿主的一次保存就重来。`parentSessionId` 固定写在 `snapshot` 之前（头部读取靠这个位置判成环），`updatedAt` 不动，否则调整层级会把会话顶到 Recent 最前面。
- 会话搜索共用 `mica-web-shared/session-search.ts`；正文搜索每会话最多 20k 字符，默认最近 3 日、最多 600 个候选，截断须告知。
- 上下文统计按整条消息 JSON 估算并排除媒体 payload；compact / rewind 后用 staleInput 说明。

## 侧栏入口与整页设置

- 会话侧栏顶部保持一行入口的固定顺序：New Session / Stats / Settings / 插件声明的侧栏入口 / Plugins。插件入口由清单 `desktop.entry` 声明、按清单顺序渲染（`Connections` 是浮层卡片）；`placement: "header"` 的入口不占侧栏位置，画在主区顶栏右侧那一簇的最左边（`Schedule` 是整页 + 顶栏图标——顶栏只有 32px 高，所以只画图标，窗口类图标仍贴最右），宿主只画一行与容器，不知道里面是什么；加一个桌面插件只改插件目录，不改侧栏代码。只声明 `desktop.page`、不写 `entry` 的插件不占这一列：它的整页入口是 Plugins 页里那张卡的「打开…」按钮（`plugin-entries.js` 的 `loadPluginPageEntry` 按 id 现取模块，`SettingsView` 经 `onOpenPluginPage` 交回 `App` 打开；标签就这样，不再占侧栏一行）。Plugins 虽然在最末，但它只是一个页面入口——点它进插件整页（目录 → 点一张卡进详情），不做下拉面板、不在侧栏里列插件。
- 设置与插件页都以覆盖整窗的一层打开（`configPage` 状态 + `fixed inset-0` + 顶部拖拽条），不在对话区右侧再开一栏：配置页自带侧栏导航，套两层侧栏只会把内容挤窄。返回走配置页侧栏顶部的「返回对话」，主区顶栏的返回只管 Files / Stats。
- `SettingsView` 每次打开重新挂载，`key` 含 section 与插件 id：入口决定落在哪一页，残留的上一页导航会让人以为点错了地方。

## 受控浏览器与终端控制

- 主进程业务例外：`src/main/browser/`、`src/main/terminal/`、`src/main/system/`；端点目录各自唯一（`browser-docs.js` / `terminal-docs.js` / `system-docs.js`），路由、文档与 MCP 操作清单同源。系统检查只服务宿主自己（`MICA_SYSTEM_SOCKET` 由运行时经 `host/system-checks.js` 直连，不做 `/remote/*` 代理、不暴露 MCP），探测用 `systemPreferences`、跳转用 `shell.openExternal`（renderer 的 `window.open` 只放行 http(s)）；配置页插件详情的「运行条件」经 `readDesktopChecks` / `openDesktopSettings` 两个桌面专有动作读它。
- 远程访问默认只有分享视图：路径分类在 `host/access-core.js` 的 `classifyRemotePath`，放行判定在 `host/remote-access-core.js` 的 `remoteAccessDecision`，接线在 `server/index.js` 的 `isLocalClient` / `shareLinkSessionId`（后者用 `chat.js` 的 `sessionExists`，且必须看原始 `req.url`——`requestPathname` 已经吃掉查询串）。分享链接即凭据：只有「指向存在会话的 `/share?session=`」才签发 `mica_share_scope` cookie，裸 `/share` 与编造 id 都换不到。要让别的机器用完整界面，用侧栏 Connections 卡片的「其他机器访问这台机器」（口令默认 `0000`，策略落 `$MICA_HOME/remote-access.json`，`secret` 由 `readRemoteAccessPolicy` 补齐落盘）；口令登录页与 cookie 签发只在 `server/index.js`。`MICA_DESKTOP_TRUSTED_CLIENTS` 仍可整段免密。
- 两者都走 Unix socket，由运行时在既有端口上代理；agent 侧各暴露一个 MCP tool `control`。
- 浏览器窗口默认全程隐藏：截图、点击、输入、按键、滚动都在隐藏窗口里完成（截图走 CDP `Page.captureScreenshot`，`capturePage()` 在隐藏窗口上是旧帧；原生输入在隐藏窗口上有效，前提是主进程挂了 `disable-backgrounding-occluded-windows`，否则 rAF 冻结、页面不动）。滚动用页面内 `scrollBy` / 内部容器 `scrollTop`——CDP 的 `mouseWheel` 在隐藏窗口上永不返回，可见时也不一定真滚；`Emulation.setFocusEmulationEnabled` 让隐藏页面 `document.hasFocus()` 为 true，否则部分站点会关掉自动聚焦与快捷键。`showBrowser` 是唯一会显示窗口的方法，只在明确要给用户演示时调用；用户自己点顶栏的浏览器图标唤出/收起。
- 浏览器顶栏（标签条 + 只读地址）是一条独立页面（`src/main/browser/browser-chrome.js`：data: URL、无 preload），配色**跟随应用主题**：外壳从 `ui-state.json` 读偏好（`auto` 跟系统，主进程按 mtime 缓存），把 `chromePalette()` 下发给页面，窗口底色也用同主题的 `--color-canvas`；主题变或系统亮暗变时重推已打开的窗口。调色板取值与 `app.css` 的主题块逐项对齐，`browser-chrome.test.js` 会比对，改主题必须同改。地址框只读，右侧只留一句「请勿手动操作」，完整说明放 tooltip。
- 同一 `persist:mica-browser` 分区共享 Cookie；服务保持 Origin/Host 守卫。
- 终端是一个会话一个后台窗口，`node-pty` 真实 pty + `@xterm/headless` 屏幕镜像；窗口按需创建，关窗只 hide。
- 读屏前必须等已排队输出解析完，并给该等待硬预算（读屏 2s、`wait` 用剩余超时）。
- `wait` 默认 `maskEchoedInput`（`skipEcho: false` 关闭）；`expectExitCode` 不匹配立刻返回实际退出码。
- 会话存在进程内，最多 12 条活着 shell；`sweep()` 每分钟回收，没有归属的立刻回收，窗口可见的不回收。
- 归属是顶栏图标的唯一依据：浏览器与终端**新建都必须带 `x-mica-owner`**（缺了返回 400），没有归属的窗口还会被回收（浏览器在列窗口前 `pruneUnowned()`，终端靠 `shouldRecycle`）——顶栏只显示当前会话自己的窗口，切会话就一起消失。
- 写入类操作校验 `x-mica-owner`（防串台，不是权限边界）；读屏与 `wait` 不拦。
- 带归属的接口调用会推一条 `browser:activity` / `terminal:activity`（`{ id, owner, endpoint, at }`，只发给列表订阅者、不改快照），页面收到后让对应那枚图标闪一下（`.control-icon-flash`，按计数重挂图标重播动画）。页面自己点图标不带 owner，不会触发。
- 纯 Web 宿主无主进程，`/remote/terminal/*` 回 503。

## 日志与性能

- **诊断日志只有一份实现**：`@packages/mica-diagnostics`（桌面 `host/log.js` 只是转发 + Electron 两个通道）。运行时、Electron 主进程、`mica app-server`、TUI、`mica exec` 都写同一套 JSONL：落 `resolveLogDir()`（macOS `~/Library/Logs/mica`，与插件日志同目录），2s 批量 flush，留 1000 条环形缓冲；保留 7 天、总容量 256 MB，超了从最旧的删。日志**不放系统 temp**：temp 每次登录被系统清空，重启后就只剩当次运行，跨天的问题无法回头查。`MICA_LOG_DIR` 覆盖目录（测试与隔离实例用），`MICA_LOG_LEVEL` 调级别（常驻宿主默认 info，一次性命令默认 warn）。
- **每个常驻进程自报内存**：`startMemorySampler({ host, describe })` 每 30s 一条 `scope: 'mem'`（`rss` / `heap` / `ext` / `ab`，附会话 id 或宿主数）。运行时报 `host: 'runtime'` + `hosts/busy`，每个 app-server 报自己的会话 id（那才是占用大头，一个能有 1GB），主进程额外带 Electron 各进程类型的分布（`app.getAppMetrics()`），TUI 报当前会话与模型。配置页 Performance 的「进程内存」按进程列出当前 / 峰值 / 窗口内增长；`mem` 不进耗时聚合、也不进事件流。
- 崩溃现场必须有落盘的一行：会话宿主非正常退出记 `host.exit`（退出码、信号、stderr 尾部 2KB），spawn 失败记 `host.spawn-failed`，主进程听 `render-process-gone` / `child-process-gone` / `unresponsive`，app-server 的 `uncaughtException` 先写日志再通知客户端。
- 通道耗时只在 `handleInvoke` 用 `logger('invoke').timedResult()` 量一次；超过 `SLOW_MS`（默认 300ms）记 warn。它还会把「调用成功、返回体里带 `error` / `ok:false`」的那些记成 `kind:'failed'` 并在聚合表计入 `fails`——大量通道（git/stats/plugin-host）把失败包在返回值里而不抛，不这么做日志里就只剩一条耗时，分不清是超时、被取消还是真报错。新增功能不要自己再包一层计时。
- `chat:compact` 额外记一条 `compact.finished`（请求模式、子进程回报的 strategy、前后 token 估算）——只按通道计时分不出本地清理与模型摘要。
- 渲染层 `perf-probe.js` 只采样、`log-probe.js` 只记错误，两者交给同一写入器。
- 采样全量记录，不做「异常才写」；隐藏窗口的 `lag` 记 null。
- 面板轮询跟可见性走（Stats 30s + 可见且聚焦；会话列表 10s，回到窗口立即补一次）；配置页 Performance 的聚合在 host 侧做完。
- **插件面板只在看得见时轮询**：`chat-cache` 保留 5 个 ChatView，每个都挂着快捷条；`PluginQuickBar` / `PluginPanels` 必须带 `visible`（`ChatView` 的 `visible` 直传），隐藏实例不轮询状态行（30s）、不预热菜单、不刷新抽屉（4s）——否则一天几千次 `chat:plugin-panel-view`，还会把没人看的会话宿主一直喂活而不被回收。host 侧再按 `id + pluginId + cwd` 合并 3 秒内的重复读（`PANEL_VIEW_REUSE_MS`），动作不做合并。
- 顶栏 Git 徽标（`git:change-counts`）是整棵工作区扫描，自己一层 20s 缓存 + **先回旧值、后台重算**；`worktreeSignature`（HEAD）变了或 `worktreeEpochOf` 变了（stage / discard / 保存文件）时不许回旧值。
- 会话列表整份返回，但内容没变时按字段指纹（`session-state.js` 的 `sameSessionSnapshot`）跳过 setState，空闲轮询不触发重渲染。
- `stats:changed` 只在**真有变化**时让页面重读：收尾那一帧由扫描器带上 `parsedFiles` / `added`，两者都是 0（这一轮没读任何文件、没有新会话）就不广播；索引补齐过程中的进度帧带 `partial: true`，侧栏（`App.jsx`）直接忽略它，统计页只在可见时跟。之前每批进度都推、页面每批都重读千人列表，一天能攒出上千次多余的全量序列化。
- 会话统计走磁盘索引：`host/stats-scanner.js` 按文件签名把每个会话的投影缓存在 `$MICA_HOME/desktop-stats-index.json`（与 `sessions/` 同级，不是会话文件），进程重启只解析变过的文件。首次构建（升级后第一次）分批让出事件循环，并经 `stats:changed` 推送进度，界面「逐渐填充」而不是空白几秒。**改 `parseSessionMeta` 的投影字段必须同一步提升 `INDEX_VERSION`**：版本没变时旧缓存行会一直缺这个字段，表现为「界面功能突然失效」。
- `stats:read` 的载荷是「会话 × 本地日」聚合行（上千会话约 1 MB），不是逐条 usage 事件；区间切换只是对日行做加法（`renderer/src/stats/scope.js`），不要再把事件级明细塞回载荷。跨会话的用量去重靠扫描器的「身份归属表」（最早创建的会话拥有），`stats:session-detail` 与列表共用同一份归属。
- 每一次模型请求都要能在统计页上看到，所以来源只有一个口径（`mica-web-shared/usage-source` 的 `usageSourceOf`）：`main` 主对话、`delegation` 委派、`plugin`（+`pluginId`）插件、`helper` 内核后台。判定顺序是 `origin: 'delegation'` / `initiatedByCallId` → 委派、`origin: 'plugin'` / `pluginId` → 插件、其余 → 内核 helper；host 的日行聚合与会话详情都调这一份，不各算一套。插件起的子代理由宿主写 `pluginId`（`ctx.subagents.run/background` 记到插件名下，委派带 `initiatedByCallId` 记成 `delegation`）。
- 没有会话可写的请求（`mica commit` 这类一次性插件命令，含桌面右键 commit；以及 `mica plugin-action` 里真的问了一次模型的插件动作）追加进 `$MICA_HOME/usage-ledger.jsonl`（形状与解析唯一实现在 `mica-web-shared/usage-ledger`，写入在 `apps/cli/src/plugins/usageLedger.ts`）。扫描器把它读成「按 cwd 分组的无会话行」（`ledger: true`、`id: null`），并进概览 / By model / By source / By project，但不冒充会话：不进 `scanMeta`、不算进「Active sessions」、不进 By session。不要为此跨进程改写会话快照——那会绕过 turn lock。配置页的「测试连接」（插件与主配置的服务商）仍不入账（`probeModelConnection` 只是一次连通性探测，没有回答）。
