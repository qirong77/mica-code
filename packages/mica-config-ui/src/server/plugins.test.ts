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
    expect(todo).toMatchObject({ source: 'official', state: 'enabled' });
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
      location: pluginDir,
    });
    expect(hello?.manifestFile).toBe(join(pluginDir, 'plugin.json'));
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
    const pluginDir = join(process.env.MICA_HOME!, 'plugins', 'hello');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ id: 'hello', name: 'Hello', version: '1.2.0', main: 'index.js' }),
    );
    writeFileSync(join(pluginDir, 'index.js'), 'export default function setup() {}');
    writeFileSync(
      join(process.env.MICA_HOME!, 'plugin-status.json'),
      JSON.stringify({
        plugins: [{ id: 'user.hello', file: join(pluginDir, 'index.js'), status: 'failed', error: 'boom' }],
      }),
    );

    expect(getPluginsDetails().plugins.find((plugin) => plugin.id === 'user.hello')).toMatchObject({
      state: 'failed',
      loadStatus: 'failed',
      error: 'boom',
    });
  });

  it('matches a load failure by plugin directory when the manifest never parsed', () => {
    const pluginDir = join(process.env.MICA_HOME!, 'plugins', 'unparsable');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      '{"id":"unparsable","name":"x","version":"1.0.0","main":"missing.js"}',
    );
    writeFileSync(
      join(process.env.MICA_HOME!, 'plugin-status.json'),
      JSON.stringify({ loadFailed: [{ file: pluginDir, status: 'failed', error: '入口文件不存在：missing.js' }] }),
    );

    expect(getPluginsDetails().plugins.find((plugin) => plugin.id === 'user.unparsable')).toMatchObject({
      state: 'failed',
      error: '入口文件不存在：missing.js',
    });
  });

  it('reports a host-capability skip without calling the plugin broken', () => {
    // TUI 里没有 `desktop` 这一面：被跳过不等于插件坏了，页面必须同时给出宿主，
    // 否则「在别的宿主里跳过」会被读成故障。
    writeFileSync(
      join(process.env.MICA_HOME!, 'plugin-status.json'),
      JSON.stringify({
        host: 'tui',
        plugins: [
          { id: 'session-copy', status: 'skipped', error: '缺少宿主能力：desktop' },
          { id: 'todo', status: 'loaded' },
        ],
      }),
    );

    const details = getPluginsDetails();
    const skipped = details.plugins.find((plugin) => plugin.id === 'session-copy');
    expect(skipped).toMatchObject({
      state: 'enabled',
      loadStatus: 'skipped',
      loadHost: 'tui',
      skipReason: '缺少宿主能力：desktop',
    });
    expect(skipped?.error).toBeUndefined();
    expect(details.plugins.find((plugin) => plugin.id === 'todo')).toMatchObject({
      state: 'enabled',
      loadStatus: 'loaded',
      loadHost: 'tui',
    });
  });

  it('does not invent a load status for official plugins nobody has assembled yet', () => {
    const plugin = getPluginsDetails().plugins.find((entry) => entry.id === 'todo');
    expect(plugin?.loadStatus).toBeUndefined();
    expect(plugin?.loadHost).toBeUndefined();
  });

  it('resolves declared desktop checks into the catalog rows the page renders', () => {
    const pluginDir = join(process.env.MICA_HOME!, 'plugins', 'needs-permissions');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        id: 'needs-permissions',
        name: 'Needs Permissions',
        version: '1.0.0',
        main: 'index.js',
        desktop: { checks: ['screen-recording', 'command-line-tools'] },
      }),
    );
    writeFileSync(join(pluginDir, 'index.js'), 'export default function setup() {}');

    const plugin = getPluginsDetails().plugins.find((entry) => entry.id === 'user.needs-permissions');
    // 顺序来自清单，文案与面板地址来自宿主的检查目录——页面自己不认识任何检查项。
    expect(plugin?.desktopChecks.map((check) => check.id)).toEqual(['screen-recording', 'command-line-tools']);
    expect(plugin?.desktopChecks[0]?.label).toBe('屏幕录制');
    expect(plugin?.desktopChecks[0]?.pane).toContain('Privacy_ScreenCapture');
    // 没有可打开的面板时不编一个出来
    expect(plugin?.desktopChecks[1]?.pane).toBeUndefined();
  });

  it('reports no desktop checks for a plugin that declares none', () => {
    expect(getPluginsDetails().plugins.find((plugin) => plugin.id === 'todo')?.desktopChecks).toEqual([]);
  });

  /*
   * 运行状态的值由插件自己写进 plugin-data：配置页只按声明取值，不认识具体插件，
   * 也就无法替它判断「通不通」——所以这里只验证取值与语气原样透传。
   */
  it('fills declared status rows from the plugin data file', () => {
    const pluginDir = join(process.env.MICA_HOME!, 'plugins', 'hello');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'index.js'), 'export default () => {};\n');
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        id: 'hello',
        name: 'Hello',
        version: '1.0.0',
        main: 'index.js',
        status: [
          { key: 'link', label: '链接', type: 'link' },
          { key: 'relay', label: '中转机', type: 'text' },
          { key: 'missing', label: '没写过', type: 'text' },
        ],
      }),
    );
    const dataDir = join(process.env.MICA_HOME!, 'plugin-data', 'user.hello');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'data.json'),
      JSON.stringify({ link: 'https://x.test/?t=a', relay: { text: '可达', tone: 'ok' } }),
    );

    const plugin = getPluginsDetails().plugins.find((entry) => entry.id === 'user.hello');
    expect(plugin?.status).toEqual([
      { key: 'link', label: '链接', type: 'link', value: 'https://x.test/?t=a', tone: null },
      { key: 'relay', label: '中转机', type: 'text', value: '可达', tone: 'ok' },
      // 插件还没上报：占位而不是隐藏，那一行本来就在声明里
      { key: 'missing', label: '没写过', type: 'text', value: null, tone: null },
    ]);
  });

  it('treats an unreadable data file as "not reported yet" instead of failing the page', () => {
    const pluginDir = join(process.env.MICA_HOME!, 'plugins', 'hello');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'index.js'), 'export default () => {};\n');
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        id: 'hello',
        name: 'Hello',
        version: '1.0.0',
        main: 'index.js',
        status: [{ key: 'relay', label: '中转机', type: 'text' }],
      }),
    );
    const dataDir = join(process.env.MICA_HOME!, 'plugin-data', 'user.hello');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'data.json'), '{ 半截');

    expect(getPluginsDetails().plugins.find((entry) => entry.id === 'user.hello')?.status).toEqual([
      { key: 'relay', label: '中转机', type: 'text', value: null, tone: null },
    ]);
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
