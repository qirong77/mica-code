# Mica Code 仓库说明

## 项目定位

- 这是一个基于 Bun + TypeScript + React（Ink）的 CLI code agent。
- 主入口在 `src/index.ts`，负责初始化 UI、AgentRuntime、SessionController、命令注册和 MCP。
- 当前架构目标是把 CLI 启动、运行时 turn loop、agent provider、命令、会话、配置、UI 分层管理，为 memory、multi-agent、fork、compact、todo 等能力留出稳定扩展点。

## 当前目录结构

- `src/`
  - `index.ts`：CLI 启动入口。
  - `app/bootstrap.ts`：应用装配层，连接 UI、AgentRuntime、TurnLoop 和命令运行所需的公共 helper。
  - `runtime/`：一次用户输入到 agent 完成的运行时编排。
    - `TurnLoop.ts`：单 turn 生命周期，包括输入解析、agent.run、会话保存和错误处理。
    - `MessageQueue.ts`：运行中用户输入的排队状态。
    - `ToolLogController.ts`：thinking/tool call/tool result 的 UI 日志控制。
    - `uiBridge.ts`：runtime 状态到 mica-ui 的映射，包括错误、消息、状态和模型展示同步。
  - `agent/AgentRuntime.ts`：agent 运行时封装，负责模型 client 生命周期、事件分发、状态管理和 snapshot。
  - `commands/`：斜杠命令/快捷命令注册与实现，例如 provider、model、resume、mcp、skills、commit。
  - `config/`：本地配置读写与 provider/model 配置。
  - `mcp/`：MCP 配置读取、连接管理、远端工具注册。
  - `session/`：会话保存、恢复与快照管理。
  - `skills/`：skills 加载。
  - `logger.ts`：运行时日志状态与格式化。
- `packages/agent/`
  - `core/`：agent 公共类型和 base class。
  - `providers/`：OpenAI-compatible、Anthropic 等 provider 实现。
  - `prompt/`：系统 prompt 构建和 prompt 测试。
  - `ui/`：agent turn log UI item factory。
- `packages/tools/`
  - 内置工具定义与执行框架，包括 read/write/edit/list/grep/run_shell/web/skill。
- `packages/mica-ui/`
  - 基于 Ink 的终端 UI 组件、状态面板、输入框、对话视图。
- `blogs/`
  - 项目相关文章，不是运行时代码。

## 关键运行链路

1. `src/index.ts` 启动 Ink 应用。
2. 创建 `AgentRuntime`，由它持有当前 provider client。
3. 创建 `SessionController` 管理当前会话快照。
4. `src/commands/index.ts` 注册快捷命令。
5. `src/mcp/index.ts` 初始化 MCP，并把远端工具注册到 `packages/tools`。
6. `src/app/bootstrap.ts` 创建 `TurnLoop`、`MessageQueue`、`ToolLogController`，并订阅 agent/UI 事件。
7. 用户输入进入 `TurnLoop`，完成一轮 agent 调用、流式 UI 更新、工具日志、会话保存。

## 配置与数据位置

- 本地配置文件：`~/.mica/config.json`。
- 默认配置来源：`src/config/default.json`。
- 启动时会读取：
  - 当前工作目录下的 `.env`
  - `packages/agent/.env`
- 修改配置时优先复用 `src/config/index.ts` 的 `getConfig`、`updateConfig`、`loadProviderModels` 等能力。
- 会话数据当前保存到 `~/.mica/sessions`。

## 架构原则

- `packages/agent` 不依赖 UI、session、commands；它只负责 provider adapter、prompt 和公共 agent 接口。
- `packages/mica-ui` 不依赖 agent 业务逻辑；它只负责终端 UI 状态、组件和交互呈现。
- `src/runtime` 是核心应用运行时，负责 turn 生命周期；新增 memory、todo、compact 等能力优先通过 runtime hook 接入。
- `src/commands` 只负责用户命令入口和 UI 面板，不直接承载长期业务状态。
- `src/session` 只负责会话/分支/快照持久化，不负责 provider 调用。
- 新增长期能力时优先采用 `Service + Store + Hook + Command` 结构，而不是继续堆进 `bootstrap.ts` 或 `AgentRuntime.ts`。

## 后续 Roadmap

### Phase 1：Runtime Hook 基础

- 新增 `src/runtime/RuntimeHooks.ts` 和 `src/runtime/TurnContext.ts`。
- 定义稳定生命周期：
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
- 让 `TurnLoop` 通过 hook runner 调用这些生命周期，先不引入新业务行为。

### Phase 2：Context 与 Compact

- 新增 `src/context/ContextManager.ts`、`src/context/CompactionService.ts`、`src/context/tokenBudget.ts`。
- 实现 `/compact` 命令。
- compact 不直接修改 provider 细节，而是读取 agent/session snapshot，生成 summary，再更新 conversation context。
- 为自动 compact 预留策略：当 token budget 超过阈值时，在 `beforePrompt` 或 `beforeTurn` 触发。

### Phase 3：Todo 系统

- 新增 `src/todo/TodoService.ts`、`src/todo/TodoStore.ts`、`src/todo/TodoHook.ts`。
- 实现 `/todo` 命令用于查看、添加、完成、清理 todo。
- 在 `afterTurn` 中允许根据 agent 输出更新 todo，但要保留用户可见、可撤销的状态。
- Todo 状态应与 session 关联，避免不同会话互相污染。

### Phase 4：Memory 系统

- 新增 `src/memory/MemoryService.ts`、`src/memory/MemoryStore.ts`、`src/memory/MemoryHook.ts`。
- `beforePrompt` 检索相关 memory，注入 prompt context。
- `afterTurn` 提取候选 memory，但需要确认或策略过滤，避免写入噪声。
- Memory store 先用本地 JSON/SQLite 均可，接口要为后续 embedding search 留空间。

### Phase 5：Session Graph 与 Fork

- 扩展 `src/session`，引入 `TurnRecord`、`SessionBranch`、`SessionGraph`。
- 实现 `/fork-agent` 命令。
- fork 应复制指定 turn 的 snapshot，生成新 branch/session，并保留 parent relation。
- UI 上先只需要能 resume branch；复杂可视化后置。

### Phase 6：Multi-agent

- 新增 `src/agent/AgentManager.ts` 和 agent instance registry。
- 主 agent、sub agent、planner、reviewer、summarizer 都作为 agent instance 管理。
- `AgentRuntime.createSubAgent` 后续下沉到 `AgentManager`，避免主 runtime 绑定具体 provider options。
- multi-agent 协作通过 runtime hooks 或 command 显式触发，不要让 provider adapter 感知其他 agent。

## 开发约束

- 优先做最小必要修改，沿用现有模式，不做与任务无关的重构。
- 修改代码前先理解调用链，尤其是 `src/runtime`、`src/agent`、`src/session`、`src/commands` 之间的边界。
- 默认不要写注释，除非是在解释隐藏约束或 workaround。
- 不要使用动态导入。
- import 路径风格应与所在文件周边保持一致。
- 注意不要引入安全问题，尤其是 shell 调用、文件读写和外部请求边界。

## 工具层约定

- 内置工具统一在 `packages/tools/index.ts` 注册。
- 新增工具时优先复用 `MicaTool` 抽象与现有 display/validation 约定。
- MCP 工具通过 `src/mcp/index.ts` 动态汇总并注册，不要绕开现有注册入口。
- 能用专用工具完成的事情，不要退化成 shell 文件操作。

## UI 与交互约定

- 快捷命令统一从 `src/commands/index.ts` 注册。
- 会话恢复后需要同步恢复 UI 状态，相关逻辑在 `src/session/SessionController.ts`。
- 终端 UI 修改优先遵循 `packages/mica-ui` 现有组件层级，不要把状态管理散落到入口文件。
- Runtime 到 UI 的映射优先放在 `src/runtime/uiBridge.ts` 或专门的 controller 中，不要让 `AgentRuntime` 直接操作 UI。

## 常用命令

- 安装依赖：`bun install`
- 启动开发：`bun run dev`
- 构建：`bun scripts/build.mjs`
- 格式化：`bunx prettier --write .`
- 类型校验：`bunx tsc --noEmit`
- Prompt 测试：`bun test packages/agent/prompt/index.test.ts`

## 提交前验证

- 修改完成后，至少执行与改动范围匹配的验证。
- 本仓库的最低要求是执行 TypeScript 校验：`bunx tsc --noEmit`。
- 如果改动涉及 prompt，运行 `bun test packages/agent/prompt/index.test.ts`。
- 如果改动涉及构建、工具或 UI，尽量补充运行对应测试、示例或构建命令。
