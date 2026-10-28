# mica-config

`mica-config` 负责 Mica Code 的本地 provider 配置、本地状态数据读取、更新和 provider 模型列表加载。

配置文件默认位于：`~/.mica/config.json`。当配置文件不存在时，会基于 `default.json` 自动创建。
本地状态默认位于：`~/.mica/storage.json`，其中最后一次使用的 provider/model/effort 按精确当前目录保存，输入框历史等数据仍为所有 Mica Code 实例共享。

默认的 `~/.mica` 目录名是构建期的品牌化值：由根 `mica.build.env` 的 `MICA_CONFIG_DIR_NAME` 经 `bun build --define` 注入，经 `brand.ts` 暴露为 `CONFIG_DIR_NAME`。`MICA_HOME` 环境变量显式设置时始终优先；路径解析统一走 `brand.ts` 的 `resolveMicaHome`/`resolveMicaHomePath`。

## 主要能力

- 读取磁盘配置：`micaConfig.read()`。
- 获取内存中的当前配置：`micaConfig.get()`。
- 更新配置并写回磁盘：`micaConfig.update(updater)`。
- 拉取指定 provider 的模型列表并缓存到内存运行态配置：`micaConfig.loadProviderModels(providerId)`。
- 为动态 provider 批量加载运行时模型列表：`micaConfig.loadMissingProviderModels()`。
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

## 设计约束

- 静态 provider 配置读写统一通过本包完成，避免多个模块各自操作 `~/.mica/config.json`。
- userConfig 类本地数据统一通过 `micaStorage.ts` 暴露 API，避免 UI 或 runtime 直接关心文件路径。
- `config.json` 不保存最后一次使用的 provider/model/effort；这些运行时选择按精确当前目录写入 `storage.json` 的 `lastUsedByDirectory`。
- provider 配置了 `get_model_url` 时，模型列表属于运行时数据，只缓存到内存配置，不写回 `config.json`；没有动态模型接口的 provider 可以配置静态 `models`。
- 仅当所有 provider 都没有 `api_key` 时，才从 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 合成运行时 provider；环境 provider 永不写回 `config.json`。
- 启动配置迁移与语义校验集中在 `packages/mica-builtin-commands/startup/validate-config.js`；缺失的 provider `protocol` 会自动补为 `openai_chat_completions`。
- 默认配置模板放在 `default.json`，新增字段需要提供明确默认值。
- 不在本包中处理 UI 展示；命令或应用层负责把配置变化同步给用户。

## 模型规则

模型规则默认由 models.dev 元数据生成（磁盘缓存 24h → 内置种子 → 在线刷新），查不到时回退 1M contextSize，并且**不带任何 effort 档位**。

- 档位名就是模型声明的那一组真实取值，不做归一化也不落别名：Anthropic 系的最高档是 `max`，OpenAI 系的 `minimal` 就是 `minimal`，`gpt-6.1` 同时声明 `xhigh` 与 `max` 时两者都能选。可选档位由 `getModelEffortOptions(model, protocol?, provider?)` 从规则里读，UI 不再有硬编码的五档。
- 规则里的每个档位同时带 `openai_chat_completions` 与 `openai_responses` 两份补丁——models.dev 只说明「模型支持哪些档位」，不说明用户会用哪种协议，所以补丁不能按猜出来的协议只存一份。传了 `protocol` 时，该协议下没有等价参数的档位会被过滤掉（例如只有 toggle 的模型在 responses 下没有可控档位）。
- 只有开关的模型（models.dev `toggle`）档位是 `none` / `on`；同时声明了 toggle 与 effort 取值的模型多一个 `none`，用来发 `thinking: disabled`。
- 只声明 `budget_tokens`、或根本没声明 reasoning 的模型没有档位：选什么都不发参数，`/effort` 与 desktop 选择器都会直说「该模型不提供推理强度选项」。
- 模型未知时默认没有档位，不发任何推理参数；猜出来的档位会被不支持该参数的端点直接 400。自建网关的模型名 models.dev 不认识，可以在 provider 上用 `effortLevels` 声明服务端真实接受的档位名（如 `["low","medium","high"]`），这些名字原样发出；有 models.dev 元数据时以模型自己的档位为准，`effortLevels` 不参与。
- 档位怎么收敛由调用方声明，不是一处全局策略：`mica exec --variant` 这类命令行显式参数走 `strict`（档位名不合法、模型没声明该档位、或模型完全没有档位也都直接报错并列出可用档位，不会被静默改成别的值）；桌面端/Codex 驱动带上来的 model+effort 走 `clamp`（收敛到目标模型自己的档位，或丢掉模型没声明的档位，并由 host 用 warning 通知说明实际发了什么）。客户端选择不是用户当场敲的参数，让它把 host 拦下来就等于一条永远发不出去的消息。
- 两种策略都要求先 `ensureModelRule(model)` 再解析档位：档位集合来自 models.dev，磁盘缓存是异步读的，先算会把「缓存里有、随包种子里没有」的模型误判成没有档位。
- Provider 可通过设置 `supportsEffort: false` 禁用 effort：它在 `resolveEffortParams` 里最先判断，模型补丁不能绕过它。
- 请求侧只有一个入口 `resolveEffortParams({ provider, model, effort, protocol })`，两个 provider client 都调它，不再各自拼参数。

## 目录说明

- `config.ts`：静态配置读写、运行时配置合成、provider 模型拉取和类型定义。
- `micaStorage.ts`：最后使用配置、共享输入框历史、用户偏好和使用记录等本地状态读写。
- `effort.ts`：effort 档位名到 wire 参数的唯一转换入口。
- `getModelRule.ts`：注册与解析模型规则（effort 档位、contextSize、请求参数补丁）。
- `persistence.ts`：配置文件 IO。
- `providerModels.ts`：模型列表加载与运行时缓存管理。
- `envProvider.ts`：环境变量 provider 的合成与识别（`synthesizeEnvProviders` / `isEnvOnlyProvider`）。
- `atomicWrite.ts`：文本文件的原子写盘（临时文件 + rename，保留原文件权限）。

模型 client 使用协议注册表创建。当前配置只开放两种已实现的 OpenAI 协议；未来接入 Anthropic 等实现时，可新增 client 并通过 `registerModelClient` 注册，无需修改 `AgentRuntime`。

- `runtimeEnv.ts`：运行时环境变量读取。
- `brand.ts`：构建期品牌常量（`RUNTIME_NAME`/`VERSION_LABEL`/`APP_NAME`/`CONFIG_DIR_NAME`）与 `resolveMicaHome`/`resolveMicaHomePath`，默认 `~/.mica` 目录由 `MICA_CONFIG_DIR_NAME` 决定。
- `types.ts`：配置与 provider 的类型定义。
- `default.json`：首次启动时使用的默认配置模板。
- `index.ts`：公共 API 聚合导出。
