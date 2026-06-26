# mica-runtime

`mica-runtime` 是 Mica Code 的运行时协议与状态基础包。它定义用户输入、运行事件、控制器接口、快照和消息队列等通用运行时原语。

## 主要能力

- 定义 runtime controller 接口。
- 定义用户输入、提交结果、终止结果和运行状态。
- 定义 runtime event 与 event bus。
- 定义可用于 UI 同步或会话保存的 view snapshot。
- 提供 `MessageQueueService` 管理运行中输入排队状态。

## 使用入口

```ts
import { micaRuntime } from '@packages/mica-runtime/index.js';

const queue = new micaRuntime.MessageQueueService();
queue.enqueue({ text: '继续' });
```

## 设计约束

- 本包只放运行时协议和状态原语，不依赖 Ink UI。
- UI 适配逻辑放在应用层或 `packages/mica-ui`。
- 具体 agent 调用、session 持久化和命令实现由上层组合。

## 目录说明

- `RuntimeController.ts`：运行时控制器接口。
- `RuntimeInput.ts`：用户输入类型。
- `RuntimeEvent.ts`、`RuntimeEventBus.ts`：运行时事件定义与事件总线。
- `RuntimeStatus.ts`：运行状态类型。
- `RuntimeViewSnapshot.ts`：运行时视图快照。
- `SubmitResult.ts`、`AbortResult.ts`：提交与中止结果。
- `MessageQueueService.ts`：运行中输入排队服务。
- `index.ts`：公共 API 聚合导出。
