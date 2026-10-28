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
      effortLevels: ['low', 'medium', 'high'],
    },
    {
      // 自建网关：模型名 models.dev 不认识，档位由 provider 自己声明。
      id: 'gateway',
      api_base: 'https://example.com',
      api_key: 'x',
      protocol: 'openai_responses',
      models: ['private-model'],
      effortLevels: ['low', 'medium', 'high'],
    },
    {
      // 端点不接受任何推理档位的网关（既没有元数据也没有 effortLevels）。
      id: 'plain',
      api_base: 'https://example.com',
      api_key: 'x',
      protocol: 'openai_responses',
      models: ['shared-model'],
    },
    {
      // 同一个模型名挂在两个 provider 下：档位得按「正在跑的那个 provider」算。
      id: 'gateway-two',
      api_base: 'https://example.com',
      api_key: 'x',
      protocol: 'openai_responses',
      models: ['shared-model'],
      effortLevels: ['low', 'medium', 'high'],
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
      expect(resolveRuntimeConfigOverride(lunaConfig, undefined, 'max', { effortPolicy: 'strict' })).toEqual({
        effort: 'max',
      });
      expect(
        resolveRuntimeConfigOverride(config, 'openrouter/gpt-5.6-luna', 'max', { effortPolicy: 'strict' }),
      ).toEqual({
        providerId: 'openrouter',
        model: 'gpt-5.6-luna',
        effort: 'max',
      });
    } finally {
      dispose();
    }
  });

  it('rejects a variant the target model does not declare when strict', async () => {
    const { default: setupModelEffortContext } =
      await import('@packages/mica-builtin-commands/startup/model-effort-context/index.js');
    const dispose = setupModelEffortContext();
    try {
      expect(() =>
        resolveRuntimeConfigOverride(config, 'openrouter/gpt-5.6-luna', 'ultra', { effortPolicy: 'strict' }),
      ).toThrow('available levels');
      expect(() =>
        resolveRuntimeConfigOverride(config, 'openrouter/gpt-5.6-luna', 'max!', { effortPolicy: 'strict' }),
      ).toThrow('Unsupported --variant value');
      expect(() =>
        resolveRuntimeConfigOverride(config, 'openrouter/gpt-5.6-luna', 'minimal', { effortPolicy: 'strict' }),
      ).toThrow('available levels');
    } finally {
      dispose();
    }
  });

  it('clamps instead of throwing for client-supplied variants', () => {
    // 网关自己声明了档位：不认识的档位收敛到它自己的一档，并带回调整原因。
    expect(resolveRuntimeConfigOverride(config, 'gateway/private-model', 'max')).toEqual({
      providerId: 'gateway',
      model: 'private-model',
      effort: 'medium',
      effortAdjustment: { requested: 'max', applied: 'medium', reason: 'unsupported' },
    });
    // 不是档位名也不抛：客户端带上来的值不该把 host 拦下来。
    expect(resolveRuntimeConfigOverride(config, 'gateway/private-model', 'high!')).toEqual({
      providerId: 'gateway',
      model: 'private-model',
      effortAdjustment: { requested: 'high!', reason: 'unknown-level' },
    });
    // 模型完全没声明档位（也没有 effortLevels）：保留原值（我们只是不知道，不该抹掉
    // 用户存的档位），并说明这次请求不会带推理参数。
    expect(resolveRuntimeConfigOverride(config, 'plain/shared-model', 'high')).toEqual({
      providerId: 'plain',
      model: 'shared-model',
      effort: 'high',
      effortAdjustment: { requested: 'high', applied: 'high', reason: 'undeclared' },
    });
  });

  it('resolves an unprefixed model against the provider that is actually running', () => {
    // 常驻 host 里会话模型没有 provider 前缀：档位必须按当前 provider 声明算，
    // 而不是全局默认 provider —— 否则同一模型名在两台网关上会算出两套档位。
    expect(resolveRuntimeConfigOverride(config, 'shared-model', 'high', { fallbackProviderId: 'gateway-two' })).toEqual(
      { model: 'shared-model', effort: 'high' },
    );
    expect(resolveRuntimeConfigOverride(config, 'shared-model', 'high', { fallbackProviderId: 'plain' })).toEqual({
      model: 'shared-model',
      effort: 'high',
      effortAdjustment: { requested: 'high', applied: 'high', reason: 'undeclared' },
    });
  });
});
