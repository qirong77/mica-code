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
    planId: string;
    name: string;
    bars: Array<{ stageId: string; label: string; start: string; end: string }>;
  };
  onBarDown: (event: unknown, row: unknown, bar: unknown) => void;
  onBarMove: (event: unknown) => void;
  onBarUp: () => void;
  onSelect: (bar: unknown) => void;
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

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function sample(): ScheduleData {
  return {
    ...emptyData(),
    plans: [
      {
        id: 'p1',
        name: '钱包改版',
        note: '',
        stages: [
          { id: 's1', name: '开发', start: '2026-10-01', end: '2026-10-03' },
          { id: 's2', name: '测试', start: '2026-10-05', end: '2026-10-07' },
        ],
      },
    ],
  };
}

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  vi.stubGlobal('React', React);
  // 页面里的弹层与键盘绑定会碰 window：这里给一个最小的替身，不需要真实 DOM
  vi.stubGlobal('window', {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 页面里的每像素天数（日视角、100% 缩放）。 */
const PX_PER_DAY = 34;

async function fixture(start: ScheduleData = sample()) {
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
  const render = () => {
    hooks.cursor = 0;
    hooks.effects = [];
    return SchedulePage({ api }) as unknown;
  };
  render();
  // 第 0 个 effect 是首屏读取；后面的（轮询、滚轮、键盘）在测试里不需要
  hooks.effects[0]!();
  await vi.waitFor(() => expect(textOf(render())).not.toContain('正在读取排期'), { timeout: 3000 });

  const drag = (stageId: string, days: number) => {
    const row = findRow(render())!;
    const bar = row.row.bars.find((item) => item.stageId === stageId)!;
    row.onBarDown(
      {
        button: 0,
        clientX: 50,
        stopPropagation() {},
        currentTarget: {
          getBoundingClientRect: () => ({ left: 0, right: 100, width: 100 }),
          setPointerCapture() {},
        },
      },
      row.row,
      bar,
    );
    row.onBarMove({ clientX: 50 + days * PX_PER_DAY });
    row.onBarUp();
  };

  return {
    api,
    render,
    drag,
    disk: () => disk,
    stage(stageId: string) {
      return disk.plans.flatMap((plan) => plan.stages).find((stage) => stage.id === stageId)!;
    },
    otherWriter(mutate: (data: ScheduleData) => ScheduleData) {
      disk = mutate(clone(disk));
      version += 1;
    },
  };
}

it('reschedules the dragged stage and leaves the rest of the plan alone', async () => {
  const page = await fixture();
  page.drag('s1', 2);
  await vi.waitFor(() => expect(page.stage('s1').start).toBe('2026-10-03'));
  expect(page.stage('s1')).toMatchObject({ end: '2026-10-05' });
  // 另一条没被碰
  expect(page.stage('s2')).toMatchObject({ start: '2026-10-05', end: '2026-10-07' });
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

  page.drag('s1', 1);
  await vi.waitFor(() => expect(page.api.writeData).toHaveBeenCalledTimes(1));
  page.drag('s2', 1);
  release();

  await vi.waitFor(() => expect(page.stage('s2').start).toBe('2026-10-06'));
  expect(page.stage('s1').start).toBe('2026-10-02');
});

it('retries a conflicting save on top of what the other writer changed', async () => {
  const page = await fixture();
  const write = page.api.writeData.getMockImplementation()!;
  page.api.writeData.mockImplementationOnce(async () => {
    // 另一个写入者（模型 / 另一个窗口）刚好把「测试」挪走了
    page.otherWriter((data) => ({
      ...data,
      plans: data.plans.map((plan) => ({
        ...plan,
        stages: plan.stages.map((stage) =>
          stage.id === 's2' ? { ...stage, start: '2026-10-12', end: '2026-10-14' } : stage,
        ),
      })),
    }));
    return { ok: false, conflict: true, error: 'conflict' };
  });
  page.api.writeData.mockImplementation(write);

  page.drag('s1', 1);
  await vi.waitFor(() => expect(page.stage('s1').start).toBe('2026-10-02'));
  expect(page.stage('s2')).toMatchObject({ start: '2026-10-12', end: '2026-10-14' });
});

it('creates a plan from the toolbar and shows it as a row', async () => {
  const page = await fixture();
  click(page.render(), '新建一个计划（一行）');
  const input = findAll(page.render(), (element) => element.props?.placeholder === '项目或主题的名字')[0]!;
  (input.props!.onChange as (event: unknown) => void)({ target: { value: '钱包二期' } });
  const form = findAll(page.render(), (element) => element.type === 'form')[0]!;
  (form.props!.onSubmit as (event: unknown) => void)({ preventDefault() {} });

  await vi.waitFor(() => expect(page.disk().plans.map((plan) => plan.name)).toEqual(['钱包改版', '钱包二期']));
  const rows = findAll(page.render(), (element) => typeName(element) === 'Row');
  expect(rows).toHaveLength(2);
});

it('deletes a stage from the editor and a whole plan from its row', async () => {
  const page = await fixture();
  const row = findRow(page.render())!;
  row.onSelect(row.row.bars.find((bar) => bar.stageId === 's2')!);

  const editor = findAll(page.render(), (element) => typeName(element) === 'StageEditor')[0]!;
  (editor.props!.onDelete as () => void)();
  await vi.waitFor(() => expect(page.disk().plans[0]!.stages.map((stage) => stage.id)).toEqual(['s1']));

  click(page.render(), '删除计划');
  click(page.render(), '确认删除');
  await vi.waitFor(() => expect(page.disk().plans).toEqual([]));
});

it('keeps the page usable when the first read comes back empty (host not ready yet)', async () => {
  const page = await fixture({ ...emptyData() });
  expect(findRow(page.render())).toBeUndefined();
  expect(textOf(page.render())).toContain('排期还是空的');
  expect(textOf(page.render())).toContain('schedule');
});
