import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IMicaConfig } from './config.js';

const previousHome = process.env.HOME;
const previousMicaHome = process.env.MICA_HOME;
const tempHome = mkdtempSync(join(tmpdir(), 'mica-config-'));
const originalFetch = globalThis.fetch;
let configApi: typeof import('./config.js');

beforeAll(async () => {
  process.env.HOME = tempHome;
  process.env.MICA_HOME = tempHome;
  configApi = (await import('./config.js')) as typeof import('./config.js');
});

afterAll(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousMicaHome === undefined) {
    delete process.env.MICA_HOME;
  } else {
    process.env.MICA_HOME = previousMicaHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('validateConfig', () => {
  it('reports a missing provider with available providers and model match suggestion', () => {
    const result = configApi.validateConfig({
      ...baseConfig(),
      provider: 'missing',
      model: 'gpt-5.5',
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'provider_not_found',
          path: 'provider',
          message: '当前 provider "missing" 不存在，必须匹配 providers[].id。',
          suggestion: expect.stringContaining('可以把 "provider" 改为 "krill-codex"。'),
        }),
      ]),
    );
  });

  it('reports duplicate provider ids', () => {
    const config = baseConfig();
    const result = configApi.validateConfig({
      ...config,
      providers: [
        config.providers[0]!,
        {
          ...config.providers[0]!,
          name: 'Duplicate DeepSeek',
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'provider_id_duplicate',
          path: 'providers[1].id',
        }),
      ]),
    );
  });

  it('reports malformed provider entries without throwing', () => {
    const result = configApi.validateConfig({
      ...baseConfig(),
      provider: 'deepseek',
      providers: [null, baseConfig().providers[0]!] as unknown as IMicaConfig['providers'],
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'provider_invalid',
          path: 'providers[0]',
        }),
      ]),
    );
  });

  it('reports provider api_base issues without throwing while validating effort support', () => {
    const result = configApi.validateConfig({
      ...baseConfig(),
      provider: 'broken',
      model: 'gpt-5.5',
      effort: 'medium',
      providers: [
        {
          id: 'broken',
          models: ['gpt-5.5'],
        },
      ] as unknown as IMicaConfig['providers'],
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'provider_api_base_empty',
          path: 'providers[0].api_base',
        }),
      ]),
    );
  });

  it('reports when the selected model is not supported by the current provider', () => {
    const result = configApi.validateConfig({
      ...baseConfig(),
      provider: 'deepseek',
      model: 'gpt-5.5',
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'model_not_supported',
          path: 'model',
          suggestion: '当前 model "gpt-5.5" 可匹配 provider "krill-codex"，可以切换 provider。',
        }),
      ]),
    );
  });

  it('allows startup when only the current provider api key is missing', () => {
    const config = baseConfig();
    const result = configApi.validateConfig({
      ...config,
      providers: [
        {
          ...config.providers[0]!,
          api_key: '',
        },
        config.providers[1]!,
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'provider_api_key_missing',
        }),
      ]),
    );
  });

  it('formats and throws validation issues for startup display', () => {
    const issues = configApi.validateConfig({
      ...baseConfig(),
      provider: 'missing',
      model: 'gpt-5.5',
    }).issues;

    expect(configApi.formatConfigValidationIssues(issues, '/tmp/config.json')).toContain(
      '配置文件有问题：/tmp/config.json',
    );
    expect(() =>
      configApi.assertValidConfig({
        ...baseConfig(),
        provider: 'missing',
        model: 'gpt-5.5',
      }),
    ).toThrow(configApi.ConfigValidationError);
  });

  it('resolves fixed effort request parameters', () => {
    const deepseek = baseConfig().providers[0]!;

    expect(configApi.resolveChatCompletionsEffortParams(deepseek, 'xhigh')).toEqual({
      reasoning_effort: 'xhigh',
    });
    expect(configApi.resolveChatCompletionsEffortParams(deepseek, 'none')).toEqual({});
  });

  it('requires and validates provider protocol', () => {
    const config = baseConfig();
    const result = configApi.validateConfig({
      ...config,
      providers: [
        {
          ...config.providers[0]!,
          protocol: 'openai_responses',
        },
        {
          ...config.providers[1]!,
          protocol: 'unsupported',
        },
      ] as IMicaConfig['providers'],
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'provider_protocol_invalid',
          path: 'providers[1].protocol',
        }),
      ]),
    );
  });

  it('uses the fixed rule for every model', () => {
    const krill = baseConfig().providers[1]!;
    const openai = {
      ...krill,
      id: 'openai',
      api_base: 'https://api.openai.com/v1',
    };

    expect(configApi.getModelRule('test-model').contextSize).toBe(1000000);

    // Set per-model data

    // Read back via configApi
    expect(configApi.getModelRule('test-model').contextSize).toBe(1000000);
    expect(configApi.getModelRule('test-model').contextSize).toBe(1000000);
    expect(configApi.getModelRule('test-model').contextSize).toBe(1000000);
    expect(configApi.getModelRule('test-model').contextSize).toBe(1000000);

    // Unknown models still get defaults
    expect(configApi.getModelRule('test-model').contextSize).toBe(1000000);

    expect(configApi.resolveChatCompletionsEffortParams(openai, 'xhigh')).toEqual({
      reasoning_effort: 'xhigh',
    });
    expect(configApi.resolveResponsesReasoningParams(openai, 'xhigh')).toEqual({
      reasoning: { effort: 'xhigh' },
    });
  });

  it('uses OpenAI request params with mapped model effort values', () => {
    const zai = {
      ...baseConfig().providers[1]!,
      id: 'zai',
      api_base: 'https://api.z.ai/api/paas/v4',
    };
    const kimi = {
      ...baseConfig().providers[1]!,
      id: 'openrouter',
      api_base: 'https://openrouter.ai/api/v1',
    };
    const disabledProvider = {
      ...baseConfig().providers[1]!,
      id: 'moonshot',
      api_base: 'https://api.moonshot.cn/v1',
      supportsEffort: false,
    };

    // Set per-model data

    expect(configApi.getModelRule('test-model').contextSize).toBe(1000000);

    expect(configApi.resolveChatCompletionsEffortParams(zai, 'xhigh')).toEqual({
      reasoning_effort: 'xhigh',
    });
    expect(configApi.resolveChatCompletionsEffortParams(kimi, 'high')).toEqual({
      reasoning_effort: 'high',
    });
    expect(configApi.resolveChatCompletionsEffortParams(disabledProvider, 'high')).toEqual({});
  });

  it('reports when top-level effort is not supported by the current provider', () => {

    const result = configApi.validateConfig({
      ...baseConfig(),
      effort: 'invalid' as IMicaConfig['effort'],
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'effort_invalid',
          path: 'effort',
        }),
      ]),
    );
  });

  it('allows a dynamic provider without static model effort or context size', () => {
    const result = configApi.validateConfig({
      provider: 'kimi',
      model: '',
      effort: 'medium',
      contextWindowSize: 256000,
      providers: [
        {
          id: 'kimi',
          name: 'Kimi',
          api_base: 'https://api.moonshot.cn/v1',
          api_key: 'test-key',
          protocol: 'openai_chat_completions',
          get_model_url: 'https://api.moonshot.cn/v1/models',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'model_empty',
          path: 'model',
        }),
      ]),
    );
  });
});

describe('loadProviderModels', () => {
  it('keeps dynamically fetched models in memory and applies the fixed model rule', async () => {
    const provider = {
      id: 'kimi',
      name: 'Kimi',
      api_base: 'https://api.moonshot.cn/v1',
      api_key: 'test-key',
      protocol: 'openai_chat_completions' as const,
      get_model_url: 'https://api.moonshot.cn/v1/models',
    };
    configApi.updateConfig(() => ({
      provider: provider.id,
      model: '',
      effort: 'medium',
      contextWindowSize: 256000,
      providers: [provider],
    }));
    globalThis.fetch = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => {
                return { data: [{ id: 'kimi-k2.6' }, { id: 'moonshot-v1-8k' }] };
      },
      text: async () => '',
    })) as unknown as typeof fetch;

    await expect(configApi.loadProviderModels(provider.id)).resolves.toEqual(['kimi-k2.6', 'moonshot-v1-8k']);

    expect(configApi.getConfig().model).toBe('kimi-k2.6');
    expect(configApi.getConfig().providers[0]?.models).toEqual(['kimi-k2.6', 'moonshot-v1-8k']);
    expect(configApi.getConfig().contextWindowSize).toBe(1000000);

    const persisted = JSON.parse(readFileSync(configApi.CONFIG_PATH, 'utf-8')) as {
      providers?: Array<Record<string, unknown>>;
    };
    expect(persisted.providers?.[0]?.model).toBeUndefined();
    expect(persisted.providers?.[0]?.effort).toBeUndefined();
    expect(persisted.providers?.[0]?.contextWindowSize).toBeUndefined();
    expect(persisted.providers?.[0]?.models).toBeUndefined();
  });

  it('does not rewrite read-only config.json after dynamic models are loaded', async () => {
    const provider = {
      id: 'kimi',
      name: 'Kimi',
      api_base: 'https://api.moonshot.cn/v1',
      api_key: 'test-key',
      protocol: 'openai_chat_completions' as const,
      get_model_url: 'https://api.moonshot.cn/v1/models',
    };
    configApi.updateConfig(() => ({
      provider: provider.id,
      model: '',
      effort: 'medium',
      contextWindowSize: 256000,
      providers: [provider],
    }));
    globalThis.fetch = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => {
                return { data: [{ id: 'kimi-k2.6' }, { id: 'moonshot-v1-8k' }] };
      },
      text: async () => '',
    })) as unknown as typeof fetch;

    await configApi.loadProviderModels(provider.id);
    const before = readFileSync(configApi.CONFIG_PATH, 'utf-8');
    chmodSync(configApi.CONFIG_PATH, 0o444);
    try {
      expect(() =>
        configApi.updateConfig((config) => ({
          ...config,
          model: 'moonshot-v1-8k',
        })),
      ).not.toThrow();
    } finally {
      chmodSync(configApi.CONFIG_PATH, 0o644);
    }

    expect(readFileSync(configApi.CONFIG_PATH, 'utf-8')).toBe(before);
  });
});

function baseConfig(): IMicaConfig {
  return {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    effort: 'high',
    contextWindowSize: 256000,
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        api_base: 'https://api.deepseek.com',
        api_key: 'test-key',
        protocol: 'openai_chat_completions',
        models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      },
      {
        id: 'krill-codex',
        name: 'Krill-Codex',
        api_base: 'https://api.cdn-krill-ai.com/codex/v1',
        api_key: 'test-key',
        protocol: 'openai_responses',
        models: ['gpt-5.5', 'gpt-5.4'],
      },
    ],
  };
}
