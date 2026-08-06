# mica-runtime

`mica-runtime` 是 Mica Code 的运行时协议与状态基础包。它定义用户输入、运行事件、控制器接口、快照和消息队列等通用运行时原语。

## 主要能力

- 定义 runtime controller 接口。
- 定义用户输入、提交结果、终止结果和运行状态。
- `RuntimeInput` 可携带 `displayText`，用于让 UI 展示更友好的输入摘要，同时保留完整 `text` 发送给 agent。
- 定义 runtime event 与 event bus。
- 定义 headless OpenCode/DevEco-compatible run JSON 事件 schema 与编码辅助。
- 定义可用于 UI 同步或会话保存的 view snapshot。
- 提供 `MessageQueueService` 管理运行中输入排队状态。
- 定义插件可用的 owner-aware queue capability，以及 `input:received`、`turn:after` hook event 类型。

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
- `Rewind.ts`：会话回退（回滚）相关类型与结果。
- `RuntimeStatus.ts`：运行状态类型。
- `RuntimeViewSnapshot.ts`：运行时视图快照。
- `SubmitResult.ts`：提交结果。
- `AbortResult.ts`：中止结果。
- `MessageQueueService.ts`：运行中输入排队服务。
- `PluginRuntime.ts`：插件 runtime queue capability、opaque owner 和 hook event 类型。
- `codexExecEvents.ts`：`mica exec --json` 的 Codex exec ThreadEvent JSONL 类型（`thread.started`/`turn.started`/`item.*`/`turn.completed`/`error`，item 类型 `agent_message`/`reasoning`/`command_execution`）、编码与输出。
- `codexProtocol.ts`：Codex v2 App Server 协议子集（`mica app-server` 用）——JSON-RPC 风格 framing（每行一个 JSON、无 `jsonrpc` 字段）、请求/响应/错误/通知编解码、方法名与通知名常量。
- `index.ts`：公共 API 聚合导出。
