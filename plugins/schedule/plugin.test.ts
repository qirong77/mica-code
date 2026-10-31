import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { refreshSchedules, type RefreshOutcome } from './refresh.js';
import { emptySnapshot } from './snapshot.js';
import setup from './index.js';

vi.mock('./dws.js', () => ({ resolveDws: () => ({ file: 'mock-dws', prefix: [] }), createDwsRunner: () => vi.fn() }));
vi.mock('./refresh.js', async (importActual) => ({
  ...(await importActual<typeof import('./refresh.js')>()),
  refreshSchedules: vi.fn(),
}));

const directories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'mica-schedule-plugin-'));
  directories.push(home);
  const file = join(home, 'plugin-data', 'schedule', 'data.json');
  mkdirSync(dirname(file), { recursive: true });
  const snapshot = {
    ...emptySnapshot(),
    updatedAtMs: 1,
    groups: [
      {
        id: 'g1',
        name: 'Group',
        author: '',
        announcedAt: 1,
        stages: [
          {
            key: 'dev',
            label: '开发',
            start: '2026-10-01',
            end: '2026-10-03',
            days: ['2026-10-01', '2026-10-03'],
            range: true,
          },
        ],
      },
    ],
    edits: [
      { id: 'dev:2026-10-01', groupId: 'g1', key: 'dev', added: false, start: '2026-10-02', end: '2026-10-04', at: 1 },
    ],
  };
  writeFileSync(file, JSON.stringify(snapshot));
  let refresh!: () => Promise<{ message: string }>;
  const health: Array<{ level: string }> = [];
  setup({
    pluginId: 'schedule',
    paths: { config: home },
    settings: { get: () => ({ groups: 'Group' }) },
    actions: {
      register: (_key: string, handler: typeof refresh) => {
        refresh = handler;
      },
    },
    background: { register() {} },
    health: { report: (value: { level: string }) => health.push(value) },
    logger: { info() {}, error() {} },
  } as unknown as PluginContext);
  return { refresh, health, snapshot, file, read: () => JSON.parse(readFileSync(file, 'utf8')) };
}

function outcome(overrides: Partial<RefreshOutcome> = {}): RefreshOutcome {
  return {
    me: '',
    scanned: 0,
    planned: 1,
    targetIds: ['g1'],
    scannedIds: [],
    groups: [],
    errors: [],
    partial: false,
    ...overrides,
  };
}

it('刷新失败拒绝动作、保留缓存，并释放锁供重试', async () => {
  const fixture = harness();
  vi.mocked(refreshSchedules).mockRejectedValueOnce(new Error('mock dws unavailable'));
  await expect(fixture.refresh()).rejects.toThrow('mock dws unavailable');
  expect(fixture.health.at(-1)?.level).toBe('error');
  expect(fixture.read()).toEqual(fixture.snapshot);
  vi.mocked(refreshSchedules).mockResolvedValueOnce(outcome({ scanned: 1, scannedIds: ['g1'] }));
  await expect(fixture.refresh()).resolves.toMatchObject({ message: expect.any(String) });
  expect(fixture.read().groups).toEqual([]);
});

it('与页面写入竞争时保留快照并明确返回可重试错误', async () => {
  const fixture = harness();
  vi.mocked(refreshSchedules).mockResolvedValue(outcome({ scanned: 1, scannedIds: ['g1'] }));
  const release = acquireProcessLock(`${fixture.file}.lock`)!;
  try {
    await expect(fixture.refresh()).rejects.toThrow('正在其他窗口保存');
    expect(fixture.read()).toEqual(fixture.snapshot);
  } finally {
    release();
  }
  await expect(fixture.refresh()).resolves.toMatchObject({ message: expect.any(String) });
});

it('未扫描群的阶段与修订在部分刷新后仍落盘', async () => {
  const fixture = harness();
  vi.mocked(refreshSchedules).mockResolvedValueOnce(outcome({ partial: true }));
  await fixture.refresh();
  expect(fixture.read().groups).toEqual(fixture.snapshot.groups);
  expect(fixture.read().edits).toEqual(fixture.snapshot.edits);
  expect(fixture.read().scope.partial).toBe(true);
  expect(fixture.health.at(-1)?.level).toBe('warn');
});

it('配置群全部匹配不到时保留缓存并返回动作失败', async () => {
  const fixture = harness();
  vi.mocked(refreshSchedules).mockResolvedValueOnce(
    outcome({ planned: 0, targetIds: [], errors: [{ name: 'Group', message: 'missing' }] }),
  );
  await expect(fixture.refresh()).rejects.toThrow('missing');
  expect(fixture.read()).toEqual(fixture.snapshot);
});

it('同一轮未结束时拒绝重入，结束后能再次刷新', async () => {
  const fixture = harness();
  let release!: (value: RefreshOutcome) => void;
  vi.mocked(refreshSchedules).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = fixture.refresh();
  try {
    await expect(fixture.refresh()).rejects.toThrow('正在整理排期');
    expect(refreshSchedules).toHaveBeenCalledTimes(1);
    expect(fixture.read()).toEqual(fixture.snapshot);
  } finally {
    release(outcome());
    await first;
  }
  vi.mocked(refreshSchedules).mockResolvedValueOnce(outcome());
  await expect(fixture.refresh()).resolves.toMatchObject({ message: expect.any(String) });
});
