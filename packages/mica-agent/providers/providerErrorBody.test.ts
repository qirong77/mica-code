import { describe, expect, it, vi } from 'vitest';
import { PiModelClient } from './PiModelClient.js';
import { errorMessageFromBody, fetchWithReadableErrors } from './providerErrorBody.js';

function responseWith(body: string, status = 400): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function fetchStub(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

describe('errorMessageFromBody', () => {
  it('reads the reason a gateway puts in detail or message', () => {
    expect(errorMessageFromBody('{"detail":"System messages are not allowed"}')).toBe(
      'System messages are not allowed',
    );
    expect(errorMessageFromBody('{"message":"model is overloaded"}')).toBe('model is overloaded');
    expect(errorMessageFromBody('{"detail":[{"msg":"field required"}]}')).toBe('[{"msg":"field required"}]');
  });

  it('leaves bodies the OpenAI SDK already understands alone', () => {
    expect(errorMessageFromBody('{"error":{"message":"bad request","type":"invalid_request_error"}}')).toBeUndefined();
    expect(errorMessageFromBody('400 upstream rejected the request')).toBeUndefined();
    expect(errorMessageFromBody('')).toBeUndefined();
    expect(errorMessageFromBody('{"detail":""}')).toBeUndefined();
  });
});

describe('fetchWithReadableErrors', () => {
  it('returns successful responses untouched', async () => {
    const original = new Response('{"ok":true}', { status: 200 });
    const response = await fetchWithReadableErrors(fetchStub(original))('http://gateway.test/v1');
    expect(response).toBe(original);
  });

  it('keeps the status and body when there is nothing to rewrite', async () => {
    const response = await fetchWithReadableErrors(fetchStub(responseWith('upstream exploded', 400)))(
      'http://gateway.test/v1',
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('upstream exploded');
  });

  it('rewrites a detail-only body so the reason survives the SDK', async () => {
    const response = await fetchWithReadableErrors(
      fetchStub(responseWith('{"detail":"System messages are not allowed"}')),
    )('http://gateway.test/v1');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: 'System messages are not allowed' } });
  });

  it('preserves top-level error codes and types when rewriting a gateway body', async () => {
    const response = await fetchWithReadableErrors(
      fetchStub(responseWith('{"message":"body read failed","code":"request_read_error","type":"codexgo_error"}')),
    )('http://gateway.test/v1');
    expect(await response.json()).toEqual({
      error: { message: 'body read failed', code: 'request_read_error', type: 'codexgo_error' },
    });
  });

  it('surfaces the gateway detail instead of "400 status code (no body)"', async () => {
    vi.useFakeTimers();
    // 每次请求都要给一个新的 Response：body 只能读一次，重试会复用同一份响应。
    const stub = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((async () => responseWith('{"detail":"System messages are not allowed"}')) as unknown as typeof fetch);
    const client = new PiModelClient({
      model: 'test-model', tools: false, systemPrompt: 'test',
      apiKey: 'test-key',
      baseURL: 'http://gateway.test/v1',
      provider: { id: 'test', protocol: 'openai_responses', api_base: 'http://gateway.test/v1', supportsEffort: false },
    });
    try {
      const query = client.query('hi').catch((error: Error) => error);
      // 网关一直回同一个 400：重试 10 次后把原因原样报出来。
      await vi.advanceTimersByTimeAsync(210_000);
      expect(String(((await query) as Error).message)).toContain('System messages are not allowed');
      expect(stub).toHaveBeenCalledTimes(11);
    } finally {
      stub.mockRestore();
      vi.useRealTimers();
    }
  });
});
