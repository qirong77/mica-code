# mica-common

`mica-common` 是 Mica Code 各 package 共享的底层工具包。它提供无业务依赖的通用类型和工具函数，用于降低 package 之间的重复实现。

## 主要能力

- `Disposable` 相关工具，用于统一资源释放。
- 类型安全的事件总线工具。
- JSON 值类型定义。
- `Result` 成功/失败结果类型。
- `ID` 生成、token 格式化、Git 命令执行与错误格式化工具。
- 共享的图片格式识别、缩放与 API 载荷压缩工具。

## 使用入口

```ts
import { micaCommon } from '@packages/mica-common/index.js';

const id = micaCommon.createId('item');
const tokenText = micaCommon.formatTokenCount(15320);
const errText = micaCommon.formatExecError(new Error('cmd error'));
```

图片处理能力通过同一公共入口按需导入：

```ts
import { prepareImageForApi } from '@packages/mica-common/index.js';
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
- `format.ts`：token 数量格式化。
- `git.ts`：git 命令执行与错误格式化。
- `image.ts`：图片格式识别、缩放和压缩。
- `index.ts`：公共 API 聚合导出。
