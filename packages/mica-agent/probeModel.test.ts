import { describe, expect, it } from 'vitest';
import { probeModelConnection } from './probeModel.js';

/**
 * 试连只关心「这条请求能不能走通」，所以这里注入一个假客户端，不去碰真 provider。
 * 与插件运行时共用 `runModelTextRequest`，因此协议、超时、错误归一化是同一套。
 */
function stubClient(reply: string | Error) {
  const calls: string[] = [];
  return {
    calls,
    createClient: () =>
      ({
        usageHistory: [],
        query: async (input: string) => {
          calls.push(input);
          if (reply instanceof Error) throw reply;
          return reply;
        },
      }) as never,
  };
}

describe('probeModelConnection', () => {
  it('reports success with latency, model and a short reply', async () => {
    const stub = stubClient('OK');

    const result = await probeModelConnection(
      { baseUrl: 'https://api.test/v1', apiKey: 'sk-test-key', model: 'mini' },
      { createClient: stub.createClient },
    );

    expect(result).toMatchObject({ ok: true, message: '', model: 'mini', reply: 'OK' });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(stub.calls).toHaveLength(1);
  });

  it('asks for the cheapest possible answer', async () => {
    const stub = stubClient('OK');
    await probeModelConnection(
      { baseUrl: 'https://api.test/v1', model: 'mini' },
      { createClient: stub.createClient },
    );
    expect(stub.calls[0]).toContain('OK');
  });

  it('refuses to send anything when address or model is missing', async () => {
    const stub = stubClient('OK');

    const result = await probeModelConnection(
      { baseUrl: '  ', model: '' },
      { createClient: stub.createClient },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('接口地址与模型');
    expect(stub.calls).toHaveLength(0);
  });

  it('turns auth failures into an instruction instead of raw provider text', async () => {
    const stub = stubClient(new Error('401 Unauthorized: invalid api key'));

    const result = await probeModelConnection(
      { baseUrl: 'https://api.test/v1', apiKey: 'sk-test-key', model: 'mini' },
      { createClient: stub.createClient },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('认证失败');
  });

  it('never echoes the api key back to the page', async () => {
    const key = 'sk-very-secret-value';
    const stub = stubClient(new Error(`network error with header Authorization: Bearer ${key}`));

    const result = await probeModelConnection(
      { baseUrl: 'https://api.test/v1', apiKey: key, model: 'mini' },
      { createClient: stub.createClient },
    );

    expect(result.message).not.toContain(key);
    expect(result.message).toContain('***');
  });
});

describe('probeModelConnection error wording', () => {
  it('explains a missing api key in Chinese instead of echoing the SDK sentence', async () => {
    const stub = {
      createClient: () =>
        ({
          usageHistory: [],
          query: async () => {
            throw new Error('Missing credentials. Please pass an `apiKey` or set `OPENAI_API_KEY`.');
          },
        }) as never,
    };

    const result = await probeModelConnection(
      { baseUrl: 'https://api.test/v1', model: 'mini' },
      { createClient: stub.createClient },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('还没有填 API Key');
  });
});
