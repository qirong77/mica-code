# mica-ipc

`mica-ipc` 是 Mica Code 本地 agent 进程之间的 IPC/RPC 协议包。它基于 Unix socket 与 JSONL 消息实现本地控制通道，用于 agent attach/detach 等多进程场景。

## 主要能力

- 基于 JSONL 的 RPC 编解码。
- IPC server/client 封装。
- 控制锁能力，避免多个控制端同时接管同一个 agent。
- 定义本地 IPC 协议类型。

## 使用入口

```ts
import { micaIpc } from '@packages/mica-ipc/index.js';

const client = new micaIpc.AgentIpcClient(options);
```

## 设计约束

- 本包只实现本地进程通信协议，不包含具体 UI 或命令实现。
- 上层的 `/agents`、`/detach` 流程通过本包提供的 client/server/control lock 能力组合。
- JSONL 消息应保持可序列化，避免传递函数或复杂运行时对象。

## 目录说明

- `AgentIpcServer.ts`：IPC 服务端。
- `AgentIpcClient.ts`：IPC 客户端。
- `ControlLock.ts`：控制锁实现。
- `jsonLine.ts`：JSONL 编解码工具。
- `protocol.ts`：IPC 协议类型。
- `index.ts`：公共 API 聚合导出。
- `examples/`：基础使用示例。
