import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import { buildConfigWebConversationItems, type ConfigWebConversationSource } from './conversation.js';
import type {
  ConfigWebContextAnalysis,
  ConfigWebContextEntry,
  ConfigWebContextTurn,
  ConfigWebConversationItem,
} from './shared/types.js';

/** Rough per-image token cost when the provider stored an image in history. */
export const IMAGE_TOKENS_PER_IMAGE = 850;
const IMAGE_MARKER = '[Image]';
const TURN_PREVIEW_CHARS = 160;
const ENTRY_PREVIEW_CHARS = 220;

/** Rough token estimate: CJK chars count as 1 token, other chars as 1/4 token. */
export function estimateTextTokens(text: string): number {
  const value = typeof text === 'string' ? text : String(text ?? '');
  let cjk = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
      (code >= 0x3040 && code <= 0x30ff) || // Kana
      (code >= 0xac00 && code <= 0xd7af) || // Hangul
      (code >= 0xff00 && code <= 0xffef) // Full-width forms
    ) {
      cjk++;
    }
  }
  return cjk + Math.ceil((value.length - cjk) / 4);
}

export function buildConfigWebContextAnalysis(
  source: ConfigWebConversationSource,
  usageHistory: AgentUsageRecord[] = [],
  contextWindowSize?: number,
): ConfigWebContextAnalysis {
  const items = buildConfigWebConversationItems(source);
  const groups: ConfigWebConversationItem[][] = [[]];
  for (const item of items) {
    if (item.type === 'user') groups.push([]);
    groups[groups.length - 1].push(item);
  }

  const usageByTurn = groupUsageByTurn(usageHistory);
  const turns: ConfigWebContextTurn[] = groups
    .slice(1)
    .map((group, index) => buildTurn(group, index + 1, usageByTurn.get(index + 1)));

  if (groups[0].length > 0) {
    // Preamble (system prompt and anything before the first user message) belongs to turn 1.
    const target = turns.length > 0 ? turns[0] : createEmptyTurn();
    const preambleEntries = groups[0].map((item) => buildEntry(item));
    target.entries.unshift(...preambleEntries);
    if (turns.length === 0) {
      target.userPreview = '(无用户消息)';
      turns.push(target);
    }
  }

  let imageCount = 0;
  for (const turn of turns) {
    for (const entry of turn.entries) {
      if (entry.type === 'tool_call' || entry.type === 'tool_result') turn.toolTokens += entry.tokens;
      else if (entry.type === 'reasoning') turn.thinkingTokens += entry.tokens;
      else turn.conversationTokens += entry.tokens;
      imageCount += entry.images ?? 0;
    }
    turn.totalTokens = turn.conversationTokens + turn.toolTokens + turn.thinkingTokens;
  }

  const totals = turns.reduce(
    (acc, turn) => ({
      conversationTokens: acc.conversationTokens + turn.conversationTokens,
      toolTokens: acc.toolTokens + turn.toolTokens,
      thinkingTokens: acc.thinkingTokens + turn.thinkingTokens,
      totalTokens: acc.totalTokens + turn.totalTokens,
    }),
    { conversationTokens: 0, toolTokens: 0, thinkingTokens: 0, totalTokens: 0 },
  );

  return {
    providerId: source.providerId,
    model: source.model,
    contextWindowSize,
    imageCount,
    turnCount: turns.length,
    totals,
    turns,
  };
}

function createEmptyTurn(): ConfigWebContextTurn {
  return {
    index: 0,
    userSequence: 0,
    userPreview: '',
    conversationTokens: 0,
    toolTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
    usageRequests: 0,
    entries: [],
  };
}

function buildTurn(
  group: ConfigWebConversationItem[],
  index: number,
  usage: AgentUsageRecord[] | undefined,
): ConfigWebContextTurn {
  const turn = createEmptyTurn();
  turn.index = index;
  const userItem = group.find((item) => item.type === 'user');
  turn.userSequence = userItem?.sequence ?? 0;
  turn.userPreview = userItem ? previewText(userItem.content, TURN_PREVIEW_CHARS) : '(无用户消息)';
  for (const item of group) addItemToTurn(turn, item);
  if (usage && usage.length > 0) {
    const last = usage[usage.length - 1];
    turn.contextTokens = last.inputTokens;
    turn.cachedInputTokens = last.cachedInputTokens;
    turn.usageRequests = usage.length;
  }
  return turn;
}

function addItemToTurn(turn: ConfigWebContextTurn, item: ConfigWebConversationItem): void {
  turn.entries.push(buildEntry(item));
}

function buildEntry(item: ConfigWebConversationItem): ConfigWebContextEntry {
  const content = item.content ?? '';
  const images = countImagesInContent(content);
  // Encrypted reasoning payloads are opaque bytes, so their size hint counts like plain text.
  const contentTokens = item.sizeHint !== undefined ? Math.ceil(item.sizeHint / 4) : estimateTextTokens(content);
  const tokens = contentTokens + images * IMAGE_TOKENS_PER_IMAGE;
  return {
    sequence: item.sequence,
    type: item.type,
    label: entryLabel(item),
    tokens,
    preview: previewText(content, ENTRY_PREVIEW_CHARS),
    images: images > 0 ? images : undefined,
  };
}

function entryLabel(item: ConfigWebConversationItem): string {
  if (item.type === 'tool_call' || item.type === 'tool_result') return item.toolName ?? 'tool';
  if (item.type === 'reasoning') return '思考';
  if (item.type === 'assistant') return 'assistant';
  if (item.type === 'user') return 'user';
  if (item.type === 'system') return 'system';
  return item.role ?? 'unknown';
}

function groupUsageByTurn(usageHistory: AgentUsageRecord[]): Map<number, AgentUsageRecord[]> {
  const grouped = new Map<number, AgentUsageRecord[]>();
  for (const record of usageHistory) {
    if (!Number.isInteger(record.turnId) || record.turnId < 1) continue;
    const list = grouped.get(record.turnId);
    if (list) list.push(record);
    else grouped.set(record.turnId, [record]);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.requestIndex - b.requestIndex);
  }
  return grouped;
}

function countImagesInContent(content: string): number {
  if (!content.includes(IMAGE_MARKER)) return 0;
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(IMAGE_MARKER, index)) !== -1) {
    count++;
    index += IMAGE_MARKER.length;
  }
  return count;
}

export function previewText(content: string, max: number): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return '(空)';
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}
