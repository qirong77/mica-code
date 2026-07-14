import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { micaTools, type ToolExecuteCallbacks } from '@packages/mica-tools/index.js';
import { finalizeTextOutput } from '@packages/mica-tools/utils/outputLimits.js';
import { connectToServer, connections, type ConnectedMcpServer } from './client.js';
import { createHash } from 'node:crypto';

type TextContent = { type: 'text'; text: string };
type ContentItem = TextContent | { type: 'image' | 'audio' | 'resource' | 'resource_link' };
const MAX_MCP_TOOL_RESULT_CHARS = 60_000;

class McpProxyTool extends micaTools.MicaTool {
  constructor(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    private readonly serverName: string,
    private readonly toolName: string,
  ) {
    super(name, description, inputSchema);
  }

  async execute(input: Record<string, unknown>, callbacks?: ToolExecuteCallbacks): Promise<string> {
    return callMcpTool(this.serverName, this.toolName, input, callbacks?.signal);
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const keys = Object.keys(input);
    if (keys.length === 0) return `[MCP:${this.serverName}] ${this.toolName}`;
    const summary = keys
      .slice(0, 3)
      .map((key) => `${key}=${String(input[key]).slice(0, 40)}`)
      .join(', ');
    const more = keys.length > 3 ? ` (+${keys.length - 3})` : '';
    return `[MCP:${this.serverName}] ${this.toolName}: ${summary}${more}`;
  }
}

export async function fetchToolsForServer(
  server: ConnectedMcpServer,
  signal?: AbortSignal,
): Promise<InstanceType<typeof micaTools.MicaTool>[]> {
  const result = await server.client.request({ method: 'tools/list' }, ListToolsResultSchema, {
    timeout: 15_000,
    signal,
  });
  const usedNames = new Set<string>();

  return result.tools.map(
    (tool) =>
      new McpProxyTool(
        createMcpToolName(server.name, tool.name, usedNames),
        tool.description ?? `MCP tool: ${tool.name}`,
        tool.inputSchema as Record<string, unknown>,
        server.name,
        tool.name,
      ),
  );
}

async function callMcpTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const server = connections.get(serverName);
  if (!server) {
    throw new Error(`MCP 服务器 "${serverName}" 未连接`);
  }

  try {
    return await doCallMcpTool(server, toolName, args, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Session not found') || signal?.aborted) throw error;
    connections.delete(serverName);
    await server.cleanup();
    const reconnected = await connectToServer(serverName, server.config, signal);
    return doCallMcpTool(reconnected, toolName, args, signal);
  }
}

async function doCallMcpTool(
  server: ConnectedMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const result = await server.client.callTool({ name: toolName, arguments: args }, CallToolResultSchema, {
    timeout: 120_000,
    signal,
  });
  const content = result.content as ContentItem[];

  if (result.isError) {
    const errorText = content
      .filter((item): item is TextContent => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    throw new Error(errorText || 'MCP tool returned an error');
  }

  const textParts = content.filter((item): item is TextContent => item.type === 'text').map((item) => item.text);

  return finalizeTextOutput(textParts.length > 0 ? textParts.join('\n') : JSON.stringify(content), {
    maxChars: MAX_MCP_TOOL_RESULT_CHARS,
    label: `MCP ${server.name}.${toolName} 输出`,
  });
}

function createMcpToolName(serverName: string, toolName: string, usedNames: Set<string>): string {
  const hash = createHash('sha1').update(`${serverName}:${toolName}`).digest('hex').slice(0, 8);
  const serverPart = sanitizeNamePart(serverName, 20);
  const toolPart = sanitizeNamePart(toolName, 64);
  const prefix = `mcp__${serverPart}__`;
  const maxToolLength = Math.max(1, 64 - prefix.length - hash.length - 1);
  const base = `${prefix}${toolPart.slice(0, maxToolLength)}_${hash}`;
  let candidate = base;
  let suffix = 1;
  while (usedNames.has(candidate)) {
    const suffixText = `_${suffix++}`;
    candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function sanitizeNamePart(value: string, maxLength: number): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const fallback = sanitized || 'tool';
  return fallback.slice(0, maxLength);
}
