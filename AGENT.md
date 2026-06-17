# Mica Code 仓库说明

## 项目定位

- 这是一个基于 Bun + TypeScript + React（Ink）的 CLI code agent。
- 主入口在 `src/index.ts`，负责初始化 UI、AgentRuntime、SessionController、插件命令和 MCP。
- 代码整体分为 CLI 启动层、agent 运行时、工具层、终端 UI、配置与会话持久化几个部分。

## 目录结构

- `src/`
  - `index.ts`：CLI 启动入口。
  - `agent/AgentRuntime.ts`：agent 运行时封装，负责模型 client 生命周期、事件分发、状态管理。
  - `bootstrap.ts`、`setup.ts`：启动期初始化逻辑。
  - `plugins/`：斜杠命令/快捷命令注册与实现，例如 provider、model、resume、mcp、skills。
  - `mcp/`：MCP 配置读取、连接管理、远端工具注册。
  - `session/`：会话保存、恢复与快照管理。
  - `store/`：本地配置读写与 provider/model 配置。
  - `skills/`：skills 加载。
- `packages/agent/`
  - 模型 client、prompt 拼装、系统提示词。
- `packages/tools/`
  - 内置工具定义与执行框架，包括 read/write/edit/list/grep/run_shell/web/skill。
- `packages/mica-ui/`
  - 基于 Ink 的终端 UI 组件、状态面板、输入框、对话视图。
- `blogs/`
  - 项目相关文章，不是运行时代码。

## 关键运行链路

1. `src/index.ts` 启动 Ink 应用。
2. 创建 `AgentRuntime`，内部使用 `packages/agent/OpenAIClient.ts`。
3. 创建 `SessionController` 管理当前会话快照。
4. `src/plugins/index.ts` 注册快捷命令。
5. `src/mcp/index.ts` 初始化 MCP，并把远端工具注册到 `packages/tools`。
6. UI 通过 `packages/mica-ui` 渲染会话、日志、状态和输入。

## 配置与数据位置

- 本地配置文件：`~/.mica/config.json`。
- 默认配置来源：`src/store/default.json`。
- 启动时会读取：
  - 当前工作目录下的 `.env`
  - `packages/agent/.env`
- 修改配置时优先复用 `src/store/index.ts` 的 `getConfig`、`updateConfig`、`loadProviderModels` 等已有能力。

## 开发约束

- 优先做最小必要修改，沿用现有模式，不做与任务无关的重构。
- 优先编辑已有文件，不随意新增文件。
- 默认不要写注释，除非是在解释隐藏约束或 workaround。
- 不要使用动态导入。
- import 路径不要新增以 `.js` 结尾的写法。
- 注意不要引入安全问题，尤其是 shell 调用、文件读写和外部请求边界。

## 工具层约定

- 内置工具统一在 `packages/tools/index.ts` 注册。
- 新增工具时优先复用 `MicaTool` 抽象与现有 display/validation 约定。
- MCP 工具通过 `src/mcp/index.ts` 动态汇总并注册，不要绕开现有注册入口。
- 能用专用工具完成的事情，不要退化成 shell 文件操作。

## UI 与交互约定

- 快捷命令统一从 `src/plugins/index.ts` 注册。
- 会话恢复后需要同步恢复 UI 状态，相关逻辑在 `src/session/SessionController.ts`。
- 终端 UI 修改优先遵循 `packages/mica-ui` 现有组件层级，不要把状态管理散落到入口文件。

## 常用命令

- 安装依赖：`bun install`
- 启动开发：`bun run dev`
- 构建：`bun run build`
- 测试：`bun run test`
- 格式化：`bun run format`
- 类型校验：`bun run check:types`
- 全量检查：`bun run check`

## 提交前验证

- 修改完成后，至少执行与改动范围匹配的验证。
- 本仓库的最低要求是执行 TypeScript 校验：`bun run check:types`。
- 如果改动涉及构建、prompt、工具或 UI，尽量补充运行对应测试或构建命令。
