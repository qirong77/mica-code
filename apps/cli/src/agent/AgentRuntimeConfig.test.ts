import { describe, expect, it, vi } from 'vitest';
import type { IMicaConfig } from '@packages/mica-config/index.js';

function makeConfig(overrides: Partial<IMicaConfig> = {}): IMicaConfig {
  return {
    providers: [
      {
        id: 'krill',
        protocol: 'openai_responses',
        api_key: 'k',
        api_base: 'https://api.example.com/v1',
        models: ['gpt-5.6-terra'],
      },
      { id: 'deepseek', protocol: 'openai_chat_completions', models: ['deepseek-v4'] },
    ],
    provider: 'krill',
    model: 'gpt-5.6-terra',
    effort: 'medium',
    contextWindowSize: 256000,
    ...overrides,
  } as unknown as IMicaConfig;
}

describe('agentRuntimeConfigFromSnapshot', () => {
  it('degrades to the default provider when the snapshot protocol no longer matches the same provider', async () => {
    vi.resetModules();
    vi.doMock('@packages/mica-config/index.js', () => ({
      micaConfig: {
        get: () => makeConfig(),
        normalizeModelEffort: () => 'medium',
        getModelRule: () => ({ contextSize: 256000 }),
      },
    }));
    const { agentRuntimeConfigFromSnapshot } = await import('./AgentRuntimeConfig.js');
    const config = agentRuntimeConfigFromSnapshot({
      providerId: 'krill',
      protocol: 'openai_chat_completions', // krill migrated to responses; this is a pre-migration session
      model: 'gpt-5.6-terra',
      effort: 'medium',
    });
    expect(config.provider.id).toBe('krill');
    expect(config.provider.protocol).toBe('openai_responses');
    expect(config.model).toBe('gpt-5.6-terra');
    expect(config.effort).toBe('medium');
  });

  it('falls back to the default provider when the snapshot provider is gone', async () => {
    vi.resetModules();
    vi.doMock('@packages/mica-config/index.js', () => ({
      micaConfig: {
        get: () => makeConfig(),
        normalizeModelEffort: () => 'low',
        getModelRule: () => ({ contextSize: 256000 }),
      },
    }));
    const { agentRuntimeConfigFromSnapshot } = await import('./AgentRuntimeConfig.js');
    const config = agentRuntimeConfigFromSnapshot({
      providerId: 'removed-provider',
      protocol: 'openai_responses',
      model: 'old-model',
      effort: 'high',
    });
    expect(config.provider.id).toBe('krill');
  });
});
