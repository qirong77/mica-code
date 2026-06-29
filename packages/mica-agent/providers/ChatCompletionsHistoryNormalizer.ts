import type { OpenAI } from 'openai';
import {
  contentBlocksToText,
  providerContentToConversationBlocks,
  type ConversationContentBlock,
  type ConversationItem,
  type ProviderHistoryNormalizer,
} from '../core/Conversation.js';

export class ChatCompletionsHistoryNormalizer implements ProviderHistoryNormalizer<OpenAI.Chat.Completions.ChatCompletionMessageParam> {
  normalize(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): ConversationItem[] {
    const items: ConversationItem[] = [];
    const toolNames = new Map<string, string>();

    for (const message of messages) {
      if (message.role === 'system' || message.role === 'user' || message.role === 'assistant') {
        const content = openAIContentToConversationBlocks(message.content);
        if (content.length > 0 || message.role !== 'assistant' || !message.tool_calls?.length) {
          items.push({ type: message.role, content, providerMetadata: message });
        }

        if (message.role === 'assistant' && message.tool_calls?.length) {
          const precedingAssistantText = contentBlocksToText(content) || undefined;
          for (const toolCall of message.tool_calls) {
            if (toolCall.type !== 'function') continue;
            const id = toolCall.id;
            const name = toolCall.function.name;
            toolNames.set(id, name);
            items.push({
              type: 'tool_call',
              id,
              name,
              args: parseJsonOrRaw(toolCall.function.arguments),
              argsText: toolCall.function.arguments,
              precedingAssistantText,
              providerMetadata: toolCall,
            });
          }
        }
        continue;
      }

      if (message.role === 'tool') {
        const id = message.tool_call_id;
        items.push({
          type: 'tool_result',
          id,
          name: toolNames.get(id),
          content: openAIContentToText(message.content),
          providerMetadata: message,
        });
        continue;
      }

      items.push({
        type: 'unknown',
        role: (message as { role?: string }).role,
        content: message,
        providerMetadata: message,
      });
    }

    return items;
  }

  denormalize(items: ConversationItem[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    for (const item of items) {
      if (item.type === 'system' || item.type === 'user' || item.type === 'assistant') {
        messages.push({ role: item.type, content: conversationBlocksToOpenAIContent(item.content) });
        continue;
      }
      if (item.type === 'tool_call') {
        messages.push({
          role: 'assistant',
          content: item.precedingAssistantText ?? null,
          tool_calls: [
            {
              id: item.id,
              type: 'function',
              function: {
                name: item.name,
                arguments: item.argsText ?? stringifyArgs(item.args),
              },
            },
          ],
        });
        continue;
      }
      if (item.type === 'tool_result') {
        messages.push({ role: 'tool', tool_call_id: item.id, content: item.content });
      }
    }
    return messages;
  }
}

function openAIContentToConversationBlocks(
  content: OpenAI.Chat.Completions.ChatCompletionMessageParam['content'],
): ConversationContentBlock[] {
  return providerContentToConversationBlocks(content, (part) => {
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part.type === 'image_url') return { type: 'image', source: part.image_url };
    return typeof part.type === 'string' ? { type: 'text', text: `[${part.type}]` } : null;
  });
}

function conversationBlocksToOpenAIContent(blocks: ConversationContentBlock[]): string {
  return blocks
    .map((block) => (block.type === 'text' ? block.text : '[Image]'))
    .filter(Boolean)
    .join('\n');
}

function openAIContentToText(content: OpenAI.Chat.Completions.ChatCompletionMessageParam['content']): string {
  return conversationBlocksToOpenAIContent(openAIContentToConversationBlocks(content));
}

function parseJsonOrRaw(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringifyArgs(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}
