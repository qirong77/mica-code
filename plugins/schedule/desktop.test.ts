import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { emptyData, type ScheduleData } from './schedule.js';

// 用真实组件、不装浏览器：状态的读写由这份 mock 的 hooks 顶着，宿主（readData/writeData）
// 什么时候完成写盘由测试控制。这样能验证「拖一条 → 写一条 → 另一条排队」这条链。
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => unknown>,
}));

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
    return hooks.slots[index];
  },
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => hooks.effects.push(effect),
}));

const { default: SchedulePage } = await import('./desktop.jsx');

type Element = { type?: unknown; props?: Record<string, unknown> };
type RowProps = {
  row: {
    color: string;
    bars: Array<{ taskId: string; label: string; start: string; end: string }>;
  };
  onBarDown: (event: unknown, bar: unknown) => void;
  onBarMove: (event: unknown) => void;
  onBarUp: () => void;
};

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
  return textOf((node as Element).props?.children);
}

function typeName(element: Element): string {
  const type = element.type as { name?: string } | string | undefined;
  return typeof type === 'string' ? type : (type?.name ?? '');
}

function findAll(tree: unknown, predicate: (element: Element) => boolean): Element[] {
  return flatten(tree).filter(predicate);
}

function findByTitle(tree: unknown, title: string): Element | undefined {
  return findAll(tree, (element) => element.props?.title === title)[0];
}

function click(tree: unknown, title: string): void {
  const element = findByTitle(tree, title);
  if (!element) throw new Error(`找不到 title=${title} 的按钮`);
  (element.props!.onClick as () => void)();
}

function findRow(tree: unknown): RowProps | undefined {
  const element = findAll(tree, (candidate) => typeName(candidate) === 'Row')[0];
  return element?.props as unknown as RowProps | undefined;
}

function findRowForBar(tree: unknown, taskId: string): RowProps {
  for (const element of findAll(tree, (candidate) => typeName(candidate) === 'Row')) {
    const row = element.props as unknown as RowProps;
    if (row.row.bars.some((bar) => bar.taskId === taskId)) return row;
  }
  throw new Error(`找不到包含任务 ${taskId} 的行`);
}

function findDialog(tree: unknown): Record<string, unknown> | undefined {
  const element = findAll(tree, (candidate) => typeName(candidate) === 'TaskDialog')[0];
  return element?.props as unknown as Record<string, unknown> | undefined;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function sample(): ScheduleData {
  return {
    ...emptyData(),
    tasks: [
      { id: 't1', name: '开发', start: '2026-10-01', end: '2026-10-03', color: 'blue', note: '' },
      { id: 't2', name: '测试', start: '2026-10-05', end: '2026-10-07', color: 'blue', note: '' },
    ],
  };
}

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  vi.stubGlobal('React', React);
  // 页面里的弹层、提示与键盘绑定会碰 window：这里给一个最小的替身，不需要真实 DOM
  vi.stubGlobal('window', {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 页面里的每像素天数（日视角、100% 缩放）。 */
const PX_PER_DAY = 34;

async function fixture(start: ScheduleData = sample(), options: { failFirstRead?: boolean } = {}) {
  let disk = clone(start);
  let version = 0;
  const api = {
    readData: vi.fn(async () => ({ ok: true, value: clone(disk), version: `v${version}` })),
    writeData: vi.fn(async (value: unknown, options?: { expectedVersion?: string | null }) => {
      if ((options?.expectedVersion ?? null) !== `v${version}`) {
        return { ok: false, conflict: true, error: 'conflict' };
      }
      disk = clone(value as ScheduleData);
      version += 1;
      return { ok: true };
    }),
  };
  if (options.failFirstRead) {
    api.readData.mockImplementationOnce(async () => ({ ok: false, error: '磁盘坏了' }) as never);
  }
  const render = () => {
    hooks.cursor = 0;
    hooks.effects = [];
    return SchedulePage({ api }) as unknown;
  };
  render();
  // 第 0 个 effect 是首屏读取；后面的（轮询、滚动）在测试里不需要
  hooks.effects[0]!();
  await vi.waitFor(() => expect(textOf(render())).not.toContain('正在读取排期'), { timeout: 3000 });

  const barEvent = (clientX: number) => ({
    button: 0,
    clientX,
    stopPropagation() {},
    currentTarget: {
      getBoundingClientRect: () => ({ left: 0, right: 100, width: 100 }),
      setPointerCapture() {},
    },
  });

  const drag = (taskId: string, days: number) => {
    const row = findRowForBar(render(), taskId);
    const bar = row.row.bars.find((item) => item.taskId === taskId)!;
    row.onBarDown(barEvent(50), bar);
    row.onBarMove({ clientX: 50 + days * PX_PER_DAY });
    row.onBarUp();
  };

  const openTask = (taskId: string) => {
    const row = findRowForBar(render(), taskId);
    const bar = row.row.bars.find((item) => item.taskId === taskId)!;
    row.onBarDown(barEvent(50), bar);
    row.onBarUp();
    return findDialog(render())!;
  };

  return {
    api,
    render,
    drag,
    openTask,
    disk: () => disk,
    task(taskId: string) {
      return disk.tasks.find((task) => task.id === taskId)!;
    },
    otherWriter(mutate: (data: ScheduleData) => ScheduleData) {
      disk = mutate(clone(disk));
      version += 1;
    },
  };
}

it('reschedules the dragged task and leaves the rest of the schedule alone', async () => {
  const page = await fixture();
  page.drag('t1', 2);
  await vi.waitFor(() => expect(page.task('t1').start).toBe('2026-10-03'));
  expect(page.task('t1')).toMatchObject({ end: '2026-10-05' });
  // 另一条没被碰
  expect(page.task('t2')).toMatchObject({ start: '2026-10-05', end: '2026-10-07' });
});

it('a second edit made while the first write is pending survives both saves', async () => {
  const page = await fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = page.api.writeData.getMockImplementation()!;
  page.api.writeData.mockImplementationOnce(async (value) => {
    await pending;
    return write(value);
  });

  page.drag('t1', 1);
  await vi.waitFor(() => expect(page.api.writeData).toHaveBeenCalledTimes(1));
  page.drag('t2', 1);
  release();

  await vi.waitFor(() => expect(page.task('t2').start).toBe('2026-10-06'));
  expect(page.task('t1').start).toBe('2026-10-02');
});

it('retries a conflicting save on top of what the other writer changed', async () => {
  const page = await fixture();
  const write = page.api.writeData.getMockImplementation()!;
  page.api.writeData.mockImplementationOnce(async () => {
    // 另一个写入者（模型 / 另一个窗口）刚好把「测试」挪走了
    page.otherWriter((data) => ({
      ...data,
      tasks: data.tasks.map((task) => (task.id === 't2' ? { ...task, start: '2026-10-12', end: '2026-10-14' } : task)),
    }));
    return { ok: false, conflict: true, error: 'conflict' };
  });
  page.api.writeData.mockImplementation(write);

  page.drag('t1', 1);
  await vi.waitFor(() => expect(page.task('t1').start).toBe('2026-10-02'));
  expect(page.task('t2')).toMatchObject({ start: '2026-10-12', end: '2026-10-14' });
});

it('creates a task from the toolbar dialog with the picked color and note', async () => {
  const page = await fixture();
  click(page.render(), '新建任务');
  const dialog = findDialog(page.render())!;
  expect(dialog.draft).toMatchObject({ color: 'emerald' });

  (dialog.onSave as (values: unknown) => void)({
    name: '新任务',
    start: '2026-11-02',
    end: '2026-11-06',
    color: 'rose',
    note: '## 验收\n- 走查通过',
  });

  await vi.waitFor(() => expect(page.disk().tasks).toHaveLength(3));
  expect(page.disk().tasks[2]).toMatchObject({
    name: '新任务',
    start: '2026-11-02',
    end: '2026-11-06',
    color: 'rose',
  });
  expect(page.disk().tasks[2]!.note).toContain('走查通过');
});

it('edits and deletes a task from the dialog opened by clicking its bar', async () => {
  const page = await fixture();
  const dialog = page.openTask('t2');
  expect(dialog.task).toMatchObject({ id: 't2', name: '测试' });

  (dialog.onSave as (values: unknown) => void)({
    name: '测试（二期）',
    start: '2026-10-06',
    end: '2026-10-08',
    color: 'amber',
    note: '备注',
  });
  await vi.waitFor(() => expect(page.task('t2').name).toBe('测试（二期）'));
  expect(page.task('t2')).toMatchObject({ start: '2026-10-06', end: '2026-10-08', color: 'amber', note: '备注' });

  const reopened = page.openTask('t2');
  (reopened.onDelete as () => void)();
  await vi.waitFor(() => expect(page.disk().tasks.map((task) => task.id)).toEqual(['t1']));
});

it('shows the empty state and loads the sample with one click', async () => {
  const page = await fixture({ ...emptyData() });
  expect(findRow(page.render())).toBeUndefined();
  expect(textOf(page.render())).toContain('还没有任务');

  click(page.render(), '载入示例');
  await vi.waitFor(() => expect(page.disk().tasks).toHaveLength(9));
  expect(page.disk().title).toBe('我的排期');
});

it('reports a failed first read with a retry entry point', async () => {
  const page = await fixture(sample(), { failFirstRead: true });
  await vi.waitFor(() => {
    const tree = page.render();
    expect(textOf(tree)).toContain('读取排期失败');
    expect(textOf(tree)).toContain('磁盘坏了');
  });
});

it('surfaces a failed save without losing the page', async () => {
  const page = await fixture();
  page.api.writeData.mockImplementation(async () => ({ ok: false, error: '磁盘满了' }) as never);
  page.drag('t1', 1);
  await vi.waitFor(() => expect(textOf(page.render())).toContain('保存失败，点此重试'));
  expect(textOf(page.render())).toContain('磁盘满了');
});
