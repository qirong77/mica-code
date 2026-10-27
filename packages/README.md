# packages

`packages/` 存放 Mica Code 的内部可复用包。可运行的应用放在 `apps/`（CLI、桌面、配置 Web、官网），这里的包主要负责沉淀稳定的领域能力和公共 API。

## 包说明

- `mica-agent`：agent 抽象、模型 provider adapter、prompt 构建。
- `mica-tools`：内置工具、支持文本/图片的工具结果、工具 registry、MCP 工具接入；`MicaTool.canOverlap(input)` 与 `micaTools.isOverlappable(name, input)` 为 provider 提供按调用输入判断的重叠调度能力。
- `mica-mcp`：MCP 配置读取、server 连接管理和工具注册。
- `mica-ui`：Ink 终端 UI 组件和 UI 状态。
- `mica-runtime`：运行时协议、事件、状态、输入、消息队列，以及 Codex 两套协议（`codexExecEvents.ts` 的 exec `ThreadEvent`、`codexProtocol.ts` 的 app-server v2 JSONL）。
- `@anthropic/ink`：仓库内 vendored 的 Ink 分支，`mica-ui` 各组件唯一的 Ink 来源。
- `mica-session`：会话快照的本地保存、读取和列表。
- `mica-config`：本地配置读写和 provider 模型列表加载。
- `mica-commands`：通用斜杠命令注册与分发。
- `mica-builtin-commands`：Mica Code 内置产品命令。
- `mica-context`：上下文管理能力，当前主要是 compact。
- `mica-skills`：用户 skills 的扫描、解析和缓存。
- `mica-plugin`：插件生命周期、hooks、service container、host capability context（含委派子代理的 `ctx.subagents` 能力面），以及插件包格式（`plugin.json` 清单、目录加载器、启停状态）。
- `mica-official-plugins`：官方插件目录。清单来自仓库根 `plugins/<id>/plugin.json`，入口静态登记；只想列清单的宿主用 `manifests.js`，避免把插件实现拖进进程。
- `mica-common`：跨包共享的底层工具，包括图片格式与尺寸识别、`loopArgs.ts` 的 `/loop` 参数解析、`chatQuote.ts` 的「引用对话」文本约定、`promptText.ts` 的消息定位归一化（CLI 与桌面端共用的 `comparableText`）、`capabilities.ts` 的会话能力开关、`todoState.ts` 的待办解析归一化与展示投影（TUI 面板与 desktop 计划 dock 共用）。
- `mica-pty`：PTY 能力包。`PtyDriver` 是基于 node-pty 的测试驱动（Node/vitest 环境）；同时提供内置 `pty_*` 工具的运行时支持（`PtyManager` + Node helper 桥接），Bun 主进程通过 JSONL IPC 使用，node-pty 只在 Node 子进程中加载。
- `mica-web-shared`：`apps/desktop` renderer 与其运行时共用的纯函数（端口常量与「本机」地址、单端口上的路径约定、时间/token/工具图标与展示名格式化、界面状态的补丁语义、侧栏会话搜索的匹配/高亮/片段），无 React、无运行时依赖。
- `mica-file-mentions`：`@` 文件补全的唯一实现（触发判定、工作区扫描 + 缓存、评分排序、插入文本）。CLI 输入框/插件与 `apps/desktop` 的聊天输入框共用它，纯逻辑在 `rank.ts`，Node 侧扫描在 `search.ts`。
- `mica-config-ui`：配置页（Mica Config）的唯一实现——页面组件、数据动作与共享类型。浏览器宿主 `apps/config-web` 用它托管页面（HTTP `/api/*`），桌面宿主 `apps/desktop` 直接渲染它的组件、数据走运行时 IPC，两边各有一份数据实现（见该包 README）。

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
- `mica-plugin` 只提供插件机制；官方插件实现放在仓库根 `plugins/`，由 `mica-official-plugins` 登记。

如果新增代码会导致底层包依赖上层包，应优先通过类型、回调、service 或 adapter 注入能力。

## 验证

修改 packages 后至少运行：

```bash
bunx tsc --noEmit
```
