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

  it('rejects unsupported effort variants', () => {
    expect(() => resolveRuntimeConfigOverride(config, undefined, 'max')).toThrow('Unsupported --variant');
  });
});
