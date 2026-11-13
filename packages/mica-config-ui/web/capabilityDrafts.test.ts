import { describe, expect, it } from 'vitest';
import { createCapabilityDraftCache, readStableCapabilityState, serializeCapabilityWrite } from './capabilityDrafts.js';
import { createAutoSaveQueue } from './autoSaveQueue.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('capability draft lifetime', () => {
  it('retains failed content after a page queue is disposed and clears only after a confirmed retry', async () => {
    const cache = createCapabilityDraftCache<{ content: string }>();
    const value = { content: 'Unsaved editing' };
    cache.remember('prompt', value);
    const queue = createAutoSaveQueue(() => ({
      save: async () => {
        throw new Error('offline');
      },
      onError: (message) => cache.fail('prompt', value, message),
    }));
    queue.schedule(value);
    await queue.flush();
    queue.dispose();
    expect(cache.read('prompt')).toEqual({ value, error: 'offline' });
    cache.confirm('prompt', cache.read('prompt')!.value);
    expect(cache.read('prompt')).toBeUndefined();
  });

  it('does not let a late response or failure erase a newer draft', () => {
    const cache = createCapabilityDraftCache<{ content: string }>();
    const old = { content: 'Old' };
    const next = { content: 'New' };
    cache.remember('prompt', old);
    cache.remember('prompt', next);
    cache.fail('prompt', old, 'late error');
    cache.confirm('prompt', old);
    expect(cache.read('prompt')).toEqual({ value: next });
  });

  it('writes the target captured with the draft even if the current runtime changes before debounce', async () => {
    const calls: string[] = [];
    const first = {
      save: async () => {
        calls.push('first');
      },
    };
    const second = {
      save: async () => {
        calls.push('second');
      },
    };
    let current = first;
    const value = { target: current };
    const queue = createAutoSaveQueue(() => ({ save: (draft: typeof value) => draft.target.save() }));
    queue.schedule(value);
    current = second;
    await queue.flush();
    queue.dispose();
    expect(calls).toEqual(['first']);
    expect(current).toBe(second);
  });

  it('serializes writes across page instances and still allows a retry after failure', async () => {
    const old = deferred<string>();
    const calls: string[] = [];
    const first = serializeCapabilityWrite('same-target', () => {
      calls.push('old');
      return old.promise;
    });
    const second = serializeCapabilityWrite('same-target', async () => {
      calls.push('new');
      return 'saved';
    });
    await Promise.resolve();
    expect(calls).toEqual(['old']);
    old.reject(new Error('old failed'));
    await expect(first).rejects.toThrow('old failed');
    await expect(second).resolves.toBe('saved');
    expect(calls).toEqual(['old', 'new']);
  });

  it('reloads when a departing page saves after new reads begin but before a slow runtime read finishes', async () => {
    const cache = createCapabilityDraftCache<{ disabledPlugins: string[] }>();
    const value = { disabledPlugins: ['notes'] };
    let disk = { disabledPlugins: [] as string[] };
    cache.remember('prompt', value);
    const saving = deferred<void>();
    const runtime = deferred<void>();
    const save = serializeCapabilityWrite('navigation-regression', async () => {
      await saving.promise;
      disk = value;
    }).then(() => cache.confirm('prompt', value));
    let reads = 0;
    const loading = readStableCapabilityState(async () => {
      reads += 1;
      const snapshot = structuredClone(disk);
      await runtime.promise;
      return snapshot;
    });

    saving.resolve();
    await save;
    expect(cache.read('prompt')).toBeUndefined();
    runtime.resolve();
    expect(await loading).toEqual(value);
    expect(reads).toBe(2);
  });
});
