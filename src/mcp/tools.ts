import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { MicaTool, type ToolExecuteCallbacks } from '../tools/MicaTool';
import { connections } from './client.js';
import type { ConnectedMcpServer } from './client.js';

type TextContent = { type: 'text'; text: string };
type ContentItem = TextContent | { type: 'image' | 'audio' | 'resource' | 'resource_link' };

class McpProxyTool extends MicaTool {
  constructor(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    private serverName: string,
    private toolName: string,
  ) {
    super(name, description, inputSchema);
  }

  async execute(input: Record<string, any>, _callbacks?: ToolExecuteCallbacks): Promise<string> {
    try {
      return await callMcpTool(this.serverName, this.toolName, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `MCP 工具 ${this.serverName}/${this.toolName} 执行失败: ${message}`;
    }
  }

  onToolUseDisplayText(input: Record<string, any>): string {
    const serverLabel = `[${this.serverName}]`;
    const shortName = this.toolName;
    try {
      const keys = Object.keys(input);
      if (keys.length === 0) return `${serverLabel} ${shortName}`;
      const summary = keys
        .slice(0, 3)
        .map((k) => `${k}=${String(input[k]).slice(0, 40)}`)
        .join(', ');
      const more = keys.length > 3 ? ` (共${keys.length}个参数)` : '';
      return `${serverLabel} ${shortName}: ${summary}${more}`;
    } catch {
      return `${serverLabel} ${shortName}`;
    }
  }

  getSlowText(elapsedMs: number, input: Record<string, any>): string {
    return `⏳ MCP 工具 ${this.toolName} 执行中 (${this.serverName}) ...`;
  }
}

export async function callMcpTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = connections.get(serverName);
  if (!server) {
    throw new Error(`MCP 服务器 "${serverName}" 未连接`);
  }

  const result = await server.client.callTool(
    { name: toolName, arguments: args },
    CallToolResultSchema,
    { timeout: 120_000 },
  );

  const content = result.content as ContentItem[];

  if (result.isError) {
    const textParts = content
      .filter((c): c is TextContent => c.type === 'text')
      .map((c) => c.text);
    throw new Error(textParts.join('\n') || 'MCP tool returned an error');
  }

  const textParts = content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text);

  if (textParts.length === 0) {
    return JSON.stringify(result.content);
  }

  return textParts.join('\n');
}

export async function fetchToolsForServer(server: ConnectedMcpServer): Promise<MicaTool[]> {
  const result = await server.client.request(
    { method: 'tools/list' },
    ListToolsResultSchema,
  );

  return result.tools.map((tool) => {
    const toolName = `mcp__${server.name}__${tool.name}`;
    return new McpProxyTool(
      toolName,
      tool.description ?? `MCP tool: ${tool.name}`,
      tool.inputSchema as Record<string, unknown>,
      server.name,
      tool.name,
    );
  });
}
