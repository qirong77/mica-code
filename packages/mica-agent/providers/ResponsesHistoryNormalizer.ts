import type {
  ResponseFunctionCallOutputItemList,
  ResponseInputItem,
  ResponseInputMessageContentList,
  ResponseOutputMessage,
} from 'openai/resources/responses/responses.js';
import { providerContentToConversationBlocks, type ConversationItem } from '../core/Conversation.js';

export class ResponsesHistoryNormalizer {
  normalize(messages: ResponseInputItem[]): ConversationItem[] {
    return messages.map((message) => responseItemToConversationItem(message));
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
      content: responseToolOutputToText(item.output),
      providerMetadata: item,
    };
  }

  return { type: 'unknown', content: item, providerMetadata: item };
}

function responseToolOutputToText(output: string | ResponseFunctionCallOutputItemList): string {
  if (typeof output === 'string') return output;
  return output
    .map((part) => {
      if (part.type === 'input_text') return part.text;
      if (part.type === 'input_image') return '[Image]';
      if (part.type === 'input_file') return '[File]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
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
