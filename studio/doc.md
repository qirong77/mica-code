# Studio 使用手册

> Studio 是一个终端 code agent（内部使用），随内部工具链 spring-cli（`@didi/spring-cli`，版本 `>= 1.9.1`）发布。Studio 的 PTY 工具依赖本机 node-pty 运行时，其余功能为内置。

## 安装

### 方式一：通过 spring-cli 安装（推荐）

```bash
npm install -g @didi/spring-cli
```

安装过程会自动把当前平台对应的 Studio 二进制复制到 `~/.local/bin/studio`。支持平台：

| 平台        | 包内二进制           |
| ----------- | -------------------- |
| macOS arm64 | `studio`             |
| macOS x64   | `studio-x64`         |
| Linux x64   | `studio-linux-x64`   |
| Linux arm64 | `studio-linux-arm64` |

> 其他平台会跳过安装（`Studio: unsupported platform`）。如需自定义安装目录，设置 `STUDIO_INSTALL_DIR` 后再安装。

验证安装：

```bash
studio --version
```

## 快速开始

```bash
studio                    # 启动交互式 TUI
studio --resume <id>      # 恢复历史会话
```

## 交互模式

启动后进入 TUI：在输入框输入内容回车即开始一轮任务，支持斜杠命令（如 `/model`、`/effort`、`/role`、`/compact`、`/commit`、`/resume`、`/mcp`、`/skills` 等，输入 `/` 可查看全部）。

常用参数：

```bash
studio                          # 新会话
studio --resume <session-id>    # 恢复指定历史会话
```

## 命令行 / 自动化（API）

所有子命令的完整参数可通过 `studio --help` 查看。

### 列出可用模型

```bash
studio models                 # 人类可读列表
studio models --json          # JSON 输出，含每个模型的 efforts 支持范围
```

输出示例：

```json
[{ "id": "Llm-proxy/kimi-k2.7-code", "efforts": ["high"] }]
```

### 一次性执行并指定模型

`--model` 接受 `provider/model` 形式，覆盖默认 provider 和模型：

```bash
studio exec --model Llm-proxy/kimi-k2.7-code "今天星期几？"
```

指定推理强度（`--variant`，取值为 `none|low|medium|high|xhigh`）：

```bash
studio exec --model Llm-proxy/kimi-k2.7-code --variant high "今天星期几？"
```

组合使用：工作目录、角色、最大轮次：

```bash
studio exec --model Llm-proxy/kimi-k2.7-code --variant high \
  --dir ~/my-project --role code-reviewer --max-turns 5 "今天星期几？"
```

常用选项：

| 选项                             | 说明                                                  |
| -------------------------------- | ----------------------------------------------------- |
| `--model <provider/model>`       | 覆盖 provider 和模型（如 `Llm-proxy/kimi-k2.7-code`） |
| `--variant <effort>`             | 推理强度：`none\|low\|medium\|high\|xhigh`            |
| `--role <name>`                  | 覆盖 agent 角色（来自 `~/.mica/role`）                |
| `--dir <path>`                   | 任务工作目录                                          |
| `--session <id>`                 | 在已有会话上继续                                      |
| `--max-turns <count>`            | 限制模型往返轮次                                      |
| `--json`                         | 输出 Codex exec 风格 ThreadEvent JSONL                |
| `--thinking`                     | 在 JSON 输出中包含 reasoning 事件                     |
| `--no-save`                      | 不落盘会话文件（一次性后台任务）                      |
| `--mcp-config <path>`            | 额外加载 MCP 服务器配置                               |
| `--strict-mcp-config`            | 不合并本地 MCP 配置                                   |
| `--mcp-init-timeout-ms <ms>`     | 单个 MCP server 的 connect + tools/list 上限          |
| `--dangerously-skip-permissions` | 自主运行模式（跳过权限确认）                          |

默认输出人类可读文本；加 `--json` 输出 `thread.started` / `turn.started` / `item.*` / `turn.completed` / `error` 事件流，适合脚本消费：

```bash
studio exec --json --thinking --model Llm-proxy/kimi-k2.7-code "今天星期几？" | jq -c 'select(.type=="turn.completed")'
```

### 常驻会话服务（app-server）

每会话一个常驻进程，通过 stdin/stdout 走 Codex v2 App Server 协议，适合桌面/宿主程序集成：

```bash
studio app-server [--session <id>] [--dir <path>] [--model <provider/model>] [--variant <effort>] [--role <name>]
```

### 其他子命令

```bash
studio compact --session <id> [--dir <path>] [--force]   # 压缩会话为 checkpoint
studio compact --session <id> --prune-only               # 仅本地清理，不调用模型
studio commit [--dir <path>]                             # 分析 git 变化、生成提交信息并提交推送
studio daemon [--server <url>] [--name <name>]           # 常驻同步 daemon（远程会话镜像）
```

## 配置与数据

Studio 使用 `~/.mica` 作为配置与本地数据目录（设置 `MICA_HOME` 时跟随 `$MICA_HOME`）：

- 配置：`~/.mica/config.json`（providers、mcpServers 等）
- 会话：`~/.mica/sessions/`
- 本地状态：`~/.mica/storage.json`（provider/model/effort、输入历史等）

## 常见问题

**Q: `studio: command not found`？**
确认 spring-cli 已全局安装（`npm ls -g @didi/spring-cli`，版本 >= 1.9.1），且 `~/.local/bin` 在 PATH 中；新开的终端会自动生效。

**Q: `~/.local/bin/studio` 不是最新的？**
重新全局安装：`npm install -g @didi/spring-cli`。

**Q: 怎么知道有哪些模型可以用？**
运行 `studio models`，选一个 `id`（如 `Llm-proxy/kimi-k2.7-code`）传给 `--model`，或在交互模式 `/model` 里选择。
