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

## 设计约束

- 配置读写统一通过本包完成，避免多个模块各自操作 `~/.mica/config.json`。
- provider 模型缓存属于配置数据，加载失败时应保留现有配置。
- 默认配置模板放在 `default.json`，新增字段需要提供明确默认值和迁移策略。
- 不在本包中处理 UI 展示；命令或应用层负责把配置变化同步给用户。

## 目录说明

- `config.ts`：配置读写、provider 模型拉取和类型定义。
- `default.json`：首次启动时使用的默认配置模板。
- `index.ts`：公共 API 聚合导出。
- `examples/`：基础使用示例。
