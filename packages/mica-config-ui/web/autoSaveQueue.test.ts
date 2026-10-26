import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutoSaveQueue, type AutoSaveOptions } from './autoSaveQueue.js';

type Recorded = { saves: string[]; saved: string[]; errors: string[]; statuses: (string | null)[] };

/** 造一个可手动放行的 save：测试自己决定每个请求何时返回。 */
function createHarness(options: { debounceMs?: number; failOn?: string[] } = {}) {
  const recorded: Recorded = { saves: [], saved: [], errors: [], statuses: [] };
  const gates: { value: string; resolve(): void; reject(error: Error): void }[] = [];
  const settings: AutoSaveOptions<string, string> = {
    debounceMs: options.debounceMs ?? 400,
    save: (value) =>
      new Promise<string>((resolve, reject) => {
        recorded.saves.push(value);
        gates.push({ value, resolve: () => resolve(`saved:${value}`), reject });
      }),
    onSaved: (result, value) => recorded.saved.push(`${result}|${value}`),
    onError: (message) => recorded.errors.push(message),
    onStatusChange: (status) => recorded.statuses.push(status),
  };
  const queue = createAutoSaveQueue<string, string>(() => settings);
  return { queue, recorded, gates, settings };
}

/** 让 drain 里 await 的 Promise 链跑完。 */
async function settle() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe('createAutoSaveQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounce 里连续输入只写最后一次', async () => {
    const { queue, recorded, gates } = createHarness();
    queue.schedule('a');
    queue.schedule('ab');
    queue.schedule('abc');
    expect(recorded.saves).toEqual([]);

    await vi.advanceTimersByTimeAsync(400);
    expect(recorded.saves).toEqual(['abc']);

    gates[0]!.resolve();
    await settle();
    expect(recorded.saved).toEqual(['saved:abc|abc']);
  });

  it('请求在飞时的新改动会在返回后补发，不覆盖用户的新输入', async () => {
    const { queue, recorded, gates } = createHarness();
    queue.schedule('first');
    await vi.advanceTimersByTimeAsync(400);
    expect(recorded.saves).toEqual(['first']);

    queue.schedule('second');
    gates[0]!.resolve();
    await settle();
    // 第一次的响应晚于用户的新输入，不能拿它刷新编辑器。
    expect(recorded.saved).toEqual([]);
    expect(recorded.saves).toEqual(['first', 'second']);

    gates[1]!.resolve();
    await settle();
    expect(recorded.saved).toEqual(['saved:second|second']);
  });

  it('失败只报错、不回滚，下一次改动会重试', async () => {
    const { queue, recorded, gates } = createHarness();
    queue.schedule('bad');
    await vi.advanceTimersByTimeAsync(400);
    gates[0]!.reject(new Error('配置校验失败'));
    await settle();
    expect(recorded.errors).toEqual(['配置校验失败']);
    expect(recorded.saved).toEqual([]);

    queue.schedule('good');
    await vi.advanceTimersByTimeAsync(400);
    gates[1]!.resolve();
    await settle();
    expect(recorded.saved).toEqual(['saved:good|good']);
    expect(recorded.statuses).toContain('saved');
  });

  it('flush 立刻发出待发内容并等到写完', async () => {
    const { queue, recorded, gates } = createHarness();
    queue.schedule('pending');
    const flushed = queue.flush();
    await settle();
    expect(recorded.saves).toEqual(['pending']);

    gates[0]!.resolve();
    await flushed;
    expect(recorded.saved).toEqual(['saved:pending|pending']);
  });

  it('cancel 丢掉还没发出的改动', async () => {
    const { queue, recorded } = createHarness();
    queue.schedule('dropped');
    queue.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(recorded.saves).toEqual([]);
  });

  it('dispose 会把最后一批改动发出去，但不再回报状态', async () => {
    const { queue, recorded, gates } = createHarness();
    queue.schedule('last');
    queue.dispose();
    await settle();
    expect(recorded.saves).toEqual(['last']);
    expect(recorded.statuses).toEqual([]);

    gates[0]!.resolve();
    await settle();
    expect(recorded.saved).toEqual(['saved:last|last']);
  });
});
