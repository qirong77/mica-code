import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';

/** Stable timestamps make persisted-history equality assertions deterministic. */
export function piUser(content: UserMessage['content'], timestamp = 1): UserMessage {
  return { role: 'user', content, timestamp };
}

export function piAssistant(
  content: string | AssistantMessage['content'],
  extra: Partial<Omit<AssistantMessage, 'role' | 'content'>> = {},
): AssistantMessage {
  return {
    role: 'assistant',
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1,
    ...extra,
  };
}

export function piToolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
  return { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError: false, timestamp: 1 };
}

/** Title/display tests keep their UI fixtures separate from the model transcript. */
export function piFromConversation(messages: MicaUiConversationMessage[]): Message[] {
  return messages.flatMap((message): Message[] => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    if (typeof message.content !== 'string') throw new Error('Use explicit Pi blocks for multimodal test fixtures');
    return [message.role === 'user' ? piUser(message.content) : piAssistant(message.content)];
  });
}
