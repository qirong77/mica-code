import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MicaCommand } from '@packages/mica-commands/index.js';
import type { PluginBackgroundTask, PluginContext } from '@packages/mica-plugin/index.js';
import setup from './index.js';

// 插件装配里默认用会话的 turn lease；测试用的是临时 home，不能让锁落到真实 `$MICA_HOME`。
vi.mock('@packages/mica-session/index.js', () => ({
  micaSession: { acquireTurnLease: () => ({ release() {} }) },
}));

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'mica-evolution-plugin-'));
  homes.push(home);
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const sessionPath = join(home, 'sessions', 'session-1.json');
  writeFileSync(
    sessionPath,
    `${JSON.stringify(
      {
        version: 1,
        id: 'session-1',
        createdAt: '2026-01-02T03:04:05.000Z',
        snapshot: { usageHistory: [{ inputTokens: 1, outputTokens: 1 }] },
      },
      null,
      2,
    )}\n`,
  );

  const messages: string[] = [];
  let command: MicaCommand | undefined;
  let task: PluginBackgroundTask | undefined;
  setup({
    pluginId: 'evolution',
    paths: { config: home },
    settings: { path: join(home, 'settings.json'), get: () => ({}), validate: () => [], set: () => ({}) },
    background: {
      register: (value: PluginBackgroundTask) => {
        task = value;
        return { dispose() {} };
      },
    },
    commands: {
      register: (value: MicaCommand) => {
        command = value;
        return { dispose() {} };
      },
    },
    ui: { showMessage: (value: string) => messages.push(value) },
    health: { report() {} },
    logger: { info() {}, warn() {}, error() {} },
    onDispose() {},
  } as unknown as PluginContext);
  return { home, sessionPath, messages, command, task };
}

function readUsage(path: string) {
  return JSON.parse(readFileSync(path, 'utf-8')).snapshot.usageHistory[0];
}

describe('evolution 插件装配', () => {
  it('注册启动清洗与 /evolution 命令，两者都能驱动同一份迁移', async () => {
    const { home, sessionPath, messages, command, task } = harness();
    expect(task?.id).toBe('startup');
    expect(command?.name).toBe('evolution');

    await task?.run({ signal: new AbortController().signal, tick: 1 });
    expect(readUsage(sessionPath).occurredAt).toBe('2026-01-02T03:04:05.000Z');

    const status = JSON.parse(readFileSync(join(home, 'plugin-data', 'evolution', 'data.json'), 'utf-8'));
    expect(status.lastRun).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(status.cleaned).toContain('1 个会话');

    await command?.handler?.({} as never, 'run');
    expect(messages.at(-1)).toContain('没有需要改写的旧数据');
  }, 20_000);
});
