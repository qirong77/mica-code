import { appendSystemLog } from '../store/logAtom';
import {
  connectToServer,
  disconnectAll,
  markServerConnected,
  markServerFailed,
  connections,
} from './client.js';
import { fetchToolsForServer } from './tools.js';
import { registerMcpTools, unregisterMcpTools } from '../tools/index.js';
import { loadMcpConfig } from './config.js';
import type { McpHttpServerConfig } from './config.js';
import type { MicaTool } from '../tools/MicaTool.js';

function extractToolInfo(tools: MicaTool[], serverName: string) {
  const prefix = `mcp__${serverName}__`;
  return tools.map((t) => ({
    name: t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name,
    description: t.description,
    inputSchema: t.input_schema as Record<string, unknown>,
  }));
}

export async function initMcp(): Promise<void> {
  const configs = await loadMcpConfig();
  const entries = Object.entries(configs);

  if (entries.length === 0) {
    appendSystemLog('MCP: 未配置 MCP 服务器');
    return;
  }

  appendSystemLog(`MCP: 正在连接 ${entries.length} 个服务器...`);

  const allTools: MicaTool[] = [];

  for (const [name, config] of entries) {
    try {
      appendSystemLog(`MCP: 连接 ${name} (${config.url})`);
      const server = await connectToServer(name, config);
      const tools = await fetchToolsForServer(server);
      markServerConnected(name, config.url, tools.length, extractToolInfo(tools, name));
      appendSystemLog(`MCP: ${name} 已连接，注册了 ${tools.length} 个工具`);
      allTools.push(...tools);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markServerFailed(name, config.url, message);
      appendSystemLog(`MCP: ${name} 连接失败 - ${message}`);
    }
  }

  if (allTools.length > 0) {
    registerMcpTools(allTools);
    appendSystemLog(`MCP: 共注册 ${allTools.length} 个 MCP 工具`);
  }
}

export async function reconnectMcpServer(name: string, config: McpHttpServerConfig): Promise<string> {
  const existing = connections.get(name);
  if (existing) {
    await existing.cleanup();
  }

  try {
    const connected = await connectToServer(name, config);
    const tools = await fetchToolsForServer(connected);
    markServerConnected(name, config.url, tools.length, extractToolInfo(tools, name));

    const allTools = [...tools];
    for (const [n, s] of connections) {
      if (n !== name) {
        try {
          const existingTools = await fetchToolsForServer(s);
          allTools.push(...existingTools);
        } catch {}
      }
    }
    registerMcpTools(allTools);

    return `已重连 ${name}，注册了 ${tools.length} 个工具`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markServerFailed(name, config.url, message);
    return `${name} 重连失败: ${message}`;
  }
}

export async function shutdownMcp(): Promise<void> {
  unregisterMcpTools();
  await disconnectAll();
}
