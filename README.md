# Mica Code

> **MICA — Minimal, Intelligent, Cache-first Agent.**
>
> 一个轻量、终端原生、关注上下文复用的 AI coding agent。

Mica Code 在当前项目目录中运行，可以阅读和编辑代码、搜索文件、执行 shell 命令、调用网页与 MCP 工具，并基于工具反馈持续推进任务。它不是一个只做补全的助手，而是一个围绕工程任务不断观察、修改、验证和恢复的终端 agent。

项目仍在快速迭代，内部 API、配置格式和命令行为可能继续调整。

## MICA 是什么

- **Minimal**：终端优先，界面克制，专注对话、编辑、命令和结果。
- **Intelligent**：具备完整 agent loop，可结合工具反馈持续分析和执行。
- **Cache-first**：会话历史默认追加演进，尽量保持请求前缀稳定，让 provider prompt cache 更容易命中。
- **Agent**：能围绕一个任务持续阅读、修改、验证、回退和分叉。

## 主要能力

- **终端原生工作流**：在项目目录中直接对话、改文件、跑命令、查看运行日志和结果。
- **多 provider 协议**：支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages，以及 DeepSeek、Moonshot、OpenAI 兼容网关和自建 provider。
- **上下文与缓存可见**：展示 context window、token 使用、cached token rate，以及 system prompt、conversation、tool schema、tool output、skills 等上下文占用。
- **统一工具系统**：内置文件读写、精确编辑、搜索、shell、后台任务、web search/fetch、skills 等工具；MCP 工具也进入同一套 registry。
- **会话可恢复**：本地保存 session snapshot，支持 `/resume` 恢复历史会话。
- **改动可回退**：`/rewind` 回到上一轮对话前的对话与文件状态。
- **上下文压缩**：`/compact` 将长会话压缩为 checkpoint，降低后续上下文压力。
- **多 agent 并行**：`/new` 创建独立 agent，`/fork` 从当前历史分叉新 agent，便于探索和实现分开进行。
- **插件化装配**：runtime、provider、tools、commands、session、UI、plugin、skills 等能力拆成独立 package，应用层只负责 wiring。

## 快速开始

### 从 GitHub Release 安装

仓库推送 `v*` tag 后，GitHub Actions 会构建 Linux/macOS 二进制，并发布一个自包含的 `install.sh`。默认安装为 `mica-code`：

```bash
curl -fsSL https://github.com/qirong77/mica-code/releases/latest/download/install.sh | sh
```

指定版本、安装目录或二进制名称：

```bash
curl -fsSL https://github.com/qirong77/mica-code/releases/download/v0.1.0/install.sh | MICA_INSTALL_DIR=$HOME/.local/bin MICA_BIN_NAME=mica-code sh
```

如果需要通过仓库脚本安装最新 release：

```bash
sh scripts/install-github.sh
```

### 本地开发运行

要求：Node.js `>=22`，运行时和包管理使用 Bun。

```bash
bun install
bun run dev
```

启动后可以直接输入任务：

```text
修复当前项目里的类型错误，并运行 typecheck 验证。
```

也可以要求它执行更完整的工程改动：

```text
把 src/ 中所有 console.log 替换为 logger，并保证测试通过。
```

### 本地构建安装

```bash
bun run build
```

默认构建输出为 `dist/mica`，`postbuild` 会把它安装到 `$HOME/.local/bin/mica`。可以通过环境变量调整：

```bash
MICA_BUILD_OUTFILE=dist/mica-code MICA_INSTALL_DIR=$HOME/.local/bin MICA_BIN_NAME=mica-code bun run build
```

## 配置

首次运行会创建本地配置文件：`~/.mica/config.json`。

启动时会读取当前工作目录下的 `.env` 和 `packages/mica-agent/.env`。最后一次使用的 provider、model、effort、context window 和共享输入框历史等本地状态保存到 `~/.mica/storage.json`，不会写回 provider 静态配置。

典型 provider 配置：

```json
{
  "id": "deepseek",
  "name": "DeepSeek",
  "api_base": "https://api.deepseek.com",
  "protocol": "openai_chat_completions",
  "get_model_url": "https://api.deepseek.com/models",
  "api_key": ""
}
```

`protocol` 决定使用哪个模型接口：`openai_chat_completions`、`openai_responses` 或 `anthropic_messages`。未配置时按 `openai_chat_completions` 处理；第三方 provider 需要明确选择自己实际支持的接口。

如果 provider 配置了 `get_model_url`，模型列表会在运行时获取并缓存到内存配置，不会回填到 `~/.mica/config.json`。没有动态模型接口的 provider 可以直接配置静态 `models` 数组。

## MCP、联网搜索与 Skills

- MCP server 配置保存在 `~/.mica/config.json` 的 `mcpServers` 中，启动时由 `mica-mcp` 连接，并把远端工具注册进 `mica-tools`。
- `web_search` 默认使用 Serper，需要配置 `serperApiKey` 或环境变量 `SERPER_API_KEY`；`web_fetch` 可直接抓取 URL 内容。
- 用户 skills 默认扫描 `~/.mica/skills`，每个 skill 目录包含一个 `SKILL.md`。

## 常用命令

在 CLI 中输入 `/` 打开命令面板。

- `/clear`：清空当前对话和运行状态。
- `/resume`：恢复历史会话。
- `/provider`：切换 provider。
- `/model`：切换当前 provider 的模型。
- `/effort`：切换推理强度。
- `/status`：查看当前 provider、model、effort、context 和 token 状态。
- `/context`：查看当前上下文占用总览。
- `/doctor`：诊断运行环境、配置、MCP、工具、会话目录和 git 状态。
- `/compact`：压缩当前会话上下文为 checkpoint。
- `/new`：新建 agent 并切换；`/new <text>` 后台创建并运行新 agent。
- `/fork`：从当前 agent 历史分叉新 agent；`/fork <text>` 后台运行。
- `/agents`：显示当前终端的 agents；`/agents clear` 清除空闲 agent。
- `/rewind`：确认后回退到上一轮对话前的状态。
- `/mcp`：查看 MCP 服务器和工具；`/mcp reconnect <server>` 重连指定 server。
- `/skills`：查看已加载 skills。
- `/log`：查看运行时日志；`/log export` 导出当前对话与日志。
- `/copy`：复制最后一条消息内容到剪贴板。
- `/rename`：重命名当前会话。
- `/git-diff-context [base]`：把当前分支相对 base 分支的 diff 作为上下文发送给 agent，默认 `master`。
- `/git-diff-context-current`：把当前未提交 git 变化作为上下文发送给 agent。
- `/commit`：分析当前 git 变化，生成提交信息，提交并推送。
- `/exit`：退出程序。

## 开发

常用验证命令：

```bash
bun run typecheck
bun run test
bun run build
bun run format
```

`bun run test` 使用 Vitest。不要直接运行裸 `bun test`，因为根目录 `temp/` 可能包含外部项目、临时代码或缺依赖代码，会导致无关失败、超时或长时间扫描。

仅运行 TypeScript 检查：

```bash
bunx tsc --noEmit
```

改动涉及 prompt 时至少运行：

```bash
bun test packages/mica-agent/prompt/index.test.ts
```

## 架构概览

```text
src/                    应用装配层：入口、Application、runtime、session、插件 wiring
packages/mica-agent     provider adapter、agent 抽象、prompt 构建
packages/mica-tools     内置工具、工具 registry、MCP 工具接入
packages/mica-mcp       MCP 配置读取、server 连接管理
packages/mica-ui        Ink 终端 UI 组件和状态 store
packages/mica-runtime   运行时协议、事件、状态、输入和消息队列
packages/mica-session   会话快照持久化
packages/mica-config    本地配置、storage、模型列表和模型规则
packages/mica-commands  通用斜杠命令注册与分发
packages/mica-builtin-commands  产品内置命令
packages/mica-context   上下文压缩能力
packages/mica-skills    skills 扫描、解析和缓存
packages/mica-plugin    插件生命周期、hooks 和 service container
packages/mica-common    跨包共享底层工具
packages/mica-logger    运行时日志 store 和格式化
```

更详细的仓库约定见 [AGENT.md](./AGENT.md)，package 边界见 [packages/README.md](./packages/README.md)，开发过程记录见 [blogs/](./blogs)，设计草案见 [docs/](./docs)。

## 状态

Mica Code 目前在积极迭代中，核心 agent loop、工具系统、会话管理、MCP 接入、多 agent、rewind 和 compact 已可用，更多长期能力持续加入。
