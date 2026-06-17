import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MicaTool, type ToolExecuteCallbacks } from "../../packages/tools/MicaTool.js";
import { connectToServer, connections, type ConnectedMcpServer } from "./client.js";

type TextContent = { type: "text"; text: string };
type ContentItem =
  | TextContent
  | { type: "image" | "audio" | "resource" | "resource_link" };

class McpProxyTool extends MicaTool {
  constructor(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    private readonly serverName: string,
    private readonly toolName: string,
  ) {
    super(name, description, inputSchema);
  }

  async execute(
    input: Record<string, any>,
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    return callMcpTool(this.serverName, this.toolName, input);
  }

  onToolUseDisplayText(input: Record<string, any>): string {
    const keys = Object.keys(input);
    if (keys.length === 0) return `[MCP:${this.serverName}] ${this.toolName}`;
    const summary = keys
      .slice(0, 3)
      .map((key) => `${key}=${String(input[key]).slice(0, 40)}`)
      .join(", ");
    const more = keys.length > 3 ? ` (+${keys.length - 3})` : "";
    return `[MCP:${this.serverName}] ${this.toolName}: ${summary}${more}`;
  }
}

export async function fetchToolsForServer(
  server: ConnectedMcpServer,
): Promise<MicaTool[]> {
  const result = await server.client.request(
    { method: "tools/list" },
    ListToolsResultSchema,
    { timeout: 15_000 },
  );

  return result.tools.map(
    (tool) =>
      new McpProxyTool(
        `mcp__${server.name}__${tool.name}`,
        tool.description ?? `MCP tool: ${tool.name}`,
        tool.inputSchema as Record<string, unknown>,
        server.name,
        tool.name,
      ),
  );
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

  try {
    return await doCallMcpTool(server, toolName, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Session not found")) throw error;
    connections.delete(serverName);
    await server.cleanup();
    const reconnected = await connectToServer(serverName, server.config);
    return doCallMcpTool(reconnected, toolName, args);
  }
}

async function doCallMcpTool(
  server: ConnectedMcpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await server.client.callTool(
    { name: toolName, arguments: args },
    CallToolResultSchema,
    { timeout: 120_000 },
  );
  const content = result.content as ContentItem[];

  if (result.isError) {
    const errorText = content
      .filter((item): item is TextContent => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    throw new Error(errorText || "MCP tool returned an error");
  }

  const textParts = content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text);

  return textParts.length > 0 ? textParts.join("\n") : JSON.stringify(content);
}
