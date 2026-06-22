import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  configApi = (await import(`./config.js?config-test=${Date.now()}`)) as typeof import('./config.js');
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
          model: 'other-model',
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
          model: 'gpt-5.5',
          effort: 'medium',
          contextWindowSize: 1000,
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

  it('filters and resolves provider-specific effort options', () => {
    const deepseek = baseConfig().providers[0]!;

    expect(configApi.getProviderEffortOptions(deepseek)).toEqual(['none', 'high', 'xhigh']);
    expect(configApi.clampProviderEffort(deepseek, 'low')).toBe('high');
    expect(configApi.resolveProviderEffortParams(deepseek, 'xhigh')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
    expect(configApi.resolveProviderEffortParams(deepseek, 'none')).toEqual({ thinking: { type: 'disabled' } });
  });

  it('uses model-specific effort rules before broad family rules', () => {
    const openai = {
      ...baseConfig().providers[1]!,
      id: 'openai',
      api_base: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
    };

    expect(configApi.getProviderEffortOptions(openai, 'gpt-5')).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(configApi.getProviderEffortOptions(openai, 'gpt-5.4')).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(configApi.getProviderEffortOptions(openai, 'gpt-5.5')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(configApi.getProviderEffortOptions(openai, 'gpt-oss-120b')).toEqual(['low', 'medium', 'high']);
    expect(configApi.getEffortMapFromConfig('unknown-reasoning-model')).toEqual({
      none: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
    });
    expect(configApi.getProviderEffortOptions(openai, 'unknown-reasoning-model')).toEqual([
      'none',
      'low',
      'medium',
      'high',
    ]);
    expect(configApi.getModelContextWindowSizeFromConfig('unknown-reasoning-model')).toBe(256000);
    expect(configApi.resolveProviderEffortParams(openai, 'xhigh', 'gpt-5.4')).toEqual({ reasoning_effort: 'xhigh' });
  });

  it('maps zai glm and kimi model effort variants', () => {
    const zai = {
      ...baseConfig().providers[1]!,
      id: 'zai',
      api_base: 'https://api.z.ai/api/paas/v4',
      model: 'glm-4.7',
    };
    const kimi = {
      ...baseConfig().providers[1]!,
      id: 'openrouter',
      api_base: 'https://openrouter.ai/api/v1',
      model: 'kimi-k2.6',
    };
    const disabledProvider = {
      ...baseConfig().providers[1]!,
      id: 'moonshot',
      api_base: 'https://api.moonshot.cn/v1',
      model: 'kimi-k2.6',
      supportsEffort: false,
    };

    expect(configApi.getProviderEffortOptions(zai)).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    expect(configApi.getModelContextWindowSizeFromConfig('deepseek-v4-pro')).toBe(1000000);
    expect(configApi.resolveProviderEffortParams(zai, 'xhigh')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
    expect(configApi.getProviderEffortOptions(kimi, 'kimi-k2.6')).toEqual(['none', 'high']);
    expect(configApi.getProviderEffortOptions(kimi, 'kimi-k2.7-code')).toEqual(['none']);
    expect(configApi.getProviderEffortOptions(disabledProvider, 'kimi-k2.6')).toEqual(['none']);
  });

  it('reports when top-level effort is not supported by the current provider', () => {
    const result = configApi.validateConfig({
      ...baseConfig(),
      effort: 'low',
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'effort_not_supported_by_provider',
          path: 'effort',
        }),
      ]),
    );
  });

  it('does not block startup when only a provider default effort is unsupported', () => {
    const config = baseConfig();
    const result = configApi.validateConfig({
      ...config,
      effort: 'high',
      providers: [
        {
          ...config.providers[0]!,
          effort: 'low',
        },
        config.providers[1]!,
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'provider_effort_unsupported',
          path: 'providers[0].effort',
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
  it('migrates provider runtime fields out of config and memory', () => {
    mkdirSync(dirname(configApi.CONFIG_PATH), { recursive: true });
    writeFileSync(
      configApi.CONFIG_PATH,
      `${JSON.stringify(
        {
          provider: 'kimi',
          model: 'kimi-k2.6',
          effort: 'high',
          contextWindowSize: 256000,
          providers: [
            {
              id: 'kimi',
              name: 'Kimi',
              api_base: 'https://api.moonshot.cn/v1',
              api_key: 'test-key',
              get_model_url: 'https://api.moonshot.cn/v1/models',
              model: 'moonshot-v1-8k',
              effort: 'medium',
              models: ['stale-model'],
              contextWindowSize: 1000,
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    const config = configApi.readConfig();
    const persisted = JSON.parse(readFileSync(configApi.CONFIG_PATH, 'utf-8')) as {
      providers?: Array<Record<string, unknown>>;
    };

    expect(config.provider).toBe('kimi');
    expect(config.model).toBe('kimi-k2.6');
    expect(config.providers[0]?.models).toBeUndefined();
    expect(config.providers[0]?.model).toBeUndefined();
    expect(config.providers[0]?.effort).toBeUndefined();
    expect(config.providers[0]?.contextWindowSize).toBeUndefined();
    expect(persisted.providers?.[0]?.models).toBeUndefined();
    expect(persisted.providers?.[0]?.model).toBeUndefined();
    expect(persisted.providers?.[0]?.effort).toBeUndefined();
    expect(persisted.providers?.[0]?.contextWindowSize).toBeUndefined();
  });

  it('keeps dynamically fetched models in memory without persisting them to config.json', async () => {
    const provider = {
      id: 'kimi',
      name: 'Kimi',
      api_base: 'https://api.moonshot.cn/v1',
      api_key: 'test-key',
      get_model_url: 'https://api.moonshot.cn/v1/models',
    };
    configApi.updateConfig(() => ({
      provider: provider.id,
      model: '',
      effort: 'medium',
      contextWindowSize: 256000,
      providers: [provider],
    }));
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: 'kimi-k2.6' }, { id: 'moonshot-v1-8k' }],
      }),
      text: async () => '',
    })) as unknown as typeof fetch;

    await expect(configApi.loadProviderModels(provider.id)).resolves.toEqual(['kimi-k2.6', 'moonshot-v1-8k']);

    expect(configApi.getConfig().model).toBe('kimi-k2.6');
    expect(configApi.getConfig().providers[0]?.models).toEqual(['kimi-k2.6', 'moonshot-v1-8k']);
    const persisted = JSON.parse(readFileSync(configApi.CONFIG_PATH, 'utf-8')) as {
      providers?: Array<Record<string, unknown>>;
    };
    expect(persisted.providers?.[0]?.model).toBeUndefined();
    expect(persisted.providers?.[0]?.effort).toBeUndefined();
    expect(persisted.providers?.[0]?.contextWindowSize).toBeUndefined();
    expect(persisted.providers?.[0]?.models).toBeUndefined();
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
        model: 'deepseek-v4-pro',
        effort: 'high',
        models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        contextWindowSize: 1000000,
      },
      {
        id: 'krill-codex',
        name: 'Krill-Codex',
        api_base: 'https://api.cdn-krill-ai.com/codex/v1',
        api_key: 'test-key',
        model: 'gpt-5.5',
        effort: 'medium',
        models: ['gpt-5.5', 'gpt-5.4'],
        contextWindowSize: 256000,
      },
    ],
  };
}
