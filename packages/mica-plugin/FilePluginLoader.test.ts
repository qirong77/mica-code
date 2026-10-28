import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { inspectPlugins, loadFilePlugins } from './FilePluginLoader.js';
import { parsePluginManifest } from './PluginManifest.js';

describe('loadFilePlugins', () => {
  it('ignores loose files: a plugin is a package, not a script', async () => {
    const dir = mkTempDir();
    try {
      writeFileSync(join(dir, 'loose.mjs'), 'export default function setup() {}');
      writeFileSync(join(dir, 'loose.js'), 'export default function setup() {}');
      writeFileSync(join(dir, 'notes.txt'), 'nope');

      expect(await loadFilePlugins({ pluginsDir: dir })).toEqual({ plugins: [], loaded: [], failed: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps loading when one plugin package is broken', async () => {
    const dir = mkTempDir();
    const warn = vi.fn();
    try {
      writeDirectoryPlugin(dir, 'bad', KEBAB_MANIFEST, 'export const nope = 1');
      writeDirectoryPlugin(dir, 'todo-lite', KEBAB_MANIFEST, 'export default function setup() {}');

      const result = await loadFilePlugins({ pluginsDir: dir, logger: { warn } });

      expect(result.plugins.map((plugin) => plugin.id)).toEqual(['user.todo-lite']);
      expect(result.failed).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith('file-plugin:load-failed', expect.objectContaining({ file: join(dir, 'bad') }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a directory plugin from its manifest and namespaces the id', async () => {
    const dir = mkTempDir();
    try {
      writeDirectoryPlugin(dir, 'todo-lite', KEBAB_MANIFEST, 'export default function setup() {}');

      const result = await loadFilePlugins({ pluginsDir: dir });

      expect(result.failed).toEqual([]);
      expect(result.plugins.map((plugin) => plugin.id)).toEqual(['user.todo-lite']);
      expect(result.plugins[0]?.name).toBe('Todo Lite');
      expect(result.plugins[0]?.manifest?.main).toBe('index.mjs');
      expect(result.loaded[0]).toMatchObject({ pluginId: 'user.todo-lite' });
      expect(result.loaded[0]?.file).toBe(join(dir, 'todo-lite', 'index.mjs'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a broken manifest and keeps loading the rest', async () => {
    const dir = mkTempDir();
    try {
      writeDirectoryPlugin(dir, 'broken', '{"id":"Broken","name":"x","version":"1.0.0"}');
      writeDirectoryPlugin(dir, 'fine', KEBAB_MANIFEST, 'export default function setup() {}');

      const result = await loadFilePlugins({ pluginsDir: dir });

      expect(result.plugins.map((plugin) => plugin.id)).toEqual(['user.todo-lite']);
      expect(result.failed).toHaveLength(1);
      expect(String(result.failed[0]?.error)).toContain('id 只能由小写字母');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips folders that are not plugin packages', async () => {
    const dir = mkTempDir();
    try {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'assets', 'logo.txt'), 'x');

      expect(await loadFilePlugins({ pluginsDir: dir })).toEqual({ plugins: [], loaded: [], failed: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never imports a disabled plugin', async () => {
    const dir = mkTempDir();
    try {
      writeDirectoryPlugin(
        dir,
        'todo-lite',
        KEBAB_MANIFEST,
        'throw new Error("disabled plugins must not be imported")',
      );

      const result = await loadFilePlugins({ pluginsDir: dir, disabled: new Set(['user.todo-lite']) });

      expect(result).toEqual({ plugins: [], loaded: [], failed: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('inspectPlugins', () => {
  it('describes plugin packages without executing them', () => {
    const dir = mkTempDir();
    try {
      writeDirectoryPlugin(dir, 'todo-lite', KEBAB_MANIFEST, 'throw new Error("should not run")');
      writeFileSync(join(dir, 'loose.mjs'), 'export default function setup() {}');

      const result = inspectPlugins({ pluginsDir: dir });

      expect(result.root).toBe(dir);
      expect(result.plugins.map((plugin) => plugin.id)).toEqual(['user.todo-lite']);
      const directory = result.plugins[0];
      expect(directory).toMatchObject({
        name: 'Todo Lite',
        version: '1.0.0',
        declaredId: 'todo-lite',
        error: undefined,
      });
      expect(directory?.files.map((file) => file.name)).toEqual(['index.mjs', 'plugin.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces manifest errors and a missing entry instead of hiding the plugin', () => {
    const dir = mkTempDir();
    try {
      writeDirectoryPlugin(dir, 'no-entry', KEBAB_MANIFEST);
      writeDirectoryPlugin(dir, 'bad-manifest', '{"id":"x"}');

      const result = inspectPlugins({ pluginsDir: dir });

      expect(result.plugins).toHaveLength(2);
      // 目录项按名字排序：bad-manifest 在 no-entry 之前。
      expect(result.plugins[0]?.error).toContain('缺少 name');
      expect(result.plugins[1]?.error).toContain('入口文件不存在');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty list for a missing directory', () => {
    const result = inspectPlugins({ pluginsDir: join(tmpdir(), `mica-missing-${Date.now()}`) });
    expect(result.plugins).toEqual([]);
  });
});

describe('parsePluginManifest', () => {
  it('fills defaults for the optional fields', () => {
    const result = parsePluginManifest({ id: 'demo', name: 'Demo', version: '0.1.0' });

    expect(result).toEqual({
      ok: true,
      manifest: {
        id: 'demo',
        name: 'Demo',
        version: '0.1.0',
        description: '',
        icon: '',
        author: undefined,
        main: 'index.js',
        assets: [],
        dependencies: [],
        required: false,
        priority: 0,
        apiVersion: 1,
        settings: [],
        requires: [],
        desktopChecks: [],
      },
    });
  });

  it('rejects paths that escape the plugin directory', () => {
    const escape = parsePluginManifest({ id: 'demo', name: 'Demo', version: '1.0.0', main: '../escape.js' });
    const absoluteAsset = parsePluginManifest({
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      assets: ['/etc/passwd'],
    });

    expect(escape).toEqual({ ok: false, error: 'main 必须是插件目录内的相对路径：../escape.js' });
    expect(absoluteAsset).toEqual({ ok: false, error: 'assets 只能是插件目录内的相对路径：/etc/passwd' });
  });

  it('rejects unsupported api versions', () => {
    expect(parsePluginManifest({ id: 'demo', name: 'Demo', version: '1.0.0', mica: { apiVersion: 2 } })).toEqual({
      ok: false,
      error: '不支持的插件能力版本：2（当前为 1）',
    });
  });
});

const KEBAB_MANIFEST = JSON.stringify({
  id: 'todo-lite',
  name: 'Todo Lite',
  version: '1.0.0',
  description: 'A smaller todo list',
  main: 'index.mjs',
  assets: ['README.md'],
});

function writeDirectoryPlugin(dir: string, name: string, manifest: string, entry?: string): void {
  const pluginDir = join(dir, name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), manifest);
  if (entry) writeFileSync(join(pluginDir, 'index.mjs'), entry);
}

function mkTempDir(): string {
  const dir = join(tmpdir(), `mica-file-plugin-loader-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
