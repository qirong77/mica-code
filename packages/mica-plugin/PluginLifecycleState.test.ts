import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookRegistry } from './HookRegistry.js';
import { PluginManager } from './PluginManager.js';
import { writePluginState } from './PluginState.js';
import type { PluginStatusFile } from './PluginStatus.js';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { ServiceContainer } from './ServiceContainer.js';
import type { MicaPlugin } from './Plugin.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'mica-plugin-state-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function plugin(id: string, setup: MicaPlugin['setup']): MicaPlugin {
  return { id, name: id, setup };
}

function stateContext(hooks = new HookRegistry()) {
  return {
    paths: { home: configDir, config: configDir, plugins: configDir },
    hooks,
    commands: new micaCommands.CommandRegistry(),
    services: new ServiceContainer(),
    events: new micaRuntime.RuntimeEventBus(),
    pluginStateSync: { host: 'tui' as const },
  };
}

/** 一个只记录「装了几次 / 卸了几次」的插件。 */
function countingPlugin(id: string, log: string[], fail = false): MicaPlugin {
  return plugin(id, (ctx) => {
    if (fail) throw new Error(`${id} setup failed`);
    log.push(`setup:${id}`);
    ctx.onDispose(() => {
      log.push(`dispose:${id}`);
    });
  });
}

function readStatus(): PluginStatusFile {
  return JSON.parse(readFileSync(join(configDir, 'plugin-status.json'), 'utf8')) as PluginStatusFile;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error('condition not met in time');
}

describe('plugin enable/disable lifecycle', () => {
  it('does not set up a plugin listed as disabled, and sets it up once enabled', async () => {
    writePluginState({ disabled: ['beta'] }, { path: join(configDir, 'plugins-state.json') });
    const log: string[] = [];
    const manager = new PluginManager();
    manager.register(countingPlugin('alpha', log));
    manager.register(countingPlugin('beta', log));

    const report = await manager.setupAll(stateContext());
    expect(report.loaded).toEqual(['alpha']);
    expect(log).toEqual(['setup:alpha']);
    // 停用的插件不该出现在状态文件里冒充「已加载」
    expect(readStatus().plugins.map((entry) => entry.id)).toEqual(['alpha']);

    await manager.applyPluginState(stateContext(), []);
    expect(log).toEqual(['setup:alpha', 'setup:beta']);
    expect(
      readStatus()
        .plugins.map((entry) => entry.id)
        .sort(),
    ).toEqual(['alpha', 'beta']);
  });

  it('unloads only the plugin that was disabled', async () => {
    const log: string[] = [];
    const manager = new PluginManager();
    manager.register(countingPlugin('alpha', log));
    manager.register(countingPlugin('beta', log));
    await manager.setupAll(stateContext());

    const change = await manager.applyPluginState(stateContext(), ['beta']);
    expect(change.disabled).toEqual(['beta']);
    expect(change.enabled).toEqual([]);
    // 只释放被停用的那一个
    expect(log).toEqual(['setup:alpha', 'setup:beta', 'dispose:beta']);
    expect(readStatus().plugins.map((entry) => entry.id)).toEqual(['alpha']);
  });

  it('drops the published role / skill index of a plugin it disables', async () => {
    const rolesDir = join(configDir, 'plugin-roles');
    const skillsDir = join(configDir, 'plugin-skills');
    mkdirSync(rolesDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(rolesDir, 'alpha.json'), '{}');
    writeFileSync(join(skillsDir, 'alpha.json'), '{}');

    const manager = new PluginManager();
    manager.register(countingPlugin('alpha', []));
    await manager.setupAll(stateContext());

    await manager.applyPluginState(stateContext(), ['alpha']);
    // 不 setup 插件的宿主（输入框的角色箭头、桌面 `/` 补全）只读这两份索引
    expect(existsSync(join(rolesDir, 'alpha.json'))).toBe(false);
    expect(existsSync(join(skillsDir, 'alpha.json'))).toBe(false);
  });

  it('applies the next plugins-state.json change at the start of a turn', async () => {
    const log: string[] = [];
    const hooks = new HookRegistry();
    const context = stateContext(hooks);
    const manager = new PluginManager();
    manager.register(countingPlugin('alpha', log));
    manager.register(countingPlugin('beta', log));
    await manager.setupAll(context);

    // 名单没变：一轮过去什么也不做
    await hooks.emit('turn:before', {});
    expect(log).toEqual(['setup:alpha', 'setup:beta']);

    writePluginState({ disabled: ['alpha'] }, { path: join(configDir, 'plugins-state.json') });
    await hooks.emit('turn:before', {});
    expect(log).toEqual(['setup:alpha', 'setup:beta', 'dispose:alpha']);

    // 同一份名单不再重复卸载
    await hooks.emit('turn:before', {});
    expect(log).toEqual(['setup:alpha', 'setup:beta', 'dispose:alpha']);

    writePluginState({ disabled: [] }, { path: join(configDir, 'plugins-state.json') });
    await hooks.emit('turn:before', {});
    expect(log).toEqual(['setup:alpha', 'setup:beta', 'dispose:alpha', 'setup:alpha']);
  });

  it('applies a state-file change immediately, without waiting for a turn', async () => {
    const log: string[] = [];
    const manager = new PluginManager();
    manager.register(countingPlugin('alpha', log));
    await manager.setupAll(stateContext());
    expect(log).toEqual(['setup:alpha']);

    writePluginState({ disabled: ['alpha'] }, { path: join(configDir, 'plugins-state.json') });
    // watchFile 是 400ms 的 stat 轮询 + 120ms 去抖：不必等下一轮对话。
    await waitFor(() => log.includes('dispose:alpha'), 8000);
    expect(log).toEqual(['setup:alpha', 'dispose:alpha']);
    await manager.disposeAll();
  });

  it('defers an unload until the running turn ends', async () => {
    let busy = true;
    const log: string[] = [];
    const hooks = new HookRegistry();
    const context = {
      ...stateContext(hooks),
      pluginStateSync: { host: 'tui' as const, canSyncNow: () => !busy },
    };
    const manager = new PluginManager();
    manager.register(countingPlugin('alpha', log));
    await manager.setupAll(context);

    writePluginState({ disabled: ['alpha'] }, { path: join(configDir, 'plugins-state.json') });
    await sleep(1500);
    // 一轮正在跑：工具与钩子不能从脚底抽走
    expect(log).toEqual(['setup:alpha']);

    busy = false;
    await hooks.emit('turn:after', {});
    await waitFor(() => log.includes('dispose:alpha'), 8000);
    expect(log).toEqual(['setup:alpha', 'dispose:alpha']);
    await manager.disposeAll();
  });

  it('runs newly enabled turn hooks immediately and excludes disabled hooks', async () => {
    const path = join(configDir, 'plugins-state.json');
    writePluginState({ disabled: ['beta'] }, { path });
    const seen: string[] = [];
    const hooks = new HookRegistry();
    const manager = new PluginManager();
    for (const id of ['alpha', 'beta', 'gamma']) {
      manager.register(plugin(id, (ctx) => {
        const hook = ctx.hooks.on('turn:before', () => { seen.push(id); });
        ctx.onDispose(() => hook.dispose());
      }));
    }
    await manager.setupAll(stateContext(hooks));
    writePluginState({ disabled: ['alpha'] }, { path });
    await hooks.emit('turn:before', {});
    expect(seen).toEqual(['gamma', 'beta']);
    await manager.disposeAll();
    seen.length = 0;
    writePluginState({ disabled: [] }, { path });
    await hooks.emit('turn:before', {});
    expect(seen).toEqual([]);
  });

  it('does not retry a plugin that failed setup when the list changes elsewhere', async () => {
    const log: string[] = [];
    let attempts = 0;
    const manager = new PluginManager();
    manager.register(
      plugin('boom', () => {
        attempts += 1;
        throw new Error('boom');
      }),
    );
    manager.register(countingPlugin('alpha', log));
    await manager.setupAll(stateContext());
    expect(attempts).toBe(1);

    await manager.applyPluginState(stateContext(), ['alpha']);
    expect(attempts).toBe(1);
    expect(readStatus().plugins.find((entry) => entry.id === 'boom')?.status).toBe('failed');
  });

  it('retries a plugin the user disabled and enabled again', async () => {
    let attempts = 0;
    const manager = new PluginManager();
    manager.register(
      plugin('flaky', () => {
        attempts += 1;
        if (attempts === 1) throw new Error('first attempt fails');
      }),
    );
    await manager.setupAll(stateContext());
    expect(attempts).toBe(1);

    await manager.applyPluginState(stateContext(), ['flaky']);
    await manager.applyPluginState(stateContext(), []);
    expect(attempts).toBe(2);
    expect(readStatus().plugins).toEqual([{ id: 'flaky', status: 'loaded' }]);
  });

  it('rescans user plugins on every change, with the disabled list it is applying', async () => {
    const calls: string[][] = [];
    const log: string[] = [];
    const manager = new PluginManager();
    manager.register(countingPlugin('alpha', log));
    const context = {
      ...stateContext(),
      pluginStateSync: {
        host: 'app-server' as const,
        loadUserPlugins: async ({ disabled }: { disabled: string[] }) => {
          calls.push(disabled);
          return { loaded: [], failed: [] };
        },
      },
    };
    await manager.setupAll(context);
    expect(calls).toEqual([[]]);

    await manager.applyPluginState(context, ['user.impl']);
    expect(calls).toEqual([[], ['user.impl']]);
  });

  it('skips the whole lifecycle when the host does not sync state', async () => {
    const log: string[] = [];
    const hooks = new HookRegistry();
    const manager = new PluginManager();
    manager.register(countingPlugin('alpha', log));
    await manager.setupAll({
      paths: { home: configDir, config: configDir, plugins: configDir },
      hooks,
      commands: new micaCommands.CommandRegistry(),
      services: new ServiceContainer(),
      events: new micaRuntime.RuntimeEventBus(),
    });

    writePluginState({ disabled: ['alpha'] }, { path: join(configDir, 'plugins-state.json') });
    await hooks.emit('turn:before', {});
    // 一次性宿主：名单只在装配时读一次
    expect(log).toEqual(['setup:alpha']);
    expect(await manager.syncPluginState()).toBeNull();
  });
});
