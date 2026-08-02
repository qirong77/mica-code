# mica-agent

`mica-agent` 是 Mica Code 的 agent provider 与 prompt 入口包。它封装模型客户端、通用 agent 抽象和系统提示词构建。

## 主要能力

- 提供 `BaseAgent`、`IAgent`、conversation message 等公共 agent 类型。
- 提供 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 三类协议 client。
- 提供子 agent 创建入口：`createSubAgent`。
- 提供 usage 汇总与 subagent usage 记录类型：`summarizeUsageHistory`、`SubagentUsageRecord`。
- 提供按 `provider.protocol` 分流的模型 client 创建入口：`createModelClient`。
- 构建运行时系统提示词：`buildSystemPrompt`。
- 从 `~/.mica/role`（或 `$MICA_HOME/role`）加载 `.md` 用户 role，以文件名（不含扩展名）作为 role 名，并保留不可覆盖的内置 `default`。

## 使用入口

```ts
import { micaAgent } from '../packages/mica-agent/index.js';

const provider = {
  id: 'openai',
  api_base: 'https://api.openai.com/v1',
  api_key: 'sk-...',
  protocol: 'openai_responses',
} as const;

const agent = micaAgent.createModelClient({
  model: 'gpt-4.1',
  apiKey: provider.api_key,
  baseURL: provider.api_base,
  provider,
});
```

## 设计约束

- 本包不依赖 UI、session、commands 等应用层模块。
- provider adapter 只负责模型协议适配，不感知多 agent 协作或命令系统。
- prompt 构建集中放在 `prompt/`，避免散落在运行时流程中。
- role 只替换 prompt 的 `<system>` 段；project instructions、skills 索引和环境 context 仍由 prompt builder 注入。
- UI/Ink 相关的日志 item 工厂放在 `packages/mica-ui`，本包只暴露 provider 与 agent 类型。

## 目录说明

- `core/`：agent 抽象类型、基类和对话消息类型。
- `providers/`：具体模型 provider adapter。
- `prompt/`：系统 prompt 构建、role 文件加载、系统提示词模板和测试。
- `ui/`：UI 提示相关展示与样式相关。
- `index.ts`：公共 API 聚合导出。
- `assets.d.ts`：静态资源类型声明。
