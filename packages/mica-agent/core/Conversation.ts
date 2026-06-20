export type ConversationTextBlock = {
  type: 'text';
  text: string;
};

export type ConversationImageBlock = {
  type: 'image';
  source?: unknown;
};

export type ConversationContentBlock = ConversationTextBlock | ConversationImageBlock;

export type ConversationRoleItem = {
  type: 'system' | 'user' | 'assistant';
  content: ConversationContentBlock[];
  providerMetadata?: unknown;
};

export type ConversationToolCallItem = {
  type: 'tool_call';
  id: string;
  name: string;
  args: unknown;
  argsText?: string;
  precedingAssistantText?: string;
  providerMetadata?: unknown;
};

export type ConversationToolResultItem = {
  type: 'tool_result';
  id: string;
  name?: string;
  content: string;
  isError?: boolean;
  providerMetadata?: unknown;
};

export type ConversationUnknownItem = {
  type: 'unknown';
  role?: string;
  content: unknown;
  providerMetadata?: unknown;
};

export type ConversationItem =
  | ConversationRoleItem
  | ConversationToolCallItem
  | ConversationToolResultItem
  | ConversationUnknownItem;

export interface ProviderHistoryNormalizer<TMessage> {
  normalize(messages: TMessage[]): ConversationItem[];
  denormalize(items: ConversationItem[]): TMessage[];
}

export function contentBlocksToText(blocks: ConversationContentBlock[]): string {
  return blocks
    .filter((block): block is ConversationTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export type ConversationContentPartMapper = (
  part: Record<string, unknown>,
) => ConversationContentBlock | null | undefined;

export function providerContentToConversationBlocks(
  content: unknown,
  mapPart: ConversationContentPartMapper,
): ConversationContentBlock[] {
  if (!content) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content) }];

  const blocks: ConversationContentBlock[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const mapped = mapPart(part as Record<string, unknown>);
    if (mapped) blocks.push(mapped);
  }
  return blocks;
}
