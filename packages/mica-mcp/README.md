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

## 目录说明

- `config.ts`：MCP 配置路径、配置类型和加载逻辑。
- `client.ts`：MCP client 与连接状态。
- `service.ts`：初始化、重连和关闭编排。
- `tools.ts`：MCP tool 到 Mica tool 的适配。
