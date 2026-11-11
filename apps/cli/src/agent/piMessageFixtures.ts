import type { AssistantMessage, UserMessage } from '@earendil-works/pi-ai';

/** Complete transcript messages used by runtime regression tests. */
export function piUser(content: UserMessage['content']): UserMessage {
  return { role: 'user', content, timestamp: 0 };
}

export function piAssistant(content: string | AssistantMessage['content']): AssistantMessage {
  const blocks = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
  return {
    role: 'assistant',
    content: blocks,
    api: 'openai-completions',
    provider: 'test-provider',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: blocks.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  };
}
