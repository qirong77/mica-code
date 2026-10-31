import { describe, expect, it, vi } from 'vitest';
import { createPluginLlmApi, type PluginModelRequest } from '@packages/mica-plugin/index.js';
import { CuratorProviderError, requestCuratorCompletion } from './providers.js';

/** 真的 `ctx.llm` 组件 + 假的底层请求：测的是插件实际走的那条路。 */
function fakeLlm(text: string, values: Record<string, string> = {}) {
  const requests: PluginModelRequest[] = [];
  const llm = createPluginLlmApi({
    spec: {},
    readValues: () => ({
      // 默认是复用会话模型；这个用例测的是「用自己的接口」那条路。
      useMainProvider: 'false',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-test',
      protocol: 'openai_chat_completions',
      model: 'gpt-test',
      ...values,
    }),
    models: vi.fn(async (request: PluginModelRequest) => {
      requests.push(request);
      return { text, usage: null };
    }),
  });
  return { requests, llm };
}

describe('requestCuratorCompletion', () => {
  it('asks the host for one request with the configured endpoint', async () => {
    const { llm, requests } = fakeLlm('{"operations":[]}');

    const text = await requestCuratorCompletion(llm, { system: 'system prompt', user: 'user prompt' });

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
    const { llm } = fakeLlm('  ');

    await expect(requestCuratorCompletion(llm, { system: 's', user: 'u' })).rejects.toThrow(/空内容/);
  });

  it('wraps transport failures without leaking the api key', async () => {
    const llm = createPluginLlmApi({
      spec: {},
      readValues: () => ({ baseUrl: 'https://api.example.test/v1', apiKey: 'sk-test', model: 'gpt-test' }),
      models: async () => {
        throw new Error('connection refused');
      },
    });

    await expect(requestCuratorCompletion(llm, { system: 's', user: 'u' })).rejects.toMatchObject({
      name: 'CuratorProviderError',
      message: expect.stringContaining('connection refused'),
    });
    await expect(requestCuratorCompletion(llm, { system: 's', user: 'u' })).rejects.not.toMatchObject({
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
