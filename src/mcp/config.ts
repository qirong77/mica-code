import { readFile } from 'node:fs/promises';
import { CONFIG_PATH as MICA_CONFIG_PATH } from '../store/index.js';

export interface McpStdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpServerConfig {
  url: string;
  type?: 'http';
  headers?: Record<string, string>;
}

export type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;

type McpConfig = {
  mcpServers?: Record<string, McpServerConfig>;
};

export const MCP_CONFIG_PATH = MICA_CONFIG_PATH;

export async function loadMcpConfig(): Promise<Record<string, McpServerConfig>> {
  try {
    const raw = await readFile(MCP_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as McpConfig;
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}
