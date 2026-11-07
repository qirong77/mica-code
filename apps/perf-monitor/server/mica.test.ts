import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, appendFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MicaStore, classifyMicaProcess, micaProcessRows } from './mica';
import type { ProcessRecord } from '../shared/types';

const roots: string[] = [];
const day = '2020-01-02';
const t0 = Date.parse(`${day}T12:00:00`);
const iso = (ms: number) => new Date(ms).toISOString();
const mem = (ms: number, host: string, pid: number, rss: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ at: ms, level: 'info', scope: 'mem', event: 'sample', host, pid, rss, ...extra });
const perf = (ms: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ at: ms, level: 'info', scope: 'perf', event: 'sample', pageId: 'page-a', lag: 1, vis: 1, ...extra });

async function fixture(files: Record<string, string[]>, sessions: Record<string, number> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mica-perf-mica-'));
  const sessionDir = join(root, 'sessions');
  roots.push(root);
  await mkdir(sessionDir, { recursive: true });
  for (const [name, rows] of Object.entries(files))
    await writeFile(join(root, name), rows.map((row) => `${row}\n`).join(''));
  for (const [name, size] of Object.entries(sessions)) await writeFile(join(sessionDir, name), 'x'.repeat(size));
  return { store: new MicaStore(root, sessionDir), root, sessionDir };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const processRow = (pid: number, overrides: Partial<ProcessRecord> = {}): ProcessRecord => ({
  pid,
  pp: 1,
  n: 'mica-code-app',
  fp: 100,
  rss: 80,
  fpd: 5,
  cpu: 10,
  th: 20,
  rt: 1,
  fd: 30,
  ni: 0,
  pi: 0,
  imx: null,
  group: 'Mica',
  identity: `${pid}:1`,
  ...overrides,
});

describe('mica process attribution', () => {
  test('splits desktop, host and plugin processes apart and keeps other mica tools out', () => {
    expect(classifyMicaProcess('/Applications/x/mica-code-app.app/Contents/MacOS/mica-code-app', 'x')?.kind).toBe(
      '桌面主进程',
    );
    expect(
      classifyMicaProcess('/Applications/x/Contents/Frameworks/mica-code-app Helper (Renderer).app/Contents/MacOS/x', 'x')
        ?.kind,
    ).toBe('渲染进程');
    expect(
      classifyMicaProcess('/Applications/x/Contents/Frameworks/mica-code-app Helper (GPU).app/Contents/MacOS/x', 'x')
        ?.kind,
    ).toBe('GPU 进程');
    const host = classifyMicaProcess(
      '/Users/u/.local/lib/mica/mica app-server --thinking --session 20261104T034213Z-loatwr --dir /repo',
      'mica',
    );
    expect(host).toEqual({ kind: '会话宿主', session: '20261104T034213Z-loatwr' });
    expect(
      classifyMicaProcess('/Users/u/.local/lib/mica/mica /Users/u/.mica/plugin-data/deepseek-harness/watchdog.mjs', 'mica')
        ?.kind,
    ).toBe('插件进程');
    // 不是 Mica 桌面端/CLI，不应被算进 Mica 的进程构成
    expect(classifyMicaProcess('/bin/sh /usr/local/libexec/mica-lca-tame/lca-tame.sh', 'sh')).toBeNull();
    expect(classifyMicaProcess('node /Users/u/.zuche/mac/mica-bridge.js', 'node')).toBeNull();
    expect(classifyMicaProcess('bun /repo/apps/perf-monitor/server/index.ts', 'bun')).toBeNull();
  });

  test('marks processes whose parent already exited', () => {
    const context = micaProcessRows(
      [processRow(100, { pp: 1 }), processRow(101, { pp: 100 }), processRow(102, { pp: 1 })],
      new Map([
        [100, { name: 'mica-code-app', argv: '/a/mica-code-app.app/Contents/MacOS/mica-code-app' }],
        [
          101,
          {
            name: 'mica-code-app',
            argv: '/a/mica-code-app.app/Contents/Frameworks/mica-code-app Helper (Renderer).app/Contents/MacOS/x',
          },
        ],
        [102, { name: 'mica', argv: '/Users/u/.local/lib/mica/mica app-server --session s1' }],
      ]),
      iso(t0),
    );
    expect(context.rows.map((row) => [row.pid, row.kind, row.orphan])).toEqual([
      [100, '桌面主进程', false],
      [101, '渲染进程', false],
      [102, '会话宿主', true],
    ]);
    expect(context.desktopApp).toBe('/a/mica-code-app.app/');
  });
});

describe('mica telemetry aggregation', () => {
  test('sums host RSS per minute, tracks growth and hides one-off hosts', async () => {
    const rows = [
      mem(t0, 'app-server', 1, 100, { session: 's1' }),
      mem(t0 + 1000, 'app-server', 2, 50, { session: 's2' }),
      mem(t0 + 2000, 'main', 3, 200, { windows: 2, byType: { GPU: 100, Tab: 80 } }),
      mem(t0 + 300_000, 'app-server', 1, 160, { session: 's1' }),
      mem(t0 + 300_000, 'app-server', 2, 50, { session: 's2' }),
      mem(t0 + 300_000, 'main', 3, 210, { windows: 2, byType: { GPU: 120, Tab: 90 } }),
      mem(t0 + 600_000, 'app-server', 1, 170, { session: 's1' }),
      mem(t0 + 600_000, 'app-server', 2, 50, { session: 's2' }),
      mem(t0 + 600_000, 'main', 3, 210, { windows: 2, byType: { GPU: 120, Tab: 90 } }),
      mem(t0 + 900_000, 'tui', 9, 150),
    ];
    const { store } = await fixture({ [`mem-20200102.jsonl`]: rows });
    const view = await store.overview(day, '24h', { at: iso(t0), rows: [], desktopApp: null });
    const first = view.memory.find((point) => point.ts === Math.floor(t0 / 60000) * 60000);
    expect(first?.appServer).toBe(150);
    expect(first?.main).toBe(200);
    expect(first?.gpu).toBe(100);
    const hosts = view.hosts.map((host) => [host.pid, host.rssMb, host.growthMb]);
    expect(hosts).toEqual([
      [3, 210, 10],
      [1, 170, 70],
      [2, 50, 0],
    ]);
    expect(view.hostSummary).toMatchObject({ activeHosts: 3, windowHosts: 4, shortLived: 1, peakHostRssMb: 210 });
  });

  test('ignores hidden renderer samples and reports exact lag percentiles', async () => {
    const rows = [
      perf(t0, { lag: 5 }),
      perf(t0 + 1000, { lag: 50 }),
      perf(t0 + 2000, { lag: 2 }),
      perf(t0 + 3000, { lag: 200 }),
      perf(t0 + 4000, { lag: 900, vis: 0 }),
      JSON.stringify({ at: t0 + 5000, level: 'info', scope: 'perf', event: 'batch', dropped: 3 }),
      perf(t0 + 60_000, { lag: null, heapMB: 30, dom: 1000, rows: 5 }),
      perf(t0 + 120_000, { lag: null, heapMB: 60, dom: 1200, rows: 6 }),
    ];
    const { store } = await fixture({ [`perf-20200102.jsonl`]: rows });
    const view = await store.overview(day, '24h', { at: iso(t0), rows: [], desktopApp: null });
    expect(view.renderer).toMatchObject({
      samples: 4,
      lagP50: 5,
      lagP95: 200,
      lagP99: 200,
      over32: 2,
      over100: 1,
      dropped: 3,
      worst: 200,
    });
    expect(view.renderer.pages[0]).toMatchObject({ heapMb: 60, heapFirstMb: 30, heapMaxMb: 60, dom: 1200, rows: 6 });
    expect(view.renderer.heap.map((point) => point.heapMb)).toEqual([30, 60]);
  });

  test('counts slow and failed calls once and keeps them out of latency percentiles', async () => {
    const call = (event: string, ms: number, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ at: t0, level: 'info', scope: 'invoke', event, ms, kind: 'call', ...extra });
    const rows = [
      call('git:status', 10),
      call('git:status', 20),
      call('git:status', 400, { kind: 'slow' }),
      call('git:status', 2, { kind: 'failed' }),
      call('stats:list-sessions', 60),
      call('stats:list-sessions', 90),
    ];
    const { store } = await fixture({ [`invoke-20200102.jsonl`]: rows });
    const view = await store.overview(day, '24h', { at: iso(t0), rows: [], desktopApp: null });
    const git = view.channels.find((channel) => channel.channel === 'git:status');
    expect(git).toMatchObject({ calls: 2, slow: 1, failed: 1, p95Ms: 20, maxMs: 20 });
    expect(view.invoke).toEqual({ calls: 4, slow: 1, failed: 1 });
  });

  test('derives open hosts from boot/shutdown events and counts reaped windows', async () => {
    const boot = (pid: number, argv: string, ms = t0) =>
      JSON.stringify({ at: ms, level: 'info', scope: 'app-server', event: 'boot', pid, argv });
    const shutdown = (pid: number, ms = t0 + 1000) =>
      JSON.stringify({ at: ms, level: 'info', scope: 'app-server', event: 'shutdown', pid });
    const { store } = await fixture({
      [`app-server-20200102.jsonl`]: [
        boot(1, 'app-server --session s1'),
        boot(2, 'app-server --session s2'),
        shutdown(1),
      ],
      [`chat-20200102.jsonl`]: [
        JSON.stringify({ at: t0, level: 'info', scope: 'chat', event: 'chat.idle-reap', idleSeconds: 900 }),
        JSON.stringify({ at: t0 + 5000, level: 'info', scope: 'chat', event: 'chat.idle-reap', idleSeconds: 30 }),
      ],
    });
    const view = await store.overview(day, '24h', { at: iso(t0), rows: [], desktopApp: null });
    expect(view.lifecycle).toMatchObject({ boots: 2, shutdowns: 1, openPids: 1, sessions: ['s1', 's2'] });
    expect(view.chat).toMatchObject({ reaped: 2, maxIdleSeconds: 900 });
  });

  test('appends only new lines on refresh and reads session volume once', async () => {
    const { store, root } = await fixture(
      {
        [`mem-20200102.jsonl`]: [
          mem(t0, 'main', 3, 200),
          mem(t0 + 1000, 'main', 3, 205),
          mem(t0 + 2000, 'main', 3, 210),
        ],
      },
      { 'a.json': 2048, 'b.json': 1024 },
    );
    const first = await store.overview(day, '24h', { at: iso(t0), rows: [], desktopApp: null });
    expect(first.hosts[0].samples).toBe(3);
    expect(first.sessions).toMatchObject({ count: 2 });
    expect(first.sessions.largest.map((session) => session.id)).toEqual(['a', 'b']);
    await appendFile(join(root, 'mem-20200102.jsonl'), `${mem(t0 + 3000, 'main', 3, 220)}\n`);
    // 绕过 5 秒刷新节流：新实例等价于服务重启后重新读取
    const second = await new MicaStore(root, join(root, 'sessions')).overview(day, '24h', {
      at: iso(t0),
      rows: [],
      desktopApp: null,
    });
    expect(second.hosts[0]).toMatchObject({ rssMb: 220, samples: 4 });
  });

  test('reports missing scopes instead of guessing values', async () => {
    const { store } = await fixture({ [`mem-20200102.jsonl`]: [mem(t0, 'main', 3, 200)] });
    const view = await store.overview(day, '24h', { at: iso(t0), rows: [], desktopApp: null });
    const perfScope = view.scopes.find((scope) => scope.id === 'perf');
    expect(perfScope?.state).toBe('unavailable');
    expect(view.renderer.samples).toBe(0);
    expect(view.renderer.lagP99).toBeNull();
    expect(view.invoke.calls).toBe(0);
    expect(view.sessions).toMatchObject({ count: 0, error: null });
  });
});
