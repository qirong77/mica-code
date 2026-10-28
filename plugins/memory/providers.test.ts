import { describe, expect, it, vi } from 'vitest';
import type { PluginModelRequest } from '@packages/mica-plugin/index.js';
import { CuratorProviderError, requestCuratorCompletion, type CuratorProviderConfig } from './providers.js';

const chatConfig: CuratorProviderConfig = {
  baseUrl: 'https://api.example.test/v1',
  apiKey: 'sk-test',
  protocol: 'openai_chat_completions',
  model: 'gpt-test',
};

function fakeModels(text: string) {
  const requests: PluginModelRequest[] = [];
  return {
    requests,
    models: {
      request: vi.fn(async (request: PluginModelRequest) => {
        requests.push(request);
        return { text, usage: null };
      }),
    },
  };
}

describe('requestCuratorCompletion', () => {
  it('asks the host for one request with the configured endpoint', async () => {
    const { models, requests } = fakeModels('{"operations":[]}');

    const text = await requestCuratorCompletion(models, chatConfig, { system: 'system prompt', user: 'user prompt' });

    expect(text).toBe('{"operations":[]}');
    expect(requests[0]).toMatchObject({
      purpose: '整理记忆',
      system: 'system prompt',
      user: 'user prompt',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-test',
      protocol: 'openai_chat_completions',
      model: 'gpt-test',
    });
  });

  it('rejects an empty completion', async () => {
    const { models } = fakeModels('  ');

    await expect(
      requestCuratorCompletion(models, chatConfig, { system: 's', user: 'u' }),
    ).rejects.toThrow(/空内容/);
  });

  it('wraps transport failures without leaking the api key', async () => {
    const models = {
      request: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    };

    await expect(requestCuratorCompletion(models, chatConfig, { system: 's', user: 'u' })).rejects.toMatchObject({
      name: 'CuratorProviderError',
      message: expect.stringContaining('connection refused'),
    });
    await expect(requestCuratorCompletion(models, chatConfig, { system: 's', user: 'u' })).rejects.not.toMatchObject({
      message: expect.stringContaining('sk-test'),
    });
  });
});

describe('CuratorProviderError', () => {
  it('carries a status when the provider rejects the request', () => {
    const error = new CuratorProviderError('HTTP 401', 401);
    expect(error.status).toBe(401);
    expect(error.name).toBe('CuratorProviderError');
  });
});
