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
  const context = {
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
  };
  setup(context as unknown as PluginContext);
  return {
    file,
    messages,
    reports,
    context,
    run: (args: string) => command!.handler({}, args),
    read: () => JSON.parse(readFileSync(file, 'utf8')),
  };
}

describe('session tags persistence', () => {
  it('第一次装上就有一个「待 review」', () => {
    const fixture = harness();
    expect(fixture.read().options).toHaveLength(1);
    expect(fixture.read().options[0]).toMatchObject({ label: '待 review' });
  });

  it('refuses concurrent plugin updates and retries from the current store after release', async () => {
    const fixture = harness();
    const release = acquireProcessLock(`${fixture.file}.lock`);
    expect(release).not.toBeNull();
    try {
      expect(await fixture.run('add 待 review')).toMatchObject({ ok: false });
      expect(fixture.read().assignments).toEqual({});
    } finally {
      release?.();
    }
    expect(await fixture.run('add 待 review')).toMatchObject({ ok: true });
    expect(fixture.read().assignments['session-1']).toEqual(['tag-1']);
  });

  it('标签被删空的文件不会被重新预置', () => {
    const fixture = harness(JSON.stringify({ version: 1, name: 'Session Tags', options: [], assignments: {} }));
    expect(fixture.read().options).toEqual([]);
  });

  it('写入失败准确返回失败，不显示已打标，修复后可重试', async () => {
    const fixture = harness();
    const original = fixture.read();
    const write = vi.spyOn(annotations, 'writeSessionAnnotations').mockImplementation(() => {
      throw new Error('mock disk full');
    });
    expect(await fixture.run('add 待 review')).toMatchObject({ ok: false });
    expect(fixture.messages.at(-1)).toContain('mock disk full');
    expect(fixture.messages.at(-1)).not.toContain('已打标');
    expect(fixture.read()).toEqual(original);
    write.mockRestore();
    expect(await fixture.run('add 待 review')).toMatchObject({ ok: true });
    expect(fixture.read().assignments['session-1']).toEqual(['tag-1']);
    expect(fixture.reports.at(-1)?.level).toBe('ok');
  });

  it('损坏文件不会被初始化覆盖，并且只上报一次健康故障', async () => {
    const fixture = harness('{broken');
    expect(await fixture.run('add 待 review')).toMatchObject({ ok: false });
    expect(readFileSync(fixture.file, 'utf8')).toBe('{broken');
    expect(fixture.reports).toHaveLength(1);
  });

  it('含空格与中文的标签名能打标、去标', async () => {
    const fixture = harness();
    // 标签的定义在桌面端页面里做，这里直接写文件模拟「用户已经加过」
    const data = fixture.read();
    data.options.push({ id: 'tag-2', label: 'Needs Review', color: '#007AFF' });
    data.options.push({ id: 'tag-3', label: '待办', color: '#FF3B30' });
    writeFileSync(fixture.file, JSON.stringify(data));

    await fixture.run('add Needs Review 待办');
    expect(fixture.read().assignments['session-1']).toEqual(['tag-2', 'tag-3']);
    await fixture.run('remove Needs Review');
    expect(fixture.read().assignments['session-1']).toEqual(['tag-3']);
    expect(fixture.messages.at(-1)).toContain('待办');
  });

  it('认不出的标签名如实说出认不出，并列出可用的', async () => {
    const fixture = harness();
    await fixture.run('add nope');
    expect(fixture.read().assignments).toEqual({});
    expect(fixture.messages.at(-1)).toContain('认不出的标签：nope');
    expect(fixture.messages.at(-1)).toContain('待 review');
  });

  it('/tags 只保留打标相关动词，改名之类的会指回页面', async () => {
    const fixture = harness();
    await fixture.run('rename red 阻塞');
    expect(fixture.read().options[0]).toMatchObject({ id: 'tag-1', label: '待 review' });
    expect(fixture.messages.at(-1)).toContain('用法：/tags');
  });
});
