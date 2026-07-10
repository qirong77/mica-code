import { describe, expect, it } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { ChatCompletionsClient } from './ChatCompletionsClient.js';
import { ResponsesClient } from './ResponsesClient.js';
import { createModelClient, createSubAgent, registerModelClient } from './createModelClient.js';
import type { ModelClientOptions } from './types.js';

describe('createModelClient', () => {
  it.each([
    ['openai_chat_completions', 'openai_chat_completions', ChatCompletionsClient],
    ['openai_responses', 'openai_responses', ResponsesClient],
  ] as const)('routes %s protocol to the matching client', (_label, protocol, ClientClass) => {
    expect(createModelClient(options(protocol))).toBeInstanceOf(ClientClass);
  });

  it('creates a tool-free sub agent without reasoning effort', () => {
    const agent = createSubAgent(options('openai_chat_completions'));

    expect(agent).toBeInstanceOf(ChatCompletionsClient);
    expect((agent as ChatCompletionsClient).tools).toBe(false);
    expect((agent as ChatCompletionsClient).effort).toBe('none');
  });

  it('preserves an explicitly selected subagent effort', () => {
    const clientOptions = options('openai_chat_completions');
    clientOptions.effort = 'high';
    const agent = createSubAgent(clientOptions);

    expect((agent as ChatCompletionsClient).effort).toBe('high');
  });

  it('supports registering a future protocol without changing AgentRuntime', () => {
    const unregister = registerModelClient(
      'future_protocol',
      (clientOptions) => new ChatCompletionsClient(clientOptions),
    );
    const futureOptions = options('openai_chat_completions');
    futureOptions.provider = { ...futureOptions.provider, protocol: 'future_protocol' as ProviderProtocol };

    expect(createModelClient(futureOptions)).toBeInstanceOf(ChatCompletionsClient);
    unregister();
    expect(() => createModelClient(futureOptions)).toThrow('Unsupported model client protocol: future_protocol');
  });

  it('does not silently replace a built-in protocol implementation', () => {
    expect(() =>
      registerModelClient('openai_responses', (clientOptions) => new ChatCompletionsClient(clientOptions)),
    ).toThrow('Model client protocol is already registered: openai_responses');
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
