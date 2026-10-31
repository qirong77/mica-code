import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MicaCommand } from '@packages/mica-commands/index.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import * as annotations from '@packages/mica-plugin/sessionAnnotations.js';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import setup from './index.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function harness(raw?: string) {
  const home = mkdtempSync(join(tmpdir(), 'mica-session-tags-'));
  directories.push(home);
  const file = annotations.sessionAnnotationsPath(home, 'session-tags');
  if (raw !== undefined) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, raw);
  }
  const messages: string[] = [];
  const reports: Array<{ level: string }> = [];
  let command: MicaCommand;
  setup({
    pluginId: 'session-tags',
    paths: { config: home },
    session: { describe: () => ({ id: 'session-1' }) },
    commands: {
      register: (value: MicaCommand) => {
        command = value;
        return { dispose() {} };
      },
    },
    ui: { showMessage: (value: string) => messages.push(value) },
    health: { report: (value: { level: string }) => reports.push(value) },
    logger: { info() {}, warn() {} },
    onDispose() {},
  } as unknown as PluginContext);
  return {
    file,
    messages,
    reports,
    run: (args: string) => command.handler({}, args),
    read: () => JSON.parse(readFileSync(file, 'utf8')),
  };
}

describe('session tags persistence', () => {
  it('refuses concurrent plugin updates and retries from the current store after release', async () => {
    const fixture = harness();
    const release = acquireProcessLock(`${fixture.file}.lock`);
    expect(release).not.toBeNull();
    try {
      expect(await fixture.run('add red')).toMatchObject({ ok: false });
      expect(fixture.read().assignments).toEqual({});
    } finally {
      release?.();
    }
    expect(await fixture.run('add red')).toMatchObject({ ok: true });
    expect(fixture.read().assignments['session-1']).toEqual(['red']);
  });

  it('补齐缺失色槽时保留已有会话标签归属', () => {
    const fixture = harness(JSON.stringify({ version: 1, options: [], assignments: { 'session-1': ['red', 'blue'] } }));
    expect(fixture.read().options).toHaveLength(7);
    expect(fixture.read().assignments).toEqual({ 'session-1': ['red', 'blue'] });
  });

  it('写入失败准确返回失败，不显示已打标，修复后可重试', async () => {
    const fixture = harness();
    const original = fixture.read();
    const write = vi.spyOn(annotations, 'writeSessionAnnotations').mockImplementation(() => {
      throw new Error('mock disk full');
    });
    expect(await fixture.run('add red')).toMatchObject({ ok: false });
    expect(fixture.messages.at(-1)).toContain('mock disk full');
    expect(fixture.messages.at(-1)).not.toContain('已打标');
    expect(fixture.read()).toEqual(original);
    write.mockRestore();
    expect(await fixture.run('add red')).toMatchObject({ ok: true });
    expect(fixture.read().assignments['session-1']).toEqual(['red']);
    expect(fixture.reports.at(-1)?.level).toBe('ok');
  });

  it('损坏文件不会被初始化覆盖，并且只上报一次健康故障', async () => {
    const fixture = harness('{broken');
    expect(await fixture.run('add red')).toMatchObject({ ok: false });
    expect(readFileSync(fixture.file, 'utf8')).toBe('{broken');
    expect(fixture.reports).toHaveLength(1);
  });

  it('重命名后的多词标签名能够打标和去标', async () => {
    const fixture = harness();
    await fixture.run('rename red Needs Review');
    await fixture.run('add Needs Review blue');
    expect(fixture.read().assignments['session-1']).toEqual(['red', 'blue']);
    await fixture.run('remove Needs Review');
    expect(fixture.read().assignments['session-1']).toEqual(['blue']);
    await fixture.run('rename Needs Review Urgent Work');
    expect(fixture.read().options[0].label).toBe('Urgent Work');
  });
});
