import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePluginStatus } from './PluginStatus.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'mica-plugin-status-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function write(
  setupReport: Parameters<typeof writePluginStatus>[0]['setupReport'],
  loaded: { pluginId: string; file: string }[] = [],
) {
  return writePluginStatus({
    pluginsDir: join(configDir, 'plugins'),
    configDir,
    host: 'app-server',
    filePlugins: { loaded: loaded as never, failed: [] },
    setupReport,
  });
}

describe('writePluginStatus', () => {
  it('records a plugin that was skipped for missing host capabilities', () => {
    const status = write({ loaded: [], failed: [], skipped: [{ pluginId: 'user.b', missing: ['prompt', 'ui'] }] });

    const entry = status.plugins.find((plugin) => plugin.id === 'user.b');
    // 跳过不是「加载成功」：页面要能看出它为什么没生效，而不是显示一个绿色的已加载。
    expect(entry?.status).toBe('skipped');
    expect(entry?.error).toBe('缺少宿主能力：prompt / ui');
  });

  it('keeps setup failures ahead of skips when both apply', () => {
    const status = write({
      loaded: [],
      failed: [{ pluginId: 'user.a', error: new Error('boom') }],
      skipped: [{ pluginId: 'user.a', missing: ['ui'] }],
    });

    expect(status.plugins.find((plugin) => plugin.id === 'user.a')?.status).toBe('failed');
  });

  it('records official plugins too, so the page never has to invent their status', () => {
    // 官方插件随包分发、没有入口文件路径：只记 id 与结论。之前的实现只写用户插件，
    // 页面只能替官方插件猜一个「已加载」，真正被跳过时看不出来。
    const status = write({
      loaded: ['todo'],
      failed: [],
      skipped: [{ pluginId: 'session-copy', missing: ['desktop'] }],
    });

    expect(status.plugins).toEqual([
      { id: 'session-copy', status: 'skipped', error: '缺少宿主能力：desktop' },
      { id: 'todo', status: 'loaded' },
    ]);
  });

  it('keeps the entry file for user plugins and names the host that wrote it', () => {
    const status = write(
      { loaded: ['user.hello'], failed: [], skipped: [] },
      [{ pluginId: 'user.hello', file: '/plugins/hello/index.js' }],
    );

    expect(status.host).toBe('app-server');
    expect(status.plugins).toEqual([{ id: 'user.hello', file: '/plugins/hello/index.js', status: 'loaded' }]);
  });

  it('writes the result to plugin-status.json so the config page can read it', () => {
    write({ loaded: ['todo', 'user.a'], failed: [], skipped: [] }, [
      { pluginId: 'user.a', file: '/plugins/a/index.js' },
    ]);
    const raw = JSON.parse(readFileSync(join(configDir, 'plugin-status.json'), 'utf-8'));
    expect(raw.host).toBe('app-server');
    expect(raw.plugins.map((plugin: { id: string; status: string }) => [plugin.id, plugin.status])).toEqual([
      ['todo', 'loaded'],
      ['user.a', 'loaded'],
    ]);
  });
});
