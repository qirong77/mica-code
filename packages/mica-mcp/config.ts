import { readFile } from 'node:fs/promises';
import { micaConfig } from '@packages/mica-config/index.js';

export interface McpStdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  stderr?: string;
  cwd?: string;
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

export const MCP_CONFIG_PATH = micaConfig.path;

export async function loadMcpConfig(): Promise<Record<string, McpServerConfig>> {
  try {
    const raw = await readFile(MCP_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as McpConfig;
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}
