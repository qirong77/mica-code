import { describe, expect, it } from 'vitest';
import {
  describeRequestError,
  isAbortError,
  REQUEST_MAX_RETRIES,
  requestRetryDelayMs,
  withRetry,
} from './retry.js';

function abort(): Error {
  return Object.assign(new Error('Agent query aborted'), { name: 'AbortError' });
}

describe('withRetry', () => {
  it('retries every failure except an abort', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('invalid request'), { status: 400 });
        if (calls === 2) throw new Error('The socket connection was closed unexpectedly');
        if (calls === 3) throw Object.assign(new Error('Our servers are currently overloaded.'), { status: 503 });
        return 'ok';
      },
      { maxRetries: REQUEST_MAX_RETRIES, delayMs: () => 0 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(4);
  });

  it('stops immediately on an abort instead of retrying', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw abort();
        },
        { maxRetries: 10, delayMs: () => 0 },
      ),
    ).rejects.toThrow('Agent query aborted');
    expect(calls).toBe(1);
  });

  it('reports each retry with its number and delay, then gives up after maxRetries', async () => {
    const seen: Array<{ attempt: number; delayMs: number }> = [];
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('boom');
        },
        {
          maxRetries: 3,
          delayMs: requestRetryDelayMs,
          onRetry: (info) => seen.push({ attempt: info.attempt, delayMs: info.delayMs }),
        },
      ),
    ).rejects.toThrow('boom');
    // 首次发送 + 3 次重试
    expect(calls).toBe(4);
    expect(seen).toEqual([
      { attempt: 1, delayMs: 2_000 },
      { attempt: 2, delayMs: 4_000 },
      { attempt: 3, delayMs: 8_000 },
    ]);
  });

  it('stops waiting as soon as the signal aborts', async () => {
    const controller = new AbortController();
    let calls = 0;
    setTimeout(() => controller.abort(), 5);
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('boom');
        },
        { maxRetries: 10, delayMs: () => 5_000, signal: controller.signal },
      ),
    ).rejects.toThrow('Agent query aborted');
    expect(calls).toBe(1);
  });
});

describe('requestRetryDelayMs', () => {
  it('doubles from 2s and caps at 30s', () => {
    expect(requestRetryDelayMs(1)).toBe(2_000);
    expect(requestRetryDelayMs(2)).toBe(4_000);
    expect(requestRetryDelayMs(4)).toBe(16_000);
    expect(requestRetryDelayMs(5)).toBe(30_000);
    expect(requestRetryDelayMs(REQUEST_MAX_RETRIES)).toBe(30_000);
  });
});

describe('isAbortError', () => {
  it('recognizes the CLI and host abort errors only', () => {
    expect(isAbortError(abort())).toBe(true);
    expect(isAbortError(Object.assign(new Error('Agent run aborted'), { name: 'AgentAbortError' }))).toBe(true);
    expect(isAbortError(new Error('socket closed'))).toBe(false);
    expect(isAbortError({ status: 503 })).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe('describeRequestError', () => {
  it('keeps the message and appends status / code when the message lacks them', () => {
    expect(describeRequestError(Object.assign(new Error('socket closed'), { status: 502 }))).toBe(
      'socket closed（HTTP 502）',
    );
    expect(describeRequestError(Object.assign(new Error('rate limited'), { code: 'rate_limit_exceeded' }))).toBe(
      'rate limited（rate_limit_exceeded）',
    );
  });

  it('does not repeat a status already present in the message', () => {
    expect(describeRequestError(Object.assign(new Error('503 Service Unavailable'), { status: 503 }))).toBe(
      '503 Service Unavailable',
    );
  });

  it('describes non-Error values', () => {
    expect(describeRequestError('plain failure')).toBe('plain failure');
  });
});
