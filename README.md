# Mica Code

Mica Code 是一个在终端里运行的轻量级 AI coding agent。它可以阅读和编辑代码、搜索文件、运行 shell 命令、调用网页与 MCP 工具，并根据执行反馈持续推进任务。

它的重点是保持终端 agent 的核心体验清晰、可控、可扩展：直接对话、改文件、跑命令、看结果，无需切换到额外的 IDE 或网页控制台。

> 当前项目仍在快速迭代，内部 API 与配置格式可能调整。

## 为什么是 Mica Code

- **终端优先的工作流**：在项目目录中直接对话、改文件、跑命令、看结果，无需切换工具。
- **轻量但完整的 agent loop**：支持流式响应、thinking/tool 日志、工具调用、多轮反馈、中止控制、输入排队和会话快照。
- **OpenAI 兼容 provider**：主路径面向 OpenAI Chat Completions 风格接口，支持 DeepSeek、Moonshot、OpenAI 兼容网关及自建 provider。
- **可插拔工具系统**：内置文件读写、精确编辑、搜索、shell、web search/fetch、skills 等工具；MCP 工具进入同一套 registry 和执行链路。
- **MCP 原生接入**：读取本地 MCP 配置、连接远端 server，将外部能力暴露给 agent 使用。
- **会话可恢复，改动可回退**：本地保存 session snapshot，支持 `/resume` 恢复历史会话；`/rewind` 回退到上一轮对话前的对话与文件状态。
- **多 agent 并行**：通过 `/new` 创建独立的 agent session，探索、计划、实现等任务分开进行，避免主会话上下文污染。
- **模块化工程架构**：runtime、provider、tools、commands、session、UI、plugin、skills 等能力拆为独立 package，定界清晰、易于扩展和替换。

## 快速开始

### 从 GitHub Release 安装

仓库推送 `v*` tag 后，GitHub Actions 自动构建并发布 Linux/macOS 二进制包：

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/install-github.sh | MICA_GITHUB_REPO=<owner>/<repo> bash
```

指定版本或安装目录：

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/install-github.sh | MICA_GITHUB_REPO=<owner>/<repo> MICA_VERSION=v0.1.0 MICA_INSTALL_DIR=$HOME/.local/bin bash
```

Release 产物：

- `mica-linux-x64.tar.gz`
- `mica-linux-arm64.tar.gz`
- `mica-darwin-x64.tar.gz`
- `mica-darwin-arm64.tar.gz`

### 本地构建

```bash
bun install
bun run dev
```

在 CLI 中直接输入任务：

```text
修复当前项目里的类型错误，并运行 typecheck 验证。
```

或让它执行复杂改动：

```text
把 src/ 中所有 console.log 替换为 logger，并保证测试通过。
```

## 配置 Provider

首次运行会创建本地配置文件 `~/.mica/config.json`。

启动时读取 `.env` 和 `packages/mica-agent/.env`。

典型 provider 配置：

```json
{
  "id": "deepseek",
  "name": "DeepSeek",
  "api_base": "https://api.deepseek.com",
  "get_model_url": "https://api.deepseek.com/models",
  "api_key": ""
}
```

主路径通过 OpenAI Chat Completions 风格的 client 连接 provider，第三方 provider 需实现对应接口。
最后一次使用的 provider、model、effort 和 context window 会写入 `~/.mica/storage.json`，不写入 provider 静态配置。
如果 provider 配置了 `get_model_url`，模型列表会在运行时获取，不会回填到 `~/.mica/config.json`；没有动态模型接口的 provider 可以直接配置静态 `models` 数组。

## 常用命令

在 CLI 中输入 `/` 打开命令面板：

- `/clear`：清空当前会话和 UI 状态。
- `/resume`：恢复历史会话。
- `/provider`：切换 provider。
- `/model`：切换模型。
- `/effort`：切换推理努力等级。
- `/status`：查看当前 provider、model、上下文和 token 状态。
- `/new`：新建 agent 并切换；`/new <text>` 后台创建并运行，不切换当前 agent。
- `/log`：查看运行时日志；`/log export` 导出当前对话与日志。
- `/agents clear`：清除非当前且空闲的 agent。
- `/rewind`：确认后回退到上一轮对话前的对话与文件状态。
- `/mcp`：查看 MCP 服务器和工具，支持 reconnect。
- `/skills`：查看已加载 skills。
- `/commit`：分析 git diff，生成提交信息并提交推送。

## 开发

常用验证命令：

```bash
bun run typecheck
bun run test
bun run build
bun run format
```

`temp/` 是临时外部目录，不属于默认验证范围。测试请使用 `bun run test` 或显式测试文件，避免直接运行裸 `bun test` 扫到 `temp/`。

仅运行 TypeScript 检查：

```bash
bunx tsc --noEmit
```

改动涉及 prompt 时运行：

```bash
bun test packages/mica-agent/prompt/index.test.ts
```

更详细的架构约定见 [AGENT.md](./AGENT.md)，开发过程记录见 [blogs/](./blogs)。

## 状态

Mica Code 目前在积极迭代中，核心 agent loop、工具系统和会话管理已稳定可用，更多能力持续加入。
