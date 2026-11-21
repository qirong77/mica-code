import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHistoryStore } from './store.js';
import { contentId, normalizeSettings, togglePin } from './model.js';

const settings = normalizeSettings({});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function snapshot(text: string) {
  return {
    text,
    types: ['public.utf8-plain-text'],
    items: [{ types: [{ type: 'public.utf8-plain-text', data: Buffer.from(text).toString('base64') }] }],
    source: { name: 'TextEdit', bundleId: 'com.apple.TextEdit' },
    files: [],
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mica-maccy-store-'));
  const store = createHistoryStore(directory);
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  cleanups.push(() => store.dispose());
  return { directory, store };
}

describe('private clipboard persistence', () => {
  it('persists payloads separately with private permissions, and restores them after reopening', async () => {
    const { directory, store } = await fixture();
    const clip = snapshot('有格式的本地文字');
    const result = await store.record(clip, settings, 100);
    const state = await store.read();
    expect(result.recorded).toBe(true);
    expect(state.items).toHaveLength(1);
    expect(state.items[0].id).toBe(contentId(clip.items));
    expect(await store.payload(state.items[0].id)).toMatchObject({ text: clip.text, schemaVersion: 1 });
    expect((await stat(join(directory, 'history.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'clips'))).mode & 0o777).toBe(0o700);
    const reopened = createHistoryStore(directory);
    cleanups.push(() => reopened.dispose());
    expect(await reopened.read()).toEqual(state);
    expect(await readFile(join(directory, 'history.json'), 'utf8')).not.toContain('base64');
  });

  it('serializes independent writers and retains pin edits while a repeated copy updates its count', async () => {
    const { directory, store } = await fixture();
    const other = createHistoryStore(directory);
    cleanups.push(() => other.dispose());
    await Promise.all([
      store.record(snapshot('first'), settings, 100),
      other.record(snapshot('second'), settings, 101),
    ]);
    const id = contentId(snapshot('first').items);
    await store.mutate((state) => togglePin(state, id));
    await other.record(snapshot('first'), settings, 102);
    const state = await store.read();
    expect(state.items).toHaveLength(2);
    expect(state.items.find((item: any) => item.id === id)).toMatchObject({
      pinned: true,
      copyCount: 2,
      lastCopiedAt: 102,
    });
  });

  it('never writes confidential data, honors pause, and consumes ignore-next without receiving its content', async () => {
    const { directory, store } = await fixture();
    await store.record(
      { ...snapshot('secret'), types: ['public.utf8-plain-text', 'org.nspasteboard.ConcealedType'] },
      settings,
    );
    expect((await store.read()).items).toEqual([]);
    await store.mutate((state) => ({ ...state, paused: true }));
    await store.record(snapshot('paused secret'), settings);
    await store.mutate((state) => ({ ...state, paused: false, ignoreNext: true }));
    await store.record(null, settings);
    expect(await store.read()).toMatchObject({ items: [], ignoreNext: false });
    expect(await readFile(join(directory, 'history.json'), 'utf8')).not.toContain('secret');
    await store.record(snapshot('allowed'), settings);
    expect((await store.read()).items).toHaveLength(1);
  });

  it('removes only evicted payloads and keeps pinned content through pruning', async () => {
    const { store } = await fixture();
    const small = normalizeSettings({ historySize: '1' });
    await store.record(snapshot('pin'), small, 100);
    const pinnedId = contentId(snapshot('pin').items);
    await store.mutate((state) => togglePin(state, pinnedId));
    await store.record(snapshot('evicted'), small, 101);
    const evictedId = contentId(snapshot('evicted').items);
    await store.record(snapshot('retained'), small, 102);
    expect((await store.read()).items).toHaveLength(2);
    expect((await store.payload(pinnedId)).text).toBe('pin');
    await expect(store.payload(evictedId)).rejects.toThrow('移除');
    await expect(store.payload('../history')).rejects.toThrow();
  });

  it('makes text beyond the metadata preview searchable without storing it in the index', async () => {
    const { store } = await fixture();
    const text = `${'prefix '.repeat(200)}uniquely-searchable-tail`;
    await store.record(snapshot(text), settings);
    const state = await store.read();
    expect(state.items[0].textPreview).not.toContain('uniquely-searchable-tail');
    expect((await store.textIndex(state.items)).get(state.items[0].id)).toBe(text);
  });

  it('refuses to overwrite a corrupt history file', async () => {
    const { directory, store } = await fixture();
    await store.read();
    const original = '{"schemaVersion":1,"items":';
    await writeFile(join(directory, 'history.json'), original, { mode: 0o600 });
    await expect(store.record(snapshot('new'), settings)).rejects.toThrow('保留原文件');
    expect(await readFile(join(directory, 'history.json'), 'utf8')).toBe(original);
  });
});
