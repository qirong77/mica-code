import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/PluginContext.js';
import { createBridgeSupervisor, materializeBridge } from './BridgeSupervisor.js';
import { BRIDGE_SOURCE } from './bridgeSource.js';

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
  });

  afterEach(() => {
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
});
