# mica-config

`mica-config` 负责 Mica Code 的本地 provider 配置、本地状态数据读取、更新和 provider 模型列表加载。

配置文件默认位于：`~/.mica/config.json`。当配置文件不存在时，会基于 `default.json` 自动创建。
本地状态默认位于：`~/.mica/storage.json`，其中最后一次使用的 provider/model/effort 按精确当前目录保存，输入框历史等数据仍为所有 Mica Code 实例共享。

## 主要能力

- 读取磁盘配置：`micaConfig.read()`。
- 获取内存中的当前配置：`micaConfig.get()`。
- 更新配置并写回磁盘：`micaConfig.update(updater)`。
- 拉取指定 provider 的模型列表并缓存到内存运行态配置：`micaConfig.loadProviderModels(providerId)`。
- 为动态 provider 批量加载运行时模型列表：`micaConfig.loadMissingProviderModels()`。
- 读取本地状态：`micaConfig.storage.read()`。
- 读取共享输入框历史：`micaConfig.inputHistory.read()`。
- 追加共享输入框历史：`micaConfig.inputHistory.append(text)`。

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
- 启动配置迁移与语义校验集中在 `packages/mica-builtin-commands/startup/validate-config.js`；缺失的 provider `protocol` 会自动补为 `openai_chat_completions`。
- 默认配置模板放在 `default.json`，新增字段需要提供明确默认值。
- 不在本包中处理 UI 展示；命令或应用层负责把配置变化同步给用户。

## 模型规则

所有模型规则都由 `getModelRule.ts` 中的固定函数生成，contextSize 为 1M。effort 固定支持 `none/low/medium/high/xhigh` 五档并直接映射到 OpenAI 请求参数。

- Provider 可通过设置 `supportsEffort: false` 禁用 effort 选择。

## 目录说明

- `config.ts`：静态配置读写、运行时配置合成、provider 模型拉取和类型定义。
- `micaStorage.ts`：最后使用配置、共享输入框历史、用户偏好和使用记录等本地状态读写。
- `effort.ts`：Effort 选项、映射与请求参数转换。
- `getModelRule.ts`：生成所有模型共用的固定规则。
- `persistence.ts`：配置文件 IO。
- `providerModels.ts`：模型列表加载与运行时缓存管理。

模型 client 使用协议注册表创建。当前配置只开放两种已实现的 OpenAI 协议；未来接入 Anthropic 等实现时，可新增 client 并通过 `registerModelClient` 注册，无需修改 `AgentRuntime`。

- `runtimeEnv.ts`：运行时环境变量读取。
- `types.ts`：配置与 provider 的类型定义。
- `default.json`：首次启动时使用的默认配置模板。
- `index.ts`：公共 API 聚合导出。
