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
