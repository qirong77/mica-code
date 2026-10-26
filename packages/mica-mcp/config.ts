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

/**
 * 展开 url / headers 里的 `${VAR}` 与 `${VAR:-默认值}`。
 *
 * 桌面端的 MCP 端点跟着运行时端口走，端口又能被 `MICA_DESKTOP_PORT` 改，
 * 写死地址会在换端口后静默指向另一个（或根本不存在的）实例。
 *
 * 只处理这两处字符串：`command` / `args` / `env` 交给子进程自己解释，
 * 免得把用户想原样传下去的 `${...}` 提前吃掉。变量未定义且没有默认值时展开为空。
 */
export function expandMcpEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
    const current = env[name];
    if (current !== undefined && current !== '') return current;
    return fallback ?? '';
  });
}

function expandServerEnv(config: McpServerConfig, env: NodeJS.ProcessEnv): McpServerConfig {
  if (!('url' in config)) return config;
  const expanded: McpHttpServerConfig = { ...config, url: expandMcpEnv(config.url, env) };
  if (config.headers) {
    expanded.headers = Object.fromEntries(
      Object.entries(config.headers).map(([key, value]) => [key, expandMcpEnv(String(value), env)]),
    );
  }
  return expanded;
}

export async function loadMcpConfig(path = MCP_CONFIG_PATH): Promise<Record<string, McpServerConfig>> {
  try {
    return await readMcpConfig(path);
  } catch {
    return {};
  }
}

export async function readMcpConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, McpServerConfig>> {
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as McpConfig;
  if (!parsed || typeof parsed !== 'object' || !parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
    return {};
  }
  return Object.fromEntries(
    Object.entries(parsed.mcpServers).map(([name, config]) => [
      name,
      config && typeof config === 'object' ? expandServerEnv(config, env) : config,
    ]),
  );
}
