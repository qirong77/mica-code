import { describe, expect, it, vi } from 'vitest';
import { createDialogStore } from './dialogState.js';

describe('dialog store', () => {
  it('resolves confirm with the user answer and clears the snapshot', async () => {
    const store = createDialogStore();
    const rejected = store.confirm({ title: '删除 Role', danger: true });

    expect(store.getSnapshot()?.kind).toBe('confirm');

    store.settle(false);
    await expect(rejected).resolves.toBe(false);
    expect(store.getSnapshot()).toBeNull();

    const accepted = store.confirm({ title: '删除 Role' });
    store.settle(true);
    await expect(accepted).resolves.toBe(true);
  });

  it('resolves prompt with the typed value, and with null when cancelled', async () => {
    const store = createDialogStore();

    const created = store.prompt({ title: '新建 Role' });
    store.settle(true, 'reviewer');
    await expect(created).resolves.toBe('reviewer');

    const dismissed = store.prompt({ title: '新建 Role' });
    store.settle(false, 'reviewer');
    await expect(dismissed).resolves.toBeNull();

    const empty = store.prompt({ title: '新建 Role' });
    store.settle(true);
    await expect(empty).resolves.toBe('');
  });

  it('queues requests and shows them one at a time', async () => {
    const store = createDialogStore();
    const first = store.confirm({ title: 'first' });
    const second = store.prompt({ title: 'second' });

    // 第二个请求排队等待，快照仍是第一个
    expect(store.getSnapshot()?.title).toBe('first');

    store.settle(true);
    await expect(first).resolves.toBe(true);
    expect(store.getSnapshot()?.kind).toBe('prompt');
    expect(store.getSnapshot()?.title).toBe('second');

    store.settle(true, 'value');
    await expect(second).resolves.toBe('value');
    expect(store.getSnapshot()).toBeNull();
  });

  it('notifies subscribers on open and close, and stops after unsubscribe', async () => {
    const store = createDialogStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const answer = store.confirm({ title: 'remove' });
    store.settle(true);
    await answer;
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    const next = store.confirm({ title: 'remove again' });
    store.settle(false);
    await next;
    expect(listener).toHaveBeenCalledTimes(2);

    // 没有待处理请求时 settle 是空操作，快照保持为 null
    store.settle(true);
    expect(store.getSnapshot()).toBeNull();
  });
});
