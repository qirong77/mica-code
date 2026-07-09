---
name: update-model-rules
description: 更新 packages/mica-config/model-rules.json，从 OpenCode Zen 最新模型列表同步模型，并通过搜索查证 contextSize 和 effortMap
when_to_use: 用户要求更新、同步、刷新或维护 Mica 的 model-rules.json、模型 effort/context 规则、OpenCode Zen 模型列表时使用
argument-hint: 可选说明需要特别关注的新模型、上下文窗口或 effort 映射
---

# Update Model Rules

## 目标

把 `packages/mica-config/model-rules.json` 更新到 OpenCode Zen 当前模型列表对应的规则版本，并保持 Mica 现有 effort/context 行为尽量稳定。

优先使用脚本：

```bash
bun run update:model-rules
```

脚本只请求：

```text
https://opencode.ai/zen/v1/models/
```

并更新 `packages/mica-config/model-rules.json`。脚本只同步最新可用模型 ID，保留已有已验证规则；新增或未确认模型会进入 `Unverified OpenCode Models`，默认 `contextSize: 256` 且 `enableEffort: false`。

## 数据源

主数据源是 OpenAI-compatible models endpoint：

```bash
curl -L https://opencode.ai/zen/v1/models/
```

接口返回结构通常是：

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-5.5",
      "object": "model",
      "created": 1783566182,
      "owned_by": "opencode"
    }
  ]
}
```

## 更新规则

1. 运行 `bun run update:model-rules`。
2. 查看 `Unverified OpenCode Models` 是否包含新增模型。
3. 对新增模型调用搜索工具查证上下文窗口、reasoning/effort 支持和参数取值。优先查官方文档、provider 文档、OpenRouter/AI SDK 等可信资料。
4. 根据查证结果把模型移动到已有规则或新增规则，并设置 `contextSize`、`enableEffort` 或 `effortMap`。
5. 保持规则顺序从具体到宽泛，避免宽泛 family 规则提前吞掉更具体模型。
6. 不要手动把 `modelKeysIncludes` 写成过宽片段，除非确认不会误伤其他模型。

## 搜索查证要求

- 模型 ID 只来自 `https://opencode.ai/zen/v1/models/`。
- `contextSize` 必须通过搜索或官方资料查证；无法查证时保留 `256`，并放在 `Unverified OpenCode Models`。
- `effortMap` 必须通过搜索或官方资料查证 reasoning effort 档位和实际 API 参数值；无法查证时使用 `enableEffort: false`。
- 对同一 family 的新模型，如果已有规则可覆盖，仍要确认上下文窗口和 effort 档位没有变化。
- 在最终回复里简要说明查到的来源和仍未确认的模型。

## 校验

更新后至少运行：

```bash
bunx prettier --write scripts/update-model-rules.mjs packages/mica-config/model-rules.json skills/update-model-rules/SKILL.md package.json
bunx tsc --noEmit
bunx vitest run packages/mica-config/config.test.ts
```

如果规则影响了测试期望，优先判断是模型规则真实变化，还是脚本分类误判；不要为了让测试通过而随意放宽 effort 映射。
