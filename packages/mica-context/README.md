# mica-context

`mica-context` 是 Mica Code 的上下文管理能力包。当前主要提供会话压缩能力，用于把较长的对话历史整理成可继续推理的 checkpoint。

## 主要能力

- 提供 `CompactionService`，封装上下文压缩流程。
- 将长对话整理为摘要消息，降低后续 prompt 的上下文压力。
- 为后续 token budget、自动 compact、memory 注入等能力预留边界。

## 使用入口

```ts
import { micaContext } from '@packages/mica-context/index.js';

const service = new micaContext.CompactionService(options);
```

## 设计约束

- 本包只处理上下文相关算法和服务，不直接依赖终端 UI。
- 不修改 provider adapter；压缩结果应通过 runtime/session 层接入对话。
- 自动压缩策略应由运行时 hook 或应用层触发。

## 目录说明

- `CompactionService.ts`：上下文压缩服务。
- `index.ts`：公共 API 聚合导出。
