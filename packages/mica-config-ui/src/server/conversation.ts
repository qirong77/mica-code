// 从具体文件取类型：这个模块会被桌面运行时复用，经 `index.js` 会拖进整个 agent 包
import type { ConversationContentBlock, ConversationItem } from '@packages/mica-agent/core/Conversation.js';
import { PiHistoryNormalizer } from '@packages/mica-agent/providers/PiHistoryNormalizer.js';
import type { Message } from '@earendil-works/pi-ai';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import type { ConfigWebConversationDetails, ConfigWebConversationItem } from '../shared/types.js';

export type ConfigWebConversationSource = {
  providerId: string;
  protocol: ProviderProtocol;
  model: string;
  systemPrompt: string;
  messages: Message[];
};

/** Normalizes provider messages into display items. Reasoning items are kept with a safe
 *  summary as content and the encrypted payload length as `sizeHint` (never the payload itself). */
export function buildConfigWebConversationItems(source: ConfigWebConversationSource): ConfigWebConversationItem[] {
  const normalized = normalizeMessages(source.messages);
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
  if (raw.type !== 'thinking') return null;
  const sizeHint = typeof raw.thinkingSignature === 'string' ? raw.thinkingSignature.length : undefined;
  const summary = typeof raw.thinking === 'string' ? raw.thinking : '';
  return {
    type: 'reasoning',
    content: summary || '(推理内容未保存在会话中)',
    sizeHint,
  };
}

function normalizeMessages(messages: Message[]): ConversationItem[] {
  const normalizer = new PiHistoryNormalizer();
  return messages.flatMap((message): ConversationItem[] => {
    // The shared normalizer projects visible messages and tools. Context analysis also
    // needs thinking sizes; retain those blocks internally, then expose only safe text/lengths.
    const thinking: ConversationItem[] =
      message.role === 'assistant'
        ? message.content.filter((part) => part.type === 'thinking').map((content) => ({ type: 'unknown', content }))
        : [];
    return [...thinking, ...normalizer.normalize([message])];
  });
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
