import { describe, expect, it } from 'vitest';
import type { IMicaConfig } from '@packages/mica-config/index.js';
import { resolveRuntimeConfigOverride } from './modelCatalog.js';

const config: IMicaConfig = {
  provider: 'openrouter',
  model: 'openai/gpt-5',
  effort: 'medium',
  contextWindowSize: 256,
  providers: [
    {
      id: 'open',
      api_base: 'https://example.com',
      api_key: 'x',
      protocol: 'openai_chat_completions',
      models: ['model'],
    },
    {
      id: 'openrouter',
      api_base: 'https://example.com',
      api_key: 'x',
      protocol: 'openai_responses',
      models: ['openai/gpt-5'],
    },
  ],
};

describe('resolveRuntimeConfigOverride', () => {
  it('uses the longest configured provider prefix and preserves slashes in model IDs', () => {
    expect(resolveRuntimeConfigOverride(config, 'openrouter/openai/gpt-5', 'high')).toEqual({
      providerId: 'openrouter',
      model: 'openai/gpt-5',
      effort: 'high',
    });
  });

  it('treats an unqualified model as a current-provider model override', () => {
    expect(resolveRuntimeConfigOverride(config, 'gpt-custom')).toEqual({ model: 'gpt-custom' });
  });

  it('accepts the level names a model declares instead of rewriting them', async () => {
    const { default: setupModelEffortContext } =
      await import('@packages/mica-builtin-commands/startup/model-effort-context/index.js');
    const dispose = setupModelEffortContext();
    try {
      // gpt-5.6-luna 自己声明了 `max`，所以 `max` 原样传下去，不会被改写成别档。
      const lunaConfig = { ...config, model: 'gpt-5.6-luna' };
      expect(resolveRuntimeConfigOverride(lunaConfig, undefined, 'max', { strictEffort: true })).toEqual({
        effort: 'max',
      });
      expect(resolveRuntimeConfigOverride(config, 'openrouter/gpt-5.6-luna', 'max', { strictEffort: true })).toEqual({
        providerId: 'openrouter',
        model: 'gpt-5.6-luna',
        effort: 'max',
      });
    } finally {
      dispose();
    }
  });

  it('rejects a variant the target model does not declare', async () => {
    const { default: setupModelEffortContext } =
      await import('@packages/mica-builtin-commands/startup/model-effort-context/index.js');
    const dispose = setupModelEffortContext();
    try {
      expect(() =>
        resolveRuntimeConfigOverride(config, 'openrouter/gpt-5.6-luna', 'ultra', { strictEffort: true }),
      ).toThrow('available levels');
      expect(() =>
        resolveRuntimeConfigOverride(config, 'openrouter/gpt-5.6-luna', 'max!', { strictEffort: true }),
      ).toThrow('Unsupported --variant value');
      expect(() =>
        resolveRuntimeConfigOverride(config, 'openrouter/gpt-5.6-luna', 'minimal', { strictEffort: true }),
      ).toThrow('available levels');
    } finally {
      dispose();
    }
  });
});
