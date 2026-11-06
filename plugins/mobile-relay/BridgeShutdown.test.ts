import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

function harness(close: () => Promise<void>) {
  const source = readFileSync(new URL('./agent/bridge.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function stopBridge(');
  const end = source.indexOf('\nprocess.on(', start);
  const exit = vi.fn();
  const stop = runInNewContext(`let stopping = false; let pushTimer = null; ${source.slice(start, end)}; stopBridge`, {
    setTimeout,
    clearTimeout,
    requestLog: { close },
    process: { exit },
  }) as () => Promise<void>;
  return { stop, exit };
}

afterEach(() => vi.useRealTimers());

describe('bridge shutdown', () => {
  it('flushes the last request log batch before normal exit and ignores repeated shutdown', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { stop, exit } = harness(close);
    const closing = stop();
    await stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    finish();
    await closing;
    expect(exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leave a bridge alive indefinitely when the log disk stalls', async () => {
    vi.useFakeTimers();
    const { stop, exit } = harness(() => new Promise<void>(() => {}));
    void stop();
    await vi.advanceTimersByTimeAsync(999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
