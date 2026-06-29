import type {
  ResponseInputItem,
  ResponseInputMessageContentList,
  ResponseOutputMessage,
} from 'openai/resources/responses/responses.js';
import {
  providerContentToConversationBlocks,
  type ConversationItem,
  type ProviderHistoryNormalizer,
} from '../core/Conversation.js';

export class ResponsesHistoryNormalizer implements ProviderHistoryNormalizer<ResponseInputItem> {
  normalize(messages: ResponseInputItem[]): ConversationItem[] {
    return messages.map((message) => responseItemToConversationItem(message));
  }

  denormalize(items: ConversationItem[]): ResponseInputItem[] {
    return items.map((item) => conversationItemToResponseItem(item));
  }
}

function responseItemToConversationItem(item: ResponseInputItem): ConversationItem {
  if (item.type === 'message') {
    const role = item.role;
    if (role === 'user' || role === 'assistant' || role === 'system') {
      return {
        type: role,
        content: responseMessageContentToBlocks(item.content),
        providerMetadata: item,
      };
    }
  }

  if (item.type === 'function_call') {
    return {
      type: 'tool_call',
      id: item.call_id,
      name: item.name,
      args: parseJson(item.arguments),
      argsText: item.arguments,
      providerMetadata: item,
    };
  }

  if (item.type === 'function_call_output') {
    return {
      type: 'tool_result',
      id: item.call_id,
      content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
      providerMetadata: item,
    };
  }

  return { type: 'unknown', content: item, providerMetadata: item };
}

function conversationItemToResponseItem(item: ConversationItem): ResponseInputItem {
  if (item.providerMetadata) return item.providerMetadata as ResponseInputItem;

  if (item.type === 'user' || item.type === 'system') {
    return {
      type: 'message',
      role: item.type,
      content: item.content.map((block) =>
        block.type === 'text' ? { type: 'input_text', text: block.text } : { type: 'input_text', text: '[Image]' },
      ),
    };
  }

  if (item.type === 'assistant') {
    return {
      type: 'message',
      role: 'assistant',
      content: item.content.map((block) => (block.type === 'text' ? block.text : '[Image]')).join('\n'),
    };
  }

  if (item.type === 'tool_call') {
    return {
      type: 'function_call',
      call_id: item.id,
      name: item.name,
      arguments: item.argsText ?? JSON.stringify(item.args ?? {}),
    };
  }

  if (item.type === 'tool_result') {
    return {
      type: 'function_call_output',
      call_id: item.id,
      output: item.content,
    };
  }

  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: JSON.stringify(item.content) }],
  };
}

function responseMessageContentToBlocks(
  content: string | ResponseInputMessageContentList | ResponseOutputMessage['content'],
) {
  return providerContentToConversationBlocks(content, (part) => {
    if (part.type === 'input_text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part.type === 'output_text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part.type === 'refusal' && typeof part.refusal === 'string') return { type: 'text', text: part.refusal };
    if (part.type === 'input_image') return { type: 'image', source: part };
    return null;
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
