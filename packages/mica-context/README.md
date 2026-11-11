# mica-context

`mica-context` 是 Mica Code 的上下文管理能力包，用于把较长的对话历史整理成可继续推理的 checkpoint。输入与输出统一使用 `@earendil-works/pi-ai` 的 `Message[]`，不处理 provider 原生历史。

## 主要能力

- `CompactionService` 封装快速清理、轻量裁剪与模型摘要流程。
- `toolResultsOnly` 快速压缩：把压缩区里的全部 `toolCall` 块与 `toolResult` 消息聚合成「一条 assistant 调用 + 一条结果」的占位消息。`id` / `toolCallId` 固定为 `mica_compact`、参数为 `{}`，说明文本列出工具名与次数，并注明不是真实结果，需要时重新读取或运行。丢弃压缩区的 `thinking` 块，并把图片替换为 `[image omitted during compact]`；用户与助手正文原样保留、顺序不变。不生成 checkpoint、不丢轮次、不调用模型。重复压缩将新增计数并入同一条说明；没有可清理内容时抛出 `CompactionNotNeededError`。
- 轻量裁剪先清理图片、base64、旧工具结果与参数，再按上下文预算决定 prune-only 或 summary + recent checkpoint。需要裁剪工具参数时使用对象占位，保持 pi `toolCall.arguments` 的结构。
- 改写 assistant 时清除 `responseId` 与块上的 `textSignature` / `thinkingSignature` / `thoughtSignature`，保留 provider、model、timestamp 与 usage 元信息。受保护消息连同签名原样保留。
- `pruneOnly` 不调用摘要模型；没有值得清理的载荷时，可以按完整用户轮次丢弃最早历史。

## 使用入口

```ts
import { micaContext } from '@packages/mica-context/index.js';

const service = new micaContext.CompactionService();
const result = await service.compact({
  messages, // pi Message[]
  options: {
    toolResultsOnly: true,
    preserveRecentMessages: 8,
    preserveLatestUserMessage: true,
  },
});
// result.messages 仍是 pi Message[]，由调用方写回 runtime/session。
```

模型压缩使用 `summarize(transcript, prompt)` 回调返回摘要文本。服务输出带 timestamp 的 pi user boundary / checkpoint 消息，再拼接保留的最近消息。`summaryInput: 'full'` 默认包含工具过程与思考；`summaryInput: 'dialogue'` 只提供用户、助手正文和已有 checkpoint，适用于手动模型压缩。摘要请求过长时按轮次缩减输入并重试，取消或失败不修改输入。

## 设计约束

- 本包只处理上下文相关算法和服务，不依赖终端 UI，不修改 provider adapter。何时触发压缩、摘要由谁生成、结果如何落盘，由 runtime/session 与插件调用方决定。
- `preserveRecentMessages` 与 `preserveRecentRounds` 保留最近消息或用户轮次，边界会向前扩展到完整工具批次，避免并行调用与结果被拆开。`preserveLatestUserMessage` 原样保护最新请求（含图片），允许单轮长工具循环只摘要较早批次。保护优先于目标 token 预算，因此结果可能仍超出目标。
- `preview` 返回原始历史的副本，并提供预估压缩统计。
- token 估算只覆盖传入的 pi 消息：文本按字符类别的实测比例折算（普通 ASCII 约 0.255 token/字符、CJK 约 0.65），工具名与结构化参数参与估算，system 消息按 pi 文本与 sections 渲染并计入声明的工具变更，每条消息加约 2 token。图片按张粗估约 1000–1760 token；工具输出里写成文本的 base64 仍按文本算。
- thinking、签名、usage、provider/model、时间戳与工具 details 不参与这份本地预算；实际计费以 provider usage 为准。
- 请求中额外的系统提示词与工具定义由调用方补齐，避免与传入的 system 消息重复计算。`resolveRequestOverhead()` 在确定性估算与上次真实请求的差额之间取其一，差额超过确定性估算两倍时视为正文估算偏差、不予采信。

## 目录说明

- `CompactionService.ts`：上下文压缩服务与摘要 transcript 生成。
- `CompactionService.test.ts`：消息结构、摘要、裁剪、快速压缩幂等与签名清理测试。
- `CompactionProtection.test.ts`：最近轮次、完整工具批次与最新用户请求保护测试。
- `CompactionCancellation.test.ts`：压缩取消与重试中止测试。
- `tokenEstimate.ts` / `tokenEstimate.test.ts`：本地 token 估算与验证。
- `loopMemoryProfile.test.ts`：循环 prune-only 的历史大小与 usage 保留验证。
- `testFixtures.ts`：统一 pi 消息测试工厂。
- `index.ts`：公共 API 聚合导出。
