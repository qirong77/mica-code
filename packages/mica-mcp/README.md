# mica-mcp

`mica-mcp` 负责读取 MCP 配置、管理 MCP server 连接，并把远端 MCP tools 注册到 `mica-tools`。

## 主要能力

- 初始化所有 MCP server：`micaMcp.init()`。
- 重新连接指定 server：`micaMcp.reconnectServer(...)`。
- 关闭连接并清理工具注册：`micaMcp.shutdown()`。
- 读取 MCP 配置：`micaMcp.loadConfig()`。
- 暴露 MCP server 状态 store：`micaMcp.servers`。

## 使用入口

```ts
import { micaMcp } from '../packages/mica-mcp/index.js';

await micaMcp.init();
```

## 设计约束

- MCP server 的生命周期由本包统一管理。
- 远端工具必须通过 `mica-tools` 的注册入口接入，不绕开工具 registry。
- 重连或关闭 server 时需要同步清理对应工具，避免留下失效工具定义。
- 配置读取与连接状态更新应保持可观测，便于 `/mcp` 命令展示。

## 目录说明

- `config.ts`：MCP 配置路径、配置类型和加载逻辑。
- `client.ts`：MCP client 与连接状态。
- `service.ts`：初始化、重连和关闭编排。
- `tools.ts`：MCP tool 到 Mica tool 的适配。
- `index.ts`：公共 API 聚合导出。
