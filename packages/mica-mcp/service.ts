import { micaTools, type MicaTool } from '@packages/mica-tools/index.js';
import { connectToServer, connections, disconnectAll, markServerConnected, markServerFailed } from './client.js';
import { loadMcpConfig, MCP_CONFIG_PATH, readMcpConfig, type McpServerConfig } from './config.js';
import { fetchToolsForServer } from './tools.js';

function configLabel(config: McpServerConfig): string {
  return 'url' in config ? config.url : `${config.command} ${(config.args ?? []).join(' ')}`.trim();
}

function extractToolInfo(tools: MicaTool[], serverName: string) {
  const prefix = `mcp__${serverName}__`;
  return tools.map((tool) => ({
    name: tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name,
    description: tool.description,
    inputSchema: tool.input_schema as Record<string, unknown>,
  }));
}

export type InitMcpOptions = {
  configPath?: string;
  strict?: boolean;
  signal?: AbortSignal;
};

export async function initMcp(options: InitMcpOptions = {}): Promise<void> {
  throwIfAborted(options.signal);
  const localConfigs = options.strict ? {} : await loadMcpConfig();
  const externalConfigs = options.configPath
    ? options.configPath === MCP_CONFIG_PATH
      ? await loadMcpConfig()
      : await readMcpConfig(options.configPath)
    : {};
  const configs = { ...localConfigs, ...externalConfigs };
  const entries = Object.entries(configs);
  if (entries.length === 0) {
    micaTools.unregisterMcp();
    return;
  }

  const allTools: MicaTool[] = [];

  for (const [name, config] of entries) {
    throwIfAborted(options.signal);
    try {
      const server = await connectToServer(name, config, options.signal);
      const tools = await fetchToolsForServer(server, options.signal);
      throwIfAborted(options.signal);
      markServerConnected(name, configLabel(config), tools.length, extractToolInfo(tools, name));
      allTools.push(...tools);
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      const message = error instanceof Error ? error.message : String(error);
      markServerFailed(name, configLabel(config), message);
    }
  }

  micaTools.registerMcp(allTools);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
}

export async function reconnectMcpServer(name: string, config: McpServerConfig): Promise<string> {
  const existing = connections.get(name);
  if (existing) await existing.cleanup();

  try {
    const server = await connectToServer(name, config);
    const tools = await fetchToolsForServer(server);
    markServerConnected(name, configLabel(config), tools.length, extractToolInfo(tools, name));

    const allTools: MicaTool[] = [...tools];
    for (const [serverName, connected] of connections) {
      if (serverName === name) continue;
      try {
        allTools.push(...(await fetchToolsForServer(connected)));
      } catch {
        // Keep other connections untouched if refresh fails.
      }
    }
    micaTools.registerMcp(allTools);
    return `已重连 ${name}，注册 ${tools.length} 个工具`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markServerFailed(name, configLabel(config), message);
    await refreshRegisteredToolsFromConnections();
    return `${name} 重连失败: ${message}`;
  }
}

export async function shutdownMcp(): Promise<void> {
  micaTools.unregisterMcp();
  await disconnectAll();
}

async function refreshRegisteredToolsFromConnections(): Promise<void> {
  const allTools: MicaTool[] = [];
  for (const server of connections.values()) {
    try {
      allTools.push(...(await fetchToolsForServer(server)));
    } catch {
      // Keep the registry consistent with servers that can still list tools.
    }
  }
  micaTools.registerMcp(allTools);
}
