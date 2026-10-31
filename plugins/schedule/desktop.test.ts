import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { GanttBar, GanttRow } from './gantt.js';
import { emptySnapshot, type ScheduleSnapshot } from './snapshot.js';
import { addDays } from './gantt.js';

// Drive the component's real callbacks without a browser. Each render preserves
// hook state, while the test controls when host reads and writes complete.
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
    return hooks.slots[index];
  },
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => hooks.effects.push(effect),
}));

const { default: SchedulePage } = await import('./desktop.jsx');
type RowProps = {
  row: GanttRow;
  onBarDown: (event: unknown, row: GanttRow, bar: GanttBar) => void;
  onBarMove: (event: unknown) => void;
  onBarUp: () => void;
  onBarCancel: () => void;
};
type Element = { type?: { name?: string }; props?: { children?: unknown } };
function findRow(node: unknown): RowProps | undefined {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.map(findRow).find(Boolean);
  const element = node as Element;
  if (element.type?.name === 'Row') return element.props as unknown as RowProps;
  return findRow(element.props?.children);
}
function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  return Array.isArray(node) ? node.map(textOf).join('') : textOf((node as Element).props?.children);
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  vi.useFakeTimers();
  vi.stubGlobal('React', React);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function fixture() {
  let disk: ScheduleSnapshot = {
    ...emptySnapshot(),
    groups: [
      {
        id: 'g1',
        name: 'Project',
        author: '',
        announcedAt: 0,
        stages: [
          {
            key: 'dev',
            label: '开发',
            start: '2026-10-01',
            end: '2026-10-03',
            days: ['2026-10-01', '2026-10-03'],
            range: true,
          },
          {
            key: 'testing',
            label: '测试',
            start: '2026-10-05',
            end: '2026-10-07',
            days: ['2026-10-05', '2026-10-07'],
            range: true,
          },
        ],
      },
    ],
  };
  const api = {
    action: vi.fn(async (_key: string) => ({ ok: true, message: '已整理' })),
    readData: vi.fn(async () => ({ ok: true, value: clone(disk) })),
    writeData: vi.fn(async (value: ScheduleSnapshot) => {
      disk = clone(value);
      return { ok: true, error: '' };
    }),
  };
  const render = () => {
    hooks.cursor = 0;
    hooks.effects = [];
    return SchedulePage({ api });
  };
  render();
  hooks.effects[0]!();
  await vi.waitFor(() => expect(findRow(render())).toBeTruthy());
  const move = (key: string, cancel = false) => {
    const row = findRow(render())!;
    const bar = row.row.bars.find((item) => item.key === key)!;
    row.onBarDown(
      {
        button: 0,
        clientX: 50,
        stopPropagation() {},
        currentTarget: { getBoundingClientRect: () => ({ left: 0, right: 100, width: 100 }), setPointerCapture() {} },
      },
      row.row,
      bar,
    );
    row.onBarMove({ clientX: 84 });
    if (cancel) row.onBarCancel();
    else row.onBarUp();
  };
  return {
    api,
    render,
    move,
    disk: () => disk,
    replaceDisk: (value: ScheduleSnapshot) => {
      disk = value;
    },
  };
}

it('a second edit made while the first write is pending survives both queued saves', async () => {
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
  page.move('dev');
  await vi.waitFor(() => expect(page.api.writeData).toHaveBeenCalledTimes(1));
  page.move('testing');
  release();
  await vi.waitFor(() => expect(page.disk().edits).toHaveLength(2));
  expect(page.disk().edits.map((edit) => edit.start)).toEqual(['2026-10-02', '2026-10-06']);
});

it('preserves edits saved by another window while changing a different stage', async () => {
  const page = await fixture();
  const otherEdit = {
    id: 'dev:2026-10-01',
    groupId: 'g1',
    key: 'dev',
    added: false,
    start: '2026-10-03',
    end: '2026-10-05',
    at: 1,
  };
  page.replaceDisk({ ...page.disk(), edits: [otherEdit] });
  page.move('testing');
  await vi.waitFor(() => expect(page.disk().edits).toHaveLength(2));
  expect(page.disk().edits.find((edit) => edit.key === 'dev')).toEqual(otherEdit);
  expect(page.disk().edits.find((edit) => edit.key === 'testing')?.start).toBe('2026-10-06');
});

it('retries a conflicting save with the latest announcement and other-window edits', async () => {
  const page = await fixture();
  const write = page.api.writeData.getMockImplementation()!;
  page.api.writeData.mockImplementationOnce(async () => {
    page.replaceDisk({
      ...page.disk(),
      coverage: 'updated by another window',
      edits: [
        {
          id: 'dev:2026-10-01',
          groupId: 'g1',
          key: 'dev',
          added: false,
          start: '2026-10-03',
          end: '2026-10-05',
          at: 1,
        },
      ],
    });
    return { ok: false, conflict: true, error: 'conflict' };
  });
  page.api.writeData.mockImplementationOnce(write);
  page.move('testing');
  await vi.waitFor(() => expect(page.disk().edits).toHaveLength(2));
  expect(page.api.writeData).toHaveBeenCalledTimes(2);
  expect(page.disk().coverage).toBe('updated by another window');
});

it('host write failures keep the error visible and restore the persisted snapshot', async () => {
  const page = await fixture();
  page.api.writeData.mockResolvedValueOnce({ ok: false, error: 'mock disk full' });
  page.move('dev');
  await vi.waitFor(() => expect(textOf(page.render())).toContain('mock disk full'));
  expect(textOf(page.render())).not.toContain('已保存');
  expect(page.disk().edits).toEqual([]);
});

it('saving an edit cannot resurrect groups removed by a completed refresh', async () => {
  const page = await fixture();
  page.replaceDisk({ ...emptySnapshot(), updatedAtMs: 1 });
  page.move('dev');
  await vi.waitFor(() => expect(page.api.writeData).toHaveBeenCalledTimes(1));
  expect(page.disk().groups).toEqual([]);
  expect(page.disk().edits).toEqual([]);
});

it('pointer cancellation drops a drag preview without persisting it', async () => {
  const page = await fixture();
  page.move('dev', true);
  await Promise.resolve();
  expect(page.api.writeData).not.toHaveBeenCalled();
  expect(page.disk().edits).toEqual([]);
});

it('coalesces a burst of edits while IO is pending and persists the final date', async () => {
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
  page.move('dev');
  await vi.waitFor(() => expect(page.api.writeData).toHaveBeenCalledTimes(1));
  for (let index = 0; index < 60; index++) page.move('dev');
  expect(page.api.writeData).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => expect(page.disk().edits[0]?.start).toBe(addDays('2026-10-02', 60)));
  expect(page.api.writeData).toHaveBeenCalledTimes(2);
});

it('rapid refresh clicks invoke one action and show failure feedback', async () => {
  const page = await fixture();
  const findRefresh = (node: unknown): { onClick: () => void } | undefined => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.map(findRefresh).find(Boolean);
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props?.['aria-label'] === '重新整理排期') return props as { onClick: () => void };
    return findRefresh(props?.children);
  };
  let release!: () => void;
  page.api.action.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: false, message: 'mock refresh unavailable' });
      }),
  );
  const refresh = findRefresh(page.render())!;
  refresh.onClick();
  refresh.onClick();
  expect(page.api.action).toHaveBeenCalledTimes(1);
  expect(textOf(page.render())).toContain('整理中');
  release();
  await vi.waitFor(() => expect(textOf(page.render())).toContain('mock refresh unavailable'));
});
