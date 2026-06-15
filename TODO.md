# TODO

## 接入 Vercel AI SDK 优化 provider 体系

### 背景
当前 `src/agent/client.ts` 直接使用 `@anthropic-ai/sdk`，供应商受限于 Anthropic Messages API 格式，只能支持 DeepSeek、Kimi、OpenRouter 等提供了 `/anthropic` 兼容端点的厂商（共约 5 个）。

### 目标
用 `ai` (Vercel AI SDK) 替换原生 Anthropic SDK，统一抽象层，扩展供应商支持到 20+。

### 改动范围

- **`src/agent/client.ts`**: 将 `new Anthropic({ apiKey, baseURL })` 替换为 `createAnthropic({ apiKey, baseURL })` 等 provider 工厂
- **`src/store/providerConfig.ts`**: `ProviderConfig` 需加 `npm` / `type` 字段区分 provider adapter（如 `@ai-sdk/anthropic`、`@ai-sdk/openai`、`@ai-sdk/google` 等）
- **`src/agent/turn.ts`**: 消息格式和 tool calling 需改为 AI SDK 的 `generateText` / `streamText` 接口
- **依赖**: 新增 `ai`、`@ai-sdk/anthropic`、`@ai-sdk/openai` 等

### 参考
- opencode-dev 的 `packages/opencode/src/provider/provider.ts` — provider 管理和 model 加载
- opencode-dev 的 `packages/opencode/src/session/llm/ai-sdk.ts` — AI SDK 调用封装

## codegraph 自动建索引

### 背景
当前 codegraph MCP server 只挂载在 `mica-code` 一个项目上。Agent 探索其他项目时需要通过 `projectPath` 参数，但该项目必须已由用户手动运行 `codegraph init` 创建 `.codegraph/` 目录，否则 `ToolHandler.getCodeGraph()` 抛出 `NotIndexedError`，agent 只能回退到内置工具。

### 目标
让 agent 能够自动为未索引项目创建 codegraph 索引，避免用户手动 init。

### 可行方案

1. **方案 A — ToolHandler 自动 init**：`getCodeGraph()` 找不到 `.codegraph/` 时调用 `CodeGraph.init()` + `indexAll()`。首次调用会很慢（大项目几分钟），可能超时。
2. **方案 B — 暴露 `codegraph_init` MCP 工具**：新增 tool 让 agent 显式初始化。配合 system prompt 引导 agent 在遇到 `NotIndexedError` 时调用。
3. **方案 C — System prompt 指令**：在 AGENTS.md 中加指令，告诉 agent 用 `run_shell` 调用 codegraph CLI init。

### 推荐
方案 B + C 组合：先加 system prompt 提示，再暴露 `codegraph_init` tool。

### 改动范围
- `codegraph/src/mcp/tools.ts` — 新增 `codegraph_init` 工具定义和处理逻辑
- `src/prompts/system.md` 或 `AGENTS.md` — 加入 codegraph 使用指引

## 大文件
使用 write 工具的时候，遇到 maxtoken的问题无法输出
## 启动校验