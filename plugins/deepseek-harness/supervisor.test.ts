import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from './plugin.json';
import {
  DEFAULT_EXECUTABLE,
  LOCK_NAME,
  createHarnessSupervisor,
  findExecutable,
  harnessAddressFromOutput,
  materializeWatchdog,
} from './supervisor.js';
import { WATCHDOG_SOURCE } from './watchdogSource.js';

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(process.env.MICA_TEST_ROOT ?? tmpdir(), 'mica-deepseek-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeChild(pid: number | undefined) {
  return Object.assign(new EventEmitter(), { pid, kill: vi.fn(() => true), unref: vi.fn() });
}

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  vi.stubEnv('MICA_DEEPSEEK_NODE', '');
  const dir = temporaryDirectory();
  const executable = join(dir, 'dsh');
  writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
  const settings = { enabled: 'true', executable, port: '0' };
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawn = vi.fn((_file: string, _args: string[], _options: object) => {
    const child = fakeChild(process.pid);
    children.push(child);
    return child;
  });
  const report = vi.fn();
  const options = { dataDir: dir, getSettings: () => settings, spawn: spawn as never, report };
  return {
    dir,
    executable,
    settings,
    spawn,
    children,
    report,
    options,
    supervisor: createHarnessSupervisor(options),
    lockPath: join(dir, LOCK_NAME),
    retry: () => JSON.parse(readFileSync(join(dir, 'retry.json'), 'utf8')),
    status: () => JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')),
  };
}

describe('deepseek harness supervisor helpers', () => {
  it('declares the independent settings and clickable address status', () => {
    expect(manifest.name).toBe('DeepSeek Harness');
    expect(manifest.requires).toEqual(['settings', 'background', 'desktop']);
    expect(manifest.settings.map((setting) => setting.key)).toEqual(['enabled', 'executable', 'port']);
    expect(manifest.status.find((status) => status.key === 'address')?.type).toBe('link');
  });

  it('finds an executable from PATH and prefers an explicit executable', () => {
    const dir = temporaryDirectory();
    const dsh = join(dir, 'dsh');
    writeFileSync(dsh, '#!/bin/sh\n');
    chmodSync(dsh, 0o755);
    expect(findExecutable('', { PATH: dir })).toBe(dsh);
    expect(findExecutable(dsh, { PATH: '' })).toBe(dsh);
    expect(findExecutable('/missing/dsh', { PATH: dir })).toBeNull();
  });

  it('materializes the watchdog source without changing it on repeat calls', () => {
    const dir = temporaryDirectory();
    const path = materializeWatchdog(dir);
    expect(path).toContain('watchdog.mjs');
    expect(readFileSync(path, 'utf8')).toBe(WATCHDOG_SOURCE);
  });

  it('parses the token-bearing URL from official CLI output', () => {
    expect(harnessAddressFromOutput('dsh web: http://127.0.0.1:61257/?token=secret-token')).toBe(
      'http://127.0.0.1:61257/?token=secret-token',
    );
    expect(WATCHDOG_SOURCE).toContain("['web', '--no-open', '--host', '127.0.0.1', '--port', String(port)]");
  });

  it('does not start when disabled or when the executable is unavailable', () => {
    const dir = temporaryDirectory();
    let starts = 0;
    const spawn = (() => {
      starts += 1;
      throw new Error('should not spawn');
    }) as never;
    const supervisor = createHarnessSupervisor({
      dataDir: dir,
      getSettings: () => ({ enabled: 'false', executable: DEFAULT_EXECUTABLE, port: '0' }),
      spawn,
    });
    supervisor.ensure();
    expect(starts).toBe(0);
  });

  it('writes an unavailable status without starting when no executable is found', () => {
    const dir = temporaryDirectory();
    const supervisor = createHarnessSupervisor({
      dataDir: dir,
      getSettings: () => ({ enabled: 'true', executable: '/missing/dsh', port: '0' }),
    });
    supervisor.ensure();
    expect(JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')).state.text).toBe('未找到可执行文件');
  });

  it('starts with the watchdog argv and restarts its owned process when settings change', () => {
    const dir = temporaryDirectory();
    const executable = join(dir, 'dsh');
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(executable, 0o755);
    let port = '0';
    const calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    const children: Array<{ killed: boolean }> = [];
    const spawn = ((_: string, args: string[], options: Record<string, unknown>) => {
      let child: {
        pid: number;
        killed: boolean;
        on: (...args: unknown[]) => typeof child;
        kill: () => boolean;
        unref: () => typeof child;
      };
      child = {
        pid: process.pid,
        killed: false,
        on: () => child,
        kill: () => {
          child.killed = true;
          return true;
        },
        unref: () => child,
      };
      calls.push({ args, options });
      children.push(child);
      return child;
    }) as never;
    const supervisor = createHarnessSupervisor({
      dataDir: dir,
      getSettings: () => ({ enabled: 'true', executable, port }),
      spawn,
    });
    supervisor.ensure();
    port = '61257';
    supervisor.ensure();
    expect(calls[0].args).toEqual([join(dir, 'watchdog.mjs')]);
    expect((calls[0].options.env as Record<string, string>).MICA_DEEPSEEK_PORT).toBe('0');
    expect((calls[1].options.env as Record<string, string>).MICA_DEEPSEEK_PORT).toBe('61257');
    expect(children[0].killed).toBe(true);
    supervisor.dispose();
    expect(children[1].killed).toBe(true);
  });

  it('does not take over or stop a watchdog owned by another session', () => {
    const dir = temporaryDirectory();
    const executable = join(dir, 'dsh');
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(executable, 0o755);
    writeFileSync(
      join(dir, 'deepseek-harness.lock'),
      JSON.stringify({
        pid: process.pid,
        ownerPid: process.pid + 1,
        fingerprint: `${executable}|0`,
        startedAt: Date.now(),
      }),
    );
    let starts = 0;
    const supervisor = createHarnessSupervisor({
      dataDir: dir,
      getSettings: () => ({ enabled: 'true', executable, port: '0' }),
      spawn: (() => {
        starts += 1;
        throw new Error('should not spawn');
      }) as never,
    });
    supervisor.ensure();
    supervisor.dispose();
    expect(starts).toBe(0);
  });
});

describe('deepseek harness startup recovery', () => {
  it('uses PATH node rather than the host executable and supports the helper override', () => {
    const f = fixture();
    f.supervisor.ensure();
    expect(f.spawn.mock.calls[0]?.[0]).toBe('node');
    f.supervisor.dispose();
    vi.stubEnv('MICA_DEEPSEEK_NODE', '/custom/node');
    const second = createHarnessSupervisor(f.options);
    second.ensure();
    expect(f.spawn.mock.calls[1]?.[0]).toBe('/custom/node');
    second.dispose();
    const third = createHarnessSupervisor({ ...f.options, nodeBin: '/explicit/node' });
    third.ensure();
    expect(f.spawn.mock.calls[2]?.[0]).toBe('/explicit/node');
    third.dispose();
  });

  it('handles missing PID before a later asynchronous error without leaving a lock', () => {
    const f = fixture();
    const child = fakeChild(undefined);
    f.spawn.mockReturnValue(child);
    f.supervisor.ensure();
    expect(existsSync(f.lockPath)).toBe(false);
    expect(() => child.emit('error', new Error('spawn node ENOENT'))).not.toThrow();
    child.emit('exit', 1, null);
    expect(f.retry().failures).toBe(1);
    expect(f.report).toHaveBeenCalledTimes(1);
    expect(f.status().state.tone).toBe('error');
    vi.advanceTimersByTime(5000);
    f.supervisor.ensure();
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it('cleans the reservation after synchronous spawn and source-materialization failures', () => {
    const f = fixture();
    f.spawn.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    expect(() => f.supervisor.ensure()).not.toThrow();
    expect(existsSync(f.lockPath)).toBe(false);
    expect(f.retry().failures).toBe(1);
    const secondDir = temporaryDirectory();
    mkdirSync(join(secondDir, 'watchdog.mjs'));
    const second = createHarnessSupervisor({ ...f.options, dataDir: secondDir });
    expect(() => second.ensure()).not.toThrow();
    expect(existsSync(join(secondDir, LOCK_NAME))).toBe(false);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.report).toHaveBeenCalledTimes(2);
  });

  it('backs off async errors and short-lived exits exponentially, capped at five minutes', () => {
    const f = fixture();
    const delays = [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000];
    for (const [index, delay] of delays.entries()) {
      f.supervisor.ensure();
      expect(f.spawn).toHaveBeenCalledTimes(index + 1);
      const child = f.children[index]!;
      if (index === 0) child.emit('error', new Error('spawn node EACCES'));
      child.emit('exit', 1, null);
      expect(existsSync(f.lockPath)).toBe(false);
      expect(f.retry().retryAt).toBe(Date.now() + delay);
      expect(f.report).toHaveBeenCalledTimes(index + 1);
      vi.advanceTimersByTime(delay - 1);
      f.supervisor.ensure();
      expect(f.spawn).toHaveBeenCalledTimes(index + 1);
      vi.advanceTimersByTime(1);
    }
  });

  it('shares backoff with newly created supervisors instead of alternating launches', () => {
    const f = fixture();
    f.supervisor.ensure();
    f.children[0]!.emit('exit', 1, null);
    const second = createHarnessSupervisor(f.options);
    second.ensure();
    f.supervisor.ensure();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    second.ensure();
    f.children[1]!.emit('exit', 1, null);
    expect(f.retry().failures).toBe(2);
    f.supervisor.ensure();
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });

  it('resets backoff after settings changes and a disable/enable cycle', () => {
    const f = fixture();
    f.spawn.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    f.supervisor.ensure();
    f.settings.port = '5001';
    f.supervisor.ensure();
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.retry().failures).toBe(1);
    f.settings.enabled = 'false';
    f.supervisor.ensure();
    expect(existsSync(join(f.dir, 'retry.json'))).toBe(false);
    f.settings.enabled = 'true';
    f.supervisor.ensure();
    expect(f.spawn).toHaveBeenCalledTimes(3);
    vi.stubEnv('MICA_DEEPSEEK_NODE', '/fixed/node');
    f.supervisor.ensure();
    expect(f.spawn).toHaveBeenCalledTimes(4);
    expect(f.spawn.mock.calls[3]?.[0]).toBe('/fixed/node');
    expect(f.retry().failures).toBe(1);
  });

  it('resets failures once a watchdog survives a minute', () => {
    const f = fixture();
    f.supervisor.ensure();
    f.children[0]!.emit('exit', 1, null);
    vi.advanceTimersByTime(10_000);
    f.supervisor.ensure();
    vi.advanceTimersByTime(60_000);
    f.supervisor.ensure();
    expect(existsSync(join(f.dir, 'retry.json'))).toBe(false);
    f.children[1]!.emit('exit', 1, null);
    expect(f.retry().failures).toBe(1);
  });

  it('does not back off intentional restarts or let old callbacks clear a replacement lock', () => {
    const f = fixture();
    f.supervisor.ensure();
    f.settings.port = '5002';
    f.supervisor.ensure();
    f.children[0]!.emit('exit', 0, 'SIGTERM');
    f.children[0]!.emit('error', new Error('late error'));
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(f.lockPath, 'utf8')).fingerprint).toBe(`${f.executable}|5002`);
    expect(existsSync(join(f.dir, 'retry.json'))).toBe(false);
    f.supervisor.dispose();
    f.children[1]!.emit('exit', 0, 'SIGTERM');
    f.supervisor.ensure();
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.report).not.toHaveBeenCalled();
  });

  it('recovers an old live-owner reservation only after its startup timeout', () => {
    const f = fixture();
    writeFileSync(
      f.lockPath,
      JSON.stringify({ pid: 0, ownerPid: process.pid, fingerprint: `${f.executable}|0`, startedAt: Date.now() }),
    );
    f.supervisor.ensure();
    expect(f.spawn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    f.supervisor.ensure();
    expect(existsSync(f.lockPath)).toBe(false);
    expect(f.retry().failures).toBe(1);
    vi.advanceTimersByTime(10_000);
    f.supervisor.ensure();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    f.supervisor.dispose();
  });

  it('defers error cleanup when another host holds the guard, then retries it safely', () => {
    const f = fixture();
    f.supervisor.ensure();
    const claim = join(`${f.lockPath}.guard.owners`, `${process.pid}-00000000-0000-0000-0000-000000000001`);
    writeFileSync(claim, '');
    f.children[0]!.emit('error', new Error('spawn failed'));
    expect(existsSync(f.lockPath)).toBe(true);
    rmSync(claim);
    f.supervisor.ensure();
    expect(existsSync(f.lockPath)).toBe(false);
    expect(f.retry().failures).toBe(1);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it('stops its owned child on dispose even while the shared guard is busy', () => {
    const f = fixture();
    f.supervisor.ensure();
    const lock = readFileSync(f.lockPath, 'utf8');
    const claim = join(`${f.lockPath}.guard.owners`, `${process.pid}-00000000-0000-0000-0000-000000000001`);
    writeFileSync(claim, '');
    f.supervisor.dispose();
    expect(f.children[0]!.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(readFileSync(f.lockPath, 'utf8')).toBe(lock);
    expect(existsSync(claim)).toBe(true);
    f.children[0]!.emit('exit', 0, 'SIGTERM');
    f.children[0]!.emit('error', new Error('late error'));
    rmSync(claim);
    f.supervisor.ensure();
    f.supervisor.dispose();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.children[0]!.kill).toHaveBeenCalledTimes(1);
    expect(f.report).not.toHaveBeenCalled();
    expect(existsSync(join(f.dir, 'retry.json'))).toBe(false);
  });

  it('does not remove another supervisor replacement lock during disposal', () => {
    const f = fixture();
    f.supervisor.ensure();
    const replacement = JSON.stringify({
      pid: process.pid,
      ownerPid: process.pid + 1,
      fingerprint: `${f.executable}|0`,
      startedAt: Date.now() + 1,
    });
    writeFileSync(f.lockPath, replacement);
    f.supervisor.dispose();
    expect(f.children[0]!.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(readFileSync(f.lockPath, 'utf8')).toBe(replacement);
  });
});
