import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import {
  contentBlocksToText,
  type ConversationContentBlock,
  type ConversationItem,
  type ProviderHistoryNormalizer,
} from '../core/Conversation.js';

export class AnthropicHistoryNormalizer implements ProviderHistoryNormalizer<MessageParam> {
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

  denormalize(items: ConversationItem[]): MessageParam[] {
    return items.flatMap((item) => {
      if (item.type === 'user' || item.type === 'assistant') {
        return [{ role: item.type, content: conversationBlocksToAnthropicContent(item.content) }];
      }
      if (item.type === 'tool_call') {
        return [
          {
            role: 'assistant',
            content: [
              ...(item.precedingAssistantText ? [{ type: 'text' as const, text: item.precedingAssistantText }] : []),
              { type: 'tool_use' as const, id: item.id, name: item.name, input: item.args },
            ],
          },
        ];
      }
      if (item.type === 'tool_result') {
        return [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result' as const,
                tool_use_id: item.id,
                content: item.content,
                is_error: item.isError,
              },
            ],
          },
        ];
      }
      return [];
    });
  }
}

function anthropicContentToConversationBlocks(content: MessageParam['content']): ConversationContentBlock[] {
  if (!content) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content) }];

  const blocks: ConversationContentBlock[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      blocks.push({ type: 'image', source: part.source });
    }
  }
  return blocks;
}

function conversationBlocksToAnthropicContent(blocks: ConversationContentBlock[]): MessageParam['content'] {
  const content = blocks.map((block) => {
    if (block.type === 'text') return { type: 'text' as const, text: block.text };
    return { type: 'text' as const, text: '[Image]' };
  });
  return content.length > 0 ? content : '';
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
