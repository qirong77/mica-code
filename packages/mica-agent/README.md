# mica-agent

`mica-agent` 是 Mica Code 的 agent provider 与 prompt 入口包。它封装模型客户端、通用 agent 抽象、系统提示词构建，以及 agent 运行日志 UI item 的创建方法。

## 主要能力

- 提供 `BaseAgent`、`IAgent`、conversation message 等公共 agent 类型。
- 提供 OpenAI-compatible provider：`OpenAIClient`、`createOpenAIClient`。
- 提供 Anthropic provider：`AnthropicAgent`。
- 提供子 agent 创建入口：`createSubAgent`。
- 构建运行时系统提示词：`buildSystemPrompt`。
- 创建 thinking、tool call、tool result、error 等 agent turn log item。

## 使用入口

```ts
import { micaAgent } from '../packages/mica-agent/index.js';

const agent = micaAgent.createOpenAI({
  model: 'gpt-4.1',
  apiKey: process.env.OPENAI_API_KEY,
});
```

## 设计约束

- 本包不依赖 UI、session、commands 等应用层模块。
- provider adapter 只负责模型协议适配，不感知多 agent 协作或命令系统。
- prompt 构建集中放在 `prompt/`，避免散落在运行时流程中。
- UI item 工厂只创建可展示数据，不持有终端 UI 状态。

## 目录说明

- `core/`：agent 抽象类型、基类和对话消息类型。
- `providers/`：具体模型 provider adapter 和历史消息归一化。
- `prompt/`：系统 prompt 构建、系统提示词模板和测试。
- `ui/`：agent turn log UI item 工厂。
- `examples/`：provider 使用示例。
