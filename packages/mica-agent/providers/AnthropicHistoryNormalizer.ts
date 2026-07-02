import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import {
  contentBlocksToText,
  providerContentToConversationBlocks,
  type ConversationContentBlock,
  type ConversationItem,
} from '../core/Conversation.js';

export class AnthropicHistoryNormalizer {
  normalize(messages: MessageParam[]): ConversationItem[] {
    const items: ConversationItem[] = [];
    const toolNames = new Map<string, string>();

    for (const message of messages) {
      const content = anthropicContentToConversationBlocks(message.content);
      const toolCalls = Array.isArray(message.content)
        ? message.content.filter((part) => part && typeof part === 'object' && part.type === 'tool_use')
        : [];
      const toolResults = Array.isArray(message.content)
        ? message.content.filter((part) => part && typeof part === 'object' && part.type === 'tool_result')
        : [];

      if (content.length > 0 || toolCalls.length === 0 || message.role !== 'assistant') {
        items.push({ type: message.role, content, providerMetadata: message });
      }

      if (message.role === 'assistant') {
        const precedingAssistantText = contentBlocksToText(content) || undefined;
        for (const toolCall of toolCalls) {
          toolNames.set(toolCall.id, toolCall.name);
          items.push({
            type: 'tool_call',
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.input,
            argsText: stringifyArgs(toolCall.input),
            precedingAssistantText,
            providerMetadata: toolCall,
          });
        }
      }

      for (const toolResult of toolResults) {
        items.push({
          type: 'tool_result',
          id: toolResult.tool_use_id,
          name: toolNames.get(toolResult.tool_use_id),
          content: anthropicToolResultToText(toolResult.content),
          isError: toolResult.is_error,
          providerMetadata: toolResult,
        });
      }
    }

    return items;
  }
}

function anthropicContentToConversationBlocks(content: MessageParam['content']): ConversationContentBlock[] {
  return providerContentToConversationBlocks(content, (part) => {
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part.type === 'image') return { type: 'image', source: part.source };
    return null;
  });
}

function anthropicToolResultToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringifyArgs(content);
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return String(part);
      if ('type' in part && part.type === 'text' && 'text' in part) return String(part.text);
      if ('type' in part && part.type === 'image') return '[Image]';
      return stringifyArgs(part);
    })
    .join('\n');
}

function stringifyArgs(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}
