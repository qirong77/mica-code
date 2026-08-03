# mica-mcp

`mica-mcp` 负责读取 MCP 配置、管理 MCP server 连接，并把远端 MCP tools 注册到 `mica-tools`。

## 主要能力

- 初始化所有 MCP server：`micaMcp.init()`。
- 重新连接指定 server：`micaMcp.reconnectServer(...)`。
- 关闭连接并清理工具注册：`micaMcp.shutdown()`。
- 读取 MCP 配置：`micaMcp.loadConfig()`。
- 从显式路径严格读取 MCP 配置：`micaMcp.readConfig(path)`。
- 暴露 MCP server 状态 store：`micaMcp.servers`。

## 使用入口

```ts
import { micaMcp } from '../packages/mica-mcp/index.js';

await micaMcp.init();

// Headless/managed runtime: explicit servers override local servers.
await micaMcp.init({ configPath: '/tmp/mcp.json' });

// Strict mode does not merge ~/.mica/config.json.
await micaMcp.init({ configPath: '/tmp/mcp.json', strict: true });

// Headless cancellation is forwarded to connect/list/call requests.
await micaMcp.init({ signal: abortController.signal });

// Managed one-shot runtime: initialize servers concurrently and bound each
// server's complete connect + tools/list phase.
await micaMcp.init({ parallel: true, initTimeoutMs: 3000 });
```

## 设计约束

- MCP server 的生命周期由本包统一管理。
- 远端工具必须通过 `mica-tools` 的注册入口接入，不绕开工具 registry。
- 重连或关闭 server 时需要同步清理对应工具，避免留下失效工具定义。
- 配置读取与连接状态更新应保持可观测，便于 `/mcp` 命令展示。
- `loadConfig` 对缺失/损坏配置保持空集合回退；`readConfig(path)` 会把显式托管文件错误交给调用方处理。
- MCP connect、tools/list 和 tools/call 都应传递 agent 的 AbortSignal；不要让 headless 取消等待默认超时。
- `initTimeoutMs` 是单个 server 的完整初始化截止时间，不会为 connect 和 tools/list 分别重新计时；本地截止只标记该 server 失败并继续，外部 AbortSignal 仍会终止整个初始化。
- `parallel: true` 并发初始化独立 server，但最终工具顺序仍按配置顺序合并。
- stdio server 使用 pipe 隐藏 stderr 时仍必须持续 drain；否则服务端大量诊断输出会填满 pipe 并阻塞协议进程。

## 目录说明

- `config.ts`：MCP 配置路径、配置类型和加载逻辑。
- `client.ts`：MCP client 与连接状态。
- `service.ts`：初始化、重连和关闭编排。
- `tools.ts`：MCP tool 到 Mica tool 的适配。
- `index.ts`：公共 API 聚合导出。
