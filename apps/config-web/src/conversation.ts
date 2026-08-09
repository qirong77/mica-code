import { type ConversationContentBlock, type ConversationItem } from '@packages/mica-agent/index.js';
import { ChatCompletionsHistoryNormalizer } from '@packages/mica-agent/providers/ChatCompletionsHistoryNormalizer.js';
import { ResponsesHistoryNormalizer } from '@packages/mica-agent/providers/ResponsesHistoryNormalizer.js';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import type { ConfigWebConversationDetails, ConfigWebConversationItem } from './shared/types.js';

export type ConfigWebConversationSource = {
  providerId: string;
  protocol: ProviderProtocol;
  model: string;
  systemPrompt: string;
  messages: unknown[];
};

type UnknownNormalizer = {
  normalize(messages: unknown[]): ConversationItem[];
};

/** Normalizes provider messages into display items. Reasoning items are kept with a safe
 *  summary as content and the encrypted payload length as `sizeHint` (never the payload itself). */
export function buildConfigWebConversationItems(source: ConfigWebConversationSource): ConfigWebConversationItem[] {
  const normalized = normalizeMessages(source.protocol, source.messages);
  const toolNamesById = new Map<string, string>();
  const items: ConfigWebConversationItem[] = [
    {
      sequence: 1,
      type: 'system',
      content: source.systemPrompt,
    },
  ];

  for (const item of normalized) {
    if (item.type === 'system' || item.type === 'user' || item.type === 'assistant') {
      items.push({
        sequence: items.length + 1,
        type: item.type,
        content: contentBlocksToDisplayText(item.content),
      });
      continue;
    }

    if (item.type === 'tool_call') {
      toolNamesById.set(item.id, item.name);
      items.push({
        sequence: items.length + 1,
        type: 'tool_call',
        content: stringifyForDisplay(item.args),
        callId: item.id,
        toolName: item.name,
      });
      continue;
    }

    if (item.type === 'tool_result') {
      items.push({
        sequence: items.length + 1,
        type: 'tool_result',
        content: item.content,
        callId: item.id,
        toolName: item.name ?? toolNamesById.get(item.id),
      });
      continue;
    }

    const reasoning = toReasoningItem(item);
    if (reasoning) {
      items.push({
        sequence: items.length + 1,
        ...reasoning,
      });
      continue;
    }

    items.push({
      sequence: items.length + 1,
      type: 'unknown',
      content: stringifyForDisplay(item.content),
      role: 'role' in item ? item.role : undefined,
    });
  }

  return items;
}

export function buildConfigWebConversationDetails(
  source: ConfigWebConversationSource,
  now: Date = new Date(),
): ConfigWebConversationDetails {
  const items = buildConfigWebConversationItems(source)
    .filter((item) => item.type !== 'reasoning')
    .map((item, index) => ({ ...item, sequence: index + 1 }));
  return {
    providerId: source.providerId,
    protocol: source.protocol,
    model: source.model,
    updatedAt: now.toISOString(),
    items,
  };
}

function toReasoningItem(
  item: ConversationItem,
): Pick<ConfigWebConversationItem, 'type' | 'content' | 'sizeHint'> | null {
  if (item.type !== 'unknown' || !item.content || typeof item.content !== 'object') return null;
  const raw = item.content as Record<string, unknown>;
  if (raw.type !== 'reasoning') return null;
  const sizeHint = typeof raw.encrypted_content === 'string' ? raw.encrypted_content.length : undefined;
  const summary = extractReasoningSummary(raw);
  return {
    type: 'reasoning',
    content: summary || '(推理内容未保存在会话中)',
    sizeHint,
  };
}

function extractReasoningSummary(raw: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(raw.summary)) {
    for (const entry of raw.summary) {
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).text === 'string') {
        parts.push((entry as Record<string, unknown>).text as string);
      }
    }
  }
  if (parts.length === 0 && Array.isArray(raw.content)) {
    for (const entry of raw.content) {
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).text === 'string') {
        parts.push((entry as Record<string, unknown>).text as string);
      }
    }
  }
  return parts.join('\n');
}

function normalizeMessages(protocol: ProviderProtocol, messages: unknown[]): ConversationItem[] {
  try {
    return getNormalizer(protocol).normalize(messages);
  } catch {
    return messages.map((content) => ({ type: 'unknown', content }));
  }
}

function getNormalizer(protocol: ProviderProtocol): UnknownNormalizer {
  if (protocol === 'openai_responses') {
    return new ResponsesHistoryNormalizer() as unknown as UnknownNormalizer;
  }
  return new ChatCompletionsHistoryNormalizer() as unknown as UnknownNormalizer;
}

function contentBlocksToDisplayText(blocks: ConversationContentBlock[]): string {
  return blocks
    .map((block) => (block.type === 'text' ? block.text : '[Image]'))
    .filter(Boolean)
    .join('\n');
}

function stringifyForDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
