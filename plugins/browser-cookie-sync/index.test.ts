import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import setup from './index.js';
import { extensionFiles } from './extensionSources.js';

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
  expect(panel).toHaveBeenCalledOnce();
});

it('keeps embedded assets in sync with the distributable extension', () => {
  for (const [name, content] of Object.entries(extensionFiles)) {
    expect(readFileSync(new URL(`./extension/${name}`, import.meta.url), 'utf8')).toBe(content);
  }
});
