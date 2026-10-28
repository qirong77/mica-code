import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = {
  provider: 'main',
  model: 'main-model',
  providers: [
    {
      id: 'main',
      name: 'Main',
      api_base: 'https://main.test/v1',
      api_key: 'main-key',
      protocol: 'openai_responses' as const,
      models: ['main-model'],
    },
    {
      id: 'cheap',
      name: 'Cheap',
      api_base: 'https://cheap.test/v1',
      api_key: 'cheap-key',
      protocol: 'openai_chat_completions' as const,
      models: ['cheap-model'],
    },
  ],
};

vi.mock('./config.js', () => ({ getConfig: () => config }));

const { readActiveProviderConfig } = await import('./activeProvider.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readActiveProviderConfig', () => {
  it('reads the active provider and its current model', () => {
    expect(readActiveProviderConfig()).toMatchObject({
      providerId: 'main',
      baseUrl: 'https://main.test/v1',
      apiKey: 'main-key',
      protocol: 'openai_responses',
      model: 'main-model',
    });
  });

  it('follows the session when it runs on another provider', () => {
    expect(readActiveProviderConfig({ providerId: 'cheap' })).toMatchObject({
      providerId: 'cheap',
      baseUrl: 'https://cheap.test/v1',
      // 不是当前 provider，就取它自己的第一个模型。
      model: 'cheap-model',
    });
  });

  it('routes by the provider prefix in the model name', () => {
    // 「只换模型名、仍走主配置」的情形：`cheap/xxx` 必须打到 cheap。
    expect(readActiveProviderConfig({ model: 'cheap/cheap-model' })).toMatchObject({
      providerId: 'cheap',
      model: 'cheap/cheap-model',
    });
    expect(readActiveProviderConfig({ model: 'main-model' })).toMatchObject({ providerId: 'main' });
  });

  it('says what to do when no provider is configured', () => {
    const original = config.providers;
    (config as { providers: unknown[] }).providers = [];
    try {
      expect(() => readActiveProviderConfig()).toThrow(/添加服务商/);
    } finally {
      (config as { providers: unknown[] }).providers = original;
    }
  });
});
