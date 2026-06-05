import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

export interface McpHttpServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface McpConfig {
  mcpServers?: Record<string, McpHttpServerConfig>;
}

export const CONFIG_PATH = resolve(homedir(), '.mica', 'config.json');

export async function loadMcpConfig(): Promise<Record<string, McpHttpServerConfig>> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    const parsed: McpConfig = JSON.parse(raw);
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}
