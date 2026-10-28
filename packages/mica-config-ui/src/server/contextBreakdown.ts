import type {
  ConfigWebContextCategory,
  ConfigWebContextItem,
  ConfigWebContextKind,
  ConfigWebContextToolCall,
} from '../shared/types.js';

/**
 * 持久化消息体按类别拆解：回答「谁占了 context」。
 *
 * 唯一实现在这里——浏览器的配置页、桌面端的会话详情与上下文弹窗都读这一份，
 * 同一个会话在两处不会给出两个数字。
 *
 * 口径：
 * - `chars/4` 估 token，与 CLI 的 ctx 同口径；
 * - 图片 / 文档块只记张数、不计字符（base64 长度与 vision token 无关）；
 * - 每条消息的结构字段（role / type / call_id / name）单列 `envelope`，线上请求同样会带上，
 *   混进正文会让「持久化消息体」明显偏小、差额全被当成 system prompt。
 */

/** 详情投影上限：超大消息不整包发给界面。 */
export const CONTEXT_CONTENT_LIMIT = 2000;
export const CONTEXT_TOOL_LIMIT = 1000;

/** 工具结果被 compact 清理后留下的占位符（packages/mica-context 的 TOOL_RESULT_PLACEHOLDER）。 */
const CLEARED_TOOL_RESULT = '[Old tool result content cleared during compact]';

const IMAGE_BLOCK_TYPES = new Set(['image_url', 'input_image', 'image']);
// 媒体块（图片 + 文档/文件）的内联 payload 与 vision token 无关，一律不计字符。
const MEDIA_BLOCK_TYPES = new Set(['image_url', 'input_image', 'image', 'document', 'input_file']);

/** 与本口径一致：一个字符约 0.25 token。 */
export function estimateContextTokens(chars: number): number {
  return Math.ceil((Number(chars) || 0) / 4);
}

export type ConfigWebContextBreakdown = {
  items: ConfigWebContextItem[];
  categories: ConfigWebContextCategory[];
  messageChars: number;
  messageTokens: number;
  clearedResults: number;
  imageCount: number;
};

/** 按类别汇总：类别顺序固定，界面不必每次重新找位置。 */
export function summarizeContextItems(messages: unknown[]): ConfigWebContextBreakdown {
  const items = projectContextItems(messages);
  const byKind = new Map<ConfigWebContextKind, ConfigWebContextCategory>();
  let messageChars = 0;
  let clearedResults = 0;
  let imageCount = 0;
  for (const item of items) {
    messageChars += item.chars;
    imageCount += item.imageCount ?? 0;
    if (item.cleared) clearedResults++;
    for (const [kind, size] of Object.entries(item.parts) as [ConfigWebContextKind, number][]) {
      if (!size) continue;
      const row = byKind.get(kind) ?? { kind, count: 0, chars: 0, tokens: 0 };
      row.count++;
      row.chars += size;
      row.tokens = estimateContextTokens(row.chars);
      byKind.set(kind, row);
    }
  }
  return {
    items,
    categories: [...byKind.values()].sort((a, b) => b.tokens - a.tokens || a.kind.localeCompare(b.kind)),
    messageChars,
    messageTokens: estimateContextTokens(messageChars),
    clearedResults,
    imageCount,
  };
}

export function projectContextItems(messages: unknown[]): ConfigWebContextItem[] {
  return (Array.isArray(messages) ? messages : []).map((message, index) =>
    describeMessage(message, index + 1),
  );
}

/**
 * 线上体积（近似）：provider 收到的是整条消息的 JSON，结构字段同样占 input。
 * 图片 / 文档块只留占位标记，base64 不计。
 */
function wireChars(message: unknown): number {
  try {
    return JSON.stringify(wireView(message))?.length ?? 0;
  } catch {
    return 0;
  }
}

function wireView(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[deep]';
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => wireView(item, depth + 1));
  if (isMediaBlock(value)) {
    const type = (value as { type?: unknown }).type;
    return { type, media: `[${String(type)}]` };
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = wireView(item, depth + 1);
  }
  return out;
}

function charLength(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function isImageBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  return IMAGE_BLOCK_TYPES.has(String((block as { type?: unknown }).type));
}

function isMediaBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  return MEDIA_BLOCK_TYPES.has(String((block as { type?: unknown }).type));
}

function countMedia(value: unknown): { images: number; others: number } {
  if (!Array.isArray(value)) return { images: 0, others: 0 };
  let images = 0;
  let others = 0;
  for (const block of value) {
    if (isImageBlock(block)) images++;
    else if (isMediaBlock(block)) others++;
  }
  return { images, others };
}

/** 参与 token 估算的字符数：媒体块按 0 计。 */
function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (isMediaBlock(block)) continue;
    total += charLength(block);
  }
  return total;
}

/** 把消息 content（string 或 blocks 数组）投影为纯文本，图片/特殊块用占位符。 */
export function projectContextContent(content: unknown, limit: number): string {
  if (typeof content === 'string') {
    return content.length > limit ? `${content.slice(0, limit)}…` : content;
  }
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const type = String((block as { type?: unknown }).type);
    if (type === 'image_url' || type === 'input_image' || type === 'image') parts.push('[image]');
    else if (type === 'tool_use' || type === 'function_call') parts.push('[tool_call]');
    else if (type === 'tool_result' || type === 'function_call_output') parts.push('[tool_result]');
    else if (type === 'thinking' || type === 'reasoning') parts.push('[thinking]');
    else {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text) parts.push(text);
    }
  }
  const joined = parts.join('\n');
  return joined.length > limit ? `${joined.slice(0, limit)}…` : joined;
}

function previewValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(wireView(value)) ?? '';
  } catch {
    return '';
  }
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function projectToolCalls(toolCalls: unknown[]): ConfigWebContextToolCall[] {
  return toolCalls.map((call) => {
    const raw = (call ?? {}) as Record<string, unknown>;
    const fn = (raw.function ?? {}) as Record<string, unknown>;
    const args = fn.arguments ?? raw.arguments;
    return {
      id: typeof raw.id === 'string' ? raw.id : undefined,
      name: typeof fn.name === 'string' ? fn.name : typeof raw.name === 'string' ? raw.name : undefined,
      arguments:
        typeof args === 'string'
          ? truncate(args, CONTEXT_TOOL_LIMIT)
          : typeof raw.arguments === 'string'
            ? truncate(raw.arguments, CONTEXT_TOOL_LIMIT)
            : undefined,
    };
  });
}

function describeMessage(message: unknown, sequence: number): ConfigWebContextItem {
  const out = describeMessageBody(message);
  // 结构字段（消息信封）单列一类，不混进正文。
  const envelope = Math.max(0, wireChars(message) - out.chars);
  if (envelope > 0) {
    out.parts.envelope = envelope;
    out.chars += envelope;
    out.tokens = estimateContextTokens(out.chars);
  }
  return { ...out, sequence };
}

type MessageDraft = Omit<ConfigWebContextItem, 'sequence'>;

function emptyDraft(): MessageDraft {
  return {
    kind: 'other',
    chars: 0,
    tokens: 0,
    parts: {},
  };
}

function describeMessageBody(message: unknown): MessageDraft {
  const raw = (message && typeof message === 'object' ? message : {}) as Record<string, unknown>;
  const out = emptyDraft();
  const role = typeof raw.role === 'string' ? raw.role : undefined;
  const type = typeof raw.type === 'string' ? raw.type : undefined;
  out.role = role;

  // Responses 的 message item 只带文本；Chat Completions 的无 type assistant 可能同时
  // 带 tool_calls，留给下面的 assistant 分支处理。
  if (type === 'message' || (!type && role === 'user')) {
    out.kind = role === 'user' ? 'user' : 'assistant';
    out.role = role === 'user' ? 'user' : 'assistant';
    const full = projectContextContent(raw.content, Number.MAX_SAFE_INTEGER);
    if (full) out.content = truncate(full, CONTEXT_CONTENT_LIMIT);
    out.truncated = full.length > CONTEXT_CONTENT_LIMIT;
    const media = countMedia(raw.content);
    out.hasImage = media.images > 0;
    out.imageCount = media.images;
    out.mediaCount = media.others;
    out.parts[out.kind] = contentChars(raw.content);
    out.chars = out.parts[out.kind] ?? 0;
    out.tokens = estimateContextTokens(out.chars);
    return out;
  }

  if (type === 'function_call') {
    out.kind = 'tool_call';
    out.role = 'assistant';
    out.name = typeof raw.name === 'string' ? raw.name : undefined;
    out.toolCallId = typeof raw.call_id === 'string' ? raw.call_id : undefined;
    const args =
      typeof raw.arguments === 'string'
        ? raw.arguments
        : charLength(raw.arguments)
          ? JSON.stringify(raw.arguments)
          : '';
    if (args) {
      out.content = truncate(args, CONTEXT_TOOL_LIMIT);
      out.truncated = args.length > CONTEXT_TOOL_LIMIT;
    }
    out.parts.tool_call = args.length;
    out.chars = args.length;
    out.tokens = estimateContextTokens(out.chars);
    return out;
  }

  if (type === 'function_call_output') {
    out.kind = 'tool_result';
    out.role = 'tool';
    out.toolCallId = typeof raw.call_id === 'string' ? raw.call_id : undefined;
    const full = projectContextContent(raw.output, Number.MAX_SAFE_INTEGER) || previewValue(raw.output);
    out.cleared = full.startsWith(CLEARED_TOOL_RESULT);
    if (full) {
      out.content = truncate(full, CONTEXT_TOOL_LIMIT);
      out.truncated = full.length > CONTEXT_TOOL_LIMIT;
    }
    const media = countMedia(raw.output);
    out.hasImage = media.images > 0;
    out.imageCount = media.images;
    out.mediaCount = media.others;
    out.parts.tool_result = contentChars(raw.output);
    out.chars = out.parts.tool_result ?? 0;
    out.tokens = estimateContextTokens(out.chars);
    return out;
  }

  if (type === 'reasoning') {
    out.kind = 'reasoning';
    out.role = 'assistant';
    const summary = Array.isArray(raw.summary)
      ? raw.summary
          .map((part) =>
            part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
              ? ((part as { text: string }).text as string)
              : '',
          )
          .filter(Boolean)
          .join('\n')
      : typeof raw.summary === 'string'
        ? raw.summary
        : '';
    const body = projectContextContent(raw.content, CONTEXT_CONTENT_LIMIT);
    const text = [summary, body].filter(Boolean).join('\n');
    if (text) {
      out.content = truncate(text, CONTEXT_CONTENT_LIMIT);
      out.truncated = text.length > CONTEXT_CONTENT_LIMIT;
    }
    // encrypted_content 是 provider 回传的加密推理链：内容不可读，但确实占 input。
    out.encryptedChars = typeof raw.encrypted_content === 'string' ? raw.encrypted_content.length : 0;
    out.parts.reasoning = summary.length + charLength(raw.content) + out.encryptedChars;
    out.chars = out.parts.reasoning ?? 0;
    out.tokens = estimateContextTokens(out.chars);
    return out;
  }

  if (role === 'tool') {
    out.kind = 'tool_result';
    out.toolCallId = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : undefined;
    const content = raw.content;
    const full = projectContextContent(content, Number.MAX_SAFE_INTEGER) || previewValue(content);
    out.cleared = full.startsWith(CLEARED_TOOL_RESULT);
    if (full) out.content = truncate(full, CONTEXT_TOOL_LIMIT);
    out.truncated = full.length > CONTEXT_TOOL_LIMIT;
    const media = countMedia(content);
    out.hasImage = media.images > 0;
    out.imageCount = media.images;
    out.mediaCount = media.others;
    out.parts.tool_result = contentChars(content);
    out.chars = out.parts.tool_result ?? 0;
    out.tokens = estimateContextTokens(out.chars);
    if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
      out.toolCalls = projectToolCalls(raw.tool_calls);
    }
    return out;
  }

  // Chat Completions 的 assistant 可以同时带文本与工具调用：分别计入各自类别。
  if (role === 'assistant') {
    out.kind = 'assistant';
    const full = projectContextContent(raw.content, Number.MAX_SAFE_INTEGER);
    if (full) out.content = truncate(full, CONTEXT_CONTENT_LIMIT);
    out.truncated = full.length > CONTEXT_CONTENT_LIMIT;
    const media = countMedia(raw.content);
    out.hasImage = media.images > 0;
    out.imageCount = media.images;
    out.mediaCount = media.others;
    out.parts.assistant = contentChars(raw.content);
    if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
      const calls = projectToolCalls(raw.tool_calls);
      out.toolCalls = calls;
      out.parts.tool_call = calls.reduce((sum, call) => sum + charLength(call.arguments), 0);
    }
    out.chars = Object.values(out.parts).reduce((sum, size) => sum + (size ?? 0), 0);
    out.tokens = estimateContextTokens(out.chars);
    return out;
  }

  out.parts.other = charLength(raw);
  out.chars = out.parts.other;
  out.tokens = estimateContextTokens(out.chars);
  return out;
}
