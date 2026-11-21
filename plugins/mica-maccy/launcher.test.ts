import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import createLauncher from './launcher.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(raw: Record<string, string> = {}, platform = 'darwin') {
  const directory = await mkdtemp(join(tmpdir(), 'mica-maccy-launcher-'));
  let task: any;
  let accessible = true;
  let count = 1;
  let nextCopy: any = null;
  const actions: string[] = [];
  const disposeTask = vi.fn();
  const native = {
    start: vi.fn(async () => ({ changeCount: count, accessibility: accessible })),
    capabilities: () => ({ accessibility: accessible }),
    request: vi.fn(async (action: string, input: any = {}) => {
      actions.push(action);
      if (action === 'poll') {
        if (!nextCopy) return { changed: false, changeCount: count };
        const copy = nextCopy;
        nextCopy = null;
        return { changed: true, changeCount: ++count, ...(input.capture ? { snapshot: copy } : {}) };
      }
      if (action === 'write') return { changeCount: ++count };
      if (action === 'status') return { accessibility: accessible, supported: true };
      if (action === 'frontmost') return { pid: 42, name: 'TextEdit' };
      if (action === 'paste') return { pasted: true };
      return {};
    }),
    dispose: vi.fn(async () => {}),
  };
  const context = {
    dataDirectory: directory,
    settings: { get: () => raw, set: vi.fn(async (values) => Object.assign(raw, values)) },
    background: {
      register(value: any) {
        task = value;
        return { dispose: disposeTask };
      },
    },
    control: vi.fn(async (action: string) => {
      actions.push(`control.${action}`);
      return {};
    }),
    health: { report: vi.fn(), clear: vi.fn() },
  };
  const launcher = createLauncher(context, { native, platform });
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  cleanups.push(() => launcher.dispose());
  const poll = () => task.run({ signal: new AbortController().signal, tick: 1 });
  const copy = async (text: string, extra: Record<string, unknown> = {}) => {
    nextCopy = {
      text,
      files: [],
      source: { name: 'TextEdit', bundleId: 'com.apple.TextEdit' },
      types: ['public.utf8-plain-text'],
      items: [{ types: [{ type: 'public.utf8-plain-text', data: Buffer.from(text).toString('base64') }] }],
      ...extra,
    };
    await poll();
    return (await launcher.request('list', {})).items[0].id;
  };
  return {
    launcher,
    context,
    native,
    poll,
    copy,
    actions,
    disposeTask,
    get task() {
      return task;
    },
    setAccessible: (value: boolean) => {
      accessible = value;
    },
  };
}

describe('clipboard launcher', () => {
  it('serves small cached image thumbnails without adding image bytes to the history list', async () => {
    const value = await fixture();
    const thumbnail = 'data:image/png;base64,iVBORw0KGgo=';
    const id = await value.copy('', {
      thumbnail,
      imageWidth: 320,
      imageHeight: 200,
      types: ['public.png'],
      items: [{ types: [{ type: 'public.png', data: 'iVBORw0KGgo=' }] }],
    });
    const response = await value.launcher.request('list', {});
    expect(response.items[0]).toMatchObject({ kind: 'image', title: '图片 320×200' });
    expect(JSON.stringify(response)).not.toContain('base64');
    expect(await value.launcher.request('thumbnails', { ids: [id, '../history'] })).toEqual({
      images: { [id]: thumbnail },
    });
    expect((await value.launcher.request('detail', { id })).previewImage).toBe(thumbnail);
    await expect(value.launcher.request('thumbnails', { ids: Array(25).fill(id) })).rejects.toThrow('24');
  });
  it('registers native observation at the configured cadence and lists full-text matches', async () => {
    const value = await fixture({ clipboardCheckInterval: '250', searchMode: 'simple' });
    expect(value.task.immediate).toBe(true);
    expect(value.task.every()).toBe(250);
    const id = await value.copy(`${'prefix '.repeat(200)}hidden-search-tail`);
    const response = await value.launcher.request('list', { query: 'hidden-search-tail' });
    expect(response.items.map((item: any) => item.id)).toEqual([id]);
    expect(response.native.supported).toBe(true);
    expect(value.native.request).toHaveBeenCalledWith(
      'poll',
      expect.objectContaining({
        ignoredTypes: expect.arrayContaining(['org.nspasteboard.ConcealedType']),
        capture: true,
      }),
    );
  });

  it('copies an item without pasting and closes the floating window', async () => {
    const value = await fixture();
    const id = await value.copy('copy me');
    value.actions.length = 0;
    expect(await value.launcher.request('select', { id, mode: 'copy' })).toEqual({ ok: true, pasted: false });
    expect(value.actions).toEqual(['write', 'control.close']);
    const detail = await value.launcher.request('detail', { id });
    expect(detail.text).toBe('copy me');
    expect(detail.item.copyCount).toBe(2);
  });

  it('captures the original target, restores plain text, then hides before sending the paste event', async () => {
    const value = await fixture();
    const id = await value.copy('paste me');
    value.actions.length = 0;
    expect(await value.launcher.request('select', { id, mode: 'plain' })).toEqual({ ok: true, pasted: true });
    expect(value.actions).toEqual(['frontmost', 'write', 'status', 'control.close', 'paste']);
    expect(value.native.request).toHaveBeenCalledWith('write', expect.objectContaining({ plain: true }));
    expect(value.native.request).toHaveBeenCalledWith('paste', { targetPid: 42 });
  });

  it('keeps an actionable permission error visible after copying successfully', async () => {
    const value = await fixture();
    const id = await value.copy('permission test');
    value.setAccessible(false);
    value.actions.length = 0;
    await expect(value.launcher.request('select', { id, mode: 'paste' })).rejects.toThrow('已复制到剪贴板');
    expect(value.actions).toEqual(['frontmost', 'write', 'status']);
    expect(value.context.control).not.toHaveBeenCalled();
  });

  it('skips a new clipboard change while ignore-next is armed, without asking native code for its payload', async () => {
    const value = await fixture();
    await value.copy('retained');
    await value.launcher.request('ignoreNext', {});
    await value.copy('ignored');
    const state = await value.launcher.request('list', {});
    expect(state.ignoreNext).toBe(false);
    expect(state.items).toHaveLength(1);
    expect(state.items[0].title).toBe('retained');
    expect(value.native.request).toHaveBeenCalledWith('poll', expect.objectContaining({ capture: false }));
  });

  it('cancels before side effects and releases monitoring when disabled', async () => {
    const value = await fixture();
    const id = await value.copy('do not paste');
    const controller = new AbortController();
    controller.abort();
    value.actions.length = 0;
    await expect(
      value.launcher.request('select', { id, mode: 'paste' }, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(value.actions).toEqual([]);
    await value.launcher.dispose();
    expect(value.disposeTask).toHaveBeenCalledOnce();
    expect(value.native.dispose).toHaveBeenCalledOnce();
    await expect(value.launcher.request('list', {})).rejects.toThrow('关闭');
    cleanups.pop();
  });

  it('reports unsupported hosts without reading their clipboard', async () => {
    const value = await fixture({}, 'linux');
    await value.poll();
    const response = await value.launcher.request('list', {});
    expect(response.native).toMatchObject({ supported: false, error: expect.stringContaining('macOS') });
    expect(value.native.start).not.toHaveBeenCalled();
  });
});
