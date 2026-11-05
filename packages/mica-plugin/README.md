# mica-plugin

`mica-plugin` 是 Mica Code 的插件基础设施包。它提供插件基类、生命周期管理、hook 注册和服务容器，用于把可扩展能力与核心运行时解耦。

## 主要能力

- 只读运行观察：`AgentObservationEvent` 定义 `agent:observe`，由 `HookRegistry.notify()` 按注册顺序调用，观察者抛错或返回挂起的 Promise 均不阻塞任务。异步完成顺序由观察插件负责，磁盘队列在插件 dispose 时 flush。覆盖主运行的起止、实际请求边界与工具定义、最终 prompt、工具调用/结果、用量、重试及历史改写；不在任何一轮里的工作（压缩摘要、旁问线程、插件 `ctx.llm` 请求）作为独立的 helper 运行出现，带 `helper: { kind, pluginId?, purpose? }` 与完整的请求边界。
- 插件自身的运行事件走独立的 `plugin:observe`（`PluginObservationEvent`）：常驻任务失败（`background:failed`：`taskId` / `tick` / `failures` / `error`）与钩子处理函数抛错（`hook:failed`：`hook` / `failures` / `error`）都不属于任何一条 run，挂到某条 run 上会让那条 run 的耗时与失败原因都变假。观察通道自己的 handler 失败不回报，否则 `notify` 会递归调用自己。

- 定义插件的唯一落盘形态（目录 + `plugin.json` + `setup(ctx)`），以及宿主进程内装配时用的 `Plugin` 基类。
- 管理插件加载、启动和销毁生命周期。正常卸载与启动失败都按资源注册的逆序释放；单项清理失败仍继续释放其余资源，正常卸载结束后以 `AggregateError` 汇总失败。
- 运行期启停：资源按 pluginId 分开登记，`syncPluginState()` 在每轮开始（`turn:before`，优先级 -10000）按 `plugins-state.json` 对齐一次——停用的卸载、重新启用的装配，正在跑的那一轮不受影响。`setupAll()` 里被停用的插件只是**不装配**（注册照旧），所以启用不需要重开进程；装配失败 / 跳过会记在 `attempts` 里，别处的名单变化不会让它们被反复重试。
- 提供 hook registry，用于扩展运行时流程。
- 提供 service container 和 service token，用于插件间共享能力。
- 定义 `PluginContext` capability，由应用注入 runtime queue、工具注册和 UI 扩展入口。
- 定义插件包格式：`plugin.json` 清单（id / name / version / main / assets / dependencies / required / priority / settings / requires / `mica.apiVersion`）、目录加载器与只读扫描（配置页用）。
- 维护启停状态（`$MICA_HOME/plugins-state.json`）：停用的插件照常注册、装配阶段跳过；常驻宿主经 `pluginStateSync` 在每轮开始时对齐名单，卸载 / 重新装配单个插件而不必重开会话。
- 插件设置：清单里声明 `settings` 字段，值存 `$MICA_HOME/plugin-settings/<id>.json`，插件用 `ctx.settings.get()` 读。字段标 `perSession: true` 表示「这条会话可以不一样」：会话覆盖存在快照的 `pluginSessionSettings`（只存改过的键），插件改用 `ctx.sessionSettings.get()` 读合并后的生效值，`overrides()` / `set()` / `clear()` 改本会话，需要 `requires` 里有 `sessionSettings`。
- 插件日志：`ctx.logger` 自带文件输出，落在 `resolveLogDir()`（与运行时日志同目录），按天分片、按大小轮转。
- 插件健康：`ctx.health.report()` 写 `$MICA_HOME/plugin-health/<id>.json`，配置页据此显示「正常 / 待配置 / 运行出错」。只有插件自己的状态写这里；缺宿主能力由 manager 记 `plugin-status.json` 的 `skipped`（见 `PluginManager.setupAll`），不进健康文件。记录带插件版本，读的一方传 `version` 就只认这一版写的（升级后旧结论自动失效）。
- 提示词贡献：`ctx.prompt.section()` 追加一段 system prompt，随插件启停一起出现 / 消失。
- 会话状态：`ctx.sessionState` 按插件 id 存进会话快照，resume / fork / rewind 跟着走。
- 会话标注：`sessionAnnotations.ts` 按 session 存插件自己的标注（标签色点等），供 `session-tags` 插件与桌面端会话列表共用。
- 模型请求重写：`ctx.agent.onIterationRewrite()` 在两次模型请求之间改写要发送的历史（自动压缩用它）；`ctx.agent.mode` 回答宿主形态（`session` / `one-shot`），一次性运行里不该跑会额外花钱的后台策略。
- 委派子代理：`ctx.subagents` 注册子代理类型、前台/后台跑一个、管后台任务。`tasks.restart(taskId)` 在原 owner 下创建带原任务与最近活动的替代任务，返回新任务 ID，不是断点续跑；与 `tasks.get` 一样限于本插件可访问的任务，不存在或不能重启时抛错。机制（建子代理、用量记账、路径租约、完成回注）由宿主提供，插件只决定有哪些类型与工具形状。
- 会话归属：`ctx.session.captureOwner?.(context)` 捕获工具上下文所属 owner，不传上下文则捕获当前会话；异步 notice 传回该 owner，临时状态按生命周期事件的 owner 隔离。
- 内置 skill：**清单 `skills` 声明相对插件目录的路径**（目录里有 `SKILL.md` 就是一条，否则扫一层子目录），
  manager 按 `MicaPlugin.root` 读进来注册，插件不必写代码。注册进来的 skill 与磁盘扫描出来的完全同权
  （system prompt 索引、`skill` 工具、会话能力开关）；磁盘上的同名 skill 优先，被遮蔽的条目会报成一条
  健康状态。正文来自内存 / 需要运行时生成时仍用 `ctx.skills.register()`，`skipped` 同理。
- 运行条件：清单里的 `desktop.checks` 声明插件依赖的权限与外部工具，取值只能来自
  `DESKTOP_CHECKS` 目录（`PluginDesktop.ts` 是宿主与插件共用的单一事实来源）。状态由桌面端探测
  并渲染在配置页的插件详情里——插件跑在 app-server 子进程里，既探测不到也渲染不了。
  依赖桌面能力面的插件用 `requires: ["desktop"]` 声明，其它宿主在注册阶段整插件跳过。
- 对话右侧面板：清单的 `desktop.panel` 声明标题、显示条件（角色名）与呈现形态
  （`display: 'drawer' | 'modal'`，默认抽屉；内容超过一屏时用 `modal`，里面按 section 切成页签），插件用
  `ctx.desktop.panel({ view, action })` 交出纯数据的视图与动作分派。宿主负责归一化与渲染，
  所以用户插件（没有前端模块）也有界面；`PluginPanel.ts` 里是类型、进程内登记表
  （`PluginPanelRegistry`）与视图/动作的归一化函数。只在清单声明了面板时才提供这个入口。
  动作回包除了 `message`，还可以声明这几种「跨出面板一步」的效果：`compose`（把文本放进当前
  会话的输入框、不发送）、`newSession`（开一个新会话跑这段提示词，`confirm` 默认 `true`
  表示页面先弹窗让用户看见并编辑）、`dialog`（只读弹窗：`text` 是会换行的正文，
  `columns` + `rows` 是对齐的表格，格子带 `link`
  就交给系统浏览器打开）、`openExternal`（让系统浏览器打开一个地址，只放行 `http(s)` /
  `mailto`，其余 scheme 丢掉）、`openPath`（让宿主在应用里打开这个文件；`focus: true` 只画编辑器、
  收起活动栏与文件树 Git 面板，改一份长文件时用它）与 `openReview`（把主窗口切到编辑器、打开一份对比：
  编辑器停在 Git 面板的 `head` 相对 `base` 上，复用
  它自己的文件列表与 monaco 差异视图；不给 `base` 就按仓库主分支（`origin/HEAD` → `main` →
  `master` → 当前分支）解析，不给 `head` 取该目录当前检出的分支。两边都只从提交里读，
  不读工作区、不切分支、也不改会话目录）。建会话、发送时机、弹窗排版都属于页面，插件只声明意图。
- 会话右键菜单：清单的 `desktop.sessionMenu` 声明菜单项（`label` + `action`，可选
  `icon` 按行指定图标名（取值见 `mica-config-ui/web/pluginIcons.tsx`，省略回落到插件图标）、
  `position: "top"` 摆到菜单最上面，省略则排在宿主自己的项之后、删除之前），插件用
  `ctx.desktop.sessionMenu({ run })` 交出按 `action` 分派的处理器。菜单项走清单是因为右键要
  立刻画出菜单（不能为它冷启动一个 app-server），处理器留在插件所在进程里；`run()` 回
  `{ copyText?, message? }`，剪贴板由页面写。`PluginSessionMenu.ts` 里是类型、进程内登记表
  （`PluginSessionMenuRegistry`）与入参/结果归一化。只在清单声明了菜单项时才提供这个入口。
  同一份清单同时喂两个入口（侧栏会话行与对话区右键），插件侧只有一套处理器。
- 用户插件装载：`loadUserPlugins()` 扫描 `$MICA_HOME/plugins` 并注册进 manager。常驻宿主
  （TUI、`mica app-server`）都要做这一步，`mica exec` 不装用户插件。
- 装配结论：`writePluginStatus()` 把「加载 / 跳过（缺宿主能力）/ 失败」写进
  `plugin-status.json`，**官方与用户插件都记**，并写下是哪个宿主装配的（`host`）。配置页
  据此显示「已跳过 · TUI」这类结论；缺哪一面取决于宿主，所以跳过不等于插件坏了。

## 使用入口

随包插件与用户插件都只有一种形态：目录 + `plugin.json` + 入口文件 default 导出的 `setup(ctx)`：

```ts
import type { PluginContext } from '@packages/mica-plugin/index.js';

export default function setup(context: PluginContext) {
  const hook = context.hooks.on('turn:after', async () => {});
  context.onDispose(() => hook.dispose());
}
```

`micaPlugin.Plugin` 这个基类只用于宿主进程内直接装配的内置插件（例如 TUI 的
`BuiltInCommandsPlugin`）；文件插件不需要、也不会被包成 class。

### System prompt 扩展

插件统一通过 `context.prompt.section()` 贡献段落，清单声明 `requires: ["prompt"]`。每次组装 system prompt 时同步渲染，空串不贡献内容；不再使用 `system-prompt:build` pipeline。

```ts
const registration = context.prompt!.section({
  id: 'guidance',
  order: 0,
  render: () => '<guidance>Plugin system guidance.</guidance>',
});
context.onDispose(() => registration.dispose());
```

宿主在 base prompt 之后，按 `order` 从小到大排列（默认 0，同值按注册顺序），并为每个非空段落统一添加边界：

```xml
<injection source="plugin" plugin="example.plugin" section="guidance">
<guidance>Plugin system guidance.</guidance>
</injection>
```

属性由宿主转义；正文保留插件自己的 XML 结构，但 `injection` 是宿主保留标签，其开闭标签会被转义，避免提前关闭或伪造外层边界。这些段落不会写入 user message 或 session provider history。会话记忆、会话自治、Loop 的顺序分别为 -300、-200、-100，位于默认顺序的动态段落之前。

### 模型请求之间的扩展

某些能力不属于「某个工具」，而是「这次请求要发什么历史」。自动压缩是第一个这样的需求，
但入口刻意做成通用的：任何想裁剪历史、按会话注入上下文、按成本降级的插件都走同一套。

```ts
const registration = context.agent!.onIterationRewrite(async (messages, agent) => {
  if (agent.mode === 'one-shot') return null; // exec 没有下一轮，省不出东西
  const usage = agent.lastUsage();
  if (!usage || usage.inputTokens < 200_000) return null;
  const { messages: next } = await agent.compact(messages, { mode: 'quick' });
  return next;
});
context.onDispose(() => registration.dispose());
```

插件拿到的是**句柄**而不是 agent 本体：只能读最近一次用量、读写自己的会话状态、请求压缩，
改不到 provider 配置、别的插件状态与会话读写面。声明 `requires: ["agent"]` 才会拿到它。

`compact(messages, { mode: 'model', summarize })` 里的 `summarize` 让插件自己发那次摘要请求
（通常就是 `ctx.llm.request`，于是「复用当前会话模型 / 独立接口 / 失败降级」由组件负责）；
不传则走宿主默认的摘要子代理。压缩怎么压（分段、预算、重试）始终归内核。

### 轮次之外的压缩

`context.agent.compactIdleHistory()` 把**已经落盘的**会话历史压一次，`mode: 'quick'` 只把工具
调用与结果聚合成一条占位调用、丢掉思考、把图片与文档换成占位符（不调用模型，对话正文不动）；
`mode: 'model'` 把用户与助手的对话（工具调用与结果不进摘要输入）交给模型写 checkpoint 摘要。
与上面那个句柄里的 `compact()` 的区别是改哪一份：那里改的是一次
请求即将发送的历史，这里改的是会话文件本身——所以重开这条会话看到的也是压缩后的样子。

它只在能独占写会话文件的常驻宿主里提供（`mica app-server`）：没有 turn 在跑、没有别的进程
持有 turn lease 时才会执行，否则回 `{ status: 'skipped', reason: 'busy' }`；历史里没有可
清理的内容回 `reason: 'empty'`。两者都不是错误、不消耗次数。`mica exec` 不落盘、TUI 由
`/compact` 负责，两边都不提供——插件应当把它当可选能力。

会话右键菜单这类**一次点击**的入口，插件回一句 `message` 就够了；要留一条对话里的记录就用
`ctx.ui.notice(content, { command, replace: true })`——同一个 command 只保留最新一条（见
`plugins/README.md` 的「notice 槽」）。

要在压缩结果旁边一并落盘的写入（`context.ui.notice`）放在 `compactIdleHistory({ afterApply })`
里：宿主在**落盘之前**调它，所以压缩与提示是同一次写。等 `await` 返回之后再写就晚了——那时文件
已经写过，提示要等下一轮才带下去，而用户可能已经关掉页面了。

要不要在轮次之外动手由插件自己决定。可订阅的客户端信号是 `input:activity`（用户在输入框
里敲了字，桌面端节流发 `mica/input/activity`）与 `input:focus`（焦点放回输入框、还没敲字，
桌面端经 `mica/input/focus` 送出、只在会话没在跑时发）；两者都不保证一定来，TUI 与 `exec`
也不发。**当前官方插件都不订阅它们**：没有哪个插件会在你没有动作时改写历史。

决定「这次值不值得压」用 `context.agent.lastUsage()` 与 `context.agent.contextWindowSize`：
前者是最近一次真实请求的输入量（与界面上的 ctx 徽标同源，压缩会保留它用来对账），后者随会话
切模型变化。不要在插件里自己估一遍历史——估出来的数和用户看到的不一致，阈值判断就会偏。

## 设计约束

- 本包只提供插件机制，不包含具体产品插件。
- 插件通过 context、hooks 和 services 与外部交互，避免直接耦合应用层单例。
- 官方运行期插件位于 `packages/mica-builtin-commands/plugins` 与仓库根 `plugins/`，都不应反向导入 `src/**`。
- 插件包格式见仓库根 `plugins/README.md`：一个插件是一个目录，入口 `default` 导出 `setup(ctx)`。
- 生命周期中注册的资源需要可释放，避免长期运行中的泄漏。`ctx.actions.register()`、`ctx.desktop.panel()` 与 `ctx.desktop.sessionMenu()` 的登记由 manager 自动回收，正常卸载与启动失败都生效；其余资源用 `ctx.onDispose()` 登记清理。

## 目录说明

- `Plugin.ts`：插件基类和生命周期约定。
- `PluginManager.ts`：插件注册、激活和销毁管理。
- `PluginContext.ts`：插件运行上下文。
- `PluginAgent.ts`：模型请求之间的扩展句柄（`onIterationRewrite` 的注册表与句柄类型）。
- `HookRegistry.ts`、`HookTypes.ts`：hook 类型与注册表。
- `ServiceContainer.ts`、`ServiceToken.ts`：服务容器与 token。
- `PluginManifest.ts`：`plugin.json` 的类型、解析与路径越界校验。
- `FilePluginLoader.ts`：扫描 `$MICA_HOME/plugins/<id>/`，以及不执行代码的 `inspectPlugins`。没有 `plugin.json` 的目录和散落的 `.js` / `.mjs` 都不算插件。
- `PluginState.ts`：启停状态文件的读写。
- `PluginHealth.ts`：插件健康状态（`$MICA_HOME/plugin-health/<id>.json`）的读写。
- `PluginSettings.ts`：设置项的声明类型、规范化读写与按 mtime 刷新的 store，供配置页与插件共用。
- `PluginPrompt.ts`：插件贡献的 system prompt 片段收集。
- `PluginDesktop.ts`：桌面宿主的能力面——检查项目录（`DESKTOP_CHECKS`）、运行条件声明与
  skill 注册的类型。新增一项检查 = 在这里登记 + 桌面端（`apps/desktop/src/main/system/`）实现探测器。
- `PluginPanel.ts`：对话右侧面板的视图类型、`PluginPanelRegistry` 与视图/动作归一化。
- `PluginSessionMenu.ts`：会话右键菜单动作的类型、`PluginSessionMenuRegistry` 与入参/结果归一化。
- `UserPlugins.ts`：`$MICA_HOME/plugins` 的装载。
- `PluginStatus.ts`：`plugin-status.json` 的形状与写盘（全部插件的装配结论 + 写它的宿主）。
- `PluginSubagents.ts`：委派子代理的能力面类型（类型声明、spawn 入参、任务快照、`PluginSubagentRegistry`），宿主实现机制、插件提供策略。
- `PluginSessionState.ts`：插件存进会话快照的状态的大小上限与校验。
- `PluginLlm.ts`：`ctx.llm` 的声明类型、设置字段生成、生效值解析与请求封装。每个声明 `llm` 的插件都获得「复用当前会话模型」开关（插件无需声明；缺省就复用会话模型，只有先用自己的接口才好用的插件把 `llm.reuseByDefault` 写成 `false`），由宿主解析成会话当前 provider；配置的接口/模型不可用时自动降级为会话模型一次，成功后记住这份配置并上报健康状态，改配置即重新尝试。`describePluginLlmView()` 是配置页与会话设置共用的展示状态，界面组件不自行判断能不能用。
- `PluginLog.ts`：插件文件日志（`resolveLogDir()/plugin-<id>-<day>[-n].jsonl`），带分片与过期清理。
- `sessionAnnotations.ts`：`$MICA_HOME/plugin-data/<pluginId>/session-annotations.json` 的归一化读写。
- `index.ts`：公共 API 聚合导出。
