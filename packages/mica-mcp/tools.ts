import { CallToolResultSchema, ListToolsResultSchema, type ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import {
  micaTools,
  type ToolExecuteCallbacks,
  type ToolImageMediaType,
  type ToolResult,
  type ToolResultBlock,
} from '@packages/mica-tools/index.js';
import { finalizeTextOutput } from '@packages/mica-tools/utils/outputLimits.js';
import { connectToServer, connections, type ConnectedMcpServer } from './client.js';
import { createHash } from 'node:crypto';

const MAX_MCP_TOOL_RESULT_CHARS = 60_000;

class McpProxyTool extends micaTools.MicaTool {
  constructor(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    private readonly serverName: string,
    private readonly toolName: string,
  ) {
    super(name, description, inputSchema, { source: 'mcp', mcpServer: serverName });
  }

  async execute(input: Record<string, unknown>, callbacks?: ToolExecuteCallbacks): Promise<ToolResult> {
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
): Promise<ToolResult> {
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
): Promise<ToolResult> {
  const result = await server.client.callTool({ name: toolName, arguments: args }, CallToolResultSchema, {
    timeout: 120_000,
    signal,
  });
  const content = result.content as ContentBlock[];

  if (result.isError) {
    const errorText = content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n');
    throw new Error(errorText || 'MCP tool returned an error');
  }

  const blocks = content.map(toToolResultBlock);
  const textLimits = {
    maxChars: MAX_MCP_TOOL_RESULT_CHARS,
    label: `MCP ${server.name}.${toolName} 输出`,
  };
  if (!blocks.some((block) => block.type === 'image')) {
    return finalizeTextOutput(
      blocks.length > 0 ? blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n') : '[]',
      textLimits,
    );
  }
  const textChars = blocks.reduce((total, block) => total + (block.type === 'text' ? block.text.length : 0), 0);
  const textBudgetRatio = Math.min(1, MAX_MCP_TOOL_RESULT_CHARS / textChars);
  return blocks.map((block) =>
    block.type === 'text'
      ? {
          ...block,
          text: finalizeTextOutput(block.text, {
            ...textLimits,
            maxChars: Math.floor(block.text.length * textBudgetRatio),
            emptyMessage: '',
          }),
        }
      : block,
  );
}

function toToolResultBlock(item: ContentBlock): ToolResultBlock {
  if (item.type === 'text') return { type: 'text', text: item.text };
  if (item.type === 'resource' && 'text' in item.resource) {
    return { type: 'text', text: item.resource.text };
  }
  if (item.type === 'resource_link') {
    return { type: 'text', text: `${item.name.slice(0, 200)}: ${item.uri.slice(0, 4096)}` };
  }
  if (item.type === 'image') {
    if (isSupportedImageMediaType(item.mimeType)) {
      return { type: 'image', source: { type: 'base64', media_type: item.mimeType, data: item.data } };
    }
    return {
      type: 'text',
      text: `[MCP image omitted: unsupported MIME type ${item.mimeType.slice(0, 100)}; supported: image/jpeg, image/png, image/gif, image/webp. Binary data was not included as text.]`,
    };
  }
  return {
    type: 'text',
    text: `[MCP ${item.type} content omitted: this content type is not supported. Its payload was not included as text.]`,
  };
}

function isSupportedImageMediaType(mimeType: string): mimeType is ToolImageMediaType {
  return mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/gif' || mimeType === 'image/webp';
}

function createMcpToolName(serverName: string, toolName: string, usedNames: Set<string>): string {
  const hash = createHash('sha1').update(`${serverName}:${toolName}`).digest('hex').slice(0, 8);
  const toolPart = micaTools.sanitizeToolNamePart(toolName, 64);
  const prefix = micaTools.mcpToolNamePrefix(serverName);
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
