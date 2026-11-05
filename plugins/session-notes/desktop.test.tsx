import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';

// 与 session-tags 的页面测试同一套办法：真组件 + mock 的 hooks，不起浏览器。
// 这里要验的是「保存飞行期间又敲了字」这条时序，所以输入与写盘完成都由测试控制。
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as Array<() => unknown> }));

vi.mock('react', async (importActual) => ({
  ...(await importActual<typeof import('react')>()),
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
    return hooks.slots[index] as { current: T };
  },
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => hooks.effects.push(effect),
}));

const { default: SessionNotesCard } = await import('./desktop.jsx');

type Element = { type?: unknown; props?: Record<string, unknown> };

function flatten(node: unknown, out: Element[] = []): Element[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out);
    return out;
  }
  if ('props' in (node as Element)) {
    const element = node as Element;
    out.push(element);
    for (const value of Object.values(element.props ?? {})) flatten(value, out);
  }
  return out;
}

const editorOf = (tree: unknown) => flatten(tree).find((element) => 'language' in (element.props ?? {}));

// 用微任务而不是 setTimeout：这个文件装了假定时器，真 setTimeout 永远不会自己跑完。
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

let writes: Array<{ text: string; resolve: (result: unknown) => void }>;

function createSession() {
  return {
    state: {
      read: () => Promise.resolve({ value: '' }),
      write: (text: string) =>
        new Promise((resolve) => {
          writes.push({ text, resolve });
        }),
      subscribe: () => () => {},
    },
    onIdle: () => () => {}
  };
}

/** 画一次并跑一遍首屏 effect（读初值那一条）。 */
async function mount() {
  hooks.cursor = 0;
  hooks.effects = [];
  const tree = SessionNotesCard({ api: { session: createSession() }, onClose: () => {} });
  for (const effect of hooks.effects.slice()) effect();
  await flush();
  return tree;
}

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  writes = [];
  vi.useFakeTimers();
  // 插件前端模块按运行时那套 JSX 编译（没有自动注入 jsx runtime），自由变量要靠全局。
  vi.stubGlobal('React', React);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('saves again when the user types while the previous save is still in flight', async () => {
  const tree = await mount();
  const onChange = editorOf(tree)!.props!.onChange as (next: string) => void;

  onChange('first');
  await vi.advanceTimersByTimeAsync(700);
  expect(writes.map((write) => write.text)).toEqual(['first']);

  // 第一次写还没落地时又敲了一个字：它的防抖回调会排在这次保存之后。
  onChange('second');
  writes[0]!.resolve({ ok: true });
  await vi.advanceTimersByTimeAsync(700);

  // 少了这一步，「second」会随着脏标记被清掉而永远不落盘。
  expect(writes.map((write) => write.text)).toEqual(['first', 'second']);
});

it('does not schedule a redundant save when nothing changed during the write', async () => {
  const tree = await mount();
  const onChange = editorOf(tree)!.props!.onChange as (next: string) => void;

  onChange('only');
  await vi.advanceTimersByTimeAsync(700);
  writes[0]!.resolve({ ok: true });
  await vi.advanceTimersByTimeAsync(700);
  expect(writes).toHaveLength(1);
});
