import type { IOType } from 'node:child_process';
import { atom } from 'nanostores';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from './config.js';
import { MCP_CONFIG_PATH } from './config.js';

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerStatus {
  name: string;
  url: string;
  configPath: string;
  status: 'connecting' | 'connected' | 'failed';
  toolCount: number;
  tools: McpToolInfo[];
  error?: string;
}

export interface ConnectedMcpServer {
  name: string;
  client: Client;
  config: McpServerConfig;
  cleanup: () => Promise<void>;
}

export const mcpServersAtom = atom<McpServerStatus[]>([]);
export const connections = new Map<string, ConnectedMcpServer>();

function updateServerStatus(update: McpServerStatus) {
  const current = mcpServersAtom.get();
  const idx = current.findIndex((server) => server.name === update.name);
  if (idx === -1) {
    mcpServersAtom.set([...current, update]);
    return;
  }
  const next = [...current];
  next[idx] = update;
  mcpServersAtom.set(next);
}

function getConfigLabel(config: McpServerConfig): string {
  return 'url' in config ? config.url : `${config.command} ${(config.args ?? []).join(' ')}`.trim();
}

export async function connectToServer(name: string, config: McpServerConfig): Promise<ConnectedMcpServer> {
  const existing = connections.get(name);
  if (existing) return existing;

  updateServerStatus({
    name,
    url: getConfigLabel(config),
    configPath: MCP_CONFIG_PATH,
    status: 'connecting',
    toolCount: 0,
    tools: [],
  });

  const transport =
    'url' in config
      ? new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers as Record<string, string> } : undefined,
        })
      : new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: config.env,
          stderr: (config.stderr ?? 'pipe') as IOType,
          cwd: config.cwd,
        });

  const client = new Client({ name: 'mica-code', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport, { timeout: 15_000 });

  const server: ConnectedMcpServer = {
    name,
    client,
    config,
    cleanup: async () => {
      connections.delete(name);
      await client.close();
    },
  };

  connections.set(name, server);
  return server;
}

export function markServerConnected(name: string, url: string, toolCount: number, tools: McpToolInfo[]) {
  updateServerStatus({
    name,
    url,
    configPath: MCP_CONFIG_PATH,
    status: 'connected',
    toolCount,
    tools,
  });
}

export function markServerFailed(name: string, url: string, error: string) {
  updateServerStatus({
    name,
    url,
    configPath: MCP_CONFIG_PATH,
    status: 'failed',
    toolCount: 0,
    tools: [],
    error,
  });
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...connections.values()].map((server) => server.cleanup()));
  mcpServersAtom.set([]);
}
