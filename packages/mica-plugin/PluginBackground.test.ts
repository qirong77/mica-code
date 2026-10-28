import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginBackgroundScheduler } from './PluginBackground.js';

describe('plugin background scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits one interval before the first round by default', async () => {
    const run = vi.fn();
    const scheduler = createPluginBackgroundScheduler({ pluginId: 'demo', onError: vi.fn() });
    scheduler.register({ id: 'poll', every: 5_000, run });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.disposeAll();
  });

  it('honours immediate so the first round runs without waiting', async () => {
    const run = vi.fn();
    const scheduler = createPluginBackgroundScheduler({ pluginId: 'demo', onError: vi.fn() });
    scheduler.register({ id: 'poll', every: 5_000, run, immediate: true });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.disposeAll();
  });

  it('re-reads every() so a task can back off between rounds', async () => {
    const delays = [2_000, 8_000];
    let calls = 0;
    const run = vi.fn();
    const scheduler = createPluginBackgroundScheduler({ pluginId: 'demo', onError: vi.fn() });
    scheduler.register({
      id: 'poll',
      every: () => delays[Math.min(calls++, delays.length - 1)],
      run,
      immediate: true,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    // 第二轮按第一次 every() 的结果等 2s
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(2);
    // 之后退避到 8s
    await vi.advanceTimersByTimeAsync(7_999);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
    scheduler.disposeAll();
  });

  it('clamps tiny intervals instead of busy looping', async () => {
    const run = vi.fn();
    const scheduler = createPluginBackgroundScheduler({ pluginId: 'demo', onError: vi.fn() });
    scheduler.register({ id: 'poll', every: 10, run, immediate: true });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.disposeAll();
  });

  it('keeps scheduling after a failing round and reports the error', async () => {
    const onError = vi.fn();
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const scheduler = createPluginBackgroundScheduler({ pluginId: 'demo', onError });
    scheduler.register({ id: 'poll', every: 1_000, run, immediate: true });

    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith('poll', expect.any(Error));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(scheduler.list()[0]).toMatchObject({ failures: 1, ticks: 1 });
    scheduler.disposeAll();
  });

  it('dispose stops the loop and aborts an in-flight round', async () => {
    let signal: AbortSignal | undefined;
    let finish: (() => void) | undefined;
    const run = vi.fn(
      (context: { signal: AbortSignal }) =>
        new Promise<void>((resolve) => {
          signal = context.signal;
          finish = resolve;
        }),
    );
    const scheduler = createPluginBackgroundScheduler({ pluginId: 'demo', onError: vi.fn() });
    const disposable = scheduler.register({ id: 'poll', every: 1_000, run, immediate: true });

    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
    disposable.dispose();
    expect(signal?.aborted).toBe(true);
    finish?.();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.list()).toEqual([]);
  });

  it('rejects duplicate ids inside one plugin', () => {
    const scheduler = createPluginBackgroundScheduler({ pluginId: 'demo', onError: vi.fn() });
    scheduler.register({ id: 'poll', every: 1_000, run: () => {} });
    expect(() => scheduler.register({ id: 'poll', every: 1_000, run: () => {} })).toThrow(/already registered/);
    scheduler.disposeAll();
  });

  it('exposes scheduling state for status surfaces', async () => {
    const scheduler = createPluginBackgroundScheduler({ pluginId: 'demo', onError: vi.fn() });
    scheduler.register({ id: 'poll', every: 1_000, run: () => {}, immediate: true });

    await vi.advanceTimersByTimeAsync(0);
    const [state] = scheduler.list();
    expect(state).toMatchObject({ id: 'poll', running: false, ticks: 1, failures: 0 });
    expect(state.lastRunAt).not.toBeNull();
    expect(state.nextRunAt).not.toBeNull();
    scheduler.disposeAll();
  });
});
