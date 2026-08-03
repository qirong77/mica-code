# krill-ai 使用统计对账笔记（mica-code-app Stats ↔ krill 平台）

> 用途：对账 mica-code-app Stats 侧栏显示的使用统计 与 krill-ai 平台（request-logs）记录的真实用量。
> 首次对账日期：2026-08-03。下次对账请改用全新模型 `gpt-5.5`，方法不变。

## 结论（2026-08-03 对账，平台 1350 条 / 本地 840 条，1:1 匹配 798 条）

两边对不上是「口径不同 + 覆盖范围不同」，平台计费口径本身无误：

1. **「输入」口径不同（最大的数字误解源）**
   - mica 记录的 `inputTokens = prompt_tokens`，**包含缓存**（`packages/mica-agent/providers/ChatCompletionsClient.ts` 与 `ResponsesClient.ts` 的 `recordUsage`），缓存单列 `cachedInputTokens`。
   - krill 平台的 `input_tokens` 是**未缓存**部分，缓存单列 `cache_read_input_tokens`。
   - 所以同一批请求：mica 输入 ≈ 平台 input_tokens + cache_read，直接对比会差 10~30 倍。
   - 1:1 四元组匹配（model + 未缓存输入 + 缓存 + 输出）证明两边 token 数值本身一致。

2. **compact 会清空 usageHistory（已修复 ✅）**
   - 旧行为：`/compact`（`src/plugins/commands/commandRuntimeServices.ts`）和 headless `mica compact`（`src/cli/runCompact.ts`）应用 checkpoint 时写 `usageHistory: []`、`lastUsage: undefined`，compact 之前的 token 统计全部丢失。
   - 数据实证：5 个带 `[Mica compact boundary]` 的 session，usage 起点全部在 compact 之后；平台在 compact 前照常计费。例：session `20260803T044511Z-isg6gk` 04:45 创建、07:17 compact，本地 usage 从 07:21 才开始，04:45–07:17 的 ~40 条 sol 请求只在平台有。
   - 修复：两处都改为 `usageHistory: snapshot.usageHistory`、`lastUsage: snapshot.lastUsage`，统计跨 compact 连续。**修复只对之后的 compact 生效**，已丢失的历史无法找回。

3. **非 mica 流量混入 krill 账号**
   - 平台有、本地完全无：`gpt-5.6-luna`（273 条）、`grok-4.5`（32 条）——本地 usageHistory 零记录；06:43–06:55 的 35 条 sol 也无本地 session 归属。这些是 krill 账号下其他入口（网页端/其他设备/其他工具）的请求，mica 永远不会记录。
   - 平台日志没有 user_agent / 客户端字段，无法溯源；如怀疑共用，检查 krill API key 是否外泄。

4. **本地有、平台无：没走 krill**
   - `glm-5.2`（27 条）、`deepseek-v4-flash`（15 条）rawUsage 无缓存字段，平台当天也没有这两个模型——走的是其他 api_base/provider。

5. **边界请求**
   - 平台 10 条 status=201（created，未正常收尾）本地不记录（流中断时客户端拿不到 usage）。

## curl：拉取平台全量请求日志

token 从 krill 网页 `app/logs` 的 Network 请求头复制（`authorization: Bearer <TOKEN>`）。

```bash
TOKEN='<你的 krill JWT>'
# 当天全量：page_size=100，一直翻到返回不足 100 条
for p in $(seq 1 20); do
  curl -s 'https://www.krill-ai.net/api/request-logs' \
    -H 'accept: application/json, text/plain, */*' \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -b "krill_jwt=$TOKEN" \
    -H 'origin: https://www.krill-ai.net' \
    -H 'referer: https://www.krill-ai.net/app/logs' \
    -H 'x-language: zh' \
    --data-raw "{\"page\":$p,\"page_size\":100,\"start_time\":\"2026-08-03T00:00\",\"end_time\":\"2026-08-03T23:59:59\",\"model\":null,\"token_id\":null,\"user_email\":null,\"charge_type\":null}" \
    > /tmp/krill_page_$p.json
  n=$(python3 -c "import json;print(len(json.load(open('/tmp/krill_page_$p.json'))['data']['items']))")
  echo "page $p: $n"; [ "$n" -lt 100 ] && break
done
```

关键字段（每条请求）：

| 字段 | 含义 |
|---|---|
| `input_tokens` | 未缓存输入 token（计费按此） |
| `cache_read_input_tokens` | 缓存命中输入 token |
| `output_tokens` | 输出 token |
| `reasoning_tokens` | 推理 token（已含在 output 中？对账时注意不要重复加） |
| `cost_usd` / `plan_cost_usd` | 费用（$） |
| `status` | 200=正常，201=created（未正常收尾），502=错误 |
| `model` / `request_time`（UTC） | 模型 / 请求时间 |

## 对账方法（脚本化）

1. 平台侧：聚合所有页，按 model 汇总 `n / uncached_in / cache / out / cost`。
2. 本地侧：扫 `~/.mica/sessions/*.json`，取 `snapshot.usageHistory` + `snapshot.subagentUsageHistory[].requests`，按 `occurredAt` 日期过滤，按 model 汇总。
   - 本地 `inputTokens` 含缓存 → 对账用 `inputTokens - cachedInputTokens` 对齐平台 `input_tokens`。
3. 1:1 匹配：`(model, uncached, cache, out)` 四元组计数匹配；再按时间（±45s）做宽松匹配定位缺口。
4. 已匹配 = 口径一致；平台独有 = compact 前丢失（已修复，仅影响旧数据）/ 其他客户端流量 / status=201；本地独有 = 非 krill 流量。

## gpt-5.5 对账检查点

- 全部新对话只用一个模型 `gpt-5.5`，平台和本地都应只有这一种模型（除 subagent）。
- 检查项：
  1. 请求数：平台 vs 本地（main + subagent）。
  2. token：本地 `inputTokens - cachedInputTokens` ≈ 平台 `input_tokens`；`cachedInputTokens` ≈ `cache_read_input_tokens`；`outputTokens` ≈ `output_tokens`。
  3. 若有 compact：确认 compact 前后统计连续（本次修复后 compact 不再清零）。
  4. 平台独有请求：确认 status=200 的缺口数量与 compact/中断/其他客户端匹配；status=201/502 不记。
  5. 费用：`cost_usd` 合计应只由平台给出（mica 不记金额）。
