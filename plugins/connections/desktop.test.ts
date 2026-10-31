import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { emptyPeerStore, rememberPeer, type PeerStore } from './peers.js';

// Run the real component callbacks and control the render boundary. This catches
// Enter/click/blur callbacks that fire before React commits the busy state.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as Array<() => unknown> }));
vi.mock('react', async (actual) => ({
  ...(await actual<typeof import('react')>()),
  useState<T>(initial: T | (() => T)) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [
      hooks.slots[index],
      (next: T | ((previous: T) => T)) => {
        hooks.slots[index] = typeof next === 'function' ? (next as (previous: T) => T)(hooks.slots[index] as T) : next;
      },
    ];
  },
  useRef<T>(initial: T) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useMemo(factory: () => unknown, deps: unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as { deps: unknown[]; value: unknown } | undefined;
    if (!previous || deps.some((value, i) => value !== previous.deps[i]))
      hooks.slots[index] = { deps, value: factory() };
    return (hooks.slots[index] as { value: unknown }).value;
  },
  useEffect(effect: () => unknown, deps?: unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as unknown[] | undefined;
    if (!deps || !previous || deps.some((value, i) => value !== previous[i])) hooks.effects.push(effect);
    hooks.slots[index] = deps;
  },
}));
const { default: ConnectionsCard } = await import('./desktop.jsx');
type Element = { type?: string | { name?: string }; props: Record<string, any> };
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object') return [];
  const element = node as Element;
  return [element, ...elements(element.props?.children)];
}
const byName = (tree: unknown, name: string) =>
  elements(tree).find((element) => typeof element.type !== 'string' && element.type?.name === name)!;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  hooks.slots = [];
  hooks.effects = [];
  hooks.cursor = 0;
  vi.stubGlobal('React', React);
});
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  let disk = rememberPeer(emptyPeerStore(), '10.0.0.2');
  const api = {
    currentHost: () => 'http://127.0.0.1:8787',
    readData: vi.fn(async () => ({ value: disk, version: 'one' })),
    writeData: vi.fn(async (next: PeerStore) => {
      disk = next;
      return { ok: true };
    }),
    probe: vi.fn(
      async (): Promise<{ ok: boolean; url?: string; access?: string; error?: string }> => ({
        ok: true,
        url: 'http://10.0.0.2:8787',
        access: 'password',
      }),
    ),
    open: vi.fn(),
  };
  const render = () => {
    hooks.cursor = 0;
    hooks.effects = [];
    const tree = ConnectionsCard({ api, onClose: undefined });
    for (const effect of hooks.effects) effect();
    return tree;
  };
  render();
  await vi.waitFor(() => expect(api.readData).toHaveBeenCalledTimes(1));
  return { api, render };
}

describe('connection card callbacks', () => {
  it('starts one probe when the same action fires twice before the next render', async () => {
    const { api, render } = await fixture();
    const probe = deferred<{ ok: boolean; error: string }>();
    api.probe.mockImplementation(() => probe.promise);
    const connect = elements(render()).find(
      (element) => element.type === 'button' && element.props.className?.includes('text-left disabled:opacity-60'),
    )!;
    connect.props.onClick();
    connect.props.onClick();
    const calls = api.probe.mock.calls.length;
    probe.resolve({ ok: false, error: 'offline' });
    await vi.waitFor(() => expect(JSON.stringify(render())).toContain('offline'));
    expect(calls).toBe(1);
  });

  it('keeps a failed note edit available for retry and only clears it after saving', async () => {
    const { api, render } = await fixture();
    byName(render(), 'NoteEditButton').props.onClick();
    byName(render(), 'NoteInput').props.onChange('Office');
    api.writeData.mockRejectedValueOnce(new Error('disk full'));
    byName(render(), 'NoteInput').props.onSave();
    await vi.waitFor(() => expect(JSON.stringify(render())).toContain('disk full'));
    const retry = byName(render(), 'NoteInput');
    expect(retry?.props.value).toBe('Office');
    retry.props.onSave();
    await vi.waitFor(() => expect(byName(render(), 'NoteInput')).toBeUndefined());
    expect(api.writeData.mock.calls.at(-1)?.[0].peers[0]?.note).toBe('Office');
    expect(JSON.stringify(render())).not.toContain('disk full');
  });
});

it('keeps a newer note draft when the previous save finishes before the next render', async () => {
  const { api, render } = await fixture();
  byName(render(), 'NoteEditButton').props.onClick();
  byName(render(), 'NoteInput').props.onChange('first');
  const editor = byName(render(), 'NoteInput');
  const pending = deferred<{ ok: boolean }>();
  api.writeData.mockReturnValueOnce(pending.promise);
  editor.props.onSave();
  await vi.waitFor(() => expect(api.writeData).toHaveBeenCalledTimes(1));
  // The next change is queued, but React has not rendered or run effects yet.
  editor.props.onChange('newer draft');
  pending.resolve({ ok: true });
  await new Promise<void>((done) => setImmediate(done));
  expect(byName(render(), 'NoteInput')?.props.value).toBe('newer draft');
});

it('serializes remote-access saves and preserves a password edited while a save is pending', async () => {
  const card = await fixture();
  const RemoteAccess = byName(card.render(), 'RemoteAccess').type as (props: unknown) => unknown;
  hooks.slots = [];
  const api = {
    access: {
      get: vi.fn(async () => ({ enabled: true, password: '0000' })),
      set: vi.fn(async (_patch: unknown) => ({ enabled: true, password: 'first' })),
    },
  };
  const render = () => {
    hooks.cursor = 0;
    hooks.effects = [];
    const tree = RemoteAccess({ api });
    for (const effect of hooks.effects) effect();
    return tree;
  };
  const input = () => elements(render()).find((element) => element.props['aria-label'] === '访问口令')!;
  render();
  await vi.waitFor(() => expect(input()).toBeTruthy());
  input().props.onChange({ target: { value: 'first' } });
  const saving = input();
  const pending = deferred<{ enabled: boolean; password: string }>();
  api.access.set.mockReturnValueOnce(pending.promise);
  saving.props.onBlur();
  saving.props.onBlur();
  const writes = api.access.set.mock.calls.length;
  input().props.onChange({ target: { value: 'newer draft' } });
  pending.resolve({ enabled: true, password: 'first' });
  await vi.waitFor(() => expect(JSON.stringify(render())).toContain('已保存'));
  expect(writes).toBe(1);
  expect(input().props.value).toBe('newer draft');
});
