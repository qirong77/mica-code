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

export async function loadMcpConfig(path = MCP_CONFIG_PATH): Promise<Record<string, McpServerConfig>> {
  try {
    return await readMcpConfig(path);
  } catch {
    return {};
  }
}

export async function readMcpConfig(path: string): Promise<Record<string, McpServerConfig>> {
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as McpConfig;
  if (!parsed || typeof parsed !== 'object' || !parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
    return {};
  }
  return parsed.mcpServers;
}
