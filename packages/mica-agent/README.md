# mica-agent

`mica-agent` 是 Mica Code 的 agent provider 与 prompt 入口包。它封装模型客户端、通用 agent 抽象、系统提示词构建，以及 agent 运行日志 UI item 的创建方法。

## 主要能力

- 提供 `BaseAgent` 与 `IAgent` 等公共 agent 类型。
- 提供 OpenAI-compatible provider：`OpenAIClient`、`createOpenAIClient`。
- 提供 Anthropic provider：`AnthropicAgent`。
- 提供子 agent 创建入口：`createSubAgent`。
- 构建运行时系统提示词：`buildSystemPrompt`。
- 创建 thinking、tool call、error 等 agent turn log item。

## 使用入口

```ts
import { micaAgent } from '../packages/mica-agent/index.js';

const agent = micaAgent.createOpenAI({
  model: 'gpt-4.1',
  apiKey: process.env.OPENAI_API_KEY,
});
```

## 目录说明

- `core/`：agent 抽象类型与基类。
- `providers/`：具体模型 provider adapter。
- `prompt/`：系统 prompt 构建与测试。
- `ui/`：agent turn log UI item 工厂。
