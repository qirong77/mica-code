import { describe, expect, it } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { PiModelClient } from './PiModelClient.js';
import { createModelClient, createSubAgent, registerModelClient } from './createModelClient.js';
import type { ModelClientOptions } from './types.js';

describe('createModelClient', () => {
  it.each([
    ['openai_chat_completions', 'openai_chat_completions', PiModelClient],
    ['openai_responses', 'openai_responses', PiModelClient],
    ['anthropic_messages', 'anthropic_messages', PiModelClient],
    ['google_generative_ai', 'google_generative_ai', PiModelClient],
  ] as const)('routes %s protocol to the matching client', (_label, protocol, ClientClass) => {
    expect(createModelClient(options(protocol))).toBeInstanceOf(ClientClass);
  });

  it('creates a tool-free sub agent without reasoning effort', () => {
    const agent = createSubAgent(options('openai_chat_completions'));

    expect(agent).toBeInstanceOf(PiModelClient);
    expect((agent as PiModelClient).tools).toBe(false);
    expect((agent as PiModelClient).effort).toBe('none');
  });

  it('preserves an explicitly selected subagent effort', () => {
    const clientOptions = options('openai_chat_completions');
    clientOptions.effort = 'high';
    const agent = createSubAgent(clientOptions);

    expect((agent as PiModelClient).effort).toBe('high');
  });

  it('supports registering a future protocol without changing AgentRuntime', () => {
    const unregister = registerModelClient('future_protocol', (clientOptions) => new PiModelClient(clientOptions));
    const futureOptions = options('openai_chat_completions');
    futureOptions.provider = { ...futureOptions.provider, protocol: 'future_protocol' as ProviderProtocol };

    expect(createModelClient(futureOptions)).toBeInstanceOf(PiModelClient);
    unregister();
    expect(() => createModelClient(futureOptions)).toThrow('Unsupported model client protocol: future_protocol');
  });

  it('does not silently replace a built-in protocol implementation', () => {
    expect(() => registerModelClient('openai_responses', (clientOptions) => new PiModelClient(clientOptions))).toThrow(
      'Model client protocol is already registered: openai_responses',
    );
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
