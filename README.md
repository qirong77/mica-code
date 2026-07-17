# <img src="./images/mica.svg" alt="Mica" width="40" height="40" align="absmiddle"> Mica Code

> **MICA — Minimal, Intelligent, Cache-first Agent.**
>
> 一个轻量、终端原生、擅长复用上下文的 AI coding agent。

![Mica Code 使用过程截图](./images/iShot_2026-07-14_17.04.46.png)

## 核心优势

- **Cache-first**：会话历史默认追加演进，尽量保持请求前缀稳定，缓存命中率 95% 以上。

- **扩展友好**：内置文件、搜索、shell、网页、skills 等工具，也能通过 MCP 接入团队或个人工具。

## 快速开始

### 从 GitHub Release 安装

产品名是 **Mica Code**（`mica-code`），启动命令是 `mica`。

`install.sh` 只下载当前平台压缩包（约 25MB），并校验 SHA256：

```bash
curl -fsSL https://github.com/qirong77/mica-code/releases/latest/download/install.sh | sh
mica
```

指定版本：

```bash
curl -fsSL https://github.com/qirong77/mica-code/releases/download/v0.1.0/install.sh | sh -s -- v0.1.0
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
