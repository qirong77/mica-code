import { atom } from 'nanostores';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpHttpServerConfig } from './config.js';

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerStatus {
  name: string;
  url: string;
  status: 'connecting' | 'connected' | 'failed';
  toolCount: number;
  tools: McpToolInfo[];
  error?: string;
}

export const mcpServersAtom = atom<McpServerStatus[]>([]);

export interface ConnectedMcpServer {
  name: string;
  client: Client;
  cleanup: () => Promise<void>;
}

export const connections = new Map<string, ConnectedMcpServer>();

function updateServerStatus(update: McpServerStatus) {
  const current = mcpServersAtom.get();
  const idx = current.findIndex((s) => s.name === update.name);
  if (idx === -1) {
    mcpServersAtom.set([...current, update]);
  } else {
    const next = [...current];
    next[idx] = update;
    mcpServersAtom.set(next);
  }
}

export async function connectToServer(
  name: string,
  config: McpHttpServerConfig,
): Promise<ConnectedMcpServer> {
  const existing = connections.get(name);
  if (existing) return existing;

  updateServerStatus({ name, url: config.url, status: 'connecting', toolCount: 0, tools: [] });

  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers
      ? { headers: config.headers as Record<string, string> }
      : undefined,
  });

  const client = new Client(
    { name: 'mica', version: '0.1.0' },
    { capabilities: {} },
  );

  await client.connect(transport);

  const cleanup = async () => {
    connections.delete(name);
    await client.close();
  };

  const server: ConnectedMcpServer = { name, client, cleanup };
  connections.set(name, server);
  return server;
}

export function markServerFailed(name: string, url: string, error: string) {
  updateServerStatus({ name, url, status: 'failed', toolCount: 0, tools: [], error });
}

export function markServerConnected(
  name: string,
  url: string,
  toolCount: number,
  tools: McpToolInfo[],
) {
  updateServerStatus({ name, url, status: 'connected', toolCount, tools });
}

export async function disconnectServer(name: string): Promise<void> {
  const server = connections.get(name);
  if (!server) return;
  await server.cleanup();
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...connections.values()].map((s) => s.cleanup()));
  mcpServersAtom.set([]);
}
