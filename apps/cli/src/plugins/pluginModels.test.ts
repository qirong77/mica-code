import { describe, expect, it, vi } from 'vitest';
import type { AgentUsageRecord, ModelClientOptions } from '@packages/mica-agent/index.js';
import { createPluginLlmApi } from '@packages/mica-plugin/index.js';
import { createPluginModels, recordPluginModelUsage, type PluginModelClient } from './pluginModels.js';

const usage: AgentUsageRecord = {
  provider: 'plugin:session-rename',
  turnId: 0,
  requestIndex: 0,
  messageCount: 2,
  model: 'mini',
  inputTokens: 120,
  cachedInputTokens: 0,
  outputTokens: 30,
  totalTokens: 150,
  paidTokenRate: 1,
  occurredAt: '2026-10-28T00:00:00.000Z',
};

function fakeClient(
  _options: ModelClientOptions,
  behaviour: { text?: string; error?: Error; usage?: AgentUsageRecord },
): PluginModelClient {
  return {
    query: async () => {
      if (behaviour.error) throw behaviour.error;
      return behaviour.text ?? '';
    },
    usageHistory: behaviour.usage ? [behaviour.usage] : [],
    lastUsage: behaviour.usage,
  } as unknown as PluginModelClient;
}

const baseRequest = {
  purpose: '自动起标题',
  system: 'system',
  user: 'user',
  model: 'mini',
  baseUrl: 'https://api.example.test/v1',
  apiKey: 'sk-test',
  protocol: 'openai_chat_completions' as const,
};

const entry = {
  pluginId: 'session-rename',
  purpose: '自动起标题',
  model: 'mini',
  requests: [usage],
  status: 'completed' as const,
  startedAt: '2026-10-28T00:00:00.000Z',
  finishedAt: '2026-10-28T00:00:02.000Z',
};

describe('createPluginModels', () => {
  it('returns the text and reports the usage back to the plugin', async () => {
    const models = createPluginModels({
      createClient: (options) => fakeClient(options, { text: '修复登录超时', usage }),
    });

    const result = await models('session-rename', baseRequest);

    expect(result).toEqual({
      text: '修复登录超时',
      usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 0, totalTokens: 150 },
    });
  });

  it('declares an independent provider with effort disabled', async () => {
    let seen: ModelClientOptions | undefined;
    const models = createPluginModels({
      createClient: (options) => {
        seen = options;
        return fakeClient(options, { text: 'ok' });
      },
    });

    await models('commit', { ...baseRequest, protocol: 'openai_responses' });

    expect(seen).toMatchObject({
      model: 'mini',
      apiKey: 'sk-test',
      baseURL: 'https://api.example.test/v1',
      effort: 'none',
    });
    expect(seen?.provider).toMatchObject({
      api_base: 'https://api.example.test/v1',
      protocol: 'openai_responses',
      models: ['mini'],
      supportsEffort: false,
    });
  });

  it('records every finished request so the plugin spend shows up in Stats', async () => {
    const record = vi.fn();
    const models = createPluginModels({
      record,
      createClient: (options) => fakeClient(options, { text: 'ok', usage }),
    });

    await models('session-rename', baseRequest);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({
      pluginId: 'session-rename',
      purpose: '自动起标题',
      model: 'mini',
      status: 'completed',
      requests: [usage],
    });
  });

  it('does not write an empty record when the failed request produced no usage', async () => {
    const record = vi.fn();
    const models = createPluginModels({
      record,
      createClient: (options) => fakeClient(options, { error: new Error('HTTP 401') }),
    });

    await expect(models('commit', baseRequest)).rejects.toThrow('HTTP 401');
    expect(record).not.toHaveBeenCalled();
  });

  it('aborts the request when it exceeds the timeout', async () => {
    let signal: AbortSignal | undefined;
    const models = createPluginModels({
      createClient: () =>
        ({
          query: (_text: string, queryOptions: { signal?: AbortSignal } = {}) => {
            signal = queryOptions.signal;
            return new Promise<string>((_resolve, reject) => {
              queryOptions.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
          },
          usageHistory: [],
          lastUsage: undefined,
        }) as unknown as PluginModelClient,
    });

    await expect(models('session-rename', { ...baseRequest, timeoutMs: 5 })).rejects.toThrow(/超时/);
    expect(signal?.aborted).toBe(true);
  });

  it('refuses a half-configured endpoint', async () => {
    const models = createPluginModels();
    await expect(models('commit', { ...baseRequest, model: ' ' })).rejects.toThrow(/接口地址或模型/);
  });
});

describe('recordPluginModelUsage', () => {
  it('writes a plugin-tagged record and saves when the turn is idle', () => {
    const recordSubagentUsage = vi.fn();
    const save = vi.fn();

    recordPluginModelUsage(entry, { agent: { recordSubagentUsage, isRunning: false }, save });

    expect(recordSubagentUsage).toHaveBeenCalledTimes(1);
    expect(recordSubagentUsage.mock.calls[0]![0]).toMatchObject({
      origin: 'plugin',
      pluginId: 'session-rename',
      subagentType: 'plugin:session-rename',
      description: '自动起标题',
      status: 'completed',
      requests: [usage],
    });
    expect(save).toHaveBeenCalled();
  });

  it('stays in memory while the turn keeps running', () => {
    const save = vi.fn();

    recordPluginModelUsage(entry, { agent: { recordSubagentUsage: vi.fn(), isRunning: true }, save });

    expect(save).not.toHaveBeenCalled();
  });

  it('does nothing when the host has no session (mica commit)', () => {
    const save = vi.fn();
    recordPluginModelUsage(entry, { agent: null, save });
    expect(save).not.toHaveBeenCalled();
  });
});

describe('createPluginModels follow-main', () => {
  it('resolves the endpoint from the host instead of the plugin', async () => {
    const built: { baseURL?: string; apiKey?: string; model?: string } = {};
    const models = createPluginModels({
      resolveMainProvider: () => ({
        baseUrl: 'https://main.test/v1',
        apiKey: 'main-key',
        protocol: 'openai_responses',
        model: 'main-model',
      }),
      createClient: ((options: { baseURL?: string; apiKey?: string; model?: string }) => {
        built.baseURL = options.baseURL;
        built.apiKey = options.apiKey;
        built.model = options.model;
        return { query: async () => 'ok', usageHistory: [] };
      }) as never,
    });

    await models('commit', { ...baseRequest, useMainProvider: true, baseUrl: '', model: '' });

    // 插件给的是空地址，实际打到宿主解析出的主配置接口上。
    expect(built).toEqual({
      baseURL: 'https://main.test/v1',
      apiKey: 'main-key',
      model: 'main-model',
    });
  });

  it('uses the model the plugin names while following the main endpoint', async () => {
    const seen: { model?: string } = {};
    const models = createPluginModels({
      resolveMainProvider: (model) => {
        seen.model = model;
        return { baseUrl: 'https://main.test/v1', apiKey: 'k', protocol: 'openai_chat_completions', model: 'picked' };
      },
      record: () => {},
      createClient: ((options: { model: string }) => ({
        query: async () => {
          seen.model = options.model;
          return 'ok';
        },
        usageHistory: [],
      })) as never,
    });

    await models('commit', { ...baseRequest, useMainProvider: true, baseUrl: '', model: 'cheap/cheap-model' });

    // 解析器拿到插件点名的模型（决定 provider），实际请求也用它。
    expect(seen.model).toBe('cheap/cheap-model');
  });

  it('fails loudly when the host cannot resolve the main provider', async () => {
    const models = createPluginModels();
    await expect(models('commit', { ...baseRequest, useMainProvider: true, baseUrl: '', model: '' })).rejects.toThrow(
      /没有提供主配置/,
    );
  });
});

describe('ctx.llm fallback through the host', () => {
  it('retries on the main endpoint and model after the plugin endpoint fails', async () => {
    const built: Array<{ baseURL?: string; apiKey?: string; model?: string }> = [];
    const models = createPluginModels({
      resolveMainProvider: () => ({
        baseUrl: 'https://main.test/v1',
        apiKey: 'main-key',
        protocol: 'openai_chat_completions',
        model: 'main-model',
      }),
      createClient: ((options: { baseURL?: string; apiKey?: string; model?: string }) => {
        built.push({ baseURL: options.baseURL, apiKey: options.apiKey, model: options.model });
        return {
          query: async () => {
            if (options.baseURL === 'https://own.test/v1') throw new Error('404 model not found');
            return 'ok';
          },
          usageHistory: [],
        };
      }) as never,
    });
    const llm = createPluginLlmApi({
      spec: {},
      readValues: () => ({ useMainProvider: 'false', baseUrl: 'https://own.test/v1', apiKey: 'k', model: 'gone' }),
      models: (request) => models('commit', request),
    });

    await expect(llm.request({ purpose: 'p', system: 's', user: 'u' })).resolves.toMatchObject({ text: 'ok' });

    // 第二次真的换了地址、Key 与模型：降级不是「同一个请求再发一遍」。
    expect(built).toEqual([
      { baseURL: 'https://own.test/v1', apiKey: 'k', model: 'gone' },
      { baseURL: 'https://main.test/v1', apiKey: 'main-key', model: 'main-model' },
    ]);
  });
});
