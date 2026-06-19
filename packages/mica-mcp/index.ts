import { mcpServersAtom } from './client.js';
import { loadMcpConfig, MCP_CONFIG_PATH } from './config.js';
import { initMcp, reconnectMcpServer, shutdownMcp } from './service.js';

export const micaMcp = {
  init: initMcp,
  reconnectServer: reconnectMcpServer,
  shutdown: shutdownMcp,
  loadConfig: loadMcpConfig,
  servers: mcpServersAtom,
  configPath: MCP_CONFIG_PATH,
};

export type { McpServerStatus } from './client.js';
export type { McpServerConfig, McpHttpServerConfig, McpStdioServerConfig } from './config.js';
