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

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ANTHROPIC_API_KEY` | API 密钥 | (必填) |
| `ANTHROPIC_BASE_URL` | API 端点 | `https://api.deepseek.com/anthropic` |
| `ANTHROPIC_MODEL` | 模型 | `deepseek-v4-flash` |
| `ANTHROPIC_MAX_TOKENS` | 最大 token 数 | `8192` |

## 命令

| 命令 | 说明 |
|------|------|
| `/model` | 切换模型 |
| `/effort` | 切换推理强度 (none/low/medium/high) |
| `/clear` | 开始新会话（旧会话可通过 /resume 恢复） |
| `/resume` | 恢复历史对话 |
| `/rewind` | 回退最近一轮对话及代码改动 |
| `/rename` | AI 生成会话标题 |
| `/init` | 分析代码库并创建/更新 AGENTS.md |
| `/skills` | 列出所有已安装的 skill |
| `/mcp` | 查看/管理 MCP 服务器 |
| `/exit` | 退出程序 |
| `/debug` | 调试工具（导出会话、查看状态） |
| `/debug-status` | 显示当前状态（模型、API 配置等） |
| `/debug-log-open` | 打开系统日志面板 |
| `/debug-log-close` | 关闭系统日志面板 |
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

## 插件系统

Mica 提供两层扩展点：

### 1. Agent Middleware

通过 `agentTurn.use(middleware)` 注册，可拦截每次用户输入的处理流程：

- **AutoCompactPlugin** — 自动压缩过长的 tool result 以节省上下文窗口
- **ErrorHandlerPlugin** — API 调用失败时自动重试（指数退避策略）

### 2. MicaPlugin 基类

继承 `MicaPlugin` 可获得 agent 实例引用、全局 store atom 访问、输入处理器注册等能力。内置插件：

| 插件 | 分类 | 功能 |
|------|------|------|
| `AutoCompactPlugin` | agent | 自动压缩上下文，保留最近 3 条完整 tool result |
| `ErrorHandlerPlugin` | agent | API 可重试错误自动重试（3 次，指数退避） |
| `QuickBashPlugin` | custom | 支持 `!` 前缀快捷执行 shell 命令 |
| `QuickCommandInitPlugin` | custom | `/init` — 分析代码库并创建 AGENTS.md |
| `QuickCommandSkillsPlugin` | custom | `/skills` — 列出已安装 skill |
| `QuickCommandDebugPlugin` | debug | `/debug` — 调试入口 |
| `QuickCommandLogTogglePlugin` | debug | `/debug-log-open` / `/debug-log-close` — 日志面板 |
| `QuickCommandLogPlugin` | debug | `/debug-log-export` — 导出日志 |
| `QuickCommandStatusPlugin` | debug | `/debug-status` — 显示当前状态 |
| `QuickCommandModelPlugin` | quick-command | `/model` — 切换模型 |
| `QuickCommandEffortPlugin` | quick-command | `/effort` — 切换推理强度 |
| `QuickCommandResumePlugin` | quick-command | `/resume` — 恢复历史对话 |
| `QuickCommandRenamePlugin` | quick-command | `/rename` — AI 生成会话标题 |
| `QuickCommandExitPlugin` | quick-command | `/exit` — 退出程序 |
| `QuickCommandRewindPlugin` | quick-command | `/rewind` — 回退最近一轮对话 |
| `QuickCommandClearPlugin` | quick-command | `/clear` — 开始新会话 |
| `QuickCommandMcpPlugin` | mcp | `/mcp` — MCP 服务器管理 |

### 编写插件

```ts
import { MicaPlugin } from '../plugins/MicaPlugin';

export class MyPlugin extends MicaPlugin {
  onInstall() {
    this.addQuickCommand({
      name: 'my-command',
      description: '我的命令',
      action: () => this.showStatus('hello'),
    });
  }
}
```

## MCP 支持

Mica 支持通过 MCP (Model Context Protocol) 接入外部工具服务器，扩展 agent 的工具能力。MCP 服务器配置文件位于 `~/.mica/mcp.json`。

使用 `/mcp` 命令查看和管理已配置的 MCP 服务器。

## Skills 系统

Skills 是用户自定义的专业能力模块，位于 `~/.mica/skills/`。每个 skill 是一个包含 `SKILL.md` 的子目录，agent 在对话中可按需调用。

```
~/.mica/skills/
└── my-skill/
    └── SKILL.md    # 包含 frontmatter (name, description, when_to_use) + 内容
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
│   ├── turn.ts           # AgentTurn: middleware 链 → API → 并行工具执行 → 循环
│   └── client.ts         # Anthropic SDK 客户端单例
├── plugins/
│   ├── MicaPlugin.ts     # 插件抽象基类
│   ├── agent/            # Middleware 插件
│   ├── quick-command/    # 命令插件
│   ├── debug/            # 调试插件
│   ├── custom/           # 自定义插件
│   └── mcp/              # MCP 插件
├── tools/                # agent 可调用工具（MicaTool 子类）
├── store/                # nanostores atoms：config、conversation、ui-state、log 等
├── components/ui/        # Ink-based React 终端 UI
├── prompts/              # 系统提示词构建
├── skills/               # Skills 加载器
└── mcp/                  # MCP 客户端
```

## 技术栈

- [Ink](https://github.com/vadimdemedes/ink) — React 驱动的 CLI 渲染
- [nanostores](https://github.com/nanostores/nanostores) — 轻量状态管理
- [Bun](https://bun.sh) — 运行时 & 构建工具
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) — API 客户端
- [MCP SDK](https://github.com/modelcontextprotocol/sdk) — Model Context Protocol 支持

## 开发

```bash
# 格式化代码
bun run format

# 检查格式化
bun run format:check

# TypeScript 类型检查
npx tsc --noEmit
```

## 许可证

MIT
