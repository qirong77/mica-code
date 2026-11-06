import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import setup from './index.js';
import { extensionAssets, extensionFiles, extensionFingerprint, extensionVersion } from './extensionSources.js';
import manifest from './plugin.json';

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it('installs the embedded extension and keeps one private token across actions', async () => {
  vi.stubEnv('MICA_BROWSER_URL', '');
  const home = mkdtempSync(join(tmpdir(), 'mica-cookie-install-'));
  homes.push(home);
  const handlers = new Map<string, () => Promise<{ message: string }>>();
  const panel = vi.fn(() => ({ dispose: vi.fn() }));
  setup({
    pluginId: 'browser-cookie-sync',
    paths: { config: home },
    actions: { register: (key: string, action: () => Promise<{ message: string }>) => handlers.set(key, action) },
    desktop: { panel },
    onDispose: vi.fn(),
    background: { register: vi.fn() },
  } as unknown as PluginContext);
  const result = await handlers.get('connection')!();
  const data = join(home, 'plugin-data', 'browser-cookie-sync');
  const token = readFileSync(join(data, 'token'), 'utf8');
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(result.message).toContain(token);
  expect(result.message).toContain(join(data, 'extension-v2'));
  expect(await handlers.get('connection')!()).toEqual(result);
  for (const [name, content] of Object.entries(extensionFiles)) {
    expect(readFileSync(join(data, 'extension-v2', name), 'utf8')).toBe(content);
  }
  for (const [name, base64] of Object.entries(extensionAssets)) {
    expect(readFileSync(join(data, 'extension-v2', name)).toString('base64')).toBe(base64);
  }
  expect(panel).not.toHaveBeenCalled();
  expect(manifest).not.toHaveProperty('desktop.panel');
});

it('refreshes the on-disk extension when the embedded build changes and keeps the previous update time otherwise', async () => {
  vi.stubEnv('MICA_BROWSER_URL', '');
  const home = mkdtempSync(join(tmpdir(), 'mica-cookie-update-'));
  homes.push(home);
  const handlers = new Map<string, () => Promise<{ message: string }>>();
  const ctx = () =>
    ({
      pluginId: 'browser-cookie-sync',
      paths: { config: home },
      actions: { register: (key: string, action: () => Promise<{ message: string }>) => handlers.set(key, action) },
      onDispose: vi.fn(),
      background: { register: vi.fn() },
    }) as unknown as PluginContext;
  const data = join(home, 'plugin-data', 'browser-cookie-sync');
  const metaFile = join(data, 'extension-meta.json');
  const readMeta = () => JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>;

  setup(ctx());
  const first = readMeta();
  expect(first).toMatchObject({ version: extensionVersion, fingerprint: extensionFingerprint });
  expect(typeof first.updatedAt).toBe('number');

  // 内容没变：再次加载插件不该推进「上次更新」，否则时间戳会变成每次启动的时间。
  await new Promise((resolve) => setTimeout(resolve, 15));
  setup(ctx());
  expect(readMeta().updatedAt).toBe(first.updatedAt);

  // 文件被改动（或旧版本残留）：重写回内嵌的那份，并推进更新时间。
  writeFileSync(join(data, 'extension-v2', 'popup.js'), 'stale');
  await new Promise((resolve) => setTimeout(resolve, 15));
  setup(ctx());
  expect(readFileSync(join(data, 'extension-v2', 'popup.js'), 'utf8')).toBe(extensionFiles['popup.js']);
  expect(readMeta().updatedAt).toBeGreaterThan(first.updatedAt as number);
  expect(handlers.has('connection')).toBe(true);
});

it('keeps embedded assets in sync with the distributable extension', () => {
  for (const [name, content] of Object.entries(extensionFiles)) {
    expect(readFileSync(new URL(`./extension/${name}`, import.meta.url), 'utf8')).toBe(content);
  }
  for (const [name, base64] of Object.entries(extensionAssets)) {
    expect(readFileSync(new URL(`./extension/${name}`, import.meta.url)).toString('base64')).toBe(base64);
  }
});
