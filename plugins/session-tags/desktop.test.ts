import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';

// 用真实组件、不装浏览器：状态读写由这份 mock 的 hooks 顶着，宿主的
// read/writeOptions 什么时候完成由测试控制。这样能验证「改一行 → 整份写回 →
// 用宿主归一化后的结果刷新」这条链，而不用起页面。
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
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => hooks.effects.push(effect),
}));

const { default: TagsPage } = await import('./desktop.jsx');

type Element = { type?: unknown; props?: Record<string, unknown> };

function flatten(node: unknown, out: Element[] = []): Element[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out);
    return out;
  }
  const element = node as Element;
  out.push(element);
  for (const value of Object.values(element.props ?? {})) flatten(value, out);
  return out;
}

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  const props = (node as Element).props ?? {};
  const own = ['title', 'description', 'hint', 'message', 'placeholder']
    .map((key) => (typeof props[key] === 'string' ? props[key] : ''))
    .join('');
  return own + textOf(props.children);
}

function findBy(tree: unknown, predicate: (props: Record<string, unknown>) => boolean): Element | undefined {
  return flatten(tree).find((element) => element.props && predicate(element.props));
}

const inputByLabel = (tree: unknown, label: string) =>
  findBy(tree, (props) => props['aria-label'] === label);

const buttonByText = (tree: unknown, text: string) =>
  findBy(tree, (props) => {
    const children = props.children as unknown;
    return Array.isArray(children) ? children.some((child) => child === text) : children === text;
  });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const options = [
  { id: 'tag-1', label: '待 review', color: '#FF9500' },
  { id: 'tag-2', label: '待办', color: '#FF3B30' },
];

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    annotations: {
      read: vi.fn(async () => ({ ok: true, options, counts: { 'tag-1': 2, 'tag-2': 0 } })),
      writeOptions: vi.fn(async (next: unknown[]) => ({
        ok: true,
        options: next,
        counts: Object.fromEntries(next.map((option) => [(option as { id: string }).id, 0])),
      })),
      ...overrides,
    },
  };
}

/** 执行挂载时登记的 effect，再让里面的 promise 落地。 */
async function mount(api: ReturnType<typeof makeApi>) {
  hooks.cursor = 0;
  const first = TagsPage({ api });
  for (const effect of hooks.effects.splice(0)) await effect();
  await flush();
  hooks.cursor = 0;
  return { api, tree: () => {
    hooks.cursor = 0;
    return TagsPage({ api });
  }, first };
}

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  vi.stubGlobal('React', React);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('lists the tags with their usage counts', async () => {
  const { tree } = await mount(makeApi());
  const text = textOf(tree());
  expect(text).toContain('待 review');
  expect(text).toContain('待办');
  expect(text).toContain('2 个会话');
  expect(text).toContain('0 个会话');
});

it('adds a tag with the picked color and clears the input', async () => {
  const { api, tree } = await mount(makeApi());
  const input = inputByLabel(tree(), '新标签名字')!;
  (input.props!.onChange as (event: unknown) => void)({ target: { value: '进行中' } });

  // 换一个颜色再提交：默认色是橙色，这里选黄色（色板自己的圆点由 Palette 渲染，
  // 测试直接调它的 onChange，与点中某个圆点等价）
  const palette = findBy(tree(), (props) => props.value === '#FF9500' && typeof props.onChange === 'function')!;
  (palette.props!.onChange as (color: string) => void)('#FFCC00');
  (buttonByText(tree(), '添加')!.props!.onClick as () => void)();
  await flush();

  expect(api.annotations.writeOptions).toHaveBeenCalledTimes(1);
  const written = api.annotations.writeOptions.mock.calls[0]![0] as Array<Record<string, string>>;
  expect(written).toHaveLength(3);
  expect(written[2]).toMatchObject({ label: '进行中', color: '#FFCC00' });
  expect(inputByLabel(tree(), '新标签名字')!.props!.value).toBe('');
});

it('refuses a duplicate name without writing anything', async () => {
  const { api, tree } = await mount(makeApi());
  const input = inputByLabel(tree(), '新标签名字')!;
  (input.props!.onChange as (event: unknown) => void)({ target: { value: '待办' } });
  (buttonByText(tree(), '添加')!.props!.onClick as () => void)();
  await flush();

  expect(api.annotations.writeOptions).not.toHaveBeenCalled();
  expect(textOf(tree())).toContain('已经有叫「待办」的标签了');
});

it('renames a tag in place and keeps the list order', async () => {
  const { api, tree } = await mount(makeApi());
  (findBy(tree(), (props) => props.title === '改名 / 换颜色')!.props!.onClick as () => void)();

  const input = inputByLabel(tree(), '标签名')!;
  expect(input.props!.value).toBe('待 review');
  (input.props!.onChange as (event: unknown) => void)({ target: { value: '等人看' } });
  (buttonByText(tree(), '保存')!.props!.onClick as () => void)();
  await flush();

  const written = api.annotations.writeOptions.mock.calls[0]![0] as Array<Record<string, string>>;
  expect(written.map((option) => option.label)).toEqual(['等人看', '待办']);
  expect(written[0]!.id).toBe('tag-1');
  expect(textOf(tree())).toContain('等人看');
});

it('asks once before deleting a tag', async () => {
  const { api, tree } = await mount(makeApi());
  (findBy(tree(), (props) => props.title === '删除标签')!.props!.onClick as () => void)();
  // 第一下只是进入确认态
  expect(api.annotations.writeOptions).not.toHaveBeenCalled();
  expect(textOf(tree())).toContain('确认删除');

  (buttonByText(tree(), '确认删除')!.props!.onClick as () => void)();
  await flush();

  const written = api.annotations.writeOptions.mock.calls[0]![0] as Array<Record<string, string>>;
  expect(written.map((option) => option.label)).toEqual(['待办']);
});

it('surfaces a failed write and keeps the current list', async () => {
  const api = makeApi({
    writeOptions: vi.fn(async () => ({ ok: false, error: '其他会话正在更新标记，稍后重试' })),
  });
  const { tree } = await mount(api);
  const input = inputByLabel(tree(), '新标签名字')!;
  (input.props!.onChange as (event: unknown) => void)({ target: { value: '进行中' } });
  (buttonByText(tree(), '添加')!.props!.onClick as () => void)();
  await flush();

  const text = textOf(tree());
  expect(text).toContain('其他会话正在更新标记');
  expect(text).toContain('待 review');
  // 输入框里的字还在，改一下就能重试
  expect(inputByLabel(tree(), '新标签名字')!.props!.value).toBe('进行中');
});

it('says so when the host has no annotations api', async () => {
  hooks.cursor = 0;
  const api = { annotations: null };
  TagsPage({ api });
  for (const effect of hooks.effects.splice(0)) await effect();
  await flush();
  hooks.cursor = 0;
  expect(textOf(TagsPage({ api }))).toContain('当前宿主还不支持');
});
