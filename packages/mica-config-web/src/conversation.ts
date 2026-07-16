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

export function buildConfigWebConversationDetails(
  source: ConfigWebConversationSource,
  now: Date = new Date(),
): ConfigWebConversationDetails {
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
    if (isInternalReasoningItem(item)) continue;

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

    items.push({
      sequence: items.length + 1,
      type: 'unknown',
      content: stringifyForDisplay(item.content),
      role: 'role' in item ? item.role : undefined,
    });
  }

  return {
    providerId: source.providerId,
    protocol: source.protocol,
    model: source.model,
    updatedAt: now.toISOString(),
    items,
  };
}

function isInternalReasoningItem(item: ConversationItem): boolean {
  if (item.type !== 'unknown' || !item.content || typeof item.content !== 'object') return false;
  return 'type' in item.content && item.content.type === 'reasoning';
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
