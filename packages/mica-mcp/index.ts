import { buildMcpCatalog } from './catalog.js';
import { mcpServersAtom } from './client.js';
import { expandMcpEnv, loadMcpConfig, MCP_CONFIG_PATH, readMcpConfig } from './config.js';
import { initMcp, reconnectMcpServer, shutdownMcp } from './service.js';

export const micaMcp = {
  /** 初始化 MCP 服务连接，并把可用远端工具注册到工具系统。 */
  init: initMcp,
  /** 重新连接指定 MCP 服务，常用于配置变更或连接异常后的恢复。 */
  reconnectServer: reconnectMcpServer,
  /** 关闭所有 MCP 连接并清理已注册的远端工具。 */
  shutdown: shutdownMcp,
  /** 从本地配置文件读取 MCP server 定义。 */
  loadConfig: loadMcpConfig,
  /** 从显式文件读取 MCP server 定义；文件损坏时向调用方抛错。 */
  readConfig: readMcpConfig,
  /** 展开 MCP 配置里的 `${VAR}` / `${VAR:-默认值}`。 */
  expandEnv: expandMcpEnv,
  servers: mcpServersAtom,
  configPath: MCP_CONFIG_PATH,
  /** 会话能力目录里的 MCP 一栏（配置 + 会话级 `--mcp-config` + 连接状态）。 */
  catalog: buildMcpCatalog,
};

export type { McpServerStatus } from './client.js';
export { buildMcpCatalog } from './catalog.js';
export type { McpCatalogEntry, McpCatalogInput } from './catalog.js';
export type { InitMcpOptions } from './service.js';
export type { McpServerConfig, McpHttpServerConfig, McpStdioServerConfig } from './config.js';
