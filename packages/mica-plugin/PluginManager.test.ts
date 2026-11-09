import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { HookRegistry } from './HookRegistry.js';
import type { PluginContext } from './PluginContext.js';
import { readPluginHealth, resolvePluginHealthPath, writePluginHealth } from './PluginHealth.js';
import { PluginManager, type PluginBaseContext } from './PluginManager.js';
import { parsePluginManifest } from './PluginManifest.js';
import { writePluginState } from './PluginState.js';
import type { PluginStatusFile } from './PluginStatus.js';
import { ServiceContainer } from './ServiceContainer.js';

let configDir: string;
let managers: PluginManager[];

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'mica-plugin-manager-'));
  managers = [];
  vi.stubEnv('MICA_HOME', configDir);
  vi.stubEnv('MICA_PLUGIN_LOG', '0');
});

afterEach(async () => {
  try {
    for (const manager of managers) await manager.disposeAll();
  } finally {
    vi.unstubAllEnvs();
    rmSync(configDir, { recursive: true, force: true });
  }
});

function createManager(): PluginManager {
  const manager = new PluginManager();
  managers.push(manager);
  return manager;
}

function context(): PluginBaseContext {
  return {
    paths: { home: configDir, config: configDir, plugins: join(configDir, 'plugins') },
    hooks: new HookRegistry(),
    commands: new micaCommands.CommandRegistry(),
    services: new ServiceContainer(),
    events: new micaRuntime.RuntimeEventBus(),
  };
}

function manifest(id: string, extra: Record<string, unknown> = {}) {
  const parsed = parsePluginManifest({ id, name: id, version: '1.0.0', ...extra });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.manifest;
}

function observeStatus(manager: PluginManager): () => PluginStatusFile {
  let readStatus: PluginContext['pluginStatus'];
  manager.register({
    id: 'observer',
    setup: (ctx) => {
      readStatus = ctx.pluginStatus;
    },
  });
  return () => {
    if (!readStatus) throw new Error('Host plugin status is unavailable');
    return readStatus();
  };
}

describe('PluginManager health ownership', () => {
  it.each([false, true])('keeps setup failure out of runtime health (required=%s)', async (required) => {
    const manager = createManager();
    const error = new Error('setup exploded');
    manager.register({
      id: 'broken',
      version: '1.0.0',
      required,
      setup: () => {
        throw error;
      },
    });
    const setup = manager.setupAll(context());
    if (required) await expect(setup).rejects.toBe(error);
    else expect((await setup).failed).toEqual([{ pluginId: 'broken', error }]);
    expect(manager.setupReport().failed).toEqual([{ pluginId: 'broken', error }]);
    expect(existsSync(resolvePluginHealthPath('broken', configDir))).toBe(false);
  });

  it.each(['loaded', 'failed'])('preserves existing runtime faults after setup is %s', async (result) => {
    const health = writePluginHealth(
      'demo',
      { level: 'error', message: 'request failed' },
      { configDir, version: '1.0.0' },
    );
    const manager = createManager();
    manager.register({
      id: 'demo',
      version: '1.0.0',
      setup: () => {
        if (result === 'failed') throw new Error('setup failed on this host');
      },
    });
    await manager.setupAll(context());
    expect(readPluginHealth('demo', { configDir, version: '1.0.0' })).toEqual(health);
  });

  it('preserves a runtime fault reported during successful setup', async () => {
    const manager = createManager();
    manager.register({
      id: 'demo',
      version: '1.0.0',
      setup: (ctx) => {
        ctx.health.report({ level: 'error', message: 'service unavailable' });
      },
    });
    await manager.setupAll(context());
    expect(readPluginHealth('demo', { configDir, version: '1.0.0' })).toMatchObject({
      level: 'error',
      message: 'service unavailable',
    });
  });

  it('reports hook faults with the loaded plugin version used by config readers', async () => {
    const manager = createManager();
    const host = context();
    manager.register({
      id: 'demo',
      version: '2.0.0',
      setup: (ctx) =>
        ctx.hooks.on(
          'turn:after',
          () => {
            throw new Error('hook exploded');
          },
          { pluginId: ctx.pluginId },
        ),
    });
    await manager.setupAll(host);
    await host.hooks.emit('turn:after', {});
    expect(readPluginHealth('demo', { configDir, version: '2.0.0' })).toMatchObject({
      version: '2.0.0',
      level: 'error',
      message: expect.stringContaining('hook exploded'),
    });
    expect(readPluginHealth('demo', { configDir, version: '1.0.0' })).toBeNull();
  });
});

describe('PluginManager host-local status', () => {
  it('does not expose status without host metadata', async () => {
    const manager = createManager();
    let supplied: PluginContext['pluginStatus'];
    const setup = vi.fn((ctx: PluginContext) => {
      supplied = ctx.pluginStatus;
    });
    manager.register({ id: 'demo', setup });
    const report = await manager.setupAll(context(), { only: ['demo'] });
    expect(report.loaded).toEqual(['demo']);
    expect(setup).toHaveBeenCalledOnce();
    expect(supplied).toBeUndefined();
    expect(existsSync(join(configDir, 'plugin-status.json'))).toBe(false);
  });

  it('isolates two managers sharing a status file, including loaded files and load failures', async () => {
    const tui = createManager();
    const desktop = createManager();
    const tuiStatus = observeStatus(tui);
    const desktopStatus = observeStatus(desktop);
    const pluginManifest = manifest('user.demo', { requires: ['desktop'] });
    for (const manager of [tui, desktop]) {
      manager.register({ id: 'user.demo', version: '1.0.0', manifest: pluginManifest, setup: () => {} });
    }
    const tuiFile = join(configDir, 'plugins', 'tui', 'index.js');
    const desktopFile = join(configDir, 'plugins', 'desktop', 'index.js');
    const brokenFile = join(configDir, 'plugins', 'broken');
    await tui.setupAll({
      ...context(),
      pluginStateSync: {
        host: 'tui',
        loadUserPlugins: async () => ({
          loaded: [{ pluginId: 'user.demo', file: tuiFile, manifest: pluginManifest }],
          failed: [{ file: brokenFile, error: new Error('bad entry') }],
        }),
      },
    });
    await desktop.setupAll({
      ...context(),
      desktop: { host: 'desktop' },
      pluginStateSync: {
        host: 'app-server',
        loadUserPlugins: async () => ({
          loaded: [{ pluginId: 'user.demo', file: desktopFile, manifest: pluginManifest }],
          failed: [],
        }),
      },
    });
    expect(JSON.parse(readFileSync(join(configDir, 'plugin-status.json'), 'utf8')).host).toBe('app-server');
    const snapshot = tuiStatus();
    expect(snapshot.host).toBe('tui');
    expect(snapshot.plugins.find((entry) => entry.id === 'user.demo')).toMatchObject({
      status: 'skipped',
      file: tuiFile,
    });
    expect(snapshot.loadFailed).toEqual([{ file: brokenFile, status: 'failed', error: 'bad entry' }]);
    expect(desktopStatus()).toMatchObject({
      host: 'app-server',
      plugins: [
        { id: 'observer', status: 'loaded' },
        { id: 'user.demo', status: 'loaded', file: desktopFile },
      ],
      loadFailed: [],
    });
    snapshot.plugins.length = 0;
    snapshot.loadFailed[0]!.error = 'mutated';
    writeFileSync(join(configDir, 'plugin-status.json'), 'invalid shared snapshot');
    expect(tuiStatus().plugins).toHaveLength(2);
    expect(tuiStatus().loadFailed[0]!.error).toBe('bad entry');
    expect(desktopStatus().plugins).toHaveLength(2);
  });

  it('refreshes snapshots after enable, disable and retry without mixing managers', async () => {
    const manager = createManager();
    const other = createManager();
    const status = observeStatus(manager);
    const otherStatus = observeStatus(other);
    const path = join(configDir, 'plugins-state.json');
    writePluginState({ disabled: ['demo'] }, { path });
    let attempts = 0;
    manager.register({
      id: 'demo',
      setup: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('first setup failed');
      },
    });
    const host = { ...context(), pluginStateSync: { host: 'tui' as const } };
    await manager.setupAll(host);
    await other.setupAll({ ...context(), pluginStateSync: { host: 'app-server' } });
    const initial = status();
    expect(initial.plugins).toEqual([{ id: 'observer', status: 'loaded' }]);

    writePluginState({ disabled: [] }, { path });
    await manager.syncPluginState();
    expect(status().plugins).toContainEqual({ id: 'demo', status: 'failed', error: 'first setup failed' });
    writePluginState({ disabled: ['demo'] }, { path });
    await manager.syncPluginState();
    expect(status().plugins).toEqual(initial.plugins);
    writePluginState({ disabled: [] }, { path });
    await manager.syncPluginState();
    expect(status().plugins).toContainEqual({ id: 'demo', status: 'loaded' });
    writePluginState({ disabled: ['demo'] }, { path });
    await manager.syncPluginState();
    expect(status().plugins).toEqual(initial.plugins);
    expect(initial.plugins).toEqual([{ id: 'observer', status: 'loaded' }]);
    expect(otherStatus().plugins).toEqual(initial.plugins);
  });
});
