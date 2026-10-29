import { readdir, readFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_DIR_NAME } from '@packages/mica-config/brand.js';
import {
  parsePluginManifest,
  PLUGIN_MANIFEST_FILE,
  type PluginManifest,
  type PluginStatusField,
} from './PluginManifest.js';
import type { DesktopCheckId } from './PluginDesktop.js';
import type { PluginSettingField } from './PluginSettings.js';
import type { PluginLlmSpec } from './PluginLlm.js';
import type { MicaPlugin } from './Plugin.js';

export type FilePluginLoaderOptions = {
  homeDir?: string;
  pluginsDir?: string;
  /** 已停用的插件 id：不导入、不加载（停用意味着连插件的副作用都不该发生）。 */
  disabled?: Iterable<string>;
  logger?: {
    warn(event: string, data?: unknown): void;
  };
};

export type LoadedFilePlugin = {
  pluginId: string;
  /** 清单 `main` 指向的入口文件。 */
  file: string;
  manifest: PluginManifest;
};

export type FilePluginLoadResult = {
  plugins: MicaPlugin[];
  loaded: LoadedFilePlugin[];
  failed: { file: string; error: unknown }[];
};

/** 配置页展示用的插件描述：只读文件、不导入代码，坏插件也能列出来。 */
export type PluginInspection = {
  /** 运行时使用的插件 id（用户插件带 `user.` 前缀，避免与内置插件撞名）。 */
  id: string;
  /** 清单里声明的 id；清单坏掉时退回目录名。 */
  declaredId: string;
  name: string;
  version?: string;
  description: string;
  /** 清单声明的图标名；清单坏掉或没声明时为空字符串，界面用默认图标兜底。 */
  icon: string;
  /** 插件目录的绝对路径。 */
  root: string;
  entryFile: string;
  manifestFile: string;
  /** 清单声明的前缀设置项；清单坏掉时为空（页面仍然列得出来，只是没有表单）。 */
  settings: PluginSettingField[];
  /** 清单里的 `llm` 声明；没声明（或清单坏掉）时为 null。 */
  llm: PluginLlmSpec | null;
  /** 清单声明的桌面端运行条件；清单坏掉时为空。 */
  desktopChecks: DesktopCheckId[];
  /** 清单声明要在页面展示的运行状态行；清单坏掉时为空。 */
  status: PluginStatusField[];
  /** 清单解析 / 入口缺失等静态问题；加载期错误由 plugin-status.json 提供。 */
  error?: string;
};

export type PluginInspectionResult = {
  root: string;
  plugins: PluginInspection[];
};

/**
 * 加载 `$MICA_HOME/plugins` 下的用户插件。
 *
 * 插件只有一种形态：`<dir>/plugin.json` + 清单声明的入口与资源。没有清单的目录、散落的
 * `.js` / `.mjs` 文件都不是插件，加载器不猜。
 *
 * 任何一个插件失败都不影响其它插件：失败进 `failed`，由调用方写进 plugin-status.json
 * 供配置页展示，而不是让整个启动流程抛错。
 */
export async function loadFilePlugins(options: FilePluginLoaderOptions = {}): Promise<FilePluginLoadResult> {
  const pluginsDir = resolvePluginsDir(options);
  const disabled = new Set(options.disabled ?? []);
  const result: FilePluginLoadResult = { plugins: [], loaded: [], failed: [] };
  let entries: string[];

  try {
    entries = (await readdir(pluginsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissingDirectory(error)) return result;
    throw error;
  }

  for (const entryName of entries) {
    const target = join(pluginsDir, entryName);
    if (!existsSync(join(target, PLUGIN_MANIFEST_FILE))) continue;
    try {
      const loaded = await loadPluginEntry(target, disabled);
      if (!loaded) continue;
      result.plugins.push(loaded.plugin);
      result.loaded.push(loaded.record);
    } catch (error) {
      result.failed.push({ file: target, error });
      options.logger?.warn('file-plugin:load-failed', { file: target, error: formatError(error) });
    }
  }

  return result;
}

/**
 * 扫描插件目录，产出配置页要的描述。
 *
 * 与 `loadFilePlugins` 共用同一套 id / 清单规则，但不执行插件的代码，所以加载失败、清单写错
 * 的插件照样能出现在列表里，用户在页面上能看到到底哪里错了。
 */
export function inspectPlugins(options: FilePluginLoaderOptions = {}): PluginInspectionResult {
  const root = resolvePluginsDir(options);
  if (!existsSync(root)) return { root, plugins: [] };

  const plugins: PluginInspection[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const manifestFile = join(dir, PLUGIN_MANIFEST_FILE);
    if (!existsSync(manifestFile)) continue;
    plugins.push(inspectPlugin(dir, manifestFile, entry.name));
  }
  return { root, plugins };
}

async function loadPluginEntry(
  dir: string,
  disabled: ReadonlySet<string>,
): Promise<{ plugin: MicaPlugin; record: LoadedFilePlugin } | null> {
  const manifest = await readManifest(join(dir, PLUGIN_MANIFEST_FILE));
  const pluginId = userPluginId(manifest);
  if (disabled.has(pluginId)) return null;
  const entryFile = join(dir, manifest.main);
  if (!existsSync(entryFile)) {
    throw new Error(`入口文件不存在：${manifest.main}`);
  }
  const setup = await importSetup(entryFile);
  const plugin = createFilePlugin(manifest, setup, pluginId);
  return { plugin, record: { pluginId: plugin.id, file: entryFile, manifest } };
}

async function readManifest(manifestFile: string): Promise<PluginManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestFile, 'utf-8'));
  } catch (error) {
    throw new Error(`plugin.json 无法解析：${formatError(error)}`);
  }
  const result = parsePluginManifest(parsed);
  if (!result.ok) throw new Error(result.error);
  return result.manifest;
}

function createFilePlugin(manifest: PluginManifest, setup: MicaPlugin['setup'], pluginId: string): MicaPlugin {
  return {
    id: pluginId,
    name: manifest.name,
    version: manifest.version,
    priority: manifest.priority,
    dependencies: manifest.dependencies.length > 0 ? manifest.dependencies : undefined,
    required: manifest.required,
    manifest,
    setup,
  };
}

/**
 * 用户插件的运行期 id 一律加前缀。
 *
 * 插件的 id 由插件的作者决定，不加前缀就存在「用户插件叫 mcp、和内名插件撞名后启动即抛
 * Plugin already registered」的风险；前缀把命名空间分开，停用名单也因此不会歧义。
 */
function userPluginId(manifest: PluginManifest): string {
  return `user.${manifest.id}`;
}

async function importSetup(entryFile: string): Promise<MicaPlugin['setup']> {
  const mod: unknown = await import(pathToFileURL(entryFile).href);
  return resolvePluginFactory(mod);
}

function resolvePluginFactory(mod: unknown): MicaPlugin['setup'] {
  if (typeof mod === 'object' && mod !== null && 'default' in mod && typeof mod.default === 'function') {
    return mod.default as MicaPlugin['setup'];
  }
  throw new Error('插件入口必须 default 导出 setup 函数');
}

function inspectPlugin(dir: string, manifestFile: string, dirName: string): PluginInspection {
  const base = {
    id: `user.${dirName}`,
    declaredId: dirName,
    name: dirName,
    description: '',
    icon: '',
    root: dir,
    entryFile: '',
    manifestFile,
    settings: [],
    llm: null,
    desktopChecks: [],
    status: [],
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestFile, 'utf-8'));
  } catch (error) {
    return { ...base, error: `plugin.json 无法解析：${formatError(error)}` };
  }

  const result = parsePluginManifest(parsed);
  if (!result.ok) return { ...base, error: result.error };

  const manifest = result.manifest;
  const entryFile = join(dir, manifest.main);
  return {
    ...base,
    id: `user.${manifest.id}`,
    declaredId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    icon: manifest.icon,
    entryFile,
    settings: manifest.settings,
    llm: manifest.llm,
    desktopChecks: manifest.desktopChecks,
    status: manifest.status,
    error: existsSync(entryFile) ? undefined : `入口文件不存在：${manifest.main}`,
  };
}

function resolvePluginsDir(options: FilePluginLoaderOptions): string {
  return options.pluginsDir ?? join(options.homeDir ?? homedir(), CONFIG_DIR_NAME, 'plugins');
}

function isMissingDirectory(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
