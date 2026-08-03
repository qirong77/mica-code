# <img src="./images/mica.svg" alt="Mica" width="40" height="40" align="absmiddle"> Mica Code

> **MICA — Minimal, Intelligent, Cache-first Agent.**
>
> 一个轻量、终端原生、擅长复用上下文的 AI coding agent。

![Mica Code 使用过程截图](./images/iShot_2026-07-14_17.04.46.png)

## 核心优势

- ⚡ **前缀稳定，缓存优先**：会话默认 append-only，尽量锁住 system / history 前缀，长对话仍可维持 96%+ 缓存命中
- ⌨️ **终端原生，不离开 shell**：Ink TUI，信息密度高、键盘优先；多 agent、后台任务、状态一眼可见
- 📎 **文件引用更快**：输入 `@` 即可搜索当前工作区文件，方向键选择后用 Enter 或 Tab 插入
- 🎭 **Role 即工作流**：`/role` 整段替换 system prompt，写码、审查、规划各用一套人格
- 🧩 **工具可拼装**：文件 / 搜索 / shell / 网页 / skills 开箱即用，MCP 接个人脚本与团队服务
- ⏪ **可回退、可压缩**：`/rewind` 可回到所选历史对话节点；有文件检查点时也可恢复文件，`/compact` 在上下文吃紧时收束历史

## 快速开始

### 从 GitHub Release 安装

```bash
curl -fsSL https://github.com/qirong77/mica-code/releases/latest/download/install.sh | sh
mica
```

## 配置模型

首次运行会创建本地配置文件：`~/.mica/config.json`。可以运行 /config 打开配置页面。典型 provider 配置：

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
      "id": "Kimi",
      "name": "Kimi",
      "protocol": "openai_chat_completions",
      "api_base": "https://api.moonshot.cn/v1",
      "models": ["kimi-k2.7", "kimi-k2.7"],
      "api_key": ""
    }
  ],
  "mcpServers": {
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    }
  }
}
```

`protocol` 可选：`openai_chat_completions` 或 `openai_responses`；

provider 配置了 `get_model_url`，模型列表会按 OpenAI `/models` 响应格式在运行时获取；

没有动态模型接口时，可以直接配置静态 `models` 数组。

## Headless JSON 协议

Mica 可以通过 OpenCode/DevEco 兼容的 NDJSON 协议被桌面应用或自动化工具调用：

```bash
mica run --format json [--thinking] [--no-save] [--session <id>] [--dir <cwd>] [--mcp-init-timeout-ms <ms>] "<prompt>"
```

默认输出 `step_start`、`text`、`tool_use`、`error` 和 `step_finish` 事件。每次工具调用先发送 `state.status: "pending"`，完成后以相同 `callID` 发送 `completed` 与结果，消费端可原位更新运行状态；headless 模式也注册 `TodoWrite`，便于结构化展示运行计划。显式传入 `--thinking` 时还会输出 `{ type: "reasoning", part: { type: "reasoning", text } }`，不传时保持精简输出并兼容现有消费者。`--mcp-init-timeout-ms` 可为每个 MCP server 的 connect + tools/list 设置总截止时间，健康 server 仍会并行完成并注册工具。Responses 协议在启用 reasoning effort 时会请求 `summary: "auto"`，让支持该能力的模型产生可流式展示的思考摘要。

对已有会话做上下文压缩（Web Chat / 自动化脚本用）：

```bash
mica compact --session <id> [--dir <cwd>] [--force]
```

`mica compact` 复用交互式 `/compact` 的 `CompactionService`（模型摘要 + 最近轮次保留），完成后把压缩后的 checkpoint 写回会话文件并输出一行 JSON（`ok`、`mode`、`strategy`、before/after token 估计与 `savedRatio`）；会话内容较少时返回 `code: "not_needed"`。`--force` 强制即使历史较短也生成摘要。

## 远程会话同步（Mica Sync）

`mica daemon` 常驻进程可以把本机所有会话（活跃的 + 历史的）实时镜像到一台中心服务器，然后在浏览器里查看并远程续聊：

```bash
# 1. 在中心服务器部署 mica-sync-server（见 packages/mica-sync-server/README.md）
# 2. 在每台需要接入的机器上启动 daemon（首次运行自动注册）
mica daemon --server http://<server>:5560   # --name 可选，默认用机器 hostname
```

之后打开 `http://<server>:5560/`（或 Nginx 反代路径）即可看到所有机器的会话；点击会话可以实时查看运行进度，也可以直接继续对话（任务回源到对应机器执行，`Agent` 的本地文件、shell、MCP 能力都保留在本机）。注意 Mica Sync 默认无认证，公网部署时建议自行加一层访问保护。

常用命令：`pm2 start node --name mica-sync -- mica-sync-server.mjs --port 5560 --data-dir ... --web-dir ...`（详见 `packages/mica-sync-server/README.md`）。
