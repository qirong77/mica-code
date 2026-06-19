# Mica Code

Mica Code 是一个轻量级 CLI code agent。它基于 Bun、TypeScript、React Ink 和可插拔工具系统构建，目标是把 Claude Code / Codex 这类终端 agent 的核心机制拆成清晰的工程模块：终端 UI、agent runtime、provider adapter、工具调用、会话恢复、MCP、skills、插件和后续的 context / memory / multi-agent 能力。

项目仍在快速演进中，当前更适合阅读、实验和二次开发。内部 API、配置格式和目录结构仍可能调整。

## 功能概览

- 终端交互 UI：基于 `@anthropic/ink`，支持对话流式渲染、状态栏、工具日志、面板和快捷命令。
- Agent runtime：负责单轮 turn 编排、模型事件处理、工具调用、中止控制、输入排队和会话保存。
- Provider adapter：支持 OpenAI-compatible provider，并保留 Anthropic adapter 扩展路径。
- 工具系统：内置文件读写、精确编辑、搜索、shell、web search/fetch、skill 等工具。
- MCP 支持：读取 MCP 配置，连接远端 MCP server，并把远端工具注册进统一工具系统。
- 会话恢复：会话快照保存到本地，可通过 `/resume` 恢复。
- 快捷命令：支持 provider、model、effort、status、logs、mcp、skills、commit、resume、clear 等命令。
- 多模态输入：支持文本和图片引用输入。
- 插件化拆分：命令、配置、runtime、session、MCP、skills、tools、UI 等能力逐步拆到 workspace package 中。

## 技术栈

- Runtime: Bun
- Language: TypeScript
- UI: React + `@anthropic/ink`
- State: nanostores
- Agent SDKs: OpenAI SDK、Anthropic SDK
- Tools: 自研 `MicaTool` 抽象 + MCP SDK

## 快速开始

安装依赖：

```bash
bun install
```

启动开发模式：

```bash
bun run dev
```

构建：

```bash
bun run build
```

类型检查：

```bash
bunx tsc --noEmit
```

Prompt 测试：

```bash
bun test packages/mica-agent/prompt/index.test.ts
```

格式化：

```bash
bun run format
```

## 配置

首次运行会创建本地配置文件：

```text
~/.mica/config.json
```

默认配置来源：

```text
src/config/default.json
```

启动时会读取：

```text
.env
packages/mica-agent/.env
```

一个典型 provider 配置如下：

```json
{
  "id": "deepseek",
  "name": "DeepSeek",
  "api_base": "https://api.deepseek.com",
  "api_key": "",
  "model": "deepseek-v4-pro",
  "effort": "low",
  "models": ["deepseek-v4-flash", "deepseek-v4-pro"],
  "contextWindowSize": 1000000
}
```

当前主路径通过 OpenAI-compatible client 连接 provider，因此第三方 provider 需要提供兼容 OpenAI Chat Completions 的接口。

## 常用命令

在 CLI 中输入 `/` 可以打开快捷命令面板。常用命令包括：

- `/clear`：清空当前会话和 UI 状态。
- `/resume`：恢复历史会话。
- `/provider`：切换 provider。
- `/model`：切换模型。
- `/effort`：切换推理努力等级。
- `/status`：查看当前 provider、model、上下文和 token 状态。
- `/logs`：查看运行时日志。
- `/mcp`：查看 MCP 服务器和工具，支持 reconnect。
- `/skills`：查看已加载 skills。
- `/commit`：分析当前 git diff，生成提交信息并提交推送。

## 项目结构

```text
src/
  index.ts              CLI 启动入口
  app/                  应用装配层，连接 UI、runtime、agent、session 和插件
  agent/                AgentRuntime 与 provider client 生命周期
  agents/               agent 相关扩展入口
  plugins/              插件适配层：commands、ipc、mcp、runtime 等
  runtime/              当前应用侧 turn loop、输入队列、工具日志和 UI bridge
  session/              应用侧会话控制

packages/
  mica-agent/           agent 公共类型、provider adapter、prompt 和 turn log UI item
  mica-builtin-commands/内置命令实现
  mica-commands/        命令注册、执行和命令面板抽象
  mica-common/          跨包公共类型和工具函数
  mica-config/          配置读写与 provider/model 配置能力
  mica-context/         上下文能力预留
  mica-ipc/             IPC 能力预留与示例
  mica-logger/          日志状态与格式化
  mica-mcp/             MCP 配置读取、连接管理和远端工具注册
  mica-plugin/          插件系统抽象
  mica-runtime/         runtime 抽象与可复用运行时能力
  mica-session/         会话持久化抽象
  mica-skills/          skills 加载与执行
  mica-tools/           内置工具定义与执行框架
  mica-ui/              Ink 终端 UI 组件、状态、面板和输入框
  @anthropic/ink/       项目内使用的 Ink 包

blogs/                  开发过程文章
scripts/                构建和安装脚本
```

## 运行链路

核心链路是事件驱动的 turn loop，而不是阻塞式 REPL：

```text
Terminal UI
  -> src/index.ts
  -> src/app/bootstrap.ts
  -> src/runtime/TurnLoop.ts
  -> src/agent/AgentRuntime.ts
  -> packages/mica-agent/providers/*
  -> packages/mica-tools/* + packages/mica-mcp/*
  -> src/session/SessionController.ts
  -> packages/mica-ui/*
```

一次 turn 的主要步骤：

1. UI 提交用户输入。
2. `MessageQueue` 判断运行中输入是否需要排队。
3. `TurnLoop` 解析文本和图片引用，追加用户消息。
4. `AgentRuntime` 调用当前 provider client。
5. provider 流式返回 text、thinking、tool call、usage 等事件。
6. `ToolLogController` 更新 thinking/tool 日志。
7. 工具执行结果回传给模型，模型继续生成或结束。
8. turn 完成后保存 session snapshot，并同步 UI 状态。

## 设计边界

- `packages/mica-agent` 不依赖 UI、session、commands；只负责 provider adapter、prompt 和公共 agent 接口。
- `packages/mica-ui` 不依赖 agent 业务逻辑；只负责终端 UI 状态、组件和交互呈现。
- `src/runtime` 是当前应用核心运行时，负责 turn 生命周期和 UI/agent/session 编排。
- `packages/mica-runtime` 承载可复用 runtime 抽象，便于后续 hook、context、multi-agent 等能力下沉。
- `src/plugins` 负责把 package 级能力接入当前 CLI 应用，避免继续堆进入口文件。
- `src/session` 和 `packages/mica-session` 负责会话/快照持久化，不负责 provider 调用。
- 后续长期能力优先采用 `Service + Store + Hook + Command` 的结构。

更详细的架构约定见 [AGENT.md](./AGENT.md)，开发过程记录见 [blogs/](./blogs)。

## 开发说明

最低验证要求：

```bash
bunx tsc --noEmit
```

如果改动涉及 prompt：

```bash
bun test packages/mica-agent/prompt/index.test.ts
```

提交信息目前采用类似格式：

```text
refactor: 重构 src 运行时与命令结构 ♻️
feat: 支持多模态输入（图片+文本）✨
fix: 完善 agent 中止与界面重置 🐛
```

## 状态

Mica Code 仍是实验性项目。当前代码更关注架构清晰度和可演进性，适合用来研究和迭代终端 agent 的工程实现。
