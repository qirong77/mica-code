# 插件、命令、工具、MCP、Skills

## 插件系统的设计准则

**插件系统仍在持续迭代：实现一个插件时，把「这个插件是否需要先推动插件系统进化」当作设计的一部分，而不是只在现有能力面上将就。**

- 该先重构的信号：需求要读插件拿不到的数据、要靠改别人的数据伪造界面、要依赖宿主里的私有约定、要在多个插件间共享同一份可变状态、或必须为某个插件在宿主里写死分支——出现任一条都说明能力面缺东西，先重构插件系统，再在新机制上实现该插件。
- 重构方向是通用能力面：扩展 `PluginContext` 的某一面（`agent` / `background` / `commands` / `desktop` / `events` / `hooks` / `session` / `sessionState` / `settings` / `skills` / `tools` / `ui`）或复用已有能力；宿主里不出现具体插件名词，「加个 if 兼容某插件」不算设计。
- 重构与实现同一次变更交付：插件系统改动、受影响的官方插件、`plugins/README.md` 与本文一并更新；不留旧形态兼容分支，不为过渡保留双路径。
- 插件格式或能力面变更后跑 `plugins/**` 相关测试与 `bun run typecheck`；触及工具定义或 prompt 前缀时确认前缀稳定。

## 插件格式与登记

- 插件只有一种形态：目录 + `plugin.json`（`id` / `name` / `version` / `icon` / `main` / `assets` / `dependencies` / `required` / `priority` / `mica.apiVersion` / `settings` / `llm` / `requires` / `desktop`）+ 入口（`default` 导出 `setup(ctx)`）。`icon` 是配置页插件目录与桌面入口行的图标名，不认的值回落默认图标。格式与字段以 `plugins/README.md` 为准。
- 官方插件在仓库根 `plugins/<id>/`：清单登记在 `mica-official-plugins/manifests.ts`，入口登记在 `index.ts`。用户插件在 `$MICA_HOME/plugins/<id>/`，由 `FilePluginLoader` 启动时加载，id 一律加 `user.` 前缀。
- 插件清单的 `name` 与 `desktop.entry.label` 一律英文（侧栏其它入口也是英文），描述这类正文才写中文。
- 没有 `plugin.json` 的目录、散落成文件的 `.js` / `.mjs` 都不是插件，加载器不猜。
- 新增插件：建目录 → 两处登记 → 测试放插件目录内（vitest 覆盖 `plugins/**`）。

## 启停与装配

- 启停状态在 `$MICA_HOME/plugins-state.json`（`{ "disabled": [...] }`）；停用的插件**照常注册**、在装配阶段跳过，所以启用只是「再 setup 一次」。
- 常驻宿主（TUI / app-server）在 `baseContext.pluginStateSync` 里交出「怎么重新扫描用户插件」与 `canSyncNow()`，manager 据此跟着 `plugins-state.json` 走：**文件一变（`watchFile` 400ms + 120ms 去抖）就对齐一次**，停用的插件立刻卸载、重新启用的立刻装配，并重写 `plugin-status.json`；`canSyncNow()` 为 false（这一轮正在跑）时只记下来，等 `turn:after` 补做——工具与钩子不能从跑到一半的轮次脚底抽走。`turn:before` 仍兜底 stat 一次（容器 / 网络盘可能漏事件），所以漏了也不会错到下一轮之后。一次性宿主（`mica exec`、插件命令 / 动作）没有下一轮可等，名单只在装配时读一次。每插件的资源按 pluginId 分开登记，卸载一个插件不能碰别人的工具、命令与钩子。
- `requires` 必须写全插件触碰的每一面：`actions` / `agent` / `background` / `commands` / `desktop` / `events` / `git` / `hooks` / `llm` / `models` / `prompt` / `runtime` / `session` / `sessionSettings` / `sessionState` / `settings` / `skills` / `subagents` / `tools` / `ui`。缺一项整插件跳过，原因写进 `plugin-status.json` 的 `skipped`；跳过**不写** `plugin-health`——缺哪一面是当前宿主的事实（TUI / `mica exec` 没有 `desktop`），写进所有宿主共享的健康状态会让桌面端显示别的宿主留下的「待配置」。
- `plugin-status.json` 由 `mica-plugin` 的 `writePluginStatus()` 唯一写盘（装配完成与每次启停对齐后各写一次）：记**全部**装配过的插件（官方与用户一视同仁）、写下 `host`（`tui` / `app-server`）。装配结论来自 manager 记的每插件 attempt（`setupReport()`），被停用的插件因此不会留下一条过期的「已加载」。配置页显示「已跳过 · TUI」，跳过不参与「插件坏了」的判定；没有记录时页面如实说「尚未加载」，不给官方插件编默认值。

## 能力面

### actions（不依赖会话的动作）

动作输入可带发起方工作区 `cwd`（绝对路径）：桌面设置页通过 `ConfigWebApp.actionCwd` 传入，独立配置页省略。
需要项目目录的动作缺上下文时应明确提示，不使用一次性宿主的 `process.cwd()` 冒充。
setup 必须先登记独立动作再按能力装配会话工具；动作宿主不伪造 `tools/session`，退出前统一释放注册资源。

属于插件、但不属于任何一次会话的操作（注册到中转机、试连接口、生成访问链接）声明成清单 `actions`，实现用 `ctx.actions.register(key, handler)`，结果是 `{ message?, link? }`。配置页在插件设置下方画按钮、就地显示结果，**不要**为此把用户跳去对话、也不要为此要求会话宿主在线：执行它的是 `mica plugin-action --plugin <id> --action <key>`，一个只装配目标插件的一次性进程（没有 agent、没有 turn）。动作通常要顺手写设置与状态文件（`ctx.settings.set()` + `plugin-data/<id>/data.json`），这样页面刷新后仍能看到结果。做不完的操作（要一串判断、要调工具）就回 `{ newSession: { prompt, send: false } }`：页面开一个新会话、把提示词放进输入框、关掉配置页，等用户按回车后由 agent 去做——提示词要能独立成立（接手的新会话看不到这里的状态）：随包 skill 用 `[skill:名字](绝对路径)` 指过去，要它落在某个仓库里做事就用 `cwd` 指定工作目录；这是与面板动作同一份 `newSession` 形状（归一化在 `mica-plugin/PluginNewSession.ts`），浏览器宿主没有会话可开时如实说「在桌面端里点」。

### background（一直在跑的东西）

随包脚本的解释器必须是真正的 Node（如 `node` 或显式的 Node 路径），不能用安装版的 `process.execPath`：
后者指向 Mica 本身。DeepSeek Harness supervisor 对启动异常与快速退出采用跨宿主共享的指数退避，设置变化重置退避。

需要「一直在跑」的东西（周期轮询、心跳、增量同步）注册成 `ctx.background.register(...)`，不要自己 `setInterval`，更不要装成 launchd / systemd 服务：那种形态在插件停用后还在跑，用户以为关了其实没有。间隔用 `every: number | (() => number)` 声明，退避策略留在插件里；单轮抛错只记健康状态与日志。跟着插件一起结束的子进程在 `ctx.onDispose()` 里杀掉，状态写 `$MICA_HOME/plugin-data/<id>/`。

官方插件载在**每会话**的 app-server 里（会话关掉进程就退），所以「必须活得比会话久」的常驻工作不能只靠进程内循环，要由常驻任务监管一个脱离父进程的子进程；随包脚本先落盘到 `$MICA_HOME` 再用 `node` 跑（`packages/mica-pty` 的 helper 与 computer-use 的 runtime 都是这个模式），源码内嵌由脚本生成。

### skills

- 内置 skill 用 `ctx.skills.register()`：正文随包用 `import … with { type: 'text' }` 内嵌，元数据由 `micaSkills.parseMarkdown(SKILL.md)` 解析（frontmatter 是唯一来源），注册后与磁盘 skill 同权（prompt 索引 / `skill` 工具 / 会话能力开关）。磁盘上的同名 skill 优先，被遮蔽的条目从返回值 `skipped` 读出来并 `ctx.health.report()`。`baseDir` 必须是真能读到的目录——单二进制没有插件目录，所以随包资源要先落盘到 `$MICA_HOME/<插件目录>` 再注册（`plugins/computer-use` 是完整示例，源码内嵌由 `scripts/generate-computer-use-sources.mjs` 生成，改 `runtime/**` 必须重跑）；**正文不落盘（`baseDir/SKILL.md` 不存在）的 skill 不会进补全列表**，因为补全插入的就是这条路径。
- 注册成功的内置 skill 由插件系统顺带发布到 `$MICA_HOME/plugin-skills/<pluginId>.json`（`PluginSkills.ts`，一个插件一份、整份重写）：不 setup 插件的宿主（桌面运行时给 `/` 补全、配置页）靠这份索引列出内置 skill，不必为两个名字冷启动会话进程。索引不主动清理（多进程会互相踩），读的时候按 `plugins-state.json` 的停用名单与 `SKILL.md` 是否还在过滤——所以停用插件、卸掉插件之后它立刻从列表消失。
- 插件整块按会话角色门控时（段落、工具、技能一起只对某个角色出现），技能也要声明角色：`ctx.skills.register(skill, { roles: ['需求开发'] })`（空数组＝所有角色）。角色随条目写进索引（`version: 2`，缺 `roles` 的旧索引直接当没有），由读索引的一方按会话角色过滤——索引是全局一份、注册只发生在跑插件的那个进程里，判定只能留在读取侧。
- **随插件分发的 skill 用清单 `skills` 声明**，不要手写 `ctx.skills.register()`，也不要把正文抄到 `$MICA_HOME`：每条是相对插件目录的路径，目录里有 `SKILL.md` 就是一条 skill、否则当容器扫一层子目录（`["skills"]` 带一组、`["./skills/x"]` 带一条）。宿主按 `MicaPlugin.root` 读成运行期 skill 并发布索引，**编辑插件目录里的文件就是编辑 skill**；相对路径以外（绝对路径、`..`）在清单解析阶段就拒绝。目录读不到只报一条健康状态、插件其余能力照常启动。`ctx.skills.register()` 仍然保留给「正文来自内存/需要动态生成」的场合（`plugins/computer-use` 的源码内嵌就是这一种）。
- **随插件分发的角色用清单 `roles` 声明**（同一套相对路径规则、同样在解析阶段拒绝越界），正文是 `<插件目录>/roles/<名字>.md`。它与 `$MICA_HOME/role/*.md` 的注入方式相同：非默认角色统一通过 `rolePrompt` **追加**为紧接固定 `<system>` 的 `<role>` 段，同属 system prompt，只写「这个角色额外要遵守什么」，不替换通用约束；内置 `default` 正文只读且不重复追加。宿主装配时写索引 `$MICA_HOME/plugin-roles/<pluginId>.json`（`mica-plugin/PluginRoles.ts`，仍为 `version: 1` 的 `name` / `path` 条目），输入框的角色箭头（`host/chat.js` 的 `listRoles`）与 `/role`（`mica-agent` 的 `listAgentRoles`）都只读索引，不必 setup 插件；磁盘同名角色优先并遮蔽插件那条。读索引的一方要按 `plugins-state.json` 的停用名单过滤（索引要等某个宿主对齐时才清，用户刚关掉插件时那些名字不该还能切到）。改角色 = 改插件目录里的文件。

### session / sessionState / sessionSettings

- 插件感知会话用 `ctx.session`：`describe(owner)`（含 `cwd`，按工作区归档的插件读它而不是缓存进程 cwd）、`messages(owner)`、`rename(title, { owner, source })`；`source: 'auto'` 在人工命名过时被拒绝。
- 插件里**跨会话共享的数据不能拿会话 id 当身份**：档案按「这份需求 / 这个项目」存，会话只留一个指针（`ctx.sessionState`）；指针缺失或被覆盖时按稳定键认回已有档案，绝不因为换了会话（fork、重开、镜像丢失）就另起一份空的——用户看到的是「我记过的东西又没了」。
- 需要按会话调整的设置项标 `perSession`：默认值仍是 `settings`（配置页写），会话里只存**改过**的键（`pluginSessionSettings[pluginId]`），没改过的继续跟随默认值。插件读 `ctx.sessionSettings.get()`（合并后的生效值），界面由 `mica/pluginSettings/get|set` 驱动，桌面端从会话设置→插件进入。只存改过的键是硬约束：整份存会把当时的默认值固化进老会话。

### agent（改写历史、压缩、维护窗口）

- 持久 headless 会话在取得 lease、刷新并应用本轮配置之后、保存输入之前 await `turn:prepare`；事件携带前后模型配置和不重新抢锁的 `compactHistory`。插件可据此做轮前维护；`compactHistory` 将当前压缩结果落盘并同步展示记录，界面与持久化历史一致。前一模型优先取最近一次真实请求的 usage，缺失时取刷新后的会话配置。
- 宿主形态由 `ctx.agent.mode` 回答（`session` / `one-shot`，后者是 `mica exec`），与迭代重写句柄上的同名属性一致；会改变成本或输出的策略只在 `session` 生效。
- 影响模型请求的插件用 `ctx.agent.onIterationRewrite(handler)`：在迭代边界改写接下来要发送的历史。句柄只暴露 `sessionId`、`mode`、`lastUsage()`、`getState()` / `setState()`、`compact()`；这里的 `compact(messages, options)` 只压传入的请求历史副本，不直接改写落盘记录。
- 同一能力面的另一半是 `ctx.agent.compactIdleHistory(options?)`：在轮次之外把已落盘的历史压一次，`mode: 'quick'` 只在本地清理工具过程（压缩区里的调用与结果聚合成一条占位调用、思考丢掉、图片与文档换占位符；对话正文与轮次结构不动，不调模型），`mode: 'model'` 把用户与助手的对话（`summaryInput: 'dialogue'`，工具过程不进摘要输入）交给模型写 checkpoint 摘要。它由宿主提供（`HeadlessTurnExecutor.runIdleMaintenance` 取 turn lease → 对齐磁盘 → 调 `compactIdleSessionHistory` → 落盘；宿主把调用方的 `pluginId` 一起传下去，没配自己摘要模型时那笔内核摘要记在插件名下，Stats 的 By source 才看得出来是谁在压），结果只有 `applied` / `skipped`（`busy`：会话忙或别的进程持锁；`empty`：没有可压的内容），两者都不算错误。要在压缩结果旁边一起落盘的写入（`ctx.ui.notice`）放在 `options.afterApply` 里——宿主在落盘**之前**调它，所以是同一次写；等 `await` 返回后再写，只能等下一轮（用户可能已经关掉页面）。`mica exec` 不落盘、TUI 走 `/compact`，两边都不提供，插件必须当可选能力。
- 轮次之外判断「现在多大」用 `ctx.agent.lastUsage()` 与 `ctx.agent.contextWindowSize`（与界面上那个 ctx 徽标同源、随会话切模型变化），不要让插件自己估历史：`lastUsage` 是最近一次真实请求的输入量，压缩保留它（Stats 对账口径），所以压完再读不会立刻变小。
- 要占住会话几秒的耗时工作（模型摘要）用 `ctx.agent.withMaintenance({ reason, label }, task)`：窗口开着时宿主通知客户端「别急着发送」，用户这段时间的发送留在客户端的排队行里（可见、可撤回），窗口结束后由客户端补发。只由能跟客户端说话的常驻宿主提供（`mica app-server`），TUI / `mica exec` 里没有，插件写 `agent.withMaintenance ? … : await task()`。`compactIdleHistory` 那条通路已经由宿主开好窗口（`label: '压缩'`），插件自己的耗时任务才需要显式用它。

### subagents

- 委派子代理用 `ctx.subagents`：`registerType()` 注册类型（工具白/黑名单、写策略、`maxTurns`）、`run` / `background` 跑一个、`tasks.list|get|kill|wait|restart` 管后台任务、`caller(context)` 解出本次调用所属的委派来源。`restart(taskId)` 使用与 `get` 相同的插件及原 owner 归属检查，返回新任务 ID；它带原任务与最近活动创建替代任务，不是断点续跑，运行中、无权访问或无法重启时抛错。机制（建子代理、用量记账、路径租约、完成回注）在宿主，策略（有哪些类型、工具形状、什么时候委派）在插件；子代理类型挂在注册它的插件名下，插件停用即消失。
- 需要「可复用的隔离子代理」（旁问、连续追问）用 `ctx.subagents.thread({ type, systemPrompt, tools, allowedTools, disallowedTools, model, maxTurns })`：一次建线程、多次 `ask()`，同一线程串行（并发 ask 直接报错）、可用 `usage()` 读请求数与最近用量、`dispose()` 收尾。线程不占 `tasks`、不拿路径租约、绑定 `ask` 当时的当前会话；每次 ask 的用量由宿主以 `origin: 'plugin'` 记进会话 `subagentUsageHistory`。system prompt 是整体替换，插件要自己带上它需要的上下文。
- 插件异步回写先通过 `ctx.session.captureOwner?.(callbacks.context)` 捕获发起者（命令不传上下文则取当前会话），notice 显式传回 owner；`turn:before` / `turn:after` 与会话生命周期按 owner 隔离临时状态，`primaryAgentOnly` 不代表整个 TUI 只有一条主会话。

### ui / logger / health

- 运行归因使用 `ctx.pluginStatus?.()`（当前 manager 内存里的装配快照、动态启停后即时变化），不要用其它进程可覆盖的 `plugin-status.json` 代替。
- setup 异常只走装配报告 / 日志，不写运行健康；hook 错误写入当前插件版本。成功装配不清除 runtime 故障。旧启动错误由 evolution 的 `plugin-startup-health` 归档原文，运行时不兼容这种混写形态。
- Harness Review 配置页状态聚合所有工作区，工具按会话目录筛选；手动重算 / 清理后立即更新全局状态，局部重算不提升全局规则版本。展示近期24小时、历史待评估、评估进展与待复核，时间覆盖不足单独标未知，同时展示统计时间及扫描/分析限制。仅近期重复与待复核触发提示点；代码修改或没有新错误不自动写评估、不表示已确认修复。

- 输入框上方的会话摘要用 `PluginPanelView.cards`（每插件最多 3 张，`id/title/summary/detail/tone/revision/actions/impressionAction`），由宿主复用主题和共享控件；清单 `dynamicShortcuts: true` 使快捷区获取视图。动作带版本 key，插件拒绝旧内容点击。`impressionAction` 只记录实际可见展示，不能在 `view()` 中记录曝光或执行副作用。
- 插件行为埋点用 `createPluginExperience(ctx)`（`PluginExperience.ts`），事件 `plugin:experience`、schemaVersion 1；仅固定动作与结果等元数据，禁放正文、路径、命令与服务地址。`telemetry` 开关即时停记，日志沿用现有轮转。导出：`bun scripts/plugin-experience-report.ts`，口径见 `docs/plugin-experience.md`。

- 命令结果给用户看走 `ctx.ui.notice(content, { command, status, surface, variant })`：`surface: 'command_panel'` 是输入框上方的运行中面板（被同一 `command` 的下一条 notice 收尾），默认进对话的 notice；headless 宿主直接落进 turn notice 日志。
- 用户可见故障（缺配置、外部服务拒绝、请求失败）必须 `ctx.health.report({ level, message, hint })`，不能只写日志。记录带上是哪一版插件写的（`createPluginHealthStore` 的 `version`），读的一方传 `version` 就只认这一版：升级之后上一版留下的「连不上 X」不该继续挂在页面上。装配失败（setup 抛错、入口加载不了）不属于健康状态——那条走 `plugin-status.json`，卡片上写「加载失败」；健康状态 `error` 写「运行出错」。
- `ctx.logger` 按 pluginId 注入，同时写 `resolveLogDir()/plugin-<id>-<day>[-n].jsonl`（macOS `~/Library/Logs/mica`，2 MB 分片、7 天清理、`MICA_PLUGIN_LOG=0` 关闭）。排查插件问题先看它。 配置页日志入口取实际存在的最新日期及数字分片；无日志时返回真实日志目录，不使用下一次写入路径。

### ask（问用户一个问题，等一个回答）

- `ctx.ask.request(question, { signal })` 把一道选择题交给客户端：`title` 一句话问题、`detail` 补充说明、`options`（`id` / `label` / `description`，最多 8 个）、可选的 `multiple` / `allowCustom`（默认开，`false` 才收掉自由输入框）/ `timeoutMs` / `summary`。答案 `{ optionIds, custom?, cancelled, reason }`，`reason` 取 `answered` / `cancelled` / `timeout` / `aborted`。
- **它在工具里 await 到用户点选为止，然后回到同一次迭代**——不追加消息、不开新一轮，所以「选完之后直接继续」不需要任何投递机制。改写/中止由传进去的 `AbortSignal` 结束（工具拿到的 `callbacks.signal`），宿主会同时撤掉那张卡片。
- 选项上的 `prompt` / `command` 不进客户端，只回到插件手里：前者是「选中后要做什么」的一段指令，后者是要当场执行的命令。真正执行命令的是插件（`ask` 只负责问答），所以「用户点一下就跑脚本」这条路径由插件自己实现并负责把它写进用户看得见的地方。
- 超时不是错误：拿到的仍是 `cancelled` + `reason: 'timeout'`，插件自己决定退化成什么。
- 官方 Ask 的 `ask_user` 默认等待 5 分钟，插件设置 `timeoutMinutes` 可调整为 1–60 分钟，每次提问重新读取，单次 `timeoutMs` 可覆盖。超时后通过 `ctx.ui.notice` 向提问前捕获的会话 owner 提示「等待回复已超时，将先按保守方案实现第一版」，工具结果要求模型继续安全、可逆的工作；不自动执行选项命令，也不把超时当成高风险操作的授权。宿主通用 `ctx.ask` 的默认等待不受此设置影响。
- **`ctx.ask.post(question)` 不阻塞**，返回 `{ id, answered, dismiss() }`：把卡片发出去插件就继续跑，用户不答也不影响任何东西。用于「后台发现了一件事，问一句要不要处理」这类顺手一问——不要为了问一句把整轮挂住。
- 同一时刻只显示一个问题（输入框上方只有一块位置，两个问题并排时用户分不清在答哪个）。抢占按「谁真的在等」定：阻塞式 `request` 可以顶掉正在显示的 `post`（那个没人等，撤掉不损失），反过来 `post` 撞上 `request` 直接抛错。
- **`display` 逐项开关每个元素**（`icon` / `meta` / `detail` / `options` / `input` / `confirm` / `hint` / `dismiss`），不传就按数据推导（`confirm` 只在多选或能自由输入时出现，`meta` 只在两个以上选项时出现）。`presentation` 选呈现位置：`dock`（缺省，输入框上方的一条）与 `modal`（浮层，适合「这一步不决定就没法继续」）。选项少、问题短的当场用 `display` 收窄，比让插件各画一套强。
- **等待期间宿主把会话文件顶部的 `awaitingInput` 写成 `summary`**（缺省用 `title`），侧栏据此在会话列表那一行显示「在等你选」；答案回来或轮次结束时清掉。`summary` 就是给侧栏那一行用的短句，别拿它当标题。
- 只有能把问题画出来、也能收到点选的宿主提供这一面（桌面端 `mica app-server`）：TUI 与 `mica exec` 没有可点的地方，写进 `requires: ["ask"]` 让它整插件跳过，比装载成功却没人回答强。

### llm（插件自己问一次模型）

- 插件自己问一次模型（起标题、写提交说明、整理记忆）只声明 `plugin.json` 的 `llm`，代码里用 `ctx.llm.request()`：接口地址 / Key / 协议 / 模型由声明生成（`group: 'llm'` 的普通设置项）。每个声明 `llm` 的插件都自带「复用当前会话模型」开关，**缺省就复用会话模型**（插件不声明也不需要声明；只有必须先用自己的接口才好用的插件把清单的 `reuseByDefault` 写成 `false`）。复用由宿主解析成当前会话的 provider（会话钉住的优先，其次模型名的 `provider/model` 前缀），选中时自己的四项在界面上隐藏。请求走 `ctx.llm` → `ctx.models` → `mica-agent/modelText.ts` + `apps/cli/src/plugins/pluginModels.ts`，协议分支、超时中断与用量记账只有一份实现，记录以 `origin: 'plugin'` 落进会话的 `subagentUsageHistory`，并作为一条 `plugin-llm` helper 运行进观察流；配置页的「测试连接」用同一个执行器（`probeModelConnection`，不记账也不进轨迹）。插件里不自建模型 HTTP 客户端，也不自己拼地址 / Key。
- 模型配置的界面只有一份：`mica-config-ui` 的 `LlmSettingsSection`，配置页插件详情与桌面端会话设置都渲染它（会话里带逐字段「跟随默认」，摘要写当前会话会用的模型）。新增宿主入口时复用它，不要再写第二套模型表单；插件也不自带模型配置组件。
- 插件配置的模型不可用时 `ctx.llm` 自己降级：用当前会话的模型（配置文件里的 provider/模型，会话里切过就是会话自己的）把这次请求重发一次，成功后记住这份配置（改任意一项就重新尝试），降级原因以 `warn` 上报 `ctx.health`、`describe()` 标「已降级」。abort 不降级；已复用会话模型且没点名模型时没有第二目标，直接抛错。降级是组件行为，插件不写 `try 自己的 → catch 换会话模型` 这一套。
- `llm` 的键（`useMainProvider` / `baseUrl` / `apiKey` / `protocol` / `model`）不允许再在 `settings` 里重复声明；`required` 只在关掉「复用当前会话模型」后生效（`requiredWhen`）。复用时隐藏的四项也不参与请求、摘要与试连，只有单次 `ctx.llm.request({ model })` 可以显式覆盖模型。

## 清单驱动的界面

### 设置项与运行状态

- 设置项在清单 `settings` 里声明，类型 `text` / `password` / `textarea` / `select` / `number` / `switch` / `directories`；数字项可带 `step` 与 `unit`，开关值只能是 `"true"` / `"false"`。值存 `$MICA_HOME/plugin-settings/<id>.json`，读取按 mtime 判断是否变化。
- `directories` 是「一组目录」：存储形态仍是换行分隔的文本（`ctx.settings.get()` 读到的就是它），页面把它渲染成目录列表 + 「选择文件夹…」（系统面板，见 `desktop.md` 的 `/pick-directory`），在浏览器宿主里退化成手动输入行。别为多值插件自己发明 JSON 数组格式——那会绕开 `validatePluginSettingValues()` 与所有宿主里同一份控件。
- 校验只有 `validatePluginSettingValues()` 一处：写盘前拒绝，插件读值时同样过一遍；非法值既不落盘也不静默通过。
- 插件自己拿到值（注册换回的口令、探测到的地址）就用 `ctx.settings.set()` 写回去，只改传入的键、其余保持原样，写盘前过同一份校验——不要要求用户复制粘贴，那正是最容易出错的一步。
- 运行条件由清单 `desktop.checks` 声明，取值只能来自 `mica-plugin/PluginDesktop.ts` 的 `DESKTOP_CHECKS`；配置页 Settings → Plugins 的插件详情里渲染成「运行条件」一节（状态 + 打开系统设置），插件跑在 app-server 子进程里、探测不到也渲染不了。新增一种检查项 = 在 `DESKTOP_CHECKS` 登记 + 桌面端实现探测器（`src/main/system/`）。声明了它就写 `requires: ["desktop"]`。
- 运行状态由清单 `status` 声明（`key` / `label` / `type: text|link`），值由插件写进 `$MICA_HOME/plugin-data/<id>/data.json`，配置页插件详情渲染成「运行状态」一节。值是字符串或 `{ text, tone: ok|warn|error }`——插件判断语义，页面只上色；没写过的键显示「尚未上报」，不隐藏。插件详情因此不需要为每个插件各写一套状态界面。
- 「得有人点一下才会好」这类状态另写一条 `attention`（`{ text, tone: warn|error, action? }`，同一份 `data.json`）：侧栏 **Plugins** 入口与插件目录的卡片上出现一枚提示点，点进去是插件详情里的一条提示 + 清单声明过的那个动作按钮，结果就地显示。`action` 必须是清单 `actions` 里的 key，页面丢弃没声明的；没 `text` 或 `tone: ok` 视为撤销。**写不写由插件判断**——没有可执行动作的 warn（中转机不可达、本机缺产物）不该上报，一枚点不动的提示比没有更糟；解析与归一化在 `mica-config-ui` 的 `plugins.ts`，侧栏那枚点由 `renderer/src/plugin-attention.js` 每 30 秒重读一次详情。**一条提示只点一次**：页面按「插件 id + 文案」记住点开过的那条（文案里带版本号，所以换了一版是另一条），插件在动作里要把这件事记上账并抹掉 `attention`（`mobile-relay` 的 `page-notice.json`）——持续状态每次重算都重新点亮红点，等于一个关不掉的通知。

### completions（`/` 里的条目）

输入框 `/` 里的条目用清单 `completions` 声明（`[{ name, description?, insert, roles? }]`，`name` 不能带空白——`/` 后面的查询按空白截断）：选中只往输入框插 `insert` 那段文本，不执行动作，`/` 是补全而不是命令面板。写清单而不是运行期注册，是为了**没有会话宿主时也能列出来**（刚打开应用、还没跑过任何一轮）：宿主只读官方清单（编译进产物）与 `$MICA_HOME/plugins/*/plugin.json`，不导入插件入口（`host/plugin-completions-core.js`，渲染层并入 `/` 的同一套评分）。停用插件、角色不匹配都跳过；重名只留先出现的那条（用户插件排在官方前面）。

### desktop（入口、整页、面板、会话菜单）

**系统启动器**由随包清单 `desktop.launcher`（`title` / `shortcut` / `width` / `height`）声明。
Electron 外壳 `main/plugin-launchers.js` 管理系统快捷键与独立浮窗；页面 `PluginLauncher.jsx`
只挂载插件 `desktop.jsx` 的 `Launcher`，不挂聊天。后端通过 `host/plugin-launcher-runtime.js`
按目录加载插件 `launcher.js` 的 default `createLauncher(context)`，不依赖会话 app-server。
接口类型在 `mica-plugin/PluginLauncher.ts`；context 只有插件设置与版本化插件数据，返回
`request(action,input)` 和可选 `dispose`。停用时两端一起释放；宿主不认识搜索等业务逻辑。
前端 `api.launcher` 提供 `request` / `status` / `retry` / `show` / `close` / `configure` / `openPath`；
原生动作走已有私有系统 socket 的 `/plugin-launcher`，路径交给主窗口唯一的编辑器入口。
插件设置页可打开启动器；浏览器宿主用整页显示同一组件，系统快捷键与浮窗仅桌面应用可用。
这类模块同 `desktop.jsx` 一样只支持随包插件，无用户插件运行期代码加载。

`desktop` 能力只有桌面端 spawn 的 app-server 提供：`buildSpawnEnv` 注入 `MICA_PLUGIN_DESKTOP_HOST=1`（别用 `MICA_DESKTOP_HOST`，那是运行时的绑定地址），`runAppServer` 据此传 `desktopHost` 给 `HeadlessPluginHost`。CLI / TUI / `mica exec` 里没有它，依赖插件整块跳过。

**入口**由清单 `desktop.entry`（`{ "entry": { "label": "Connections" } }`，可选 `placement`：`sidebar`（默认）是侧栏一行、`header` 是主区顶栏右侧的一枚图标按钮，文案进 tooltip）+ 插件目录里的 `desktop.jsx` 组成：`default` 导出卡片组件（props `{ api, onClose }`），可选命名导出 `summary(api)` 给入口行右侧那一行字。宿主只画一行与卡片容器（悬停/点击、浮层定位、Esc 与点外部收起都在 `renderer/src/PluginEntries.jsx`），按 id 用 `import.meta.glob('@plugins/*/desktop.jsx')` 找模块，所以**不需要在宿主里登记**。只对随包插件生效：页面是构建期打的包，`$MICA_HOME/plugins` 里没有它的模块，用户插件声明了也渲染不出入口。

同一个 `desktop.jsx` 若在清单里另外声明 `desktop.page`（`{ "page": { "title": "排期" } }`），点这一行不进浮层而是打开整页：宿主把它渲染在 `renderer/src/PluginPage.jsx` 里（盖住整窗、顶部一条 `← 返回对话` + 标题，内容是插件模块自己的组件，props 同样是 `{ api }`），`App.jsx` 用 `pluginPage` 状态承接、清掉浮层的悬停展开——时间轴、看板这类要整屏宽高的界面走这条，浮层的 320px 放不下。

`entry` 是**可选**的：只声明 `desktop.page`、不写 `entry` 的插件不占侧栏 / 顶栏位置，整页从配置页插件详情里那枚「打开…」按钮进（`PluginsPage` 的 `onOpenPluginPage`，由宿主按 id 现取模块并打开——`renderer/src/plugin-entries.js` 的 `loadPluginPageEntry`，所以同样只对随包插件有效）。`session-tags` 走这条：打标签在会话行右键与 `/tags`，重编标签表才需要那张页面，不必常驻侧栏。

**输入框控件**由清单 `desktop.composer: true` + 同一个 `desktop.jsx` 的 `Composer` 命名导出组成：宿主在 `renderer/src/PluginComposerControls.jsx` 里按插件 id 挂到输入框动作区（「+」之前），props 是 `{ api, isMobile, appendText, onOpenSettings }`。`appendText` 只追加进**当前草稿**（不覆盖已输入内容、不发送），实现在 `ChatView.appendComposerText`；控件拿到的 `api.panelAction(action, values)` 与 `desktop.panel` 的动作是同一条会话级通路（`chat:plugin-panel-action`），所以插件只写一份 `ctx.desktop.panel(...)` 就能同时服务面板与输入框；`api.uploadAttachment(file)` 走 `/api/attachment`（与「添加附件」同一目录），只把临时素材落盘、**不**插路径。与 `entry` / `page` 一样只对随包插件生效，理由相同：页面是构建期打的包。

**面板**由清单 `desktop.panel`（`{ "panel": { "label": "需求开发", "roles": ["需求开发"], "display": "modal", "shortcuts": [...] } }`）+ `ctx.desktop.panel({ view, action })` 组成：**插件给数据、宿主画出来**，所以用户插件也有。视图是纯数据（`title` / `status` / `statusBar` / `sections〔title, subtitle, text, markdown, editor, rows, items, table, fields, commit, actions〕`），宿主统一归一化（长度、条目数与字段类型）后渲染，畸形视图不会让页面崩掉。几种内容各管一种事：

- `text` 是一整段会换行、保留段落的正文（需求描述、结论），不解释 Markdown 语法；
- `markdown` 是一整篇 Markdown 正文，用**对话区那套渲染**排版（标题、列表、表格、代码块）：角色文档这类本来就是 markdown 的内容用它；与 `text` 互斥、同时给按 `markdown` 画，正文上限 8 万字符。宿主不另写一套排版；
- `rows` 是「标签 — 一个值」（`wrap` 让长句 / 长路径换行而不省略，`link` 让值可点、由宿主交给系统浏览器）；
- `items` 是一列可带按钮的条目；
- `table` 是几列并列的清单（`columns` 声明列，`grow` 让一列吃掉剩余宽度，`actions: true` 的那一列画 `row.actions`；格子是 `{ text, sub?, tone, link }` 或 `{ check: { checked, action } }`，`sub` 是同一格的第二行——地址、路径、上次连接的时间，主行照常染色、副行退一档，别把两件事拼成一行）；勾选列由宿主收窄居中，勾选切换带上行的 `key` 与 `values.check/column`，`keepDrafts` 保证切换不动表单里正在填的字；没有行的表整块不画，让插件用 `empty` 说话。

`statusBar.section` 让输入框上方那颗状态胶囊点开后落到指定分区。`display` 决定呈现形态——默认 `drawer` 是右侧 340px 抽屉、每个 section 一块 `CollapsiblePanel`（`collapsed` 决定初始是否收起）；`modal` 是盖住整窗的弹窗、**左边分区导航（复用设置页的 `SplitView` / `split-item`）、右边该分区的详情**、**高度定死**（切分区不抖）且内容在内部滚动（内容多时别用抽屉）。`open` 声明「点了入口直接执行这个动作」而不是打开抽屉——只回答一件事的面板（手机访问那张二维码）用它，点「+」菜单那一行就把动作交给插件、按动作回包弹窗，不必为一张码先摊开一整块抽屉。

有输入框的 section 用 `commit` 声明自动保存动作，宿主在输入停顿约 0.5s 后带字段值调它，设置类因此不用再点按钮；**自动提交不消费表单**——它只是把草稿同步过去，动作完成默认会按新视图把输入框归位，所以这类动作（以及任何失败后要让人改一个字再试的动作）回 `keepDrafts: true`，否则视图永不回填的输入（密码）会在停顿半秒后凭空消失。动作只回 `{ action, key?, values? }`，宿主每次动作后重新取一次视图。一个插件最多一块面板（再注册会替换）。

`roles` 是显示条件（会话角色名，空数组＝任何角色）；声明了它就要写 `requires: ["desktop"]`，但**没有** `desktop.entry` 那条「只对随包插件生效」的限制。

`shortcuts` 是输入框正上方那排按钮，每个四选一：`action` 直接触发插件动作（不打开面板），`section` 打开面板并展开同名 section，`items` 是一组写死的子项（悬停/点击展开：「频道」→ 同步频道 / 频道设置），`menu` 的**表格**来自视图的 `menus[menu]`（`{ columns, rows: [{ key, action, cells }] }`：会话事实现算，「PR」→ 这个需求涉及的项目 / 端 / 分支，点一行就评审那一条）——常用动作、配置项与按状态变长的入口因此各走各的路，不用挤进一块抽屉。

按钮也可以是**运行期**的：清单写 `desktop.panel.dynamicShortcuts: true`，视图返回 `shortcuts`（`{ id, label, action?, section?, key? }`，最多 8 枚），宿主把它们画在同一排、排在清单声明的那些之后。这条路径给的是「按钮本身运行期才知道」的插件（模型在会话里现建的一排按钮）；静态入口仍写清单，运行期不给菜单。视图按钮的 `id` 必填（页面靠它认「还是那一个按钮」，也是 `shortcutStates` 的键，页面 key 带 `view:` 前缀与清单按钮分开），`key` 是点击时随动作回传的那个 `key`——一排按钮共用一个动作 id 时靠它分辨。声明了它，即使清单里一枚按钮都没有，页面也会为首屏取一次视图；没有落点或 id 不合法的按钮在归一化里丢掉。

视图按钮还能带 `preview`（`{ title, subtitle?, text?, markdown?, columns?, rows?, note? }`，与弹窗共用同一份只读内容块，表格最多 6 列 / 8 行）：悬停出那张**不打断对话**的轻量卡片，底部动作由宿主按这枚按钮自己的落点生成，插件不能从 `preview` 注入动作。与 `menu` 分工——`menu` 是「点行就动手」的数据表，`preview` 是「只看不动手」的摘要（产物对不对 / 服务通不通 / 构建成没成）。

按钮的外观只声明**意图**：清单与视图的 `shortcuts[].style = { icon, color, shape, iconOnly }`，`icon` 取 `PluginIcon` 那张 lucide 表、`color` 取 `accent|danger|success|warn`、`shape` 取 `pill|soft|plain`。宿主在 `renderer/src/plugin-panels.js` 的 `quickbarButtonLook()` 里翻成类名，色值全走主题令牌（明暗两套），因此插件写不出「只在一套主题里读得清」的颜色；认不出的取值当没写。

需要「点开先看一眼」的入口不要另开一套界面：插件从 `action` 回 `dialog`（`title` / `subtitle` / `text` 与 `markdown` 二选一 / `columns` + `rows` / `note`，另加 `actions` 最多 3 颗底部按钮），宿主用已共享的 ModalShell、表格与 Button 渲染（`ChatView` 的 `PluginTableDialog`）。弹窗按钮点了把 `{ action: id, key }` 交回同一个 `action` 处理器，回新的 `dialog` 就换内容——所以「一段说明 + 几个做法」是一条链，不需要插件自己画页面。

动作的返回形态（页面负责建会话、摆页签、控制发送时机、弹窗排版，插件只声明意图）：`{ message }` 回一句话（显示在按钮旁边；常驻宿主里 `ctx.ui.notice` 用户看不到）、`{ compose }` 把文本放进当前会话输入框（不发送）、`{ newSession: { prompt, role?, cwd?, confirm?, send? } }` 开一个新会话跑这段提示词（默认先弹窗让用户看见并编辑，点开始才发；`send: false` 只把提示词放进输入框、等用户按回车，指令类动作不该由插件替人按发送）、`{ dialog: { title, subtitle?, text?, qr?, columns?, rows?, note?, configure? } }` 弹一个只读弹窗（`qr` 是一段二维码，插件只给 `{ value, caption? }`、编码与静区归宿主；`text` 是会换行的正文；`columns` + `rows` 给对齐的表格，格子 `{ text, link? }`，带 `link` 的交给系统浏览器打开；三者可以单用也可以叠；`configure: { label? }` 在底部多一个打开**这个插件自己的设置页**的按钮，「还没配好」的弹窗用它把人送过去，`panel: { label? }` 同样是个按钮但打开**面板**——弹窗只回答最常问的那件事，首次部署这类细节仍留在面板里；两者之外纯展示、编辑仍回面板 section）、`{ openPath: { path, line?, focus? } }` 让宿主把这个文件在应用里打开、`{ openReview: { cwd, base?, head?, label? } }` 让宿主盖一层**整窗评审视图**：`head`（缺省取那个目录当前检出的分支）相对 `base`（缺省按仓库主分支解析：`origin/HEAD` → `main` → `master`）在分叉点上比，左边文件、右边 diff。两边都只从提交里读（`git:ref-summary` + `git:file` 的 `refs` 模式），**不读工作区、也不改会话目录**——评审别人的分支不会把评审人自己的未提交改动混进来，那个目录被清掉也不影响，关掉就回到原来的对话。`cwd` 只提供仓库位置、不是会话工作区：评审层不加载那里的文件树；面板只有 340px，插件自己的配置、随包分发的 skill 这种超过一屏的正文在那里既看不清也改不动，编辑交给宿主已有的能力。动作改到的 `ctx.sessionState` 由宿主在动作返回后补一次会话落盘，插件不用自己触发保存。

**会话右键菜单**由清单 `desktop.sessionMenu`（`[{ "label": "复制会话 Markdown", "action": "copy" }]`，可选 `icon` 按行声明图标（取值见 `mica-config-ui/web/pluginIcons.tsx`，省略回落到插件图标）、`position: "top"` 摆到菜单最上面、省略则排在宿主自己的项之后与删除之前、`surface: "chat" | "sidebar"` 限定只出现在其中一处（省略＝两处都出；两处共用同一份清单，过滤在 `renderer/src/session-menu-plugins.js` 里按 `surface` 做，侧栏与对话区各自传自己那一处））+ `ctx.desktop.sessionMenu({ run })` 组成：**菜单项来自清单、处理器来自插件注册**——右键是同步交互，不能为「有没有菜单项」去冷启动 app-server；处理器只活在插件所在进程里，页面只转发 `pluginId + action`。`run()` 只认 `copyText`（页面写系统剪贴板：插件进程里没有剪贴板，也不该为三个平台各调一次系统命令）与 `message`（回给用户的一句话）。动作要立刻返回，不要在里面等模型请求。声明它就要写 `requires: ["desktop"]`；用户插件同样有。

### 前端模块的 api

插件前端模块的能力就这几件，来自 `renderer/src/plugin-host.js` 的 `createPluginHostApi(pluginId, session)`：`currentHost()`（页面所在运行时的 origin）、`probe(address)`、`readData()` / `writeData(value, options?)`、`open(url)`、`access`（读改写这台机器的远程访问策略）、`action(key)`（执行清单 `actions` 里声明过的动作，宿主转给一次性插件进程 `mica plugin-action`；卡片要「真的干一件事」时用它，不要用 `writeData` 伪造一个请求位再等后端轮询，没声明的 key 会被拒绝，卡片能做的动作与配置页的按钮是同一份声明）、`session`（页面正在看的那条会话：`id()` / `sessionId()` / `cwd()`、`state.read()|write(value)|subscribe()` 读写插件自己的会话级状态（`pluginState[pluginId]`，与 `ctx.sessionState` 同一份，走 `mica/sessionState/get|set`）、`onIdle()` 在这一轮跑完时回调——模型在轮次里写下的状态只能在这一刻重读）。`session` 为 null 表示当前没有打开的会话，卡片要如实画空态。探活、数据读写、访问策略与动作必须由运行时代劳（页面读不到跨源响应、碰不到请求分派、也没有文件系统），落在 `host/plugin-host.js` 的 `plugin-host:probe` / `plugin-host:read-data|write-data` / `plugin-host:access-get|set` / `plugin-host:run-action`；数据文件统一在 `$MICA_HOME/plugin-data/<id>/data.json`，宿主不解析结构。读取返回 `{ value, version }`，缺文件两者为 null、IO 失败显式报错；读改写可带 `{ expectedVersion }`，宿主在跨进程锁内比较版本并原子替换，冲突返回 `{ ok: false, conflict: true }`，插件重读并只重放本次修改。`open` 是纯页面行为，分支在 `shell-env.js` 的 `isElectronShell`。

- 卡片宽度默认 320px，插件模块可以 `export const card = { width }` 声明更宽的（夹在 240–960）；长文编辑这类在 320 里放不下的界面用它，宿主只负责尺寸与浮层定位。
- 插件前端模块用到的 Tailwind 工具类必须被扫描到：`plugins/` 不在 `apps/desktop` 下，`app.css` 里用 `@source '../../.../plugins'` 显式纳入，否则插件里的间距、`group-hover/*`、`max-md:*` 一个都不会生成（表现为间距全塌、悬停不出现）。

## 界面控件只有一份

控件在 `@mica-config-ui/web`：按钮 `Button`（`variant` + `size="compact"` + `fullWidth`；`primary` 是抬起的灰底、`accent` 是实心强调，对话框主操作（确定 / 开始 / 保存）用 `accent`，行内动作用 `ghost`、破坏性的用 `danger-ghost`）、状态 `Tag`、空态 `Empty`、错误 `Alert`、开关 `Switch`、勾选 `Checkbox`（带 `mixed`）、下拉 `SelectMenu`（可 `filterable` / 分组 / compact）、日期 `DateField`（可打字 + Arco 月历）、分段 `Segmented`、数据表 `DataTable`（列定义 + 受控排序 + 翻页 + 窄容器退列，单元格内容由调用方渲染）、普通输入 `Input` / `InputNumber`（onChange 接收值）与透传原生按钮属性的 `ArcoAction`、行 `SettingRow`、分组 `SettingsGroup`、折叠 `CollapsiblePanel`、`SecretInput`。基础控件统一基于 Arco；全应用由 `ArcoProvider` 和 `body.mica-arco-theme` 提供配置与主题，设置布局样式仍限定在 `.mica-config-ui` 作用域内：插件整页（`PluginPage`）与插件入口卡片（`PluginEntries`）已统一套好，面板视图本身由宿主渲染。

**禁止原生 `<select>` / `type="date"` / `type="checkbox"`**：它们的弹层与外观由系统绘制，在浮层和内嵌视图里会飘出控件、几百个选项时铺满整屏，也和旁边的共享控件对不齐；也确实存在不了的形态（多行截断的行按钮、页签、导航项）才用结构化 `<button>` + 自己的布局类，而不是重画一个按钮控件。要新控件先加到 `web/components/Ui.tsx`（或同目录的独立组件）再从 `web/index.tsx` 导出，别在页面、面板或插件里各写一套——同一应用里三种按钮高度比样式不统一更糟的是每次改都要改两处。

## 官方插件

`ask`（让模型把岔路口交还给用户：`ask_user` 工具 + 提问策略 prompt 段落，`requires: ["ask", "prompt", "tools", "settings", "ui", "session"]`。工具阻塞到用户点选，答案回到同一次迭代；选项可带 `prompt`（选中后作为指令回到工具结果）与 `command`（选中后当场执行，输出并进结果）。宿主能力是 `ctx.ask`，只有桌面端 spawn 的 `mica app-server` 提供（`MICA_PLUGIN_DESKTOP_HOST=1`），TUI / `mica exec` / 侧车这类没有可点界面的宿主里整插件跳过）、`todo`（进程内待办 + `plan` prompt 段落，计划纪律在 `plugins/todo/prompt.ts`，`requires` 含 `prompt`）、`btw`（`/btw` 旁问：`ctx.subagents.thread` 开一条可复用的隔离子代理，结果经 `ctx.ui.notice` 呈现）、`session-notes`（会话笔记）、`session-tags`（自定义会话标签：名字与颜色都由用户定，标签表的增删改只在桌面端那张整页里做（不占侧栏一行，入口是配置页 **Settings → Plugins → Session Tags** 里的「打开标签」），`/tags` 与会话右键只管打标；页面通过前端 api 的 `annotations.read/writeOptions` 整份替换宿主那份 `session-annotations.json` 的 `options`，宿主负责跨进程锁、归一化并把删掉的项从会话归属里摘掉，写完广播 `annotations:changed`）、`session-copy`（会话右键菜单「复制会话 Markdown」：`plugins/session-copy/markdown.ts` 确定性拼装标题 / 路径 / 模型 / 用户与助手正文，工具调用、思考与 notice 都不进导出，**不调用 `ctx.llm`**）、`session-rename`（每轮前自动起标题）、`session-compact`（会话压缩：主会话区右键菜单里的「快速压缩」（`surface: "chat"`，侧栏会话行不出现）（工具过程聚合成一条占位调用，对话正文不动，不调模型）与「模型压缩」（用户与助手的对话交给模型写 checkpoint 摘要）；模型配置变更后下一次发送前自动快速压缩，没有阈值与定时触发）、`memory`（跨会话记忆，按**适用范围**分三层：`profile`（用户本人，总是注入）/ `domain`（`domains/<名字>.md` 头部 `match` 声明覆盖哪组同域仓库）/ `project`（按仓库身份归档：`repo.ts` 纯 fs 读 `.git`、worktree 的 `commondir` 与 `origin` 地址，不 spawn git；无 git 时只认带项目标记的当前目录）。**只注入当前会话适用的层**，没有适用条目时整段不出现；存储不设写入上限（20 000 字符失控保护），注入按层预算挑选、`! ` 前缀优先。**项目记忆跟着「实际在改哪个仓库」而不是 cwd**：`activity.ts` 从 `agent:observe` 的 `tool:call` 参数认路径（写 3 / `cd` 2 / 读 1，同一次调用按 slug 去重），权重 ≥2 的非 cwd 仓库（最多 2 个）注入，最高者成为工具省略 `repo` 时的默认写入目标，模型也可用 `memory({ repo })` 显式指定。`memory` 工具默认最窄作用域；整理器（`curator.ts`）过三道测试、默认最窄、**不允许写 profile**、不能新建领域，领域只能由 `/memory domain new` 创建，操作可带 `repo` 决定归属。会话内冻结，`/memory refresh` 或作用域变化（`/cd`、认出新目标仓库）才重读。整理可走宿主子代理，也可配独立接口地址 / Key / 协议 / 模型）、`web-search`（`web_search` 工具）、`video`（`video_frames` 工具：按时间点抽帧，走已有的多模态图片链路，内核零改动。**可寻址单位是时间不是帧序号**——下一轮的模型看不到上一轮返回的图片，`at:["1:03.5"]` 才自洽。不给 `at` 时按画面变化取样，不是均匀撒点：把视频降到 96×54 灰度逐帧求差（ffmpeg 自己的 `scene` 分值对深色终端录屏只有 0.016，完全不够用），静止为主的画面用噪声底线判切换——**不能按峰值折算阈值**，一次剧变（切窗口 0.89）会把同一视频里其他真实转场（0.0006）全吞掉；切换点要往后挪 0.25s 再取帧，差异最大的那一刻正是转场中间态（实测取到一整张纯白）；切换点比帧数多时按时间分桶、段内取变化最大处，只挑最剧烈的会把帧全挤到后半段。整段帧差都在噪声底以下（静止录屏、单页幻灯片）时只给首尾 1–2 帧并说明，别发四张一样的图（每张约 790 tokens）；段数少于请求帧数时如实给段数，硬凑只会重复某一段。`start`/`end` 只扫描那一段（长录屏看某 10 分钟），扫描 fps 按区间长度自适应以覆盖整段而不是只扫开头；`-ss` 落在最后一帧之后时 ffmpeg 一帧都取不到，采样上界按 `max(0.1s, 2/fps)` 往回退，极短视频（单帧导出）只取开头；帧按「真实路径 + 大小 + mtime」缓存在 `plugin-data/video/frames/`、下载的远程视频在 `plugin-data/video/sources/`，两者共用一个容量上限（一小时内下载的 source 不动，可能正被 ffmpeg 读着），同一视频追问第二次不起子进程（536MB 4K 首次 5.1s、缓存 66ms）；依赖本机 ffmpeg，缺失时上报健康状态并给出可行动的报错）、`subagent`（7 种子代理类型、`agent` 工具、委派 prompt 段落与委派倾向设置）、`evolution`（旧数据清洗：每次宿主启动跑一轮，把 `$MICA_HOME` 下变过的会话与插件数据就地改成当前形态；`/evolution status|run` 查看与手动触发。迁移规则的唯一来源是 `plugins/evolution/migrations.ts`（会话快照）与 `plugins/evolution/data/`（其它数据），改了持久化形态就往里加一条，运行时代码不保留旧形态分支；账本与备份在 `plugin-data/evolution/`，每台机器各跑自己那份）、`commit`（`/commit` 命令：确定性 git 分析 + 一次模型请求写提交说明 + add / commit / push；模型可复用当前会话，也可单独配接口地址 / Key / 协议 / 模型）、`computer-use`（macOS 桌面自动化：`computer_use` 工具（`Tool.ts`，一次调用 = 一批步骤 = 一次用户确认）+ 随包 skill + runtime（AX 元素树 + CGEvent 键鼠 + 截图，落盘到 `$MICA_HOME/computer-use`，首次用到时 clang 编译 helper）。**写命令必须经工具**：用户点「允许」后工具写一份一次性许可文件（内容是这次批准的具体命令，每条只能消费一次、2 分钟过期），经 `MICA_COMPUTER_USE_APPROVAL` 传给 `desktop.mjs`；runtime 自己校验，模型绕过工具直接 shell 调写命令会退出码 6。没有 `ctx.ask` 的宿主只留只读命令，写操作直接拒绝（问不到人就执行是更糟的降级）。截图按 `screens` 的多屏几何走：默认每块屏各截一张、第一张是前台窗口所在屏，`--display` / `winshot <app>` 收窄，坐标是跨屏全局逻辑点；权限状态显示在配置页插件详情的「运行条件」里）、`browser-cookie-sync`（Chrome MV3 扩展监听 cookies.onChanged，通过仅监听 127.0.0.1:19387、要求 Bearer 口令的插件服务增量写入受控浏览器；Mica 浏览器 cookies.changed 单独 SSE 只发身份键，插件按作用域回读最新值推给扩展。MV3 唤醒/重连才全量对齐，两侧同时改动不自动覆盖；无需按钮、全磁盘访问或钥匙串。插件停用时服务随宿主卸载；设置页的「安装 Chrome 扩展」展示安装目录与口令）、`connections`（侧栏 `Connections`：接另一台机器上的运行时，连接清单存 `plugin-data/connections/data.json`；能力全在 `desktop.jsx`，后端 setup 是空的）、`quick-buttons`（输入框上方那排「点一下就走」的按钮：`quick_buttons` 工具按**会话**建/改一排按钮（最多 6 枚），四个落点——`open`（默认在受控浏览器里打开：`MICA_BROWSER_URL` 的 `POST /browser/browsers` 带 `x-mica-owner`，窗口挂到顶栏图标上；没有受控浏览器时退回系统浏览器）、`compose`（放进输入框不发送）、`session`（开新会话跑提示词）、`path`（在应用里打开文件）。按钮存会话快照的 `pluginState['quick-buttons']`，切会话就换一套。面板走 `dynamicShortcuts`：按钮由视图现给，面板本身只管看一眼、删一个、手动加一个。`requires` 里**没有** `desktop`——TUI / `mica exec` 里工具照旧可用，工具结果把每枚按钮摊平成可读的链接，那段 prompt 只在桌面宿主渲染）、`schedule`（本地排期，与任何聊天工具无关：数据就是 `plugin-data/schedule/data.json` 里的一串任务，每条有名称、起止、颜色与 Markdown 备注，同色的任务排在同一行。侧栏 `Schedule` 开整页甘特图：工具栏改标题 / 日周月 / 缩放 / 今天 / 新增任务 / 导入导出清空，空白处点或横拖新建、拖条体 / 两端改期、点条开弹窗改名称颜色备注，滚轮缩放（锚点换算在 `gantt.ts`）、Shift+滚轮平移，别处的写入 15 秒轮询进来；模型经 `schedule` 工具（`list` / `add|update|delete_task`，按 id 只改一条）与随包 skill `schedule` 读写同一份数据。写盘共用一把跨进程锁：工具侧「现读 → 改一条 → 原子写」（`store.ts`），页面侧按版本比较、冲突时把这条操作重放到最新数据上（`writer.ts`），所以拖动、另一个窗口、模型同时改不会互相覆盖；旧的两层数据（`plans` / `stages`）读取时迁移成扁平任务（计划名并进任务名、计划备注放在第一条））、`sidecar`（派生并驱动子会话：随包 skill `sidecar` + 9 个 `sidecar_*` 工具，每个子会话是一个 `mica app-server` 子进程，`--parent` 写进会话文件让侧栏嵌套；事件走 Codex v2 JSONL，投影在 `plugins/sidecar/transcript.ts`，分层的读法在 `views.ts`；不传 `role` 时继承父会话角色，深度由 `MICA_SIDECAR_DEPTH` 限制在 2 层，子进程在 `onDispose` 里一路降到 SIGKILL 收掉）、`ssh`（让模型操作远端服务器：系统 OpenSSH + 主机清单（面板里按「密码 / 私钥」两种认证方式填：用户名默认 `root`、别名可用中文、密码留空表示沿用已存的那个，口令存 `plugin-data/ssh/secrets.json` 的 0600 明文、只给插件自己读，模型只拿得到别名）+ **按会话的范围**（服务器表里两列勾选：「添加到会话」存会话快照的 `pluginState.ssh`，「自动添加到会话」是新会话的初值；prompt 与 `ssh_*` 工具只认本次会话里的机器，没有全局开关）+ 主机指纹固定 + `ssh_run`（多行脚本）/ `ssh_read`（只读、可多台并发）/ `ssh_session`（持久 shell，长任务分段取结果）/ `ssh_hosts`；ControlMaster 复用连接，输出默认只回尾部、全文在远端 `/tmp`，调用记 `plugin-data/ssh/audit.jsonl`）。

## 数据演进与旧数据清洗

**改了持久化形态（会话字段、用量记录、插件数据布局、目录结构、配置键）时，同一次变更里必须做三件事**：删掉运行时代码里的旧解析 / 回退 / 兼容分支；在 `plugins/evolution/migrations.ts`（会话快照）或 `plugins/evolution/data/`（其它数据）追加一条迁移；更新 `plugins/evolution/README.md` 的迁移表。三者缺一，旧数据要么读不出来，要么永远留在旧形态里慢慢被新代码当成脏数据。

- `evolution` 是官方插件（`plugins/evolution/`），**每次宿主启动跑一轮**：把 `$MICA_HOME` 下变过的会话文件就地改成当前形态，未洗完时 5 秒后续跑（最多 12 轮），洗完就停——不做常驻轮询，否则会在别的宿主读着同一条会话时改写它，迁移结果被那份内存快照写回去、下一轮再迁一次。`/evolution status|run` 查看与手动触发。账本在 `plugin-data/evolution/`，**每台机器各跑自己那份**——另一台装着 mica 的机器不会因为这边洗过而跳过。
- 一条迁移是纯函数（`Migration.apply(document)` 返回改动记录数），只允许**幂等**、**只增补或改名不删用户数据**、**只看文档本身**。不满足这三条就不要写迁移，先设计形态。
- 会话之外的旧数据（记忆文件、插件自己的 JSON、config.json）放 `plugins/evolution/data/`：`DataMigration.run({ home, log })` 返回改动的对象数，没有签名账本，所以每次启动都跑、必须幂等、必须能判成 0。
- 清洗的执行约束在 `plugins/evolution/run.ts`：只处理签名（size+mtime）变过的会话、拿到该会话的 turn lease 才动、单轮有数量上限、每 15ms 让出事件循环、写回走临时文件 + 原子重命名、改动前留首次备份（7 天）。新增迁移不需要改这里。
- 一次性、无法就地转换的形态（需要联网确认、需要用户决策）不写迁移：删掉兼容代码，在本文与插件 README 里写明「这个形态不再支持」，让用户重来而不是让代码长期背着旧分支。
- 统计 / 派生数据（`desktop-stats-index.json`、`session-index.json`）不写迁移：它们是可重建缓存，按签名或版本自动失效。

## 命令

- 命令实现放 `mica-builtin-commands/commands/`；装配放 `plugins/command-*.ts`，统一经 `index.ts` 导出。
- `/commit` 由官方插件 `plugins/commit/` 提供（TUI 里执行，可通过 `--dir` 之外的入口无参调用）。`mica commit`（CLI）与桌面右键 commit 都经 `apps/cli/src/cli/runPluginCommand.ts` 以一次性插件命令执行：只装配 `commands` / `events` / `settings` 这一层插件宿主，不建会话、不启 agent、不记账。
- 命令可以用 `CommandResult` 的 `message`（给用户看的一句话）与 `data`（结构化结果，`mica commit` 直接打印成 JSON）回报执行输出。
- `/capabilities` 管理本会话 Tools / Skills / MCP 三页签开关（运行中拒绝提交，逐项切换）。工具分组由 `mica-tools/registry.ts` 的 `TOOL_FAMILY_LABELS` 唯一定义：只认声明过前缀的工具，至少两个成员才成组。
- quick commands 另由 `apps/cli/src/plugins/commands/index.ts` 注册；新增/删除时检查两条路径与 README。
- 通过 `CommandRuntimeServices` / active proxy 注入依赖；耗时且改状态的命令走 exclusive task。
- turn 运行中是否可执行由注册时的 `allowDuringTurn` 决定；exclusive task 期间仅 status、task、agents、new。

## 工具与 PTY

- `mica-tools` 是唯一 registry，产品工具优先经插件 `ctx.tools.register()`；新增工具继承 `MicaTool`，声明 schema、展示、错误格式与 `readOnly`。
- 工具名一律 snake_case 全小写；历史遗留名登记在 `mica-common/toolNames.ts`，读取处统一过 `normalizeToolName`。
- `readOnly` 分类受 `MicaTool.test.ts` 约束：纯查询为 true；写文件、patch、shell、kill、PTY、wait 为 false。
- 执行类工具按「启动 / 等待 / 查看」拆开：`run_shell` 只跑前台命令（≤120s）；`background_tasks_start` 启动并立即返回 id；`wait_for` 只观察条件。
- `overlappable: true`（`wait_for` / `pty_wait`）或 `canOverlap(input)`（`agent` 仅 await/join）表示可与同消息其余调用重叠；加入前确认无写副作用。
- 只在会话里注册的工具（`agent`、`todo_write`、`session_peers`、`session_notes`、`harness_review`）在配置页/设置页由 `RUNTIME_TOOL_DESCRIPTORS` 兜底列出，改描述要同步 `runtimeToolDescriptors.test.ts`。每条描述带 `pluginId`：注册它的插件停用时 `getToolCatalog()` 跳过这一行。真正装配插件的宿主（TUI、`mica app-server`）在 setup 之前还会调 `micaTools.setRuntimeToolFallback(false)` 整块关掉兜底——那里注册表就是唯一事实来源，否则停用一个插件之后它的工具仍会被静态描述补回目录（用户在能力面板里看到「关掉了却还在」）。配置页 / 桌面设置页这些不加载插件的宿主保持开启。
- PTY 由懒启动的 Node helper（`mica-pty/src/server.mjs`）承载；改 `server.mjs` 后跑 `bun run scripts/generate-pty-server-source.mjs` 同步 `ptyServerSource.ts`。

### Todo

- Todo（`plugins/todo/`）是「本轮计划」，不写 session 快照。宿主只渲染、不改写模型给的状态：turn 结束既不把 `pending` 升成 `completed`，也不把 `in_progress` 退回写进数据。**显示边界也是轮次**：`resolveTodoPanel` 只在清单所属那一轮还在跑（或用户 `/todo show` 手动打开）时返回 `visible: true`；turn 正常完成即收起，中断 / 失败则保留最近清单并暂停显示进行中，下一轮开始前从 checkpoint 读回进度。desktop 从历史里的 `todo_write` 工具行投影，必须校验 `turnId` 才能避免旧计划一直挂在页面上。解析归一化、投影、显示规则唯一实现在 `mica-common/todoState.ts`，TUI 面板与 desktop dock 共用。执行期只做归一化（未知字段忽略、多个 `in_progress` 降级、超长截断），不拒绝整次调用。
- 中断后的进度必须让模型也看得见，而不只是界面：工具批次里 `todo_write` 可能已经执行、其余调用尚未提交到 provider 历史就被打断。因此每次写入都原子落盘到 `$MICA_HOME/todo-checkpoints/<sessionId>.json`（`version` / `sessionId` / `turnId` / `items`，写路径不合法就拒绝），下一轮 `turn:before` 读回，`ctx.agent.onIterationRewrite` 以**一条 system 消息**（`<mica-todo-recovery>`，先删掉上一条再按需追加）附给模型——不写进用户消息、不改 `conversationMessages`。会话归属由 `bindTodoSessionOwner()` 解析（现场取 id，resume 换会话即失效），`mica exec` 这类不落盘的宿主关掉 checkpoint（`setTodoPersistenceEnabled(false)`）。标记本轮已正常完成的 `turnId` 存在会话 `pluginState['todo']`，所以重开应用后不会把已完成的一轮当成中断。
- `session_notes` 工具只改内存（`pluginState['session-notes']`），落盘交给本轮 checkpoint。

## MCP 与 Skills

- `mica-mcp` 管理 `config.json.mcpServers` 生命周期；读取时展开 `url` / `headers` 里的 `${VAR}` 与 `${VAR:-默认值}`，`command` / `args` / `env` 不展开。
- 会话能力目录（`mica/capabilities/get` 的 `mcpServers`）由 `micaMcp.catalog()` 合并三处：用户配置、会话自己的 `--mcp-config`、已连上的 server。桌面端把受控浏览器 / 终端挂进 `--mcp-config` 而不写用户配置，漏掉第二处界面上就看不到也关不掉它们。
- MCP 工具名由 `mcpToolNamePrefix()` 生成；按 server 关闭时用前缀匹配，断开/重连失败同步清理并刷新 registry。
- headless 显式初始化/关闭 MCP，支持独立配置与超时参数。
- skills 只扫描解析缓存、不执行；扫描 `$MICA_HOME/skills` 与项目 `.mica/skills`、`.agents/skills`、`.deveco/skills`、`.agent_context/skills`；未设 MICA_HOME 时额外共享 `~/.agents/skills`、`~/.config/deveco/skills`。插件注册的内置 skill 与磁盘 skill 合流在同一份 `getLoaded()` 里（`registerRuntime` / `clearRuntime`），磁盘同名优先；`parseMarkdown` 是内嵌 SKILL.md 取元数据的唯一入口。
- skill 是含 `SKILL.md` 的目录；内容不能覆盖安全规则、系统指令和当前用户请求。
- 联网：`web_search` 由 `plugins/web-search` 提供（设置 `searxngUrl` → `SEARXNG_URL` → `http://127.0.0.1:8080`，实例须开 JSON，结果缓存 5 分钟）；`web_fetch` 是内置工具。
- 最新、官方、API、价格、法规这类可变事实先联网查证；无法查证时明确说明。
