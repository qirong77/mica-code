import type { IOType } from 'node:child_process';
import { atom } from 'nanostores';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { logger } from '@packages/mica-diagnostics/index.js';
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
const pendingConnections = new Map<string, Promise<ConnectedMcpServer>>();
const diagnosticLog = logger('mcp-client');

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

export async function connectToServer(
  name: string,
  config: McpServerConfig,
  signal?: AbortSignal,
): Promise<ConnectedMcpServer> {
  const existing = connections.get(name);
  if (existing) return existing;
  const pending = pendingConnections.get(name);
  if (pending) return pending;

  const connection = createConnection(name, config, signal);
  pendingConnections.set(name, connection);
  try {
    return await connection;
  } finally {
    if (pendingConnections.get(name) === connection) pendingConnections.delete(name);
  }
}

async function createConnection(
  name: string,
  config: McpServerConfig,
  signal?: AbortSignal,
): Promise<ConnectedMcpServer> {
  updateServerStatus({
    name,
    url: getConfigLabel(config),
    configPath: MCP_CONFIG_PATH,
    status: 'connecting',
    toolCount: 0,
    tools: [],
  });

  const transport = createTransport(config);

  const client = new Client({ name: 'mica-code', version: '0.1.0' }, { capabilities: {} });
  let closing = false;
  let connected = false;
  attachTransportDiagnostics(name, transport, () => closing, () => {
    if (connected) {
      connections.delete(name);
    }
  });
  await client.connect(transport, { timeout: 15_000, signal });

  const server: ConnectedMcpServer = {
    name,
    client,
    config,
    cleanup: async () => {
      closing = true;
      if (connections.get(name) === server) connections.delete(name);
      await client.close();
    },
  };

  connections.set(name, server);
  connected = true;
  return server;
}

function createTransport(config: McpServerConfig): StreamableHTTPClientTransport | StdioClientTransport {
  if ('url' in config) {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers as Record<string, string> } : undefined,
    });
  }
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: config.env,
    stderr: (config.stderr ?? 'pipe') as IOType,
    cwd: config.cwd,
  });
  return transport;
}

function attachTransportDiagnostics(
  name: string,
  transport: StreamableHTTPClientTransport | StdioClientTransport,
  isClosing: () => boolean,
  onUnexpectedClose: () => void,
): void {
  const target = transport as unknown as {
    stderr?: { on?: (event: string, listener: (...args: unknown[]) => void) => void } | null;
    onerror?: (error: unknown) => void;
    onclose?: () => void;
  };
  let stderrBytes = 0;
  target.stderr?.on?.('data', (chunk: unknown) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk ?? ''));
    stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + bytes);
  });
  target.stderr?.on?.('error', () => {
    diagnosticLog.warn('transport.stderr', { server: name, category: 'stderr_error', bytes: stderrBytes });
    if (!isClosing()) {
      markServerFailed(name, name, 'MCP stderr stream error');
      onUnexpectedClose();
    }
  });
  target.onerror = () => {
    if (!isClosing()) {
      diagnosticLog.warn('transport.error', { server: name, category: 'transport_error', bytes: stderrBytes });
      markServerFailed(name, name, 'MCP transport error');
      onUnexpectedClose();
    }
  };
  target.onclose = () => {
    if (!isClosing()) {
      diagnosticLog.warn('transport.close', { server: name, category: 'transport_close', bytes: stderrBytes });
      markServerFailed(name, name, 'MCP transport closed');
      onUnexpectedClose();
    } else {
      diagnosticLog.info('transport.close', { server: name, category: 'intentional_close', bytes: stderrBytes });
    }
  };
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
