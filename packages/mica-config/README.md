# mica-config

`mica-config` 负责 Mica Code 的本地 provider 配置、本地状态数据读取、更新和 provider 模型列表加载。

配置文件默认位于：`~/.mica/config.json`。当配置文件不存在时，会基于 `default.json` 自动创建。
本地状态默认位于：`~/.mica/storage.json`，保存共享输入框历史、用户偏好和使用记录。模型和 effort 的运行态选择不写入本地状态。

默认的 `~/.mica` 目录名是构建期的品牌化值：由根 `mica.build.env` 的 `MICA_CONFIG_DIR_NAME` 经 `bun build --define` 注入，经 `brand.ts` 暴露为 `CONFIG_DIR_NAME`。`MICA_HOME` 环境变量显式设置时始终优先；路径解析统一走 `brand.ts` 的 `resolveMicaHome`/`resolveMicaHomePath`。

## 主要能力

- 读取磁盘配置：`micaConfig.read()`。
- 获取内存中的当前配置：`micaConfig.get()`。
- 更新配置并写回磁盘：`micaConfig.update(updater)`。
- 新建会话前调用 `await micaConfig.prepareSessionModelDefaults()`：重新读取磁盘默认值，等待 provider 作用域的模型规则后重算原始默认 effort；模型不可用时抛错。同步重置可使用 `micaConfig.resetSessionModelDefaults()`。
- 读取本地状态：`micaConfig.storage.read()`。
- 读取共享输入框历史：`micaConfig.inputHistory.read()`。
- 追加共享输入框历史：`micaConfig.inputHistory.append(text)`。
- 模型规则注册与解析：`micaConfig.ensureModelRule`、`registerModelRules`、`registerModelRuleResolver`。
- effort 档位与 wire 参数的唯一入口：`getModelEffortOptions` / `normalizeModelEffort` / `resolveEffortParams`。
- 档位与上下文跟着「谁在服务这个模型」走：`getModelRule` / `ensureModelRule` 接受 provider 作用域（`{ id, api_base }`），缓存键带上 provider。同一模型名在网关与厂商原生条目下的档位可以不同（OpenRouter 的 `moonshotai/kimi-k3` 多一个 `none`），只按模型名查会用错那一份；服务商在 models.dev 收录了该模型就以它为准（先认 `id`，再认 `api_base` 主机名），否则按模型厂商的条目。`micaConfig.providerForModel(model)` 解出归属。
- 读写新会话默认能力：`readCapabilityDefaults` / `updateCapabilityDefaults`，对应 `config.json` 的 `capabilityDefaults`，配置页 Capabilities 页签用它。

## 使用入口

```ts
import { micaConfig } from '../packages/mica-config/index.js';

const config = micaConfig.get();

micaConfig.update((current) => ({
  ...current,
  model: 'gpt-5.4',
}));
```

## 新会话默认模型

`providers[].protocol` 支持以下显式协议；OpenAI 配置名保持原样，原生协议同样由 `PiModelClient` 使用 pi-ai 发送：

| 配置值                    | 接口                    |
| ------------------------- | ----------------------- |
| `openai_chat_completions` | OpenAI Chat Completions |
| `openai_responses`        | OpenAI Responses        |
| `anthropic_messages`      | Anthropic Messages      |
| `google_generative_ai`    | Google Generative AI    |

`providerProtocol.ts` 是协议枚举、`ProviderProtocol` 和 `isProviderProtocol` 的纯模块入口，浏览器表单、启动校验和 helper/probe 共用它。

在 `config.json` 中配置 `defaultModel`，provider 和 model 必填，effort 可选：

```json
{
  "providers": [
    {
      "id": "openai",
      "api_base": "https://api.openai.com/v1",
      "api_key": "your-key",
      "protocol": "openai_responses",
      "models": ["gpt-5.4", "gpt-5.5"]
    }
  ],
  "defaultModel": { "provider": "openai", "model": "gpt-5.5", "effort": "high" }
}
```

- 配置了 `defaultModel` 就使用对应 provider/model；model 必须在该 provider 的 `models` 列表里。
- 未配置 `defaultModel` 时取 provider 列表第一项的第一个 model。
- effort 省略时使用该 provider 下模型规则的 `defaultEffort`；填写的档位必须符合档位名语法，不支持的档位按同一 provider 的模型规则收敛。`supportsEffort: false` 始终使用 `none`。
- 上次会话的选择不会改变新会话默认值。`await prepareSessionModelDefaults()` 在新会话入口调用，重新读取磁盘并在模型元数据就绪后重置 `provider`、`model`、`effort` 和 `contextWindowSize`；已有会话继续使用自己的模型状态。

## 设计约束

- 静态 provider 配置读写统一通过本包完成，避免多个模块各自操作 `~/.mica/config.json`。
- userConfig 类本地数据统一通过 `micaStorage.ts` 暴露 API，避免 UI 或 runtime 直接关心文件路径。
- `config.json` 的 `defaultModel` 是唯一的显式默认模型配置；当前会话的 provider/model/effort 只保存在运行态，不读取或写入历史默认模型偏好。
- 模型列表只有一份来源：`config.json` 里手填的 `providers[].models`；代码里没有任何拉取或缓存模型的路径。
- 仅当所有 provider 都没有 `api_key` 时，才从 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 合成运行时 provider；环境 provider 永不写回 `config.json`。
- 启动配置迁移与语义校验集中在 `packages/mica-builtin-commands/startup/validate-config.js`；缺失的 provider `protocol` 会自动补为 `openai_chat_completions`。
- 默认配置模板放在 `default.json`；`defaultModel` 默认省略，采用配置列表首项。
- 不在本包中处理 UI 展示；命令或应用层负责把配置变化同步给用户。

## 模型规则

OpenAI 协议的模型规则由 models.dev 元数据生成（磁盘缓存 24h → 内置种子 → 在线刷新）。Anthropic / Google 原生协议优先读取 pi-ai 随包的静态模型目录；这只复用能力元数据，不发现或改写配置中的模型列表，也不读取凭据或发网络请求。pi 未收录的模型继续查 models.dev；两边都查不到时回退 1M contextSize，并且**不带任何 effort 档位**。

- 档位名就是模型声明的那一组真实取值，不做归一化也不落别名：`minimal` 就是 `minimal`，同时支持 `xhigh` 与 `max` 的模型保留两个选项。可选档位由 `getModelEffortOptions(model, protocol?, provider?)` 从规则里读，UI 不再有硬编码的五档。
- models.dev 的规则继续带 `openai_chat_completions` 与 `openai_responses` 两份补丁，保持既有 OpenAI effort 语义；能确定 Anthropic / Google 厂商及原生字段时也附上对应补丁。传了 `protocol` 时，该协议下没有等价参数的档位会被过滤掉（例如只有 toggle 的模型在 responses 下没有可控档位）。原生协议的规则缓存包含协议，防止同一 provider 改协议后复用旧规则。
- 原生能力读取复用 pi-ai 的 `getSupportedThinkingLevels` 与 `thinkingLevelMap`，只保留模型实际原生值：Anthropic adaptive thinking 使用 `thinking` / `output_config.effort`，Google 离散档位使用 SDK payload 的 `config.thinkingConfig.thinkingLevel`（如 `MINIMAL` / `HIGH`）。`max` 不变成 `xhigh`；不把 Pi simple API 为旧模型生成的 token budget 当成真实 effort 档位。
- 只有开关的模型（models.dev `toggle`）档位是 `none` / `on`；同时声明了 toggle 与 effort 取值的模型多一个 `none`，用来发 `thinking: disabled`。
- 只声明 `budget_tokens`、或根本没声明 reasoning 的模型没有档位：选什么都不发参数，`/effort` 与 desktop 选择器都会直说「该模型不提供推理强度选项」。
- 模型未知时默认没有档位，不发任何推理参数；猜出来的档位会被不支持该参数的端点直接 400。自建网关的模型名 models.dev 不认识，可以在 provider 上用 `effortLevels` 声明服务端真实接受的档位名（如 `["low","medium","high"]`），这些名字原样发出；有 models.dev 元数据时以模型自己的档位为准，`effortLevels` 不参与。
- 档位怎么收敛由调用方声明，不是一处全局策略：`mica exec --variant` 这类命令行显式参数走 `strict`（档位名不合法、模型没声明该档位、或模型完全没有档位也都直接报错并列出可用档位，不会被静默改成别的值）；桌面端/Codex 驱动带上来的 model+effort 走 `clamp`（收敛到目标模型自己的档位，或丢掉模型没声明的档位，并由 host 用 warning 通知说明实际发了什么）。客户端选择不是用户当场敲的参数，让它把 host 拦下来就等于一条永远发不出去的消息。
- 两种策略都要求先 `ensureModelRule(model)` 再解析档位：档位集合来自 models.dev，磁盘缓存是异步读的，先算会把「缓存里有、随包种子里没有」的模型误判成没有档位。
- Provider 可通过设置 `supportsEffort: false` 禁用 effort：它在 `resolveEffortParams` 里最先判断，模型补丁不能绕过它。
- 请求侧只有一个入口 `resolveEffortParams({ provider, model, effort, protocol })`，`PiModelClient` 在 `onPayload` 上应用返回补丁；Google 的 `config` 与现有 SDK 参数应递归合并。
- 服务端可能拒绝 models.dev 声明的档位（同一模型名在不同网关上的真实枚举并不一致）：provider 用 400/422 明确拒绝时，客户端经 `markEffortLevelRejected` 记下这台服务商不收这一档，`resolveEffortParams` 之后不再发它。

## 目录说明

- `config.ts`：静态配置读写、运行时配置合成和类型定义。
- `micaStorage.ts`：共享输入框历史、用户偏好和使用记录等本地状态读写。
- `effort.ts`：effort 档位名到 wire 参数的唯一转换入口。
- `getModelRule.ts`：注册与解析模型规则（effort 档位、contextSize、请求参数补丁）。
- `nativeModelRules.ts`：读取 Pi 的静态原生能力目录、生成 Anthropic / Google 的真实档位补丁。
- `providerProtocol.ts`：浏览器安全的协议枚举、类型与校验函数。
- `persistence.ts`：配置文件 IO。
- `envProvider.ts`：环境变量 provider 的合成与识别（`synthesizeEnvProviders` / `isEnvOnlyProvider`）。
- `atomicWrite.ts`：文本文件的原子写盘（临时文件 + rename，保留原文件权限）。

模型 client 使用协议注册表创建，四种协议统一交给 `PiModelClient`；协议选择不按 `api_base` 猜测。

- `runtimeEnv.ts`：运行时环境变量读取。
- `brand.ts`：构建期品牌常量（`RUNTIME_NAME`/`VERSION_LABEL`/`APP_NAME`/`CONFIG_DIR_NAME`）与 `resolveMicaHome`/`resolveMicaHomePath`，默认 `~/.mica` 目录由 `MICA_CONFIG_DIR_NAME` 决定。
- `types.ts`：配置与 provider 的类型定义。
- `default.json`：首次启动时使用的默认配置模板。
- `index.ts`：公共 API 聚合导出。
