# mica-common

`mica-common` 是 Mica Code 各 package 共享的底层工具包。它提供无业务依赖的通用类型和工具函数，用于降低 package 之间的重复实现。

## 主要能力

- `Disposable` 相关工具，用于统一资源释放。
- 类型安全的事件总线工具。
- JSON 值类型定义。
- `Result` 成功/失败结果类型。
- ID 生成工具。

## 使用入口

```ts
import { micaCommon } from '@packages/mica-common/index.js';

const id = micaCommon.createId();
```

## 设计约束

- 不依赖任何产品业务包。
- 不包含 UI、agent、配置、会话等领域逻辑。
- 新增工具应保持小而稳定，适合作为跨包基础能力复用。

## 目录说明

- `disposable.ts`：资源释放接口和辅助方法。
- `eventBus.ts`：事件总线相关类型与实现。
- `json.ts`：JSON 类型定义。
- `result.ts`：结果类型。
- `ids.ts`：ID 生成。
- `index.ts`：公共 API 聚合导出。
- `examples/`：基础使用示例。
