import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createPluginHealthStore } from '@packages/mica-plugin/PluginHealth.js';
import setup from './index.js';
import { writeStatus } from './supervisor.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

function fixture() {
  vi.stubEnv('MICA_DEEPSEEK_NODE', 'node');
  const home = mkdtempSync(join(process.env.MICA_TEST_ROOT ?? tmpdir(), 'mica-deepseek-plugin-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const executable = join(home, 'dsh');
  writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
  const dataDir = join(home, 'plugin-data', 'deepseek-harness');
  const settings = { enabled: 'true', executable, port: '0' };
  const health = createPluginHealthStore('deepseek-harness', { configDir: home, version: '1.0.0' });
  const clear = vi.spyOn(health, 'clear');
  const child = Object.assign(new EventEmitter(), { pid: process.pid, kill: vi.fn(), unref: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as never);
  let run!: () => void;
  const ctx = {
    pluginId: 'deepseek-harness',
    paths: { config: home },
    desktop: {},
    settings: { get: () => settings },
    health,
    background: {
      register: (task: { run: () => void }) => {
        run = task.run;
        return { dispose: vi.fn() };
      },
    },
    onDispose: (dispose: () => void | Promise<void>) => cleanup.push(dispose),
  } as unknown as PluginContext;
  return {
    health,
    clear,
    settings,
    child,
    setup: () => setup(ctx),
    run: () => run(),
    ready: (overrides: Record<string, unknown> = {}) =>
      writeStatus(dataDir, {
        state: { text: '运行中', tone: 'ok' },
        process: { text: `DeepSeek Harness watchdog ${child.pid}`, tone: 'ok' },
        executable,
        address: 'http://127.0.0.1:61257/?token=test-token',
        ...overrides,
      }),
  };
}

describe('deepseek harness health recovery', () => {
  it('clears a startup failure only after repair and a ready report from the current watchdog', () => {
    const f = fixture();
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error('spawn node ENOENT');
    });
    f.setup();
    const failure = f.health.read();
    expect(failure).toMatchObject({ level: 'error', message: expect.stringContaining('spawn node ENOENT') });
    vi.stubEnv('MICA_DEEPSEEK_NODE', '/fixed/node');
    f.run();
    expect(spawn).toHaveBeenCalledTimes(2);
    f.run();
    expect(f.health.read()).toEqual(failure);
    for (const status of [
      { process: { text: `DeepSeek Harness watchdog ${process.pid + 1}`, tone: 'ok' } },
      { state: { text: '启动中', tone: 'warn' } },
      { executable: '/stale/dsh' },
      { address: 'not-an-address' },
    ]) {
      f.ready(status);
      f.run();
      expect(f.health.read()).toEqual(failure);
    }
    expect(f.clear).not.toHaveBeenCalled();
    f.ready();
    f.run();
    expect(f.health.read()).toBeNull();
    f.run();
    expect(f.clear).toHaveBeenCalledTimes(1);
  });

  it('recovers its persisted health issue when observing a shared ready watchdog', () => {
    const f = fixture();
    f.setup();
    f.health.report({ level: 'error', message: 'DeepSeek Harness 启动失败：previous host failure' });
    f.ready();
    f.setup();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(f.health.read()).toBeNull();
  });

  it.each(['hook:turn:after failed', 'background:deepseek-harness-supervisor failed'])(
    'does not clear an unrelated runtime error after readiness: %s',
    (message) => {
      const f = fixture();
      f.setup();
      f.health.report({ level: 'error', message });
      f.ready();
      f.run();
      expect(f.health.read()).toMatchObject({ level: 'error', message });
      expect(f.clear).not.toHaveBeenCalled();
    },
  );

  it('clears its missing-executable warning only after the repaired service becomes ready', () => {
    const f = fixture();
    const executable = f.settings.executable;
    f.settings.executable = '/missing/dsh';
    f.setup();
    expect(f.health.read()?.level).toBe('warn');
    f.settings.executable = executable;
    f.run();
    expect(f.health.read()?.level).toBe('warn');
    f.ready();
    f.run();
    expect(f.health.read()).toBeNull();
  });
});
