# mica-config

`mica-config` 负责 Mica Code 的本地配置读取、更新和 provider 模型列表加载。

配置文件默认位于：`~/.mica/config.json`。当配置文件不存在时，会基于 `default.json` 自动创建。

## 主要能力

- 读取磁盘配置：`micaConfig.read()`。
- 获取内存中的当前配置：`micaConfig.get()`。
- 更新配置并写回磁盘：`micaConfig.update(updater)`。
- 拉取指定 provider 的模型列表：`micaConfig.loadProviderModels(providerId)`。
- 为缺失模型缓存的 provider 批量加载模型：`micaConfig.loadMissingProviderModels()`。

## 使用入口

```ts
import { micaConfig } from '../packages/mica-config/index.js';

const config = micaConfig.get();

micaConfig.update((current) => ({
  ...current,
  model: 'gpt-4.1',
}));
```

## 目录说明

- `config.ts`：配置读写、provider 模型拉取和类型定义。
- `default.json`：首次启动时使用的默认配置模板。
