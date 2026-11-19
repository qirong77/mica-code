import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConsoleViewController, resetLastSnapshot } from './console-view.js';

const snapshot = (id: string) => ({ version: 1, generatedAt: id, id });

describe('Harness console view refresh policy', () => {
  beforeEach(() => resetLastSnapshot());
  afterEach(() => {
    vi.useRealTimers();
    resetLastSnapshot();
  });

  it('settles cancelled loading with auto-refresh off and still permits manual retry', async () => {
    let visible = true;
    const read = vi.fn((signal: AbortSignal) =>
      read.mock.calls.length === 1
        ? new Promise<object>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          )
        : Promise.resolve(snapshot('manual')),
    );
    const controller = createConsoleViewController({ read, isVisible: () => visible, isFocused: () => true });
    const unmount = controller.mount();
    const pending = controller.refresh();
    await Promise.resolve();
    controller.setAutoRefresh(false);
    visible = false;
    controller.syncActivity();
    await pending;
    expect(controller.getState()).toMatchObject({ loading: false, refreshing: false, error: '', autoRefresh: false });
    visible = true;
    controller.syncActivity();
    expect(read).toHaveBeenCalledTimes(1);
    await controller.refresh();
    expect(controller.getState().snapshot).toEqual(snapshot('manual'));
    expect(read).toHaveBeenCalledTimes(2);
    unmount();
    controller.dispose();
  });

  it('waits for a cancelled request to drain before a rapid focus catch-up read', async () => {
    let visible = true;
    let finish!: (value: object) => void;
    const read = vi.fn(() =>
      read.mock.calls.length === 1
        ? new Promise<object>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(snapshot('restored')),
    );
    const controller = createConsoleViewController({ read, isVisible: () => visible, isFocused: () => true });
    const unmount = controller.mount();
    const pending = controller.refresh();
    await Promise.resolve();
    visible = false;
    controller.syncActivity();
    visible = true;
    controller.syncActivity();
    expect(read).toHaveBeenCalledTimes(1);
    finish(snapshot('cancelled-old'));
    await pending;
    await controller.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toMatchObject({ snapshot: snapshot('restored'), loading: false, refreshing: false });
    unmount();
    controller.dispose();
  });

  it('keeps the previous snapshot when a refresh fails', async () => {
    let attempt = 0;
    const controller = createConsoleViewController({
      read: async () => {
        attempt += 1;
        if (attempt > 1) throw new Error('暂时不可读');
        return snapshot('first');
      },
      isVisible: () => true,
      isFocused: () => true,
    });
    const unmount = controller.mount();
    await controller.refresh();
    expect(controller.getState().snapshot).toEqual(snapshot('first'));
    await expect(controller.refresh()).rejects.toThrow('暂时不可读');
    expect(controller.getState()).toMatchObject({
      snapshot: snapshot('first'),
      error: '运行快照刷新失败，请稍后重试；已有统计仍保留。',
      loading: false,
    });
    unmount();
    controller.dispose();
  });

  it('does not write a late result after unmount and cancels its request', async () => {
    let resolveRead!: (value: unknown) => void;
    let aborted = false;
    const controller = createConsoleViewController({
      read: (signal) =>
        new Promise((resolve) => {
          resolveRead = resolve;
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
            },
            { once: true },
          );
        }),
      isVisible: () => true,
      isFocused: () => true,
    });
    const unmount = controller.mount();
    await Promise.resolve();
    unmount();
    resolveRead(snapshot('late'));
    await Promise.resolve();
    expect(aborted).toBe(true);
    expect(controller.getState().snapshot).toBeNull();
    controller.dispose();
  });

  it('pauses while hidden, then performs one catch-up read on restore without overlap', async () => {
    vi.useFakeTimers();
    let visible = true;
    let focused = true;
    let reads = 0;
    const controller = createConsoleViewController({
      intervalMs: 30,
      read: async () => {
        reads += 1;
        return snapshot(String(reads));
      },
      isVisible: () => visible,
      isFocused: () => focused,
    });
    const unmount = controller.mount();
    await vi.runAllTicks();
    expect(reads).toBe(1);
    visible = false;
    focused = false;
    controller.syncActivity();
    await vi.advanceTimersByTimeAsync(100);
    expect(reads).toBe(1);
    visible = true;
    focused = true;
    controller.syncActivity();
    await vi.runAllTicks();
    expect(reads).toBe(2);
    unmount();
    controller.dispose();
  });
});
