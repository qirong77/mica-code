# mica-context

`mica-context` 是 Mica Code 的上下文管理能力包。当前主要提供会话压缩能力，用于把较长的对话历史整理成可继续推理的 checkpoint。

## 主要能力

- 提供 `CompactionService`，封装上下文压缩流程。
- `toolResultsOnly` 快速压缩：把压缩区里的全部工具调用与结果聚合成「一条调用 + 一条结果」的占位消息（`call_id` 固定为 `mica_compact`、参数 `{}`，说明文本列出每种工具的调用次数，形如 `[Mica compact] Placeholder for 42 collapsed tool calls (not a real result): read_file × 18, bash × 12, …`），丢弃这一区的思考（Responses `reasoning` 条目、Chat `reasoning_content`），并把媒体块替换为占位符（`[image omitted during compact]`，只认能识别的块类型）。用户与助手正文原样保留、顺序不变；不生成 checkpoint、不丢轮次、不调用模型（可重复执行——重复压缩把新计数并入同一条说明，id 与文本保持稳定；没有可清理内容时报 not needed）。
- 将长对话整理为摘要消息，降低后续 prompt 的上下文压力。
- 先裁剪媒体、base64 和旧工具结果，再按上下文预算决定 prune-only 或 summary + recent checkpoint。
- 保留完整 recent round，并避免把 tool call / tool result 切成不合法的 provider 历史。
- 不截断 tool-call `arguments` 为自由文本；过长或损坏的参数会改写成合法 JSON 占位，防止后续请求 400。
- 为后续 token budget、自动 compact、memory 注入等能力预留边界。

## 使用入口

```ts
import { micaContext } from '@packages/mica-context/index.js';

const service = new micaContext.CompactionService(options);
```

## 设计约束

- 本包只处理上下文相关算法和服务，不直接依赖终端 UI。
- 不修改 provider adapter；压缩结果应通过 runtime/session 层接入对话。
- 什么时候压缩由调用方决定：运行时在手动入口（`/compact`、`mica compact`）触发，`session-compact` 插件在会话右键菜单里经 `ctx.agent.compactIdleHistory` 触发。手动模型压缩用 `summaryInput: 'dialogue'`：摘要请求只带用户与助手的对话，工具调用、工具结果与思考都不进摘要输入。
- token 估算（`tokenEstimate.ts`）只覆盖消息：文本按字节折算（ASCII 约 4 字符/token，CJK 约 1.5 token/字），**图片块按张计价**（`input_image` / `image_url` 走像素口径，几百到几千），工具输出里以 `data:` 开头的文本仍按文本算——provider 也是这么计费的。真实请求还带系统提示词与工具定义，那部分由调用方补：`resolveRequestOverhead()` 在确定性估算（`AgentRuntime.estimateRequestOverheadTokens`）与上次真实请求的差额之间取其一，差额超过确定性估算两倍时视为估算对正文的偏差、不予采信。

## 目录说明

- `CompactionService.ts`：上下文压缩服务。
- `CompactionService.test.ts`：上下文压缩服务测试。
- `tokenEstimate.ts`：本地 token 估算（压缩阈值、notice 与 ctx 徽标共用）。
- `index.ts`：公共 API 聚合导出。
