import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IMicaConfig } from './config.js';
import {
  DEFAULT_PROVIDER_PROTOCOL,
  ConfigValidationError,
  applyConfigDefaultsToFile,
  assertValidConfig,
  validateConfig,
} from '../../buildin-plugins/validate-config.mjs';

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

describe('startup config validation', () => {
  it('fills a missing provider protocol and persists the migrated config', () => {
    const configPath = join(tempHome, 'legacy-config.json');
    writeFileSync(
      configPath,
      `${JSON.stringify({ providers: [{ id: 'legacy', api_base: 'https://example.com' }] })}\n`,
      'utf-8',
    );

    const result = applyConfigDefaultsToFile(configPath);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      providers: Array<{ protocol?: string }>;
    };

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(persisted.providers[0]?.protocol).toBe(DEFAULT_PROVIDER_PROTOCOL);
  });

  it('reports invalid provider fields and throws a readable startup error', () => {
    const result = validateConfig({
      providers: [{ id: 'broken', api_base: '', protocol: 'unsupported' }],
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'provider_api_base_empty', path: 'providers[0].api_base' }),
        expect.objectContaining({ code: 'provider_protocol_invalid', path: 'providers[0].protocol' }),
      ]),
    );
    expect(() => assertValidConfig(result, '/tmp/config.json')).toThrow(ConfigValidationError);
    expect(() => assertValidConfig(result, '/tmp/config.json')).toThrow('配置文件有问题：/tmp/config.json');
  });

  it('validates MCP server shapes while keeping a missing provider API key non-blocking', () => {
    const result = validateConfig({
      providers: [{ id: 'local', api_base: 'https://example.com' }],
      mcpServers: {
        broken: { command: '', args: [1] },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'warning', code: 'provider_api_key_missing' }),
        expect.objectContaining({ severity: 'error', code: 'mcp_server_command_invalid' }),
        expect.objectContaining({ severity: 'error', code: 'mcp_server_args_invalid' }),
      ]),
    );
  });
});

describe('model configuration', () => {
  it('resolves fixed effort request parameters', () => {
    const deepseek = baseConfig().providers[0]!;

    expect(configApi.resolveChatCompletionsEffortParams(deepseek, 'xhigh')).toEqual({
      reasoning_effort: 'xhigh',
    });
    expect(configApi.resolveChatCompletionsEffortParams(deepseek, 'none')).toEqual({});
  });

  it('uses the fixed rule for every model', () => {
    const krill = baseConfig().providers[1]!;
    const openai = {
      ...krill,
      id: 'openai',
      api_base: 'https://api.openai.com/v1',
    };

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

    expect(configApi.resolveChatCompletionsEffortParams(zai, 'xhigh')).toEqual({
      reasoning_effort: 'xhigh',
    });
    expect(configApi.resolveChatCompletionsEffortParams(kimi, 'high')).toEqual({
      reasoning_effort: 'high',
    });
    expect(configApi.resolveChatCompletionsEffortParams(disabledProvider, 'high')).toEqual({});
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
    globalThis.fetch = vi.fn(async () => ({
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
    globalThis.fetch = vi.fn(async () => ({
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

  it('preserves a configured model that is absent from a dynamic catalog', async () => {
    const provider = {
      id: 'partial-catalog',
      name: 'Partial Catalog',
      api_base: 'https://example.com/v1',
      api_key: 'test-key',
      protocol: 'openai_chat_completions' as const,
      get_model_url: 'https://example.com/v1/models',
    };
    configApi.updateConfig(() => ({
      provider: provider.id,
      model: 'configured-model',
      effort: 'medium',
      contextWindowSize: 256000,
      providers: [provider],
    }));
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'catalog-model' }] }),
      text: async () => '',
    })) as unknown as typeof fetch;

    await configApi.loadProviderModels(provider.id);

    expect(configApi.getConfig().model).toBe('configured-model');
    expect(configApi.getConfig().providers[0]?.models).toEqual(['configured-model', 'catalog-model']);
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
