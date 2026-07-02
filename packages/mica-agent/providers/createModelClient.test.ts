import { describe, expect, it } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { AnthropicAgent } from './AnthropicAgent.js';
import { ChatCompletionsClient } from './ChatCompletionsClient.js';
import { ResponsesClient } from './ResponsesClient.js';
import { createModelClient, createSubAgent } from './createModelClient.js';
import type { ModelClientOptions } from './types.js';

describe('createModelClient', () => {
  it.each([
    ['openai_chat_completions', 'openai_chat_completions', ChatCompletionsClient],
    ['openai_responses', 'openai_responses', ResponsesClient],
    ['anthropic_messages', 'anthropic_messages', AnthropicAgent],
  ] as const)('routes %s protocol to the matching client', (_label, protocol, ClientClass) => {
    expect(createModelClient(options(protocol))).toBeInstanceOf(ClientClass);
  });

  it('creates a tool-free sub agent without reasoning effort', () => {
    const agent = createSubAgent(options('openai_chat_completions'));

    expect(agent).toBeInstanceOf(ChatCompletionsClient);
    expect((agent as ChatCompletionsClient).tools).toBe(false);
    expect((agent as ChatCompletionsClient).effort).toBe('none');
  });
});

function options(protocol: ProviderProtocol): ModelClientOptions {
  return {
    model: 'test-model',
    apiKey: 'test-key',
    baseURL: 'https://example.com/v1',
    provider: {
      id: 'test',
      api_base: 'https://example.com/v1',
      protocol,
    },
  };
}
