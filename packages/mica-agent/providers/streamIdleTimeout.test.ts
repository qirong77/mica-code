import { afterEach, describe, expect, it, vi } from 'vitest';
import { withIdleTimeout, STREAM_IDLE_TIMEOUT_MS } from '../core/streamIdleTimeout.js';
import { isRetryableError } from '../core/retry.js';
afterEach(() => vi.useRealTimers());
describe('withIdleTimeout', () => {
  it('passes every event through and completes normally', async () => {
    const events: number[] = [];
    for await (const event of withIdleTimeout(streamOf<number>(1, 2, 3))) events.push(event);
    expect(events).toEqual([1, 2, 3]);
  });

  it('throws a retryable timeout error when the stream goes silent', async () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    const silent = (async function* () {
      yield 'first';
      await new Promise(() => {});
    })();
    const promise = (async () => {
      for await (const event of withIdleTimeout(silent)) seen.push(event);
    })();
    // 先接管拒绝：超时发生在 advanceTimersByTimeAsync 内部，等推进完再断言会
    // 让 Node 在两者之间先报一次 unhandledRejection。
    const settled = promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1);
    expect(seen).toEqual(['first']);

    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toMatchObject({ name: 'TimeoutError' });
    expect(String(((await settled) as Error).message)).toMatch(/No stream data from provider for 60s/);
    expect(isRetryableError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
  });
});

async function* streamOf<T>(...items: T[]) {
  yield* items;
}
