import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from './plugin.json';
import {
  DEFAULT_EXECUTABLE,
  createHarnessSupervisor,
  findExecutable,
  harnessAddressFromOutput,
  materializeWatchdog,
} from './supervisor.js';
import { WATCHDOG_SOURCE } from './watchdogSource.js';

describe('deepseek harness supervisor helpers', () => {
  it('declares the independent settings and clickable address status', () => {
    expect(manifest.name).toBe('DeepSeek Harness');
    expect(manifest.requires).toEqual(['settings', 'background', 'desktop']);
    expect(manifest.settings.map((setting) => setting.key)).toEqual(['enabled', 'executable', 'port']);
    expect(manifest.status.find((status) => status.key === 'address')?.type).toBe('link');
  });

  it('finds an executable from PATH and prefers an explicit executable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-deepseek-'));
    const dsh = join(dir, 'dsh');
    writeFileSync(dsh, '#!/bin/sh\n');
    chmodSync(dsh, 0o755);
    expect(findExecutable('', { PATH: dir })).toBe(dsh);
    expect(findExecutable(dsh, { PATH: '' })).toBe(dsh);
    expect(findExecutable('/missing/dsh', { PATH: dir })).toBeNull();
  });

  it('materializes the watchdog source without changing it on repeat calls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-deepseek-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'mica-deepseek-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'mica-deepseek-'));
    const supervisor = createHarnessSupervisor({
      dataDir: dir,
      getSettings: () => ({ enabled: 'true', executable: '/missing/dsh', port: '0' }),
    });
    supervisor.ensure();
    expect(JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')).state.text).toBe('未找到可执行文件');
  });

  it('starts with the watchdog argv and restarts its owned process when settings change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-deepseek-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'mica-deepseek-'));
    const executable = join(dir, 'dsh');
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(executable, 0o755);
    writeFileSync(
      join(dir, 'deepseek-harness.lock'),
      JSON.stringify({ pid: process.pid, ownerPid: process.pid + 1, fingerprint: `${executable}|0`, startedAt: Date.now() }),
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
