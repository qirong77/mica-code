# Models.dev model rule sync

这个目录用于从 [Models.dev](https://models.dev) 获取主流大模型元数据，并保守地同步 `packages/mica-config/model-rules.json`。

## Models.dev

[Models.dev](https://github.com/anomalyco/models.dev) 是一个 MIT License 的开源 AI 模型数据库，也是 OpenCode 使用的模型元数据来源之一。数据以 TOML 文件维护在公开仓库中，再生成网页、JSON API 和客户端快照。它是社区维护的数据源，适合自动发现和交叉检查，但模型厂商的官方文档仍应作为冲突时的最终依据。

本同步器使用两个无需 API Key 的公开接口：

- [`https://models.dev/models.json`](https://models.dev/models.json)：与具体接入渠道无关的 canonical 模型信息，包括模型 ID、上下文窗口、最大输入/输出、模态、工具调用和发布日期等。
- [`https://models.dev/api.json`](https://models.dev/api.json)：按 provider 划分的模型配置。除了价格和 endpoint 限制，还包含 `reasoning_options`。例如 effort 模型可能提供 `none`、`low`、`medium`、`high`、`xhigh`、`max` 等值。

`models.json` 不包含 `reasoning_options`，因为 reasoning 参数可能随 provider 或 endpoint 而变化。因此脚本以 `models.json` 提供 canonical 规格，并用 `api.json` 补充 provider 级配置。对于 OpenCode Zen 中的模型，优先采用 `api.json` 的 `opencode` endpoint 限制，因为免费或代理 endpoint 的上下文窗口可能小于底层 canonical 模型。

## 使用方式

从仓库根目录运行：

```bash
bun run update:model-rules:models-dev
```

只查看远端数据会带来哪些变化，不写文件：

```bash
bun run update:model-rules:models-dev --dry-run
```

检查规则是否与远端数据一致，存在差异时以退出码 `1` 结束，适合 CI：

```bash
bun run update:model-rules:models-dev --check
```

也可以直接运行脚本：

```bash
bun packages/mica-config/models-dev/update-model-rules.mjs
```

## 同步策略

脚本只修改现有规则，不自动添加或删除 `modelKeysIncludes`：

1. 对每个 model key 做大小写不敏感的精确匹配，不用模糊包含匹配猜测模型。
2. 更新 `contextSize`。一条现有规则中的模型窗口不同时，按配置自动拆成多条规则，避免用一个近似值覆盖不同模型。
3. 从 `api.json` 读取 `reasoning_options`，根据每个精确模型支持的 effort 值更新 `effortMap`；配置不同的模型同样会拆成独立规则。
4. 保留已有的映射语义，例如把 Mica 的 `xhigh` 映射为 provider 的 `max`，不会强制改成同名档位。
5. `reasoning_options` 缺失、只有 `toggle`/`budget_tokens`、不同模型配置不一致，或者规则已设置 `enableEffort: false` 时，不自动修改 effort 配置。
6. 拆分后的规则按具体模型键优先排列；运行时也始终选择最长的匹配键，防止 `gpt-5` 一类宽泛键抢先匹配 `gpt-5-codex`。
7. 输出文件会使用仓库的 Prettier 配置格式化。

这种策略刻意偏保守。Models.dev 的 canonical ID、provider ID 和 Mica 使用的模型别名不总是一致，脚本会报告无法匹配的键，由维护者结合官方资料处理。

## 主要字段

Models.dev 常用字段如下：

| 字段                | 含义                                              |
| ------------------- | ------------------------------------------------- |
| `id`                | 模型或 provider endpoint ID                       |
| `limit.context`     | 总上下文窗口 token 数                             |
| `limit.input`       | 最大输入 token 数                                 |
| `limit.output`      | 最大输出 token 数                                 |
| `reasoning_options` | provider 支持的 reasoning 控制方式和 effort 值    |
| `modalities.input`  | 支持的输入模态，如 text、image、audio、video、pdf |
| `modalities.output` | 支持的输出模态                                    |
| `tool_call`         | 是否支持工具调用                                  |
| `structured_output` | 是否支持结构化输出                                |
| `temperature`       | 是否支持 temperature 参数                         |
| `cost`              | 每百万 token 的输入、输出和缓存价格               |
| `release_date`      | 首次公开发布日期                                  |
| `last_updated`      | 元数据最近更新时间                                |

接口响应结构和字段可能随 Models.dev 演进。脚本会验证顶层结构、记录结构、关键 provider 和数据量下限；同步失败时不会写入部分结果。最终结果通过同目录临时文件原子替换，尽量保证已有 `model-rules.json` 不会因中途失败而被截断。
