import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPluginsDetails, setPluginEnabled } from './plugins.js';

const tempDirectories: string[] = [];
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.MICA_HOME;
  process.env.MICA_HOME = mkTempDir();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = previousHome;
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('getPluginsDetails', () => {
  it('lists official plugins even when nothing is installed', () => {
    const details = getPluginsDetails();

    const todo = details.plugins.find((plugin) => plugin.id === 'todo');
    expect(todo).toMatchObject({ source: 'official', state: 'enabled', format: 'directory' });
    expect(todo?.location).toBe('plugins/todo');
    expect(details.officialDir).toBe('plugins');
    expect(details.statePath).toBe(join(process.env.MICA_HOME!, 'plugins-state.json'));
  });

  it('describes installed user plugins and their files', () => {
    const pluginDir = join(process.env.MICA_HOME!, 'plugins', 'hello');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ id: 'hello', name: 'Hello', version: '1.2.0', description: 'Says hi', main: 'index.js' }),
    );
    writeFileSync(join(pluginDir, 'index.js'), 'export default function setup() {}');

    const hello = getPluginsDetails().plugins.find((plugin) => plugin.id === 'user.hello');
    expect(hello).toMatchObject({
      name: 'Hello',
      version: '1.2.0',
      source: 'user',
      state: 'enabled',
      format: 'directory',
      location: pluginDir,
    });
    expect(hello?.files.map((file) => file.name)).toEqual(['index.js', 'plugin.json']);
  });

  it('marks broken plugins as failed with the manifest error', () => {
    const pluginDir = join(process.env.MICA_HOME!, 'plugins', 'broken');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), '{"id":"broken"}');

    const broken = getPluginsDetails().plugins.find((plugin) => plugin.id === 'user.broken');
    expect(broken?.state).toBe('failed');
    expect(broken?.error).toContain('缺少 name');
  });

  it('records the last load status written by the CLI', () => {
    const pluginDir = join(process.env.MICA_HOME!, 'plugins', 'legacy.mjs');
    mkdirSync(join(process.env.MICA_HOME!, 'plugins'), { recursive: true });
    writeFileSync(pluginDir, 'export default function setup() {}');
    writeFileSync(
      join(process.env.MICA_HOME!, 'plugin-status.json'),
      JSON.stringify({ plugins: [{ id: 'file.legacy', file: pluginDir, status: 'failed', error: 'boom' }] }),
    );

    const legacy = getPluginsDetails().plugins.find((plugin) => plugin.id === 'file.legacy');
    expect(legacy).toMatchObject({ state: 'failed', loadStatus: 'failed', error: 'boom' });
  });
});

describe('setPluginEnabled', () => {
  it('persists the disabled list and reports it on the next read', () => {
    const details = setPluginEnabled('todo', false);

    expect(details.plugins.find((plugin) => plugin.id === 'todo')?.state).toBe('disabled');
    expect(getPluginsDetails().plugins.find((plugin) => plugin.id === 'todo')?.state).toBe('disabled');

    expect(setPluginEnabled('todo', true).plugins.find((plugin) => plugin.id === 'todo')?.state).toBe('enabled');
  });
});

function mkTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mica-config-plugins-'));
  tempDirectories.push(directory);
  return directory;
}
