<p align="center">
  <img src="./apps/desktop/resources/icon.svg" alt="Mica Code" width="76" height="76">
</p>

<h1 align="center">Mica Code</h1>

<p align="center">
  <b>MICA — Minimal, Intelligent, Cache-first Agent</b><br>
  轻量、终端原生、缓存优先的 AI coding agent
</p>

<p align="center">
  <a href="https://github.com/qirong77/mica-code/actions/workflows/build-binaries.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/qirong77/mica-code/build-binaries.yml?label=build"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522-3c873a">
  <img alt="Shell" src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-555">
</p>

<p align="center">
  <img src="./images/app-chat.png" width="920" alt="Mica Code 桌面端">
</p>

读代码、改代码、跑测试、提交，都在一个可以留在终端里的 agent 里完成：会话按 append-only 追加，前缀尽量不动，长对话也能保持高缓存命中。

## 核心优势

- **缓存优先**：system prompt、工具定义、历史前缀都尽量保持稳定，命中率上限直接决定成本和速度。本地评测里 9 个任务的输入侧缓存命中率是 99.1%。
- **终端原生**：Ink 写的 TUI，键盘优先、信息密度高；多 agent、后台任务、待办与用量常驻一行状态栏。
- **一套引擎三种入口**：交互 TUI、桌面 App、`mica exec` / `mica app-server` 共用同一个 turn 循环、同一份会话与同一套插件，行为不会分叉。
- **可回退**：`/rewind` 回到任意一轮（带文件检查点时连文件一起回滚），`/compact` 只替换工具结果、不改对话文本。

## 评测：同样 9 个任务，五个 agent 各跑一遍

<p align="center">
  <img src="./images/eval-benchmark.svg" width="920" alt="五个 coding agent 在同一批任务上的对比">
</p>

- **口径**：9 个真实仓库的 bugfix / 特性任务，464 项人工检查；模型统一 DeepSeek Flash；同一 prompt、同一仓库快照、同一台机器；每格取 4 次运行的中位数。
- **结论**：五者通过数只差 1.1 个百分点（457–462 项），正确率同档；Mica 的输入侧缓存命中率最高（99.1%），总耗时 86.2 分钟居中，轮次比 Codex / Claude Code 多。
- **复现**：评测脚本与原始记录在本地项目 `frontier-harness-eval-benchmark`（本地代理抓包 + 本地评分，暂未开源）。`base` 指未改动仓库的通过率 19.6%，说明大部分检查来自真实修复而不是既有通过项。

## 快速开始

```bash
# 安装（install.sh 探测 os/arch、校验 sha256，装到 ~/.local/lib/mica，并在 ~/.local/bin/mica 写薄 launcher）
curl -fsSL https://github.com/qirong77/mica-code/releases/latest/download/install.sh | sh

mica            # 进入 TUI
mica models     # 看当前可用的 provider / model
```

首次运行会在 `~/.mica/` 下创建配置（`MICA_HOME` 可改目录）。在 TUI 里运行 `/config` 打开配置页面，或直接编辑 `config.json`：

```json
{
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "api_base": "https://api.deepseek.com",
      "protocol": "openai_chat_completions",
      "get_model_url": "https://api.deepseek.com/models",
      "api_key": ""
    },
    {
      "id": "kimi",
      "name": "Kimi",
      "protocol": "openai_chat_completions",
      "api_base": "https://api.moonshot.cn/v1",
      "models": ["kimi-k2.7"],
      "api_key": ""
    }
  ]
}
```

| 字段             | 说明                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `protocol`       | 只能是 `openai_chat_completions` 或 `openai_responses`，按 provider 官方支持的接口选，不按 `api_base` 猜 |
| `get_model_url`  | 按 OpenAI `/models` 响应格式在运行时拉模型列表；没有动态接口就写静态 `models` 数组                       |
| `supportsEffort` | 该 provider 不支持推理强度时设为 `false`，避免请求被拒                                                   |

容器或 CI 里没有配置文件时，只要磁盘上没有任何 provider 配了 `api_key`，`OPENAI_API_KEY` + `OPENAI_BASE_URL` 会合成一个运行时 `openai` provider（协议默认 `openai_responses`，可用 `MICA_PROVIDER_PROTOCOL` 覆盖），不会写回 `config.json`。

## 能力一览

### 内置命令

| 命令                         | 作用                                                  | 运行中可执行 |
| ---------------------------- | ----------------------------------------------------- | ------------ |
| `/model` `/effort` `/role`   | 切换 provider/model、推理强度、角色                   | —            |
| `/status` `/context`         | 当前 provider/model/effort 与会话用量、上下文占用明细 | ✓            |
| `/new` `/fork`               | 新开 agent、从当前历史分叉                            | ✓            |
| `/task`                      | 终端会话、subagent、后台 shell 一览                   | ✓            |
| `/btw`                       | 旁问：隔离子代理，不污染主上下文                      | ✓            |
| `/rename`                    | 重命名当前会话                                        | ✓            |
| `/resume` `/rewind` `/clear` | 恢复、回退到某一轮、开新会话                          | —            |
| `/compact`                   | 就地压缩工具结果（`llm` 生成摘要 checkpoint）         | —            |
| `/loop`                      | 定时循环执行任务（每轮前先做一次本地压缩）            | —            |
| `/commit`                    | 分析 git 变更并提交（`agent` 只提交本 agent 的改动）  | ✓            |
| `/config` `/exit`            | 打开配置页、退出                                      | ✓            |
| `/mcp` `/skills` `/cd`       | MCP 与 skills 管理、切到最近用过的目录                | —            |

完整清单与快捷键见 [内置命令](https://qirong77.github.io/mica-code/docs/commands)、[packages/mica-builtin-commands/README.md](./packages/mica-builtin-commands/README.md)。

### 工具与扩展

| 类别       | 工具                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| 只读       | `read_file` `list_files` `grep_search` `read_image` `web_search` `web_fetch` `Skill` `background_tasks` `read_task_output` |
| 写入与执行 | `write_file` `apply_patch` `run_shell` `kill_task` `wait_for` `pty_spawn` `pty_send` `pty_read` `pty_wait` `pty_kill`      |
| 编排       | `Agent`（subagent）、`TodoWrite`、`session_info` `session_peers` `session_compact`、`loop_*`                               |

- **Skills**：`<cwd>/.mica/skills`、`.agents/skills`、`.deveco/skills`、`.agent_context/skills` 与 `$MICA_HOME/skills`，目录里放 `SKILL.md` 即生效，只在 system prompt 里留索引。
- **MCP**：`config.json` 的 `mcpServers` 照常写 `command` / `args` / `env`，工具自动并入 registry；`/mcp reconnect <server>` 单独重连。
- **Role**：`$MICA_HOME/role/*.md`，文件名即角色名，整段替换 system prompt；`/role` 选择，`Shift+Tab` 循环。
- **Subagent**：`general-purpose`、`Explore`、`Implementer`、`Reviewer`、`Tester`、`Planner`、`Proposal` 七种，可指定 `run_in_background` 与 `owned_paths` 租约，按 owner 隔离并发上限。

### 桌面 App

<p align="center">
  <img src="./images/app-turn-log.png" width="920" alt="回合日志、待办与工具执行">
</p>

同一个运行时也带 Electron 外壳：多页签会话、Files/Git（含提交级 diff）、按会话分组的终端、Stats、配置页、By The Way 抽屉、定时循环、自动压缩，以及给 agent 用的受控浏览器与终端控制。运行时只监听一个 HTTP 端口，页面走 HTTP + SSE，所以浏览器打开同一个地址就是完整功能（含移动端布局与 `/share` 只读分享）。

> `npm run build:app` 打包桌面端；运行时默认监听 `0.0.0.0:8787` 且没有认证，所有能连上的客户端都拥有完整宿主能力，请只在可信网络里开。

## 集成与自动化

执行协议与 OpenAI Codex 对齐，现成的 Codex driver 不用改适配层：

| 命令                                                     | 用途                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `mica exec [--json] [--thinking] [--no-save] "<prompt>"` | 一次性执行；`--json` 输出 Codex ThreadEvent JSONL                                   |
| `mica app-server [--session <id>] [--dir <cwd>]`         | 每会话常驻进程，stdin/stdout 走 Codex v2                                            |
| `mica compact --session <id>`                            | 压缩历史；`--tool-results-only` 本地替换、`--prune-only` 更激进、`--force` 强制摘要 |
| `mica commit [--dir <cwd>] [--session <id>]`             | 确定性提交：一次模型请求生成 message，程序自己执行 add/commit/push                  |
| `mica models [--json]`                                   | 列出可用模型与 effort                                                               |

`mica exec` 直接接收 codex-family driver 逐字发出的参数：`--cd`、`--enable`、`--skip-git-repo-check`、`--dangerously-bypass-approvals-and-sandbox`、`-c model_reasoning_effort=<…>`、`--` 与收尾裸 prompt。细节见 [docs/headless-design.md](./docs/headless-design.md)、[Headless 协议](https://qirong77.github.io/mica-code/docs/headless)。

## 文档

| 文档                                                                  | 内容                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [docs/README.md](./docs/README.md)                                    | 文档索引：设计文档、开发博客、官网文档的入口                        |
| [docs/headless-design.md](./docs/headless-design.md)                  | Headless 执行层内部设计：turn 循环、队列、重试、事件投影            |
| [docs/multica-runtime.md](./docs/multica-runtime.md)                  | 如何把 Mica 接进 Multica / Codex 系 driver                          |
| [blogs/](./blogs/README.md)                                           | 从 0 到 1 的开发记录：上下文压缩、skills、MCP→Skill、记忆生命周期等 |
| [官网文档](https://qirong77.github.io/mica-code/docs/getting-started) | 快速开始、内置命令、Headless、架构                                  |

## 开发

```bash
bun install
bun run dev              # 交互 TUI
bun run typecheck
bun run test -- packages/mica-runtime   # Vitest
bun run build            # typecheck → 单二进制 → 安装本地入口
bun run dev:app          # 桌面端（Electron + Vite）
```

`apps/` 放应用（`cli`、`desktop`、`config-web`、`website`），`packages/` 放可复用能力（`mica-agent`、`mica-runtime`、`mica-tools`、`mica-ui`、`mica-session`、`mica-config` …），包之间靠 `@packages/<name>` 引用，不反向依赖 `apps/*`。架构约束与维护约定见 [AGENT.md](./AGENT.md)。

---

项目仍处在快速迭代阶段，接口与配置字段可能变化；有问题请开 issue。
