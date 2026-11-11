import type { Message } from '@earendil-works/pi-ai';
import { contentBlocksToText, type ConversationContentBlock, type ConversationItem } from '../core/Conversation.js';

/** One projection for all protocols. Signed replay data stays on the pi message. */
export class PiHistoryNormalizer {
  normalize(messages: Message[]): ConversationItem[] {
    const items: ConversationItem[] = [];
    for (const message of messages) {
      if (message.role === 'toolResult') {
        items.push({
          type: 'tool_result', id: message.toolCallId, name: message.toolName,
          content: contentBlocksToText(blocks(message.content)), isError: message.isError, providerMetadata: message,
        });
        continue;
      }
      const content = blocks(message.content);
      if (message.role !== 'assistant' || content.length) {
        items.push({ type: message.role, content, providerMetadata: message });
      }
      if (message.role !== 'assistant') continue;
      for (const part of message.content) {
        if (part.type !== 'toolCall') continue;
        items.push({
          type: 'tool_call', id: part.id, name: part.name, args: part.arguments,
          argsText: JSON.stringify(part.arguments), precedingAssistantText: contentBlocksToText(content) || undefined,
          providerMetadata: part,
        });
      }
    }
    return items;
  }
}

function blocks(content: Message['content']): ConversationContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content.flatMap((part): ConversationContentBlock[] => {
    if (part.type === 'text') return [{ type: 'text', text: part.text }];
    if (part.type === 'image') return [{ type: 'image', source: part }];
    return [];
  });
}
