import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import type { PluginContext } from '@packages/mica-plugin/PluginContext.js';
import type { PluginBackgroundTask } from '@packages/mica-plugin/PluginBackground.js';
import {
  buildStatus,
  createBridgeSupervisor,
  materializeBridge,
  registerBridgeSupervisor,
} from './BridgeSupervisor.js';
import { BRIDGE_SOURCE } from './bridgeSource.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

type FakeContext = PluginContext & {
  healthLog: Array<{ level: string; message: string }>;
};

function fakeContext(values: Record<string, string> = {}, issues: unknown[] = []): FakeContext {
  const healthLog: Array<{ level: string; message: string }> = [];
  const ctx = {
    pluginId: 'mobile-relay',
    settings: {
      path: null,
      get: () => ({ enabled: 'true', relayUrl: 'https://relay.example', token: 'secret', ...values }),
      validate: () => issues,
    },
    health: {
      report: (report: { level: string; message: string }) => healthLog.push(report),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as FakeContext;
  ctx.healthLog = healthLog;
  return ctx;
}

describe('mobile-relay bridge supervisor', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mica-relay-test-'));
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('materializes the embedded bridge script and keeps it stable', () => {
    const first = materializeBridge(dir);
    expect(readFileSync(first, 'utf8')).toBe(BRIDGE_SOURCE);
    const before = statSync(first).mtimeMs;

    const second = materializeBridge(dir);
    expect(second).toBe(first);
    // 内容没变就不重写：否则每次启动都换 mtime，白折腾
    expect(statSync(second).mtimeMs).toBe(before);
  });

  it('rewrites the script when the embedded copy changes', () => {
    const target = materializeBridge(dir);
    writeFileSync(target, '// stale', 'utf8');
    materializeBridge(dir);
    expect(readFileSync(target, 'utf8')).toBe(BRIDGE_SOURCE);
  });

  it('does not start anything when the switch is off', () => {
    const ctx = fakeContext({ enabled: 'false' });
    const supervisor = createBridgeSupervisor(ctx, { dataDir: dir });
    expect(supervisor.ensure()).toEqual({ pid: null, changed: false });
    expect(supervisor.runningPid()).toBeNull();
  });

  it('refuses to run with incomplete settings and reports why', () => {
    const ctx = fakeContext({}, [{ key: 'token', message: '不能为空' }]);
    const supervisor = createBridgeSupervisor(ctx, { dataDir: dir });
    expect(supervisor.ensure().pid).toBeNull();
    expect(ctx.healthLog.at(-1)?.message).toContain('token');
  });

  it('treats a lock whose process is gone as stale', () => {
    // 一个几乎不可能存在的 pid
    writeFileSync(join(dir, 'bridge.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 0 }), 'utf8');
    const ctx = fakeContext({ enabled: 'false' });
    const supervisor = createBridgeSupervisor(ctx, { dataDir: dir });
    expect(supervisor.ensure().pid).toBeNull();
    expect(() => statSync(join(dir, 'bridge.lock'))).toThrow();
  });

  it('stops a running bridge when the switch flips off', () => {
    const ctx = fakeContext({ enabled: 'false' });
    writeFileSync(join(dir, 'bridge.lock'), JSON.stringify({ pid: process.pid, startedAt: 0 }), 'utf8');
    const supervisor = createBridgeSupervisor(ctx, { dataDir: dir });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(supervisor.ensure()).toEqual({ pid: null, changed: true });
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(() => statSync(join(dir, 'bridge.lock'))).toThrow();
    kill.mockRestore();
  });

  it('restarts the bridge when the relay address or token changes', () => {
    const values: Record<string, string> = { relayUrl: 'https://old.example', token: 'tok-old' };
    const ctx = fakeContext(values);
    ctx.settings.get = () => ({ enabled: 'true', ...values });
    // 假装桥是本实例刚拉起的，且用的是 old.example
    writeFileSync(join(dir, 'bridge.lock'), JSON.stringify({ pid: process.pid, startedAt: 0 }), 'utf8');
    const supervisor = createBridgeSupervisor(ctx, { dataDir: dir });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    // 第一次 ensure 把当前配置认作「这份桥的配置」
    process.env.MICA_BRIDGE_NODE = 'false';
    expect(supervisor.ensure()).toEqual({ pid: process.pid, changed: false });

    values.token = 'tok-new';
    // 换了口令：先停，下一跳按新配置拉起
    expect(supervisor.ensure()).toEqual({ pid: null, changed: true });
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(() => statSync(join(dir, 'bridge.lock'))).toThrow();
    kill.mockRestore();
    delete process.env.MICA_BRIDGE_NODE;
  });

  function backgroundHarness(values: Record<string, string>) {
    const ctx = fakeContext(values);
    let task!: PluginBackgroundTask;
    ctx.background = {
      register: (entry) => {
        task = entry;
        return { dispose() {} };
      },
      list: () => [],
      disposeAll() {},
    };
    ctx.onDispose = vi.fn();
    registerBridgeSupervisor(ctx, dir);
    return { ctx, run: (signal = new AbortController().signal) => task.run({ signal, tick: 1 }) };
  }

  it('refreshes relay health immediately after only the token changes', async () => {
    const values = { enabled: 'false', relayUrl: 'https://relay.test', token: 'old-token' };
    const { ctx, run } = backgroundHarness(values);
    ctx.settings.get = () => values;
    const fetcher = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(
          JSON.stringify({
            phoneOnline: (init.headers as Record<string, string>)['x-relay-token'] === 'old-token',
          }),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    await run();
    values.token = 'new-token';
    await run();
    expect(fetcher).toHaveBeenCalledTimes(2);
    const status = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8'));
    expect(status.phoneOnline).toBe(false);
  });

  it('cancels an in-flight health probe and does not publish after disposal', async () => {
    const { run } = backgroundHarness({ enabled: 'false' });
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
          }),
      ),
    );
    const running = run(controller.signal);
    controller.abort();
    await running;
    expect(() => statSync(join(dir, 'data.json'))).toThrow();
  });

  it('does not rewrite unchanged status on every supervision tick', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );
    const { run } = backgroundHarness({ enabled: 'false' });
    await run();
    const first = readFileSync(join(dir, 'data.json'), 'utf8');
    now.mockReturnValue(103_000);
    await run();
    expect(readFileSync(join(dir, 'data.json'), 'utf8')).toBe(first);
  });

  it('does not replace a lock while another session is starting the bridge', () => {
    const lock = { pid: 0, ownerPid: process.pid, startedAt: Date.now() };
    writeFileSync(join(dir, 'bridge.lock'), JSON.stringify(lock));
    const supervisor = createBridgeSupervisor(fakeContext(), { dataDir: dir });
    expect(supervisor.ensure().pid).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, 'bridge.lock'), 'utf8'))).toEqual(lock);
  });

  it('does not remove a stale lock or start a bridge while another supervisor owns the guard', () => {
    const lockPath = join(dir, 'bridge.lock');
    const stale = JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 0 });
    writeFileSync(lockPath, stale);
    const release = acquireProcessLock(`${lockPath}.guard`)!;
    const supervisor = createBridgeSupervisor(fakeContext(), { dataDir: dir });
    try {
      expect(supervisor.ensure()).toEqual({ pid: null, changed: false });
      expect(supervisor.runningPid()).toBeNull();
      expect(readFileSync(lockPath, 'utf8')).toBe(stale);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it.each(['missing', 'replaced'])('releases its own child even when its lock is %s', (state) => {
    const child = { pid: 44001, on: vi.fn(), unref: vi.fn(), kill: vi.fn() };
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const supervisor = createBridgeSupervisor(fakeContext(), { dataDir: dir });
    expect(supervisor.ensure().pid).toBe(child.pid);
    const lockPath = join(dir, 'bridge.lock');
    if (state === 'missing') rmSync(lockPath);
    else writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ownerPid: process.pid }));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(supervisor.stop({ ownedOnly: true })).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');
    if (state === 'replaced') expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
    expect(supervisor.stop({ ownedOnly: true })).toBe(false);
  });

  it('recovers an old incomplete lock without deleting a lock that is still being written', () => {
    const lockPath = join(dir, 'bridge.lock');
    writeFileSync(lockPath, '');
    const supervisor = createBridgeSupervisor(fakeContext({ enabled: 'false' }), { dataDir: dir });
    expect(supervisor.runningPid()).toBeNull();
    expect(statSync(lockPath).isFile()).toBe(true);
    utimesSync(lockPath, new Date(1), new Date(1));
    expect(supervisor.runningPid()).toBeNull();
    expect(() => statSync(lockPath)).toThrow();
  });

  it('does not stop another session’s bridge when an observing session closes', async () => {
    writeFileSync(join(dir, 'bridge.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const { ctx, run } = backgroundHarness({});
    const dispose: Array<() => void> = [];
    ctx.onDispose = (handler) => {
      dispose.push(handler);
    };
    registerBridgeSupervisor(ctx, dir);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    );
    await run();
    for (const handler of dispose) handler();
    expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(JSON.parse(readFileSync(join(dir, 'bridge.lock'), 'utf8')).pid).toBe(process.pid);
  });
});

describe('buildStatus', () => {
  // 卡片只读这一份；链接、开关状态与三个在线标记都必须在这里定死
  it('builds a phone link that already carries the token', () => {
    const status = buildStatus(
      { relayUrl: 'https://1-2-3-4.sslip.io/', token: '0123456789abcdef0123' },
      null,
      null,
      1_000,
    );
    expect(status.relayUrl).toBe('https://1-2-3-4.sslip.io');
    expect(status.phoneUrl).toBe('https://1-2-3-4.sslip.io/?t=0123456789abcdef0123');
  });

  it('leaves the link empty when the address or the token is missing', () => {
    expect(buildStatus({ relayUrl: 'https://x.test', token: '' }, null, null, 1).phoneUrl).toBe('');
    expect(buildStatus({ token: 'abc' }, null, null, 1).phoneUrl).toBe('');
  });

  // 短口令（自己编的、没在中转机上登记过）一定 401：给出一条打不开的链接只会误导
  it('leaves the link empty when the token is too short to be registered', () => {
    expect(buildStatus({ relayUrl: 'https://x.test', token: 'dd' }, null, null, 1).phoneUrl).toBe('');
  });

  it('marks the relay unreachable without inventing liveness', () => {
    const status = buildStatus({ relayUrl: 'https://x.test', token: 'a' }, null, 42, 7);
    expect(status).toMatchObject({
      relayOnline: false,
      agentOnline: false,
      phoneOnline: false,
      bridgePid: 42,
      updatedAt: 7,
    });
  });

  it('reports what the relay health says when it answers', () => {
    const status = buildStatus(
      { relayUrl: 'https://x.test', token: 'a' },
      { agentOnline: true, phoneOnline: true },
      9,
      1,
    );
    expect(status).toMatchObject({ relayOnline: true, agentOnline: true, phoneOnline: true });
  });

  it('treats only the literal false as switched off', () => {
    expect(buildStatus({}, null, null, 1).enabled).toBe(true);
    expect(buildStatus({ enabled: 'false' }, null, null, 1).enabled).toBe(false);
  });

  // 手机端页面是随包产物的一份拷贝：Mica 升级后这里要能看出手机上还是旧界面
  it('compares the page version the relay serves with the local one', () => {
    const same = buildStatus({ relayUrl: 'https://x.test', token: 'a' }, { pageVersion: 'abc123' }, 9, 1, 'abc123');
    expect(same.page).toEqual({ text: '已同步 · abc123', tone: 'ok' });

    const behind = buildStatus({ relayUrl: 'https://x.test', token: 'a' }, { pageVersion: 'abc123' }, 9, 1, 'def456');
    expect(behind.page.tone).toBe('warn');
    expect(behind.page.text).toContain('落后');
    expect(behind.page.text).toContain('def456');

    expect(buildStatus({ relayUrl: 'https://x.test', token: 'a' }, null, 9, 1, null).page).toEqual({
      text: '未知',
      tone: 'warn',
    });
  });

  // 配置页直接渲染这三行，语气由插件给：页面不认识「桥是什么」，只按 tone 上色
  it('describes the three runtime rows the config page shows', () => {
    const offline = buildStatus({ relayUrl: 'https://x.test', token: 'a' }, null, 12, 1);
    expect(offline.bridge).toEqual({ text: '运行中 · pid 12', tone: 'ok' });
    expect(offline.relay).toEqual({ text: '不可达', tone: 'error' });
    expect(offline.phone).toEqual({ text: '未连接', tone: 'warn' });

    const online = buildStatus({ relayUrl: 'https://x.test', token: 'a' }, { phoneOnline: true }, null, 1);
    expect(online.bridge).toEqual({ text: '未运行', tone: 'error' });
    expect(online.relay).toEqual({ text: '可达', tone: 'ok' });
    expect(online.phone).toEqual({ text: '正在查看', tone: 'ok' });
  });

  it('says 未配置 rather than 不通 when no relay address is set yet', () => {
    const status = buildStatus({ token: 'a' }, null, 5, 1);
    expect(status.relay).toEqual({ text: '未配置', tone: 'warn' });
    expect(status.phone).toEqual({ text: '未配置', tone: 'warn' });
  });

  it('switched off reports the bridge as stopped instead of running', () => {
    expect(buildStatus({ enabled: 'false' }, null, 5, 1).bridge).toEqual({ text: '已停用', tone: 'warn' });
  });
});
