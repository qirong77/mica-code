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
    desktopPage: null,
    status: [],
    actions: [],
    desktopPanel: null,
    desktopSessionMenu: [],
    skills: [],
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
    // 跳过只进报告与日志，不进插件健康状态：缺哪一面取决于当前宿主（TUI / exec 没有
    // desktop），写进所有宿主共享的 plugin-health 会让别的宿主看到一条过时的「待配置」。
    expect(readPluginHealth('needs-prompt', { configDir })).toBeNull();
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

  it('registers the skills declared in the manifest without the plugin calling ctx.skills', async () => {
    const root = join(configDir, 'plugins', 'demo');
    const skillDir = join(root, 'skills', 'rules');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo-rules\ndescription: 规则\n---\n\n正文\n', 'utf-8');

    const manager = new PluginManager();
    const setup = vi.fn();
    manager.register({
      id: 'demo-manifest',
      name: 'demo-manifest',
      // 插件目录是清单相对声明的根：插件在哪，它带的 skill 就在哪
      root,
      manifest: { ...manifest(['skills']), skills: ['skills'] },
      setup,
    });

    try {
      const report = await manager.setupAll(baseContext(configDir));
      expect(report.loaded).toEqual(['demo-manifest']);
      expect(setup).toHaveBeenCalled();
      // 生效的两处都要有：进程级注册表（模型能调用）与磁盘索引（不 setup 插件的宿主能列出）
      expect(readPublishedPluginSkills({ configDir })).toEqual([
        expect.objectContaining({ pluginId: 'demo-manifest', name: 'demo-rules', path: join(skillDir, 'SKILL.md') }),
      ]);
    } finally {
      await manager.disposeAll();
    }
  });

  it('reports a declared skill directory it cannot read instead of failing the plugin', async () => {
    const manager = new PluginManager();
    manager.register({
      id: 'demo-missing',
      name: 'demo-missing',
      root: join(configDir, 'plugins', 'demo-missing'),
      manifest: { ...manifest(['skills']), skills: ['skills'] },
      setup: () => {},
    });

    try {
      const report = await manager.setupAll(baseContext(configDir));
      // 目录写错不该让整个插件起不来：插件其余能力照常可用，问题显示在配置页
      expect(report.loaded).toEqual(['demo-missing']);
      expect(readPluginHealth('demo-missing', { configDir })?.message).toContain('skill 目录');
    } finally {
      await manager.disposeAll();
    }
  });
});
