# Mica

轻量级、插件式的 code agent CLI。基于 Anthropic API 的交互式编程辅助工具，核心设计理念是简洁和可扩展。

## 设计理念

- **轻量** — 最小依赖，快速启动，聚焦核心的代码编辑工作流
- **插件式** — 核心只做编排，功能通过插件扩展，按需加载
- **可组合** — Middleware 机制让插件可以自由组合、拦截和增强 agent 行为

## 安装

```bash
# 安装依赖
bun install

# 开发模式（直接运行 TS）
bun run dev

# 构建原生二进制
bun run build

# 通过 -p 参数直接执行单次任务
bun run dev -- -p "你的问题"
```

## Provider 配置

Mica 支持多 AI 服务提供商切换。配置文件位于 `~/.mica/provider.json`，首次启动自动生成。内置 DeepSeek、Claude、Kimi 三个提供商，可通过对应的环境变量配置 API Key：

| 提供商 | API Key 环境变量 |
|--------|-----------------|
| DeepSeek | `DEEPSEEK_API_KEY` |
| Claude | `ANTHROPIC_API_KEY` |
| Kimi | `MOONSHOT_API_KEY` |

启动后通过 `/provider` 命令切换提供商，无需手动编辑文件。

## 命令

| 命令 | 说明 |
|------|------|
| `/model` | 切换模型 |
| `/effort` | 切换推理强度 (none/low/medium/high) |
| `/provider` | 切换 AI 服务提供商 |
| `/clear` | 开始新会话（旧会话可通过 /resume 恢复） |
| `/resume` | 恢复历史对话（收藏的会话优先展示） |
| `/rewind` | 回退最近一轮对话及代码改动 |
| `/rename` | AI 生成会话标题 |
| `/star` | 收藏 / 取消收藏当前会话 |
| `/delete` | 删除当前会话 |
| `/compact` | 手动压缩对话上下文 |
| `/commit` | 分析当前 git 变更，AI 生成 commit message 并提交 |
| `/git-change-context` | 对比目标分支的代码改动，让 AI 总结上下文 |
| `/memory` | 查看/管理当前项目的记忆文件 |
| `/init` | 分析代码库并创建/更新 AGENTS.md |
| `/skills` | 列出所有已安装的 skill |
| `/mcp` | 查看/管理 MCP 服务器 |
| `/status` | 显示当前状态（模型、API 配置、上下文用量等） |
| `/exit` | 退出程序 |
| `/debug-log-export` | 导出日志和会话记录到当前路径 |

## 内置工具

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件 |
| `write_file` | 写入文件 |
| `edit_file` | 字符串替换编辑文件 |
| `list_files` | glob 模式列出文件 |
| `grep_search` | 正则搜索 |
| `run_shell` | 执行 shell 命令 |
| `web_fetch` | 抓取 URL 内容 |
| `Skill` | 调用已安装的 skill |

## 记忆系统

Mica 会自动从对话中提取持久化记忆，存储在 `~/.mica/memory/`（项目级）和 `~/.mica/sessions/`（会话级）。记忆分为四类：

- **user** — 用户角色、偏好、职责
- **feedback** — 对代码/交互方式的反馈
- **project** — 项目目标、已知 bug、关键决策
- **reference** — 外部系统链接

每轮对话结束后，后台自动更新记忆文件。Agent 启动时会将 MEMORY.md 索引注入系统 prompt。使用 `/memory` 查看当前记忆状态。

## 插件系统

Mica 提供两层扩展点：

### 1. Agent Middleware

通过 `agentTurn.use(middleware)` 注册，可拦截每次用户输入的处理流程：

- **AutoCompactPlugin** — 自动压缩过长的 tool result 以节省上下文窗口
- **ErrorHandlerPlugin** — API 调用失败时自动重试（指数退避策略）

### 2. MicaPlugin 基类

继承 `MicaPlugin` 或 `UIPanelPlugin` 可获得 agent 实例引用、store atom 访问、输入处理器注册、UI 面板渲染等能力。内置插件：

| 插件 | 类型 | 功能 |
|------|------|------|
| `ErrorHandlerPlugin` | agent | API 可重试错误自动重试（3 次，指数退避） |
| `AutoCompactPlugin` | agent | 自动压缩上下文，保留最近 3 条完整 tool result |
| `MemoryPlugin` | memory | 自动提取/管理跨对话记忆和会话记忆 |
| `BuiltinCommandsPlugin` | quick-command | `/clear`, `/exit`, `/status`, `/debug-log-export` |
| `QuickCommandModelPlugin` | quick-command | `/model` — 切换模型 |
| `QuickCommandEffortPlugin` | quick-command | `/effort` — 切换推理强度 |
| `QuickCommandProviderPlugin` | quick-command | `/provider` — 切换 AI 提供商 |
| `QuickCommandResumePlugin` | quick-command | `/resume` — 恢复历史对话 |
| `QuickCommandRenamePlugin` | quick-command | `/rename` — AI 生成会话标题 |
| `QuickCommandRewindPlugin` | quick-command | `/rewind` — 回退最近一轮对话 |
| `QuickCommandStarPlugin` | quick-command | `/star` — 收藏/取消收藏会话 |
| `QuickCommandDeletePlugin` | quick-command | `/delete` — 删除会话 |
| `QuickCommandCompactPlugin` | quick-command | `/compact` — 手动压缩上下文 |
| `QuickCommandGitChangeContextPlugin` | quick-command | `/git-change-context` — 分支 diff 分析 |
| `QuickCommitPlugin` | custom | `/commit` — AI 生成 commit 并提交 |
| `QuickCommandInitPlugin` | custom | `/init` — 分析代码库创建 AGENTS.md |
| `QuickCommandSkillsPlugin` | custom | `/skills` — 列出已安装 skill |
| `DebugExportLogPlugin` | debug | 调试日志面板 |
| `QuickCommandMcpPlugin` | mcp | `/mcp` — MCP 服务器管理 |

### 编写插件

```ts
import { MicaPlugin } from '../plugins/MicaPlugin';

export class MyPlugin extends MicaPlugin {
  onInstall() {
    this.addQuickCommand({
      name: 'my-command',
      description: '我的命令',
      action: () => this.showMessage('hello'),
    });
  }
}
```

如需渲染 UI 面板（如进度日志），继承 `UIPanelPlugin` 并调用 `showUISimple(Component)`。

## MCP 支持

Mica 支持通过 MCP (Model Context Protocol) 接入外部工具服务器，扩展 agent 的工具能力。MCP 服务器配置在 `~/.mica/config.json` 的 `mcpServers` 字段。

支持两种传输方式：
- **stdio** — 本地进程通信（command + args）
- **http** — SSE 流式传输（url + headers）

使用 `/mcp` 命令查看和管理已配置的 MCP 服务器。

## Skills 系统

Skills 是用户自定义的专业能力模块，位于 `~/.mica/skills/`（兼容 `~/.claude/skills/`）。每个 skill 是一个包含 `SKILL.md` 的子目录，agent 在对话中可按需调用。

```
~/.mica/skills/
└── my-skill/
    └── SKILL.md    # frontmatter (name, description, when_to_use) + 内容
```

使用 `/skills` 命令查看已安装的 skill 列表。

## 架构概览

```
src/
├── index.ts              # 入口：注册插件，启动 MicaAgent
├── bootstrap.ts          # 连接 TerminalInput 输入 → agentTurn.run()
├── core/
│   ├── agent.ts          # MicaAgent 单例：插件注册、atom 注入、UI 访问
│   └── agentEvents.ts    # agentTurn 事件流 → nanostores 映射
├── agent/
│   ├── turn.ts           # AgentTurn：middleware 链编排（run / abort）
│   ├── client.ts         # Anthropic SDK 客户端单例
│   ├── iterationRunner.ts # 单次 API 调用 + 工具执行循环
│   ├── toolExecutor.ts   # 并行工具执行器
│   ├── agentSession.ts   # 会话消息管理（增删改查、修复）
│   ├── subagent.ts       # 独立 sub-agent（不经过主会话/中间件）
│   └── forkedAgent.ts    # 并行 fork agent（记忆提取等后台任务）
├── plugins/
│   ├── MicaPlugin.ts     # 插件抽象基类 + UIPanelPlugin
│   ├── agent/            # Middleware 插件
│   ├── quick-command/    # 命令插件（select/resume/rename/rewind/star/delete/compact 等）
│   ├── custom/           # /commit, /init, /skills
│   ├── debug/            # 调试导出
│   ├── memory/           # 记忆提取与管理
│   └── mcp/              # MCP 管理
├── tools/                # agent 可调用工具（MicaTool 子类）
├── store/                # nanostores atoms
├── components/           # Ink-based React 终端 UI
├── prompts/              # 系统提示词构建
├── skills/               # Skills 加载器
├── mcp/                  # MCP 客户端
└── utils/                # 工具函数（compact, repair, format, display 等）
packages/
├── @anthropic/ink/       # 自定义 Ink fork（workspace 依赖）
└── ink/                  # 参考用 Ink 源码，不参与构建
```

## 技术栈

- [Ink](https://github.com/vadimdemedes/ink) — React 驱动的 CLI 渲染（自维护 fork）
- [nanostores](https://github.com/nanostores/nanostores) — 轻量状态管理
- [Bun](https://bun.sh) — 运行时 & 构建工具
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) — API 客户端
- [MCP SDK](https://github.com/modelcontextprotocol/sdk) — Model Context Protocol 支持

## 开发

```bash
bun run dev          # 开发模式
bun run build        # 构建原生二进制
bun run format       # 格式化代码
bun run format:check # 检查格式化
npx tsc --noEmit     # TypeScript 类型检查
```

## 许可证

MIT
