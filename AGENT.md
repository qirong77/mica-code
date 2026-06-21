# Mica Code 仓库说明

## 项目定位

- Mica Code 是一个基于 Bun + TypeScript + React（Ink）的 CLI code agent。
- 目标是把 CLI 启动、运行时 turn loop、agent provider、工具、命令、会话、配置、UI、插件分层管理，为 compact、memory、todo、fork、multi-agent 等能力保留稳定扩展点。
- 当前仓库采用 `src/` 应用装配层 + `packages/` 可复用包的结构。新增通用能力优先放入对应 package，`src/` 只做应用级 wiring。

## 目录结构

```
src/              应用装配层：入口、Application、runtime、session、插件 wiring
  index.ts         CLI 入口（shebang bun，dotenv，错误钩子，创建并启停 Application）
  app/             Application 类、插件注册、activeContext、适配器
  agent/           AgentRuntime
  agents/          terminalAgentSessions
  session/         SessionController（保存/恢复会话）
  runtime/         RewindCheckpointManager、ToolLogController、uiBridge
  plugins/         mcp、runtime、commands 内置插件
packages/         可复用包（详见 packages/README.md）
  mica-agent      模型 provider adapter、prompt 构建
  mica-tools      内置工具、工具 registry、MCP 工具接入
  mica-mcp        MCP 配置读取、server 连接管理
  mica-ui         Ink 终端 UI 组件和状态
  mica-runtime    运行时协议、事件、状态、输入和消息队列
  mica-session    会话快照的本地保存、读取和列表
  mica-config     本地配置读写和 provider 模型列表加载
  mica-commands   通用斜杠命令注册与分发
  mica-builtin-commands  Mica Code 内置产品命令
  mica-context    上下文管理（compact）
  mica-skills     用户 skills 扫描、解析和缓存
  mica-plugin     插件生命周期、hooks 和 service container
  mica-common     跨包共享底层工具
  mica-logger     运行时日志 store 和格式化
  @anthropic/ink  Ink fork（终端 React 渲染）
scripts/          构建和安装脚本
temp/             临时外部/实验代码目录，不属于项目源码、测试、格式化或构建范围
```

## 常用命令

```bash
bun run dev             # 开发运行
bun run typecheck       # 类型检查（tsc --noEmit）
bun run test            # 运行项目白名单测试；不要直接运行裸 bun test
bun run build           # 构建
bun run format          # 格式化（prettier）
```

引擎要求：Node >= 22，运行时使用 Bun。

## 测试

测试文件与源码放在同一目录，命名为 `*.test.ts`：

- `packages/mica-agent/prompt/index.test.ts`
- `packages/mica-tools/MicaTool.test.ts`
- `packages/mica-tools/ToolRunShell.test.ts`
- `src/runtime/RewindCheckpointManager.test.ts`

运行：`bun test <files>` 或 `bun run test`。

不要直接运行裸 `bun test`。Bun 会递归发现仓库下所有测试文件，而根目录 `temp/` 可能包含外部项目、临时代码或缺依赖代码，会导致无关失败、超时或长时间扫描。扩大验证范围时也要显式指定项目路径或测试文件，例如 `bun test src/runtime/RewindCheckpointManager.test.ts packages/mica-tools/MicaTool.test.ts`。

## 命令范围与临时目录

- 根目录 `temp/` 是临时目录，已被 git 忽略，不是本项目的源码、测试、格式化、构建或搜索默认范围。
- 后续 agent/开发者执行会递归扫描的命令时，必须避开 `temp/`：优先使用 `bun run test`、`bun run format`、`bun run typecheck` 等项目脚本，或显式传入 `src/`、`packages/`、`scripts/`、`docs/` 等目标路径。
- 如果必须手写递归命令，使用白名单路径或排除规则，例如 `rg --glob '!temp/**' ...`。只有用户明确要求检查 `temp/` 时才进入该目录。

## Import 约定

- 根 tsconfig 配置了 `@packages/*` alias，映射到 `./packages/*`。`src/` 中引用 package 统一使用 `@packages/<name>/index.js`。
- 不使用动态 import。
- 每个 package 通过 `index.ts` 暴露公共 API，应用层优先从 `index.ts` 引用。
- import 路径风格保持与所在文件周边一致。

## 配置与数据

- 用户配置和 userConfig 类本地数据由 `mica-config` 管理，本地持久化；例如共享输入框历史保存在 `~/.mica/input-history.json`。
- 运行时 env：入口 `src/index.ts` 自动加载 `.env` 和 `packages/mica-agent/.env`。
- 会话数据由 `mica-session` 管理，`SessionController` 负责序列化为 `PersistedSession`（version 1）。

## 运行时架构

- `Application`（`src/app/Application.ts`）是唯一应用入口，持有 `ApplicationContext`。
- `ApplicationContext` 通过 `src/app/activeContext.ts` 暴露：`setActiveContext` / `getActiveContext` / `clearActiveContext`。
- 插件、runtime 等模块不应反向 import `Application.ts` 获取全局状态，统一走 `activeContext`。
- 运行时核心对象：`Application` → `AgentRuntime` + `SessionController` + `LocalRuntimeController` + `MicaUiRuntimeBridge` + `CommandRegistry` + `PluginManager`。
- 插件注册阶段（`use(plugin)`）在 `start()` 内部完成，先注册内置插件，再通过 `plugins.setupAll()` 初始化。

## 包依赖边界

- `mica-common` 不依赖任何产品业务包。
- `mica-agent` 不依赖 UI、session、commands 或应用入口。
- `mica-ui` 不直接调用模型 provider，不持有 agent 运行逻辑。
- `mica-runtime` 只定义协议和状态原语，不做具体 turn loop 编排。
- `mica-commands` 只放通用命令机制，产品命令放在 `mica-builtin-commands`。
- `mica-builtin-commands` 通过 services 注入外部能力，避免直接导入应用层单例。
- `mica-tools` 统一管理工具定义和执行，MCP 工具也必须通过它注册。
- `mica-session` 只负责持久化，不调用模型、不渲染 UI。
- `mica-plugin` 只提供插件机制，不内置具体产品插件。

## 维护要求

- 如果一次改动涉及项目整体架构、目录结构、关键运行链路、公共 package 边界、配置/数据位置、常用命令或开发约束变化，必须同步修改本 `AGENT.md`。
- 如果新增长期模块、核心服务、命令体系、runtime 生命周期、session 存储格式、工具注册方式或 UI 状态模型，也必须更新本文件中的对应章节。
- 不要让本文件变成实现细节日志；只记录会影响后续 agent/开发者理解和修改项目的稳定约定。

## 特别注意

- 如果改动影响旧数据或旧架构，全部使用新的写法，禁止先保留旧路径再逐步迭代，而是一次性完成。
- runtime 级公共结果类型优先放在 `packages/mica-runtime`；例如 rewind 预览/应用结果类型由 `packages/mica-runtime/Rewind.ts` 导出，命令包只做消费或 re-export。
- 修改 packages 后至少运行 `bunx tsc --noEmit`。
