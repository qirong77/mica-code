import { describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  assertValidConfig,
  formatConfigValidationIssues,
  validateConfig,
  type IMicaConfig,
} from './config.js';

describe('validateConfig', () => {
  it('reports a missing provider with available providers and model match suggestion', () => {
    const result = validateConfig({
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
    const result = validateConfig({
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
    const result = validateConfig({
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

  it('reports when the selected model is not supported by the current provider', () => {
    const result = validateConfig({
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
    const result = validateConfig({
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
    const issues = validateConfig({
      ...baseConfig(),
      provider: 'missing',
      model: 'gpt-5.5',
    }).issues;

    expect(formatConfigValidationIssues(issues, '/tmp/config.json')).toContain('配置文件有问题：/tmp/config.json');
    expect(() =>
      assertValidConfig({
        ...baseConfig(),
        provider: 'missing',
        model: 'gpt-5.5',
      }),
    ).toThrow(ConfigValidationError);
  });
});

function baseConfig(): IMicaConfig {
  return {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    effort: 'low',
    contextWindowSize: 256000,
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        api_base: 'https://api.deepseek.com',
        api_key: 'test-key',
        model: 'deepseek-v4-pro',
        effort: 'low',
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
