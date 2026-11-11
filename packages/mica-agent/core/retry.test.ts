import { describe, expect, it } from 'vitest';
import { isRetryableError, withRetry } from './retry.js';

describe('isRetryableError', () => {
  it('treats overloaded server messages as retryable', () => {
    expect(isRetryableError(new Error('Our servers are currently overloaded. Please try again later.'))).toBe(true);
  });

  it('treats provider retryable error codes as retryable', () => {
    expect(isRetryableError(Object.assign(new Error('server is busy'), { code: 'overloaded' }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('rate limited'), { code: 'rate_limit_exceeded' }))).toBe(true);
  });

  it('treats service_unavailable_error type as retryable', () => {
    expect(isRetryableError(Object.assign(new Error('server is busy'), { type: 'service_unavailable_error' }))).toBe(
      true,
    );
  });

  it('treats server_is_overloaded and slow_down codes as retryable', () => {
    expect(isRetryableError(Object.assign(new Error('server is busy'), { code: 'server_is_overloaded' }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('server is busy'), { code: 'slow_down' }))).toBe(true);
  });

  it('does not retry aborts', () => {
    const error = new Error('Agent query aborted');
    error.name = 'AbortError';

    expect(isRetryableError(error)).toBe(false);
  });

  it('retries a gateway that failed to parse our request body', () => {
    // Go 网关读包抖动时把「合法 JSON」判成非法：重发通常就过。
    expect(
      isRetryableError(
        Object.assign(new Error("400 invalid json: invalid character '\\x00' in string literal"), { status: 400 }),
      ),
    ).toBe(true);
    expect(
      isRetryableError(
        Object.assign(
          new Error("invalid json: invalid character '\\x00' looking for beginning of object key string"),
          { status: 400 },
        ),
      ),
    ).toBe(true);
  });

  it('leaves other 400s alone', () => {
    expect(isRetryableError(Object.assign(new Error('invalid request'), { status: 400 }))).toBe(false);
    expect(
      isRetryableError(
        Object.assign(new Error("Invalid 'max_output_tokens': integer below minimum value"), { status: 400 }),
      ),
    ).toBe(false);
  });

  it.each([
    { message: '400 请求体必须是有效 JSON，最大 8MB' },
    { message: '400 invalid_json' },
    {
      message: '400 {"error":{"code":"invalid_json","message":"请求体必须是有效 JSON，最大 8MB","type":"codexgo_error"}}',
    },
    { message: 'bad request', code: 'invalid_json' },
    { message: 'bad request', error: { code: 'invalid_json' } },
  ])('retries codexgo parse failures: $message', (detail) => {
    expect(isRetryableError(Object.assign(new Error(detail.message), detail, { status: 400 }))).toBe(true);
  });

  it.each([400, 401, 403, 404, 413, 422])('keeps deterministic HTTP %s errors non-retryable', (status) => {
    const detail =
      status === 400
        ? { code: 'request_too_large', message: '请求体超过最大 8MB' }
        : { code: 'invalid_json', message: '请求体必须是有效 JSON，最大 8MB' };
    expect(isRetryableError(Object.assign(new Error(detail.message), detail, { status }))).toBe(false);
  });

  it('does not retry an aborted request even with a gateway parse error', () => {
    expect(isRetryableError({ name: 'AbortError', status: 400, code: 'invalid_json' })).toBe(false);
  });

  it.each([
    [400, 'request_incomplete'],
    [400, 'request_read_error'],
    [408, 'request_timeout'],
  ] as const)('retries codexgo HTTP %s body read failure %s', (status, code) => {
    expect(isRetryableError({ status, code })).toBe(true);
    expect(isRetryableError({ status, error: { code } })).toBe(true);
    expect(isRetryableError({ status, message: `${status} {"error":{"code":"${code}"}}` })).toBe(true);
    expect(isRetryableError({ status: 413, code })).toBe(false);
    expect(isRetryableError({ status, code, name: 'AbortError' })).toBe(false);
  });

  it('stops retrying persistent codexgo parse failures at the retry limit', async () => {
    const error = Object.assign(new Error('400 请求体必须是有效 JSON，最大 8MB'), { status: 400 });
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw error;
        },
        { maxRetries: 2, delayMs: 0 },
      ),
    ).rejects.toBe(error);
    expect(calls).toBe(3);
  });

  it('treats timeout errors as retryable', () => {
    // Bun 下 AbortSignal.timeout() 触发的 fetch 超时：name=TimeoutError、
    // code=23（数字，不匹配 code 白名单）、无 status。
    expect(
      isRetryableError(
        Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError', code: 23 }),
      ),
    ).toBe(true);
    // OpenAI SDK 的连接超时
    expect(
      isRetryableError(
        Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }),
      ),
    ).toBe(true);
    // 只带文案、没有 name 的层
    expect(isRetryableError(new Error('The operation timed out.'))).toBe(true);
  });

  it('withRetry honors a shouldRetry override', async () => {
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('transient');
        return 'ok';
      },
      { delayMs: 0, shouldRetry: () => true },
    );
    expect(calls).toBe(2);
  });

  it('withRetry shouldRetry can veto a retry', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('overloaded');
        },
        { delayMs: 0, shouldRetry: () => false },
      ),
    ).rejects.toThrow('overloaded');
    expect(calls).toBe(1);
  });
});
