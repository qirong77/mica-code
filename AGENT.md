# Mica Code 仓库说明

## 项目定位

- Mica Code 是一个基于 Bun + TypeScript + React（Ink）的 CLI code agent。
- 目标是把 CLI 启动、运行时 turn loop、agent provider、工具、命令、会话、配置、UI、插件分层管理，为 compact、memory、todo、fork、multi-agent、IPC/remote control 等能力保留稳定扩展点。
- 当前仓库采用 `src/` 应用装配层 + `packages/` 可复用包的结构。新增通用能力优先放入对应 package，`src/` 只做应用级 wiring 和少量兼容胶水。

## 维护要求

- 如果一次改动涉及项目整体架构、目录结构、关键运行链路、公共 package 边界、配置/数据位置、常用命令或开发约束变化，必须同步修改本 `AGENT.md`。
- 如果新增长期模块、核心服务、命令体系、runtime 生命周期、session 存储格式、工具注册方式或 UI 状态模型，也必须更新本文件中的对应章节。
- 不要让本文件变成实现细节日志；只记录会影响后续 agent/开发者理解和修改项目的稳定约定。

## 当前目录结构

### 应用入口与装配：`src/`

- `src/index.ts`：CLI 启动入口，负责加载环境、创建应用并启动 UI/运行时。
- `src/prebuild.ts`：构建前处理脚本。
- `src/app/`
  - `Application.ts`：应用生命周期对象。
  - `ApplicationContext.ts`：应用运行所需服务上下文。
  - `createApplication.ts`：组装应用、runtime、插件、命令和 UI。
  - `builtinPlugins.ts`：内置插件注册入口。
  - `index.ts`：应用层导出。
- `src/runtime/`
  - `TurnLoop.ts`：应用层单 turn 生命周期，包括输入解析、agent.run、会话保存和错误处理。
  - `MessageQueue.ts`：运行中用户输入的排队状态。
  - `ToolLogController.ts`：thinking/tool call/tool result 的 UI 日志控制。
  - `uiBridge.ts`：runtime 状态到 mica-ui 的映射，包括错误、消息、状态和模型展示同步。
- `src/agent/AgentRuntime.ts`：agent 运行时封装，负责模型 client 生命周期、事件分发、状态管理和 snapshot。
- `src/agents/terminalAgentSessions.ts`：终端 agent 会话相关状态/桥接。
- `src/session/SessionController.ts`：应用层会话保存、恢复与 UI 状态同步。

### 公共包：`packages/`

- `packages/mica-agent/`
  - agent 公共类型、provider adapter、prompt、模型事件和 agent run 抽象。
  - 不应依赖 UI、commands、session 或应用层 `src/`。
- `packages/mica-runtime/`
  - package 化 runtime 抽象，包括 `RuntimeController`、`RuntimeEventBus`、`RuntimeInput`、`RuntimeStatus`、`MessageQueueService`、`RuntimeViewSnapshot` 等。
  - 新 runtime 能力优先沉淀到这里，再由 `src/app` 接入。
- `packages/mica-tools/`
  - 内置工具定义与执行框架，包括 read/write/edit/list/grep/run_shell/web/skill。
  - 新增工具优先复用 `MicaTool`、registry、display/validation 约定。
- `packages/mica-ui/`
  - 基于 Ink 的终端 UI，包括 app、conversation、bottom surface、input、panels、dropdown、primitives、hooks。
  - 只负责 UI 状态、组件和交互呈现，不直接调用 provider 或持久化 session。
- `packages/mica-commands/`
  - 命令注册抽象与类型，例如 `CommandRegistry`。
- `packages/mica-builtin-commands/`
  - 内置斜杠/快捷命令实现，例如 provider、model、resume、mcp、skills、commit、compact、agents、logs、status、new、clear。
- `packages/mica-plugin/`
  - 插件系统基础设施，包括 `PluginManager`、`HookRegistry`、`ServiceContainer`、`ServiceToken`、插件上下文和 hook 类型。
  - 新增长期能力优先以 plugin/service/hook 形式接入，而不是堆到入口文件。
- `packages/mica-config/`
  - 配置读取、默认配置和 provider/model 配置能力。
  - 默认配置文件在 `packages/mica-config/default.json`。
- `packages/mica-session/`
  - 会话持久化基础能力，例如 `sessionStore.ts`。
- `packages/mica-mcp/`
  - MCP 配置、连接管理、工具桥接与注册。
- `packages/mica-skills/`
  - skills 类型和加载逻辑。
- `packages/mica-context/`
  - context/compact 相关能力，例如 `CompactionService.ts`。
- `packages/mica-ipc/`
  - JSON line 协议、IPC client/server、control lock，用于远程控制或进程间协作。
- `packages/mica-common/`
  - 通用基础工具，例如 id、json、event bus、disposable、result。
- `packages/mica-logger/`
  - 运行时日志状态与格式化/导出能力。
- `packages/@anthropic/`
  - 本仓库 vendored/workspace 形式使用的 Ink 相关包。

### 其他目录

- `blogs/`：项目相关文章，不是运行时代码。
- `docs/`：项目文档。
- `scripts/`：构建、安装等脚本。
- `temp/`：外部项目/临时参考代码，不属于 Mica Code 运行时代码；默认不要修改，除非用户明确要求。
- `dist/`：构建产物，不应手写修改。

## 关键运行链路

1. `src/index.ts` 启动 CLI，加载环境变量和应用配置。
2. `src/app/createApplication.ts` 创建应用上下文、UI、runtime、agent runtime、session controller、插件和命令。
3. 内置插件通过 `src/app/builtinPlugins.ts` 接入，命令通过 `packages/mica-commands` / `packages/mica-builtin-commands` 注册。
4. MCP 通过 `packages/mica-mcp` 初始化，并把远端工具桥接到 `packages/mica-tools` 的工具注册体系。
5. 用户输入从 `packages/mica-ui/input` 进入应用层 runtime。
6. `src/runtime/TurnLoop.ts` 负责当前应用的单 turn 编排：排队判断、append user message、调用 `AgentRuntime.run`、处理流式事件、保存 session、更新 UI。
7. `src/runtime/ToolLogController.ts` 与 `src/runtime/uiBridge.ts` 将 agent/tool/runtime 状态映射到 `packages/mica-ui`。
8. `src/session/SessionController.ts` 负责保存和恢复当前会话，并在恢复后同步 UI 状态。

## 配置与数据位置

- 本地用户配置：`~/.mica/config.json`。
- 默认配置：`packages/mica-config/default.json`。
- 启动时会读取：
  - 当前工作目录下的 `.env`
  - `packages/mica-agent/.env`
- 修改配置时优先复用 `packages/mica-config` 暴露的配置能力，不要在业务代码里散落读写 JSON。
- 会话数据当前保存到 `~/.mica/sessions`，底层能力在 `packages/mica-session`，应用同步在 `src/session/SessionController.ts`。
- 日志相关能力优先走 `packages/mica-logger`。

## 架构原则

- `packages/mica-agent` 不依赖 UI、session、commands、plugin 或应用层 `src/`；它只负责 provider adapter、prompt、agent run 和公共 agent 接口。
- `packages/mica-ui` 不依赖 provider 和 agent 业务逻辑；它只负责终端 UI 状态、组件和交互呈现。
- `packages/mica-runtime` 承载可复用 runtime 抽象；`src/runtime` 可以保留应用层编排和兼容逻辑，但新增通用 runtime 能力应优先下沉到 `packages/mica-runtime`。
- `packages/mica-plugin` 是长期扩展入口；新增 memory、todo、compact、multi-agent 等能力优先采用 `Service + Store + Hook + Command/Plugin` 结构。
- `packages/mica-commands` 只定义命令体系；具体内置命令放在 `packages/mica-builtin-commands`。
- `src/app` 负责 wiring，不应承载长期业务状态。
- `src/session` / `packages/mica-session` 只负责会话/快照持久化，不负责 provider 调用。
- Runtime 到 UI 的映射优先放在 `src/runtime/uiBridge.ts` 或专门 controller 中，不要让 `AgentRuntime` 直接操作 UI。
- 不要跨层偷懒引用：package 不应随意 import `src/`；底层 package 不应依赖上层 package。

## 后续 Roadmap

### Phase 1：Runtime Hook 基础

- 在 `packages/mica-runtime` 中沉淀稳定生命周期和 hook runner，应用层 `src/runtime` 负责接入。
- 推荐生命周期：
  - `onUserInput`
  - `beforeTurn`
  - `beforePrompt`
  - `onModelEvent`
  - `beforeToolCall`
  - `afterToolCall`
  - `beforePersist`
  - `afterTurn`
  - `onAbort`
  - `onError`
- 先只接入生命周期，不引入复杂业务行为。

### Phase 2：Context 与 Compact

- 继续完善 `packages/mica-context`，包括 context manager、token budget、compaction service。
- `/compact` 命令放在 `packages/mica-builtin-commands`，通过 service/hook 接入 runtime。
- compact 不直接修改 provider 细节，而是读取 agent/session snapshot，生成 summary，再更新 conversation context。
- 自动 compact 策略应挂在 runtime hook 上。

### Phase 3：Todo 系统

- 新增 todo service/store/hook/plugin，优先放在独立 package 或清晰模块中。
- `/todo` 命令用于查看、添加、完成、清理 todo。
- Todo 状态应与 session 关联，避免不同会话互相污染。
- agent 输出可生成 todo 候选，但应保留用户可见、可撤销的状态。

### Phase 4：Memory 系统

- 新增 memory service/store/hook/plugin。
- `beforePrompt` 检索相关 memory 并注入 prompt context。
- `afterTurn` 提取候选 memory，但需要确认或策略过滤，避免写入噪声。
- Memory store 先用本地 JSON/SQLite 均可，接口要为后续 embedding search 留空间。

### Phase 5：Session Graph 与 Fork

- 扩展 `packages/mica-session` 和 `src/session`，引入 turn record、branch、session graph。
- 实现 `/fork-agent` 或相关命令。
- fork 应复制指定 turn 的 snapshot，生成新 branch/session，并保留 parent relation。
- UI 上先只需要能 resume branch；复杂可视化后置。

### Phase 6：Multi-agent

- 新增 agent instance registry/manager，主 agent、sub agent、planner、reviewer、summarizer 都作为 agent instance 管理。
- multi-agent 协作通过 runtime hooks、plugin 或 command 显式触发，不要让 provider adapter 感知其他 agent。
- 和 IPC/terminal agent session 集成时，应明确区分 UI 展示状态、agent API 输入和 session 持久化状态。

## 开发约束

- 优先做最小必要修改，沿用现有模式，不做与任务无关的重构。
- 修改代码前先理解调用链，尤其是 `src/app`、`src/runtime`、`src/agent`、`src/session`、`packages/mica-runtime`、`packages/mica-plugin`、`packages/mica-ui` 之间的边界。
- 默认不要写注释，除非是在解释隐藏约束或 workaround。
- 不要使用动态导入。
- import 路径风格应与所在文件周边保持一致。
- 不要手写修改 `dist/` 构建产物。
- `temp/` 下是参考项目/临时材料，不属于本项目源码；除非用户明确要求，不要修改。
- 注意不要引入安全问题，尤其是 shell 调用、文件读写、MCP、IPC、外部请求和凭据处理边界。
- 如果变更了整体架构、目录结构、关键链路、公共 package 边界或常用命令，必须同步更新本 `AGENT.md`。

## 工具层约定

- 内置工具统一在 `packages/mica-tools/index.ts` 和 registry 体系中注册。
- 新增工具时优先复用 `MicaTool` 抽象与现有 display/validation 约定。
- MCP 工具通过 `packages/mica-mcp` 动态汇总并注册，不要绕开现有注册入口。
- 工具实现必须清晰区分参数校验、执行、展示和错误处理。
- 能用专用工具完成的事情，不要退化成 shell 文件操作。

## 命令与插件约定

- 命令抽象在 `packages/mica-commands`。
- 内置命令实现放在 `packages/mica-builtin-commands`。
- 应用层通过 `src/app/builtinPlugins.ts` / `src/app/createApplication.ts` 接入内置能力。
- 新增长期能力时优先提供 service token，并通过 plugin/context 注入，而不是直接在多个模块间互相 import 单例。

## UI 与交互约定

- 终端 UI 修改优先遵循 `packages/mica-ui` 现有组件层级：`app`、`conversation`、`bottom`、`input`、`panels`、`primitives`。
- 会话恢复后需要同步恢复 UI 状态，相关逻辑在 `src/session/SessionController.ts`。
- Runtime 到 UI 的映射优先放在 `src/runtime/uiBridge.ts` 或专门 controller 中。
- 输入框、快捷键、dropdown、plugin panel 的状态不要散落到入口文件。
- 如果新增运行中输入、队列、回退、history search 等交互，需要同步考虑 UI 提示、session 状态和 runtime 状态一致性。

## 常用命令

- 安装依赖：`bun install`
- 启动开发：`bun run dev`
- 构建：`bun scripts/build.mjs` 或 `bun run build`
- 构建前处理：`bun run prebuild`
- 格式化：`bun run format`
- 类型校验：`bunx tsc --noEmit`
- Prompt 测试：`bun test packages/mica-agent/prompt/index.test.ts`

## 提交前验证

- 修改完成后，至少执行与改动范围匹配的验证。
- 本仓库的最低要求是执行 TypeScript 校验：`bunx tsc --noEmit`。
- 如果改动涉及 prompt，运行 `bun test packages/mica-agent/prompt/index.test.ts`。
- 如果改动涉及构建、工具、runtime、IPC、MCP 或 UI，尽量补充运行对应测试、示例或构建命令。
- 如果只修改文档，可以不运行完整类型校验，但最终回复中要明确说明未运行代码验证的原因。
