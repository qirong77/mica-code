import type { AgentContentBlockParam } from './Content.js';

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

export function micaContentToConversationBlocks(content: string | AgentContentBlockParam[]): ConversationContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];

  return content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    return { type: 'image', source: block.source };
  });
}
