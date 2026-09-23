import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isEnvOnlyProvider, synthesizeEnvProviders } from './envProvider.js';
import type { ProviderDefinition } from './types.js';

const DEEPSEEK: ProviderDefinition = {
  id: 'deepseek',
  name: 'DeepSeek',
  api_base: 'https://api.deepseek.com',
  protocol: 'openai_chat_completions',
  api_key: '',
};

const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MICA_PROVIDER_PROTOCOL'] as const;

describe('synthesizeEnvProviders', () => {
  const original = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) original.set(key, process.env[key]);

  const clearEnv = () => {
    for (const key of ENV_KEYS) delete process.env[key];
  };

  beforeEach(clearEnv);

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('leaves providers untouched when the environment has no credentials', () => {
    expect(synthesizeEnvProviders([DEEPSEEK])).toEqual([DEEPSEEK]);
    expect(isEnvOnlyProvider('openai')).toBe(false);
  });

  it('prepends an environment provider when nothing is configured', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const providers = synthesizeEnvProviders([DEEPSEEK]);
    expect(providers).toHaveLength(2);
    expect(providers[0]).toEqual({
      id: 'openai',
      name: 'OpenAI (environment)',
      api_base: 'https://api.openai.com/v1',
      api_key: 'sk-test',
      protocol: 'openai_responses',
    });
    expect(providers[1]).toBe(DEEPSEEK);
    expect(isEnvOnlyProvider('openai')).toBe(true);
  });

  it('honours OPENAI_BASE_URL and the protocol override', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = 'https://proxy.internal/v1';
    process.env.MICA_PROVIDER_PROTOCOL = 'openai_chat_completions';
    expect(synthesizeEnvProviders([])[0]).toMatchObject({
      api_base: 'https://proxy.internal/v1',
      protocol: 'openai_chat_completions',
    });
  });

  it('ignores an unknown protocol override', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.MICA_PROVIDER_PROTOCOL = 'not-a-protocol';
    expect(synthesizeEnvProviders([])[0]).toMatchObject({ protocol: 'openai_responses' });
  });

  it('never overrides a configured provider that already has credentials', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const configured: ProviderDefinition = { ...DEEPSEEK, api_key: 'configured' };
    expect(synthesizeEnvProviders([configured])).toEqual([configured]);
    expect(isEnvOnlyProvider('openai')).toBe(false);
  });

  it('does not shadow a provider with the same id', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const existing: ProviderDefinition = {
      id: 'openai',
      api_base: 'https://api.openai.com/v1',
      protocol: 'openai_chat_completions',
    };
    expect(synthesizeEnvProviders([existing])).toEqual([existing]);
  });
});
