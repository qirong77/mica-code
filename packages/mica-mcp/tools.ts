import { CallToolResultSchema, ListToolsResultSchema, type ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { prepareImageForApi, type ProcessedImage } from '@packages/mica-common/index.js';
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
const MCP_TOOL_TIMEOUT_MS = 120_000;
const RESPONSE_GRACE_MS = 5_000;
const IMAGE_FAILURE_REASON_CHARS = 120;

/** A declared wait budget must not be cut short by the transport's old 120s ceiling. */
function toolCallTimeout(args: Record<string, unknown>): number {
  const params = args.params && typeof args.params === 'object' ? (args.params as Record<string, unknown>) : {};
  const budgets = [args.timeoutMs, params.timeoutMs].filter(
    (value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
  );
  // SDK timers overflow above the signed 32-bit range. Do not turn a long wait
  // into an immediate timeout, or lower the existing default for short waits.
  return Math.min(2_147_483_647, Math.max(MCP_TOOL_TIMEOUT_MS, ...budgets.map((value) => value + RESPONSE_GRACE_MS)));
}

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
    timeout: toolCallTimeout(args),
    signal,
  });
  const content = result.content as ContentBlock[];

  if (result.isError) {
    const errorText = content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n');
    throw new Error(errorText || 'MCP tool returned an error');
  }

  // 逐张顺序处理：一次只解码一张图，多张大图不会同时各占一份像素内存。
  const blocks: ToolResultBlock[] = [];
  for (const item of content) {
    blocks.push(...(await toToolResultBlocks(item)));
  }
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

async function toToolResultBlocks(item: ContentBlock): Promise<ToolResultBlock[]> {
  if (item.type === 'text') return [{ type: 'text', text: item.text }];
  if (item.type === 'resource' && 'text' in item.resource) {
    return [{ type: 'text', text: item.resource.text }];
  }
  if (item.type === 'resource_link') {
    return [{ type: 'text', text: `${item.name.slice(0, 200)}: ${item.uri.slice(0, 4096)}` }];
  }
  if (item.type === 'image') return imageBlocks(item.mimeType, item.data);
  return [
    {
      type: 'text',
      text: `[MCP ${item.type} content omitted: this content type is not supported. Its payload was not included as text.]`,
    },
  ];
}

/**
 * 远端图片复用 `prepareImageForApi`：PNG 缩小，其它格式校验尺寸；
 * 超过解码资源或最终尺寸上限的图片在本机拦下。
 *
 * 单张失败只换成一行说明，不动同一结果里的其它图文——一张坏图不该让整个 MCP 调用
 * 变成一条错误。缩过就在图片前面说清原始/实际尺寸与再看细节的办法。
 */
async function imageBlocks(declaredMimeType: string, data: string): Promise<ToolResultBlock[]> {
  if (!isSupportedImageMediaType(declaredMimeType)) {
    return [
      {
        type: 'text',
        text: `[MCP image omitted: unsupported MIME type ${declaredMimeType.slice(0, 100)}; supported: image/jpeg, image/png, image/gif, image/webp. Binary data was not included as text.]`,
      },
    ];
  }

  let processed: ProcessedImage;
  try {
    processed = await prepareImageForApi(Buffer.from(data, 'base64'));
  } catch (error) {
    return [
      {
        type: 'text',
        text: `[MCP image omitted: ${declaredMimeType} could not be prepared for the model (${imageFailureReason(error)}). Ask the MCP tool to shrink, crop or re-encode it, or read it in pieces. Binary data was not included as text.]`,
      },
    ];
  }

  const scaleNote = imageScaleNote(processed);
  return [
    ...(scaleNote ? [{ type: 'text' as const, text: scaleNote }] : []),
    {
      type: 'image' as const,
      // 用实际识别出的类型，不用 MCP 声明的：服务端把 JPEG 标成 PNG 时，
      // 按声明发出去只会换来一条「不认识的图片格式」。
      source: { type: 'base64' as const, media_type: processed.mediaType, data: processed.buffer.toString('base64') },
    },
  ];
}

/** 缩过就说一声：模型据此知道自己看到的不是原始分辨率，读小字失败时该去要更精确的信息。 */
function imageScaleNote(image: ProcessedImage): string {
  if (!image.resized) return '';
  const actual = image.width && image.height ? `${image.width}x${image.height}` : 'unknown size';
  const source =
    image.sourceWidth && image.sourceHeight ? `${image.sourceWidth}x${image.sourceHeight}` : 'unknown size';
  return (
    `[MCP image: ${image.mediaType} ${source} downscaled to ${actual} to fit the API limit. ` +
    'Fine details may be lost at this scale: ask the MCP tool to crop or re-capture the region you need, ' +
    'or read the image in sections, before relying on exact text or small shapes.]'
  );
}

/** 失败说明只留一小段原因，并抹掉任何长 base64 串：报错文案里不该出现载荷。 */
function imageFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const condensed = message
    .replace(/[A-Za-z0-9+/]{64,}={0,2}/g, '[data]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!condensed) return 'unknown error';
  return condensed.length > IMAGE_FAILURE_REASON_CHARS
    ? `${condensed.slice(0, IMAGE_FAILURE_REASON_CHARS)}…`
    : condensed;
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
