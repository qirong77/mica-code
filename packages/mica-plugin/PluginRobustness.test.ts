import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPluginHealth, createPluginHealthStore, readPluginHealth, writePluginHealth } from './PluginHealth.js';
import { readPublishedPluginSkills } from './PluginSkills.js';
import { HookRegistry } from './HookRegistry.js';
import { PluginManager } from './PluginManager.js';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { ServiceContainer } from './ServiceContainer.js';
import type { MicaPlugin } from './Plugin.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'mica-plugin-health-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('plugin health', () => {
  it('round-trips the last report', () => {
    writePluginHealth('demo', { level: 'warn', message: '缺少接口地址' }, { configDir });
    const report = readPluginHealth('demo', { configDir });
    expect(report).toMatchObject({ level: 'warn', message: '缺少接口地址' });
    expect(report?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('collapses whitespace so a stack-trace-ish message stays one line', () => {
    writePluginHealth('demo', { level: 'error', message: '第一行\n  第二行' }, { configDir });
    expect(readPluginHealth('demo', { configDir })?.message).toBe('第一行 第二行');
  });

  it('treats a corrupt file as "never reported" instead of failing', () => {
    writePluginHealth('demo', { level: 'ok', message: '正常' }, { configDir });
    const store = createPluginHealthStore('demo', { configDir });
    clearPluginHealth('demo', { configDir });
    expect(store.read()).toBeNull();
    expect(readPluginHealth('demo', { configDir })).toBeNull();
  });

  it('does nothing (rather than throwing) without a config dir', () => {
    expect(() => writePluginHealth('demo', { level: 'ok', message: 'x' })).not.toThrow();
    expect(readPluginHealth('demo')).toBeNull();
  });
});

function plugin(id: string, setup: MicaPlugin['setup'], requires?: MicaPlugin['manifest']): MicaPlugin {
  return {
    id,
    name: id,
    setup,
    manifest: requires,
  };
}

function manifest(requires: string[]) {
  return {
    id: 'x',
    name: 'x',
    version: '1.0.0',
    description: '',
    icon: '',
    main: 'index.js',
    assets: [],
    dependencies: [],
    required: false,
    priority: 0,
    apiVersion: 1,
    llm: null,
    settings: [],
    requires: requires as never,
    desktopChecks: [],
    desktopEntry: null,
    status: [],
    desktopPanel: null,
  };
}

/** 最小可用宿主：这些用例只关心 manager 的健壮性分支，不依赖真实服务。 */
function baseContext(configDir: string, hooks = new HookRegistry()) {
  return {
    paths: { home: configDir, config: configDir, plugins: configDir },
    hooks,
    commands: new micaCommands.CommandRegistry(),
    services: new ServiceContainer(),
    events: new micaRuntime.RuntimeEventBus(),
  };
}

describe('PluginManager robustness', () => {
  it('skips a plugin whose declared requirement the host cannot provide instead of crashing', async () => {
    const manager = new PluginManager();
    const setup = vi.fn();
    manager.register(plugin('needs-prompt', setup, manifest(['prompt'])));

    const report = await manager.setupAll(baseContext(configDir));

    expect(setup).not.toHaveBeenCalled();
    expect(report.skipped).toEqual([{ pluginId: 'needs-prompt', missing: ['prompt'] }]);
    expect(report.failed).toEqual([]);
    // 跳过必须留痕，否则页面上只能看到一个「已启用」却什么都不做的插件。
    expect(readPluginHealth('needs-prompt', { configDir })?.message).toContain('prompt');
  });

  it('records invalid settings as a health warning without blocking startup', async () => {
    const manager = new PluginManager();
    manager.register({
      id: 'needs-config',
      name: 'needs-config',
      manifest: { ...manifest([]), settings: [{ key: 'model', label: 'model', type: 'text', required: true }] },
      setup: () => {},
    });

    const report = await manager.setupAll(baseContext(configDir));

    expect(report.loaded).toEqual(['needs-config']);
    expect(readPluginHealth('needs-config', { configDir })?.level).toBe('warn');
  });

  it('leaves plugin health untouched when the host asked for quiet skips', async () => {
    const manager = new PluginManager();
    const setup = vi.fn();
    manager.register(plugin('needs-prompt', setup, manifest(['prompt'])));

    const report = await manager.setupAll(baseContext(configDir), { quietSkips: true });

    expect(setup).not.toHaveBeenCalled();
    expect(report.skipped).toEqual([{ pluginId: 'needs-prompt', missing: ['prompt'] }]);
    // 一次性命令宿主只提供命令相关的几面能力：跳过是设计如此，不能写进用户的插件健康状态。
    expect(readPluginHealth('needs-prompt', { configDir })).toBeNull();
  });

  it('surfaces hook handler errors through the plugin health channel', async () => {
    const hooks = new HookRegistry();
    const manager = new PluginManager();
    manager.register({
      id: 'boom',
      name: 'boom',
      setup: (ctx) => {
        ctx.hooks.on(
          'turn:after',
          () => {
            throw new Error('hook exploded');
          },
          { pluginId: ctx.pluginId },
        );
      },
    });

    await manager.setupAll(baseContext(configDir, hooks));
    await hooks.emit('turn:after', {});

    const report = readPluginHealth('boom', { configDir });
    expect(report?.level).toBe('error');
    expect(report?.message).toContain('hook exploded');
  });

  it('publishes the skills that actually took effect so other hosts can scan them', async () => {
    const skillDir = join(configDir, 'builtin', 'demo-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo-skill\n---\n', 'utf-8');
    const register = (ctx: Parameters<MicaPlugin['setup']>[0], description: string) => {
      ctx.skills.register({
        name: 'demo-skill',
        description,
        content: 'body',
        baseDir: skillDir,
      });
    };

    const manager = new PluginManager();
    manager.register({
      id: 'demo-builtin',
      name: 'demo-builtin',
      manifest: manifest(['skills']),
      setup: (ctx) => register(ctx, '内置能力'),
    });
    manager.register({
      id: 'demo-late',
      name: 'demo-late',
      manifest: manifest(['skills']),
      // 同名第二次注册会被运行期注册表拒绝（磁盘/先注册的那份优先）
      setup: (ctx) => register(ctx, '第二份'),
    });

    try {
      const report = await manager.setupAll(baseContext(configDir));
      expect(report.loaded).toEqual(['demo-builtin', 'demo-late']);
      expect(readPublishedPluginSkills({ configDir }).map((skill) => [skill.pluginId, skill.name])).toEqual([
        ['demo-builtin', 'demo-skill'],
      ]);
    } finally {
      await manager.disposeAll();
    }
  });
});
