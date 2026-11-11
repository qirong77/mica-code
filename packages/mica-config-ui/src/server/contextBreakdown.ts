import type {
  ConfigWebContextCategory,
  ConfigWebContextItem,
  ConfigWebContextKind,
  ConfigWebContextToolCall,
} from '../shared/types.js';

/** Pi history → context sizes shared by the config page and desktop session details. */
export const CONTEXT_CONTENT_LIMIT = 2000;
export const CONTEXT_TOOL_LIMIT = 1000;
const CLEARED_TOOL_RESULT = '[Old tool result content cleared during compact]';

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
  return (Array.isArray(messages) ? messages : []).map((message, index) => describeMessage(message, index + 1));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

/** Inline image data does not measure vision tokens. */
function wireView(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[deep]';
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => wireView(item, depth + 1));
  if (record(value).type === 'image') return { type: 'image', media: '[image]' };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wireView(item, depth + 1)]));
}

/** Only request content counts: Pi's local timestamp, API identity and usage are not replayed as input. */
function wireChars(raw: Record<string, unknown>): number {
  const message = {
    role: raw.role,
    content: raw.content,
    ...(raw.role === 'toolResult' ? { toolCallId: raw.toolCallId, toolName: raw.toolName, isError: raw.isError } : {}),
  };
  return charLength(wireView(message));
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function projectContextContent(content: unknown, limit: number): string {
  if (typeof content === 'string') return truncate(content, limit);
  if (!Array.isArray(content)) return '';
  const parts = content.flatMap((block): string[] => {
    const raw = record(block);
    if (raw.type === 'image') return ['[image]'];
    if (raw.type === 'thinking')
      return [typeof raw.thinking === 'string' && raw.thinking ? raw.thinking : '[thinking]'];
    if (raw.type === 'toolCall') return ['[tool_call]'];
    return typeof raw.text === 'string' && raw.text ? [raw.text] : [];
  });
  return truncate(parts.join('\n'), limit);
}

function projectToolCall(raw: Record<string, unknown>): ConfigWebContextToolCall {
  return {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    arguments: truncate(
      typeof raw.arguments === 'string' ? raw.arguments : (JSON.stringify(raw.arguments) ?? ''),
      CONTEXT_TOOL_LIMIT,
    ),
  };
}

function describeMessage(message: unknown, sequence: number): ConfigWebContextItem {
  const raw = record(message);
  const role = typeof raw.role === 'string' ? raw.role : undefined;
  const kind =
    role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : role === 'toolResult' ? 'tool_result' : 'other';
  const out: ConfigWebContextItem = { sequence, kind, role, chars: 0, tokens: 0, parts: {} };
  const content = raw.content;
  const calls: ConfigWebContextToolCall[] = [];
  let imageCount = 0;
  let encryptedChars = 0;
  const add = (category: ConfigWebContextKind, chars: number) => {
    out.parts[category] = (out.parts[category] ?? 0) + chars;
  };
  if (typeof content === 'string') add(kind, content.length);
  else if (Array.isArray(content)) {
    for (const part of content) {
      const block = record(part);
      if (block.type === 'image') imageCount++;
      else if (block.type === 'toolCall') {
        calls.push(projectToolCall(block));
        add('tool_call', charLength(block.arguments));
      } else if (block.type === 'thinking') {
        const signatureSize = typeof block.thinkingSignature === 'string' ? block.thinkingSignature.length : 0;
        encryptedChars += signatureSize;
        add('reasoning', charLength(block.thinking) + signatureSize);
      } else if (block.type === 'text') add(kind, charLength(block.text));
      else add('other', charLength(block));
    }
  }
  if (kind === 'assistant' && !out.parts.assistant) {
    if (calls.length) out.kind = 'tool_call';
    else if (out.parts.reasoning) out.kind = 'reasoning';
  }
  const full = projectContextContent(content, Number.MAX_SAFE_INTEGER);
  const limit = kind === 'tool_result' ? CONTEXT_TOOL_LIMIT : CONTEXT_CONTENT_LIMIT;
  if (full) out.content = truncate(full, limit);
  out.truncated = full.length > limit;
  out.imageCount = imageCount;
  out.hasImage = imageCount > 0;
  if (calls.length) out.toolCalls = calls;
  if (encryptedChars) out.encryptedChars = encryptedChars;
  if (kind === 'tool_result') {
    out.toolCallId = typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined;
    out.name = typeof raw.toolName === 'string' ? raw.toolName : undefined;
    out.cleared = full.startsWith(CLEARED_TOOL_RESULT);
  }
  const bodyChars = Object.values(out.parts).reduce((sum, size) => sum + (size ?? 0), 0);
  const envelope = Math.max(0, wireChars(raw) - bodyChars);
  if (envelope) out.parts.envelope = envelope;
  out.chars = bodyChars + envelope;
  out.tokens = estimateContextTokens(out.chars);
  return out;
}
