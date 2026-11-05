import { describe, expect, it, vi } from 'vitest';
import type { AgentUsageRecord, ModelClientOptions } from '@packages/mica-agent/index.js';
import { createPluginLlmApi } from '@packages/mica-plugin/index.js';
import {
  capturePluginModelUsageRecorder,
  createPluginModels,
  type PluginModelClient,
} from './pluginModels.js';

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
  it('reports the request in the helper trace and forwards its observer callbacks', async () => {
    const finished: { outcome: string; usage?: readonly AgentUsageRecord[] }[] = [];
    const infos: unknown[] = [];
    let queryOptions: { onRequestStart?: unknown; onRequestEnd?: unknown } | undefined;
    const models = createPluginModels({
      createClient: (() => ({
        query: async (_input: unknown, options: { onRequestStart?: unknown; onRequestEnd?: unknown }) => {
          queryOptions = options;
          return 'ok';
        },
        usageHistory: [usage],
      })) as never,
      trace: (info) => {
        infos.push(info);
        return {
          onRequestStart: () => {},
          onRequestEnd: () => {},
          onRetry: () => {},
          finish: (outcome, _error, requests) => finished.push({ outcome, usage: requests }),
        };
      },
    });

    await models('session-rename', baseRequest);

    expect(infos).toMatchObject([{ pluginId: 'session-rename', purpose: '自动起标题', model: 'mini', providerId: 'plugin-helper', protocol: 'openai_chat_completions', input: 'user' }]);
    // 宿主给的三个回调必须真的递给模型客户端：否则轨迹里只有起止、没有请求边界。
    expect(typeof queryOptions?.onRequestStart).toBe('function');
    expect(typeof queryOptions?.onRequestEnd).toBe('function');
    expect(finished).toMatchObject([{ outcome: 'completed' }]);
    expect(finished[0].usage).toHaveLength(1);
  });

  it('finishes the trace with an error and never lets a broken tracer fail the request', async () => {
    const finished: string[] = [];
    const models = createPluginModels({
      createClient: (() => ({
        query: async () => {
          throw Object.assign(new Error('provider down'), { usageHistory: [usage] });
        },
        usageHistory: [],
      })) as never,
      trace: () => ({
        onRequestStart: () => {},
        onRequestEnd: () => {},
        onRetry: () => {},
        finish: (outcome) => finished.push(outcome),
      }),
    });
    await expect(models('commit', baseRequest)).rejects.toThrow('provider down');
    expect(finished).toEqual(['error']);

    const broken = createPluginModels({
      createClient: ((options: ModelClientOptions) => fakeClient(options, { text: 'fine' })) as never,
      trace: () => {
        throw new Error('trace exploded');
      },
    });
    await expect(broken('commit', baseRequest)).resolves.toMatchObject({ text: 'fine' });
  });

  it('treats a caller abort as aborted even when the client throws a plain error', async () => {
    const finished: string[] = [];
    const controller = new AbortController();
    const models = createPluginModels({
      createClient: (() => ({
        query: async () => {
          // provider 的流被中断时 SDK 常抛一个普通 Error：只有信号本身是可靠判据。
          controller.abort();
          throw new Error('The operation was aborted');
        },
        usageHistory: [],
      })) as never,
      trace: () => ({
        onRequestStart: () => {},
        onRequestEnd: () => {},
        onRetry: () => {},
        finish: (outcome) => finished.push(outcome),
      }),
    });
    await expect(models('commit', { ...baseRequest, signal: controller.signal })).rejects.toThrow();
    // 与 request:end 的口径一致：同一次中断不能在轨迹里一半算 aborted、一半算 error。
    expect(finished).toEqual(['aborted']);
  });

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

  it('does not resend or reject a successful model response when local usage persistence fails', async () => {
    const createClient = vi.fn((options: ModelClientOptions) =>
      fakeClient(options, { text: 'already paid result', usage }),
    );
    const models = createPluginModels({
      record: () => {
        throw new Error('local disk full');
      },
      createClient,
    });
    const result = await models('memory', baseRequest);
    expect(result.text).toBe('already paid result');
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('keeps the provider failure when recording partial usage also fails', async () => {
    const models = createPluginModels({
      record: () => {
        throw new Error('local disk full');
      },
      createClient: (options) => fakeClient(options, { error: new Error('provider failure'), usage }),
    });
    await expect(models('memory', baseRequest)).rejects.toThrow('provider failure');
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

  it.each([false, true])(
    'binds the usage destination before a delayed request finishes (failed: %s)',
    async (failed) => {
      let activeSession = 'original';
      const destinations: string[] = [];
      const captureRecorder = vi.fn(() => {
        const destination = activeSession;
        return () => {
          destinations.push(destination);
        };
      });
      const models = createPluginModels({
        captureRecorder,
        createClient: () =>
          ({
            query: async () => {
              activeSession = 'switched';
              if (failed) throw new Error('late failure');
              return 'ok';
            },
            usageHistory: [usage],
            lastUsage: usage,
          }) as unknown as PluginModelClient,
      });

      const request = models('memory', baseRequest);
      if (failed) await expect(request).rejects.toThrow('late failure');
      else await request;

      expect(captureRecorder).toHaveBeenCalledTimes(1);
      expect(destinations).toEqual(['original']);
    },
  );

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

describe('capturePluginModelUsageRecorder', () => {
  it('captures the session id even when a controller later resumes another session', () => {
    let sessionId = 'original';
    const recordSubagentUsageForSession = vi.fn();
    const record = capturePluginModelUsageRecorder({
      getCurrentSessionId: () => sessionId,
      recordSubagentUsageForSession,
    });
    sessionId = 'switched';

    record(entry);

    expect(recordSubagentUsageForSession).toHaveBeenCalledWith(
      'original',
      expect.objectContaining({
        origin: 'plugin',
        pluginId: 'session-rename',
        requests: [usage],
      }),
    );
  });
});

describe('createPluginModels follow-main', () => {
  it('uses the resolved provider identity in both the client and trace', async () => {
    const clients: ModelClientOptions[] = [];
    const traces: unknown[] = [];
    const models = createPluginModels({
      resolveMainProvider: () => ({ providerId: 'gateway', baseUrl: 'https://main.test/v1', apiKey: 'k', protocol: 'openai_responses', model: 'm' }),
      createClient: (options) => {
        clients.push(options);
        return fakeClient(options, { text: 'ok' });
      },
      trace: (info) => {
        traces.push(info);
        return undefined;
      },
    });
    await models('commit', { ...baseRequest, useMainProvider: true, model: '' });
    expect(clients[0]?.provider).toMatchObject({ id: 'gateway', protocol: 'openai_responses' });
    expect(traces).toMatchObject([{ providerId: 'gateway', protocol: 'openai_responses' }]);
  });

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
