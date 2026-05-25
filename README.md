# Mica

轻量级、插件式的 code agent CLI。基于 Anthropic API 的交互式编程辅助工具，核心设计理念是简洁和可扩展。

## 设计理念

- **轻量** — 最小依赖，快速启动，聚焦核心的代码编辑工作流
- **插件式** — 核心只做编排，功能通过插件扩展，按需加载
- **可组合** — Middleware 机制让插件可以自由组合、拦截和增强 agent 行为

## 插件系统

Mica 提供两层扩展点：

### 1. Agent Middleware

通过 `agentTurn.use(middleware)` 注册，可拦截每次用户输入的处理流程。典型用途：

- **AutoCompactPlugin** — 自动压缩过长的 tool result 以节省上下文窗口
- **ErrorHandlerPlugin** — API 调用失败时自动重试（退避策略）

### 2. MicaPlugin 基类

继承 `MicaPlugin` 可获得 agent 实例引用、全局 store atom 访问、输入处理器注册等能力。内置插件：

| 插件 | 功能 |
|------|------|
| `AutoCompactPlugin` | 自动压缩上下文中的 tool result，保留最近 3 条完整结果 |
| `ErrorHandlerPlugin` | API 可重试错误自动重试（3 次，指数退避） |
| `QuickCommandLogPlugin` | `/session-export` — 导出会话记录 |
| `QuickCommandClearPlugin` | `/clear` — 清空对话 |
| `QuickCommandModelPlugin` | `/model-switch` 切换模型，`/model-effort` 设置推理强度 |
| `DebugExportAtomPlugin` | `/debug-export-atom` — 导出所有内部状态 |

插件在 `src/index.ts` 中按需加载：

```ts
import { AutoCompactPlugin } from './plugins/agent/auto-compact-plugin';
import { ErrorHandlerPlugin } from './plugins/agent/error-handler-plugin';

await MicaAgent.usePlugin(new AutoCompactPlugin());
await MicaAgent.usePlugin(new ErrorHandlerPlugin());
```

### 编写插件

```ts
import { MicaPlugin } from '../plugins/MicaPlugin';

export class MyPlugin extends MicaPlugin {
  onInstall() {
    // 通过 this.agent 访问 agent 实例
    // 通过 this.store 访问全局状态
    this.addQuickCommand({
      name: 'my-command',
      description: '我的命令',
      action: () => this.showStatus('hello'),
    });
  }
}
```

## 安装

从 [Releases](https://github.com/your-org/micro-claude/releases) 下载对应平台的二进制文件，放到 PATH 中即可：

```bash
# macOS ARM64
curl -L https://github.com/your-org/micro-claude/releases/latest/download/mica-darwin-arm64 -o /usr/local/bin/mica
chmod +x /usr/local/bin/mica
```

## 开发

```bash
# 安装依赖
bun install

# 开发模式（直接运行 TS）
bun run dev

# 构建原生二进制（发布用）
bun run build:compile

# 构建 bun bundle（本地调试用）
bun run build
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ANTHROPIC_API_KEY` | API 密钥 | (必填) |
| `ANTHROPIC_BASE_URL` | API 端点 | `https://api.deepseek.com/anthropic` |
| `ANTHROPIC_MODEL` | 模型 | `deepseek-v4-flash` |
| `ANTHROPIC_MAX_TOKENS` | 最大 token 数 | `8192` |

## 内置工具

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件 |
| `write_file` | 写入文件 |
| `edit_file` | 字符串替换编辑文件 |
| `list_files` | glob 模式列出文件 |
| `grep_search` | 正则搜索 |
| `run_shell` | 执行 shell 命令 |

## 命令

| 命令 | 说明 |
|------|------|
| `/model-switch` | 切换模型 |
| `/model-effort` | 设置推理强度 (none/low/medium/high) |
| `/clear` | 清空对话 |
| `/session-export` | 导出会话记录 |
| `/debug-export-atom` | 导出所有内部状态 |

## 技术栈

- [ink](https://github.com/vadimdemedes/ink) — React 驱动的 CLI 渲染
- [nanostores](https://github.com/nanostores/nanostores) — 轻量状态管理
- [Bun](https://bun.sh) — 运行时 & 构建工具
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) — API 客户端

## 许可证

MIT
