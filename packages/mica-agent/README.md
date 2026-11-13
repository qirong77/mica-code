# mica-agent

`mica-agent` 是 Mica Code 的 agent provider 与 prompt 入口包。它封装模型客户端、通用 agent 抽象和系统提示词构建。

## 主要能力

- 提供 `IAgent`、conversation message 等公共 agent 类型。
- `IAgent.getSnapshot({ includeConversation: false })` 只取 provider 状态，省去展示消息投影；默认仍包含 `conversationMessages`。保存和回滚热路径可按需关闭投影。
- `PiModelClient` 通过 `@earendil-works/pi-ai` 统一支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Google Generative AI；请求编码、SSE、思考重放、工具参数的增量 JSON 解析和多模态工具结果编码由 pi 处理。
- `ModelMessage` 是 pi-ai 的消息类型，所有协议使用同一种历史；`PiHistoryNormalizer` 投影成展示用的正文与工具记录。快照写 `messageFormat: 'pi-ai-v1'`。旧 OpenAI 原生历史不再直接加载，由 `evolution` 一次性迁移。
- `AgentCallbacks.onToolInput` 提供模型生成工具输入的 start/delta/end 事件；`onToolCall` / `onToolResult` 继续表示实际执行。思考显示按 pi 内容块有序提交 checkpoint，签名与加密数据保存在模型历史中。
- `AgentQueryOptions.onRequestStart` 在实际发起每轮请求前提供消息数量与本轮工具定义；包括首个失败请求，transport 重试另走 `onRetry`，观察回调抛错不影响请求。
- 提供子 agent 创建入口：`createSubAgent`。
- 提供 usage 汇总与 subagent usage 记录类型：`summarizeUsageHistory`、`SubagentUsageRecord`。
- `AgentUsageRecord` 可携带请求的 `providerId`、含重试的 `durationMs` 和最终尝试的 `firstTokenMs`；`responseWaitMs` 从原请求开始计至最终成功尝试首个非空正文或思考增量，包含 provider 内重试。生成速率用成对的 `generationOutputTokens` / `generationDurationMs`：前者为 API 输出量减去明确的推理用量与首 token，后者只量成功尝试首末非空**正文**增量（不混入思考摘要）。仅在至少 32 个非推理输出 tokens、两个正文增量、500ms 且无工具或其它输出时采样；推理明细缺失不假设为零，多个无法匹配的用量不关联计时。口径参考 [vLLM TPOT](https://github.com/vllm-project/vllm/blob/main/vllm/benchmarks/serve.py) 与 [NVIDIA GenAI-Perf per-user throughput](https://github.com/triton-inference-server/perf_analyzer/blob/main/genai-perf/README.md#metrics)；32 tokens / 500ms 是本项目防止短回答与集中分块放大误差的门槛，不是上游标准。API 非推理输出仍包含不可见格式 tokens，分块也不保证一块一个 token，所以仅为客户端正文流估算，不是服务端解码速度。旧时长没有新分子的形态不再支持，不能拿总输出量回填。`ModelTextRequest.providerId` 可传入实际服务商标识。
- 提供 subagent 用量记账原语：`buildSubagentUsageRecord`、`recordSubagentTaskUsage`（helper 子代理的请求记进 owner 的 `subagentUsageHistory`，支持 `fromIndex` 只记新增部分）。`origin` 标出这笔开销的来源——`delegation`（主对话经工具委派）、`plugin` + `pluginId`（插件自己的请求与它起的后台任务）、`helper`（内核后台助手）；统计页按它归到「主对话 / 委派 / 插件 / 内核后台」。
- 提供按 `provider.protocol` 分流的模型 client 创建入口：`createModelClient`。
- 构建运行时系统提示词：`buildSystemPrompt`。固定使用内置默认正文，非默认 Role 通过 `rolePrompt` 追加；`BuildSystemPromptOptions.baseSystemPrompt` 覆盖入口已移除，这个形态不再支持。
- 单独取 skills 索引正文：`formatSkillsIndex`（By The Way 的隔离子代理替换了系统提示词，索引必须与主流程同源）。
- 同一条消息内的工具调用按并行安全分组执行：只读工具与 `Agent` 调用并发，写/执行类工具串行，结果按原始顺序回填。
- `tools: false` 同时关闭工具声明与执行；模型意外返回工具调用时拒绝该响应，并保留已经报告的用量。
- 从 `~/.mica/role`（或 `$MICA_HOME/role`）加载 `.md` 用户 role，以文件名（不含扩展名）作为 role 名，并与插件角色统一追加到默认正文后。内置 `default` 正文只读、不可覆盖，Role 页面展示其正文。

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
- Pi 提供协议、签名和工具结果的转换；Mica 的共享循环保留权限过滤、只读并发、写入屏障、等待重叠、队列输入、压缩、展示回滚与用量归属。Pi SDK 的自动重试关闭，可见重试由 Mica 统一管理。
- 图片预算只处理 pi user / toolResult 的图片内容块，工具参数与签名按正文计入预算并原样保留。内部预算入口不再支持旧 Chat / Responses wire 消息形态。
- 不引用 pi 的完整 agent 应用；`pi-agent-core` 的执行模式不能表达 Mica 按工具输入判断的等待重叠与写入屏障，因此不额外叠加第二个执行循环。
- pi-ai 固定版本为 `1.5.2`，Node 运行时要求 `>=22.19.0`。真实 API 冒烟用显式开关 `MICA_PI_LIVE=1 MICA_PI_SOURCE_HOME=/path/to/.mica MICA_PI_PROVIDER=<id> bunx vitest run --project unit packages/mica-agent/providers/piLive.test.ts`；默认跳过，不读取真实凭据。每种选中协议最多三次模型请求，验证工具循环与序列化后重放。
- prompt 构建集中放在 `prompt/`，避免散落在运行时流程中。
- `<system>` 始终保留内置默认正文；磁盘与插件的非默认 role 都经 `rolePrompt` 追加成紧接其后的 `<role>` 段，两段同属 system prompt，`default` 不重复追加。`AgentRole` 不再包含 `append` 标志；project instructions、skills 索引和环境 context 仍由 prompt builder 注入。
- `prompt/index.ts` 的 `inspectSystemPrompt(options)` 同次返回 `{ prompt, sections }`；`BuildSystemPromptOptions.promptControls` 支持 role / project-instructions / skills / context 的开关与正文覆盖，固定 system 始终只读。`buildSystemPrompt()` 复用这份实现，无覆盖时输出不变。
- UI/Ink 相关的日志 item 工厂放在 `packages/mica-ui`，本包只暴露 provider 与 agent 类型。

## 目录说明

- `core/`：agent 抽象类型、基类和对话消息类型。
- `providers/`：具体模型 provider adapter。
- `prompt/`：系统 prompt 构建、role 文件加载、系统提示词模板和测试。
- `index.ts`：公共 API 聚合导出。
- `assets.d.ts`：静态资源类型声明。

系统提示词保留 `system`、可选的 `role`、`project-instructions`、`skills`、`context` 顶层边界；项目中的 `AGENT.md` / `AGENTS.md` 各自包装为带 `source` 的 `document`，文档正文作为 XML 文本转义。插件贡献由宿主的 `PluginPromptSections` 单独追加，不在本包中拼接插件业务规则。
