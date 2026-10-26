import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFilePluginStatus } from './file-plugins.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'mica-file-plugins-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function writeStatus(setupReport: Parameters<typeof writeFilePluginStatus>[2]) {
  return writeFilePluginStatus(
    { paths: { config: configDir, plugins: join(configDir, 'plugins') } },
    {
      loaded: [
        { pluginId: 'user.a', id: 'user.a', file: join(configDir, 'plugins', 'a') },
        { pluginId: 'user.b', id: 'user.b', file: join(configDir, 'plugins', 'b') },
      ],
      failed: [],
    } as never,
    setupReport,
  );
}

describe('writeFilePluginStatus', () => {
  it('records a plugin that was skipped for missing host capabilities', () => {
    const status = writeStatus({
      loaded: [],
      failed: [],
      skipped: [{ pluginId: 'user.b', missing: ['prompt', 'ui'] }],
    });

    const entry = status.plugins.find((plugin) => plugin.id === 'user.b');
    // 跳过不是「加载成功」：页面要能看出它为什么没生效，而不是显示一个绿色的已加载。
    expect(entry?.status).toBe('skipped');
    expect(entry?.error).toBe('缺少宿主能力：prompt / ui');
  });

  it('keeps setup failures ahead of skips when both apply', () => {
    const status = writeStatus({
      loaded: [],
      failed: [{ pluginId: 'user.a', error: new Error('boom') }],
      skipped: [{ pluginId: 'user.a', missing: ['ui'] }],
    });

    expect(status.plugins.find((plugin) => plugin.id === 'user.a')?.status).toBe('failed');
  });

  it('writes the result to plugin-status.json so the config page can read it', () => {
    writeStatus({ loaded: ['user.a'], failed: [], skipped: [] });
    const raw = JSON.parse(readFileSync(join(configDir, 'plugin-status.json'), 'utf-8'));
    expect(raw.plugins.map((plugin: { id: string; status: string }) => [plugin.id, plugin.status])).toEqual([
      ['user.a', 'loaded'],
      ['user.b', 'registered'],
    ]);
  });
});
