# packages

`packages/` 存放 Mica Code 的内部可复用包。可运行的应用放在 `apps/`（CLI、桌面、配置 Web、官网），这里的包主要负责沉淀稳定的领域能力和公共 API。

## 包说明

插件动作输入 `PluginActionInput.cwd` 来自发起方工作区（可省略），配置页 `ConfigWebApp.actionCwd` 与
`runPluginAction(id, action, values, cwd)` 在 HTTP / IPC / CLI 间传递，不从服务进程推断。
`mica-plugin` 的 `createPluginStatus()` 纯函数生成装配快照，`ctx.pluginStatus?.()` 读取当前 manager
的本地装配结论；共享 `plugin-status.json` 只用于展示最近宿主状态，不用于运行归因。

`mica-plugin` 的 `PluginDesktopLauncher` 与 `PluginLauncherContext` 描述随包系统启动器：
清单声明全局快捷键，桌面运行时按插件承载独立浮窗与 `launcher.js` 后端，不依赖聊天会话。
后端可读插件设置并读写版本化插件数据；停用时回收。完整约定见 [插件文档](../plugins/README.md)。

`mica-plugin` 的 `PluginTurnPrepareEvent` 描述持久 headless 会话的异步轮前维护钩子：
在 lease 内、用户输入落盘前读取前后模型配置并可压缩历史。

- `mica-agent`：agent 抽象、模型 provider adapter、prompt 构建；请求用量可附服务商 ID、总耗时与首字等待。生成速率另用成对的 `generationOutputTokens`（扣推理与首 token）/ `generationDurationMs`（正文首末增量），只采纳明细可归因且足够长的正文流，仍为客户端估算。`IAgent.getSnapshot({ includeConversation: false })` 可省去展示消息投影。
- `mica-tools`：内置工具、支持文本/图片的工具结果、工具 registry、MCP 工具接入；`MicaTool.canOverlap(input)` 与 `micaTools.isOverlappable(name, input)` 为 provider 提供按调用输入判断的重叠调度能力。
- `mica-mcp`：MCP 配置读取、server 连接管理和工具注册。
- `mica-ui`：Ink 终端 UI 组件和 UI 状态。
- `mica-runtime`：运行时协议、事件、状态、输入、消息队列，以及 Codex 两套协议（`codexExecEvents.ts` 的 exec `ThreadEvent`、`codexProtocol.ts` 的 app-server v2 JSONL）。
- `@anthropic/ink`：仓库内 vendored 的 Ink 分支，`mica-ui` 各组件唯一的 Ink 来源。
- `mica-session`：会话快照的本地保存、读取和列表。
- `mica-config`：本地配置读写；provider 模型列表由用户手填，`defaultModel` 配置新会话的 provider/model/effort，`micaConfig.resetSessionModelDefaults()` 重读默认值。
- `mica-commands`：通用斜杠命令注册与分发。
- `mica-builtin-commands`：Mica Code 内置产品命令。
- `mica-context`：上下文管理能力，当前主要是 compact。
- `mica-skills`：用户 skills 的扫描、解析和缓存。
- `mica-plugin`：插件生命周期、hooks、service container、host capability context（含委派子代理的 `ctx.subagents` 与对话右侧面板 `ctx.desktop.panel` 两个能力面），`ctx.subagents.tasks.restart(taskId)` 在原 owner 下创建带原任务上下文的替代任务并返回新 ID（不是断点续跑），类型可选 `maxTurnContinuations` 控制同上下文续跑，以及插件包格式（`plugin.json` 清单、目录加载器、用户插件装载、`writePluginStatus()` 写全部插件的装配结论与宿主、启停状态）；启停是运行期能力：资源按插件登记，`syncPluginState()` 在每轮开始时对齐名单，改完不必重开会话。`AgentObservationEvent` 定义 `agent:observe` 的只读运行观察协议，覆盖运行、请求、工具、用量和终态。
- 插件面板编辑器的正文上限为 200000 字符：超限读取只读告知、超限提交拒绝且不调用处理器，空字符串正文可正常提交；不静默截断可写内容。
- `mica-official-plugins`：官方插件目录。清单来自仓库根 `plugins/<id>/plugin.json`，入口静态登记；只想列清单的宿主用 `manifests.js`，避免把插件实现拖进进程。
- 会话体验扩展使用 `mica-plugin` 的 `PluginPanelView.cards` 摘要卡与 `createPluginExperience()` 本地元数据记录；`summarizePluginExperience()` 提供可自动化分析的版本化聚合。官方插件目录里当前没有使用这套能力面的插件，格式见 [埋点与导出](../docs/plugin-experience.md)。
- `mica-common`：跨包共享的底层工具，包括图片格式与尺寸识别、`loopArgs.ts` 的 `/loop` 参数解析、`chatQuote.ts` 的「引用对话」文本约定、`promptText.ts` 的消息定位归一化（CLI 与桌面端共用的 `comparableText`）、`capabilities.ts` 的会话能力开关、`todoState.ts` 的待办解析归一化与展示投影（TUI 面板与 desktop 计划 dock 共用）、`btwLimits.ts` 的 By The Way 线程上限（host 判定与抽屉按钮共用）。
- `mica-diagnostics`：诊断日志的唯一写入器（node-only）。JSONL 落 `resolveLogDir()`、2s 批量 flush、7 天与 256MB 保留策略、环形缓冲与慢操作聚合；`startMemorySampler()` 让每个常驻进程每 30s 上报自己的 `memoryUsage()`，`readPerformanceSummary()` 把渲染采样、通道耗时与进程内存聚合成配置页 Performance 用的形状。桌面运行时、Electron 主进程、`mica app-server`、TUI、`mica exec` 共用这一份。
- `mica-pty`：PTY 能力包。`PtyDriver` 是基于 node-pty 的测试驱动（Node/vitest 环境）；同时提供内置 `pty_*` 工具的运行时支持（`PtyManager` + Node helper 桥接），Bun 主进程通过 JSONL IPC 使用，node-pty 只在 Node 子进程中加载。
- `mica-web-shared`：`apps/desktop` renderer 与其运行时共用的纯函数（端口常量与「本机」地址、单端口上的路径约定、时间/token/工具图标与展示名格式化、界面状态的补丁语义、侧栏会话搜索的匹配/高亮/片段、模型用量来源分类与无会话用量账本的解析），无 React、无运行时依赖。
- `mica-file-mentions`：`@` 文件补全的唯一实现（触发判定、工作区扫描 + 缓存、评分排序、插入文本）。CLI 输入框/插件与 `apps/desktop` 的聊天输入框共用它，纯逻辑在 `rank.ts`，Node 侧扫描在 `search.ts`。
- `mica-config-ui`：配置页（Mica Config）的唯一实现——页面组件、数据动作与共享类型；Web 基础控件统一以 Arco Design React 实现，公开 `Input` / `InputNumber` / `Select`、全应用 `ArcoProvider`、富内容浮层 `ArcoPopover`、透传原生按钮事件与 ref 的 `ArcoAction` 和保留业务接口的按钮、开关、下拉、日期、表格供宿主与插件复用，布局不由组件库接管。浏览器宿主 `apps/config-web` 用它托管页面（HTTP `/api/*`），桌面宿主 `apps/desktop` 直接渲染它的组件、数据走运行时 IPC，两边各有一份数据实现（见该包 README）。

## 应用目录

可运行产品统一放在 `apps/`：

- `apps/cli`：Mica CLI 主应用（`apps/cli/src`，原根目录 `src/`）。
- `apps/desktop`：Electron 桌面应用（原 `mica-code-app/`）。
- `apps/config-web`：本地配置 Web 的**浏览器宿主**：Bun HTTP 服务 + 内嵌静态资源（页面与数据层在 `packages/mica-config-ui`）。
- `apps/website`：官网与文档站（Astro，原 `mica-code-website/`）。

## 包规范

- 每个包通过 `index.ts` 暴露公共 API，应用层优先从 `index.ts` 引用。
- 子包 README 需要说明包职责、主要能力、使用入口和目录结构。
- 包内实现应保持职责单一，不把应用装配逻辑塞进 package。
- 新增公共能力时同步更新对应包的 README 和导出入口。
- 默认不使用动态导入；PTY 工具首次调用时延迟加载 `mica-pty` 的 manager 模块是显式例外（避免 Bun 进程加载 node-pty）。
- import 路径风格保持与所在文件周边一致。

## 依赖边界

- `mica-common` 不依赖任何产品业务包。
- `mica-agent` 不依赖 UI、session、commands 或应用入口。
- `mica-ui` 不直接调用模型 provider，不持有 agent 运行逻辑。
- `mica-runtime` 只定义协议和状态原语，不做具体 turn loop 编排。
- `mica-commands` 只放通用命令机制，产品命令放在 `mica-builtin-commands`。
- `mica-builtin-commands` 通过 services 注入外部能力，避免直接导入应用层单例。
- `mica-tools` 统一管理工具定义和执行，MCP 工具也必须通过它注册。
- `mica-session` 只负责持久化，不调用模型、不渲染 UI。
- `mica-plugin` 只提供插件机制；官方插件实现放在仓库根 `plugins/`，由 `mica-official-plugins` 登记。动作、桌面面板与会话菜单的登记由 manager 随插件自动回收；资源按注册逆序释放，单项清理失败不跳过其余资源。

如果新增代码会导致底层包依赖上层包，应优先通过类型、回调、service 或 adapter 注入能力。

## 验证

修改 packages 后至少运行：

```bash
bunx tsc --noEmit
```

系统提示词按注入来源组织 XML：`mica-common` 导出 `escapePromptXml` / `wrapPromptXml`，`mica-agent` 包装基础段落与项目文档，`mica-plugin` 的 `ctx.prompt.section()` 为插件正文统一生成带 `plugin`、`section` 属性的 `injection`。`system-prompt:build` 形态不再支持。插件线程和独立模型请求由 CLI 宿主包装其系统提示词。
