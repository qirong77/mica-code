import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDisabledPluginIds } from '@packages/mica-plugin/index.js';
import type { FilePluginLoaderOptions, FilePluginLoadResult, PluginSetupReport } from '@packages/mica-plugin/index.js';

type FilePluginsContext = {
  paths?: { config?: string; plugins?: string };
  plugins?: { has(id: string): boolean; register(plugin: unknown): void };
  loadFilePlugins?: (options?: FilePluginLoaderOptions) => Promise<FilePluginLoadResult>;
  logger?: FilePluginLoaderOptions['logger'];
};

type FilePluginStatusResult = {
  root: string;
  updatedAt: string;
  plugins: {
    id: string;
    file: string;
    status: 'failed' | 'loaded' | 'registered' | 'skipped';
    error?: string;
  }[];
  loadFailed: { file: string; status: 'failed'; error: string }[];
};

/**
 * Loads user-owned plugin packages ($MICA_HOME/plugins/<id>/plugin.json) and
 * registers them with the runtime plugin manager before setupAll() is called.
 */
export default async function setupFilePlugins(ctx: FilePluginsContext): Promise<FilePluginLoadResult> {
  const pluginsDir = requirePluginPath(ctx);
  const plugins = ctx?.plugins;
  const loadFilePlugins = ctx?.loadFilePlugins;

  if (!plugins || typeof plugins.has !== 'function' || typeof plugins.register !== 'function') {
    throw new Error('file-plugins requires ctx.plugins');
  }
  if (typeof loadFilePlugins !== 'function') {
    throw new Error('file-plugins requires ctx.loadFilePlugins');
  }

  const loaded = await loadFilePlugins({
    pluginsDir,
    // 停用发生在加载之前：连插件的 import 都不做，避免它在 setup 之外产生副作用。
    disabled: readDisabledPluginIds(),
    logger: ctx.logger,
  });

  for (const plugin of loaded.plugins) {
    if (plugins.has(plugin.id)) continue;
    plugins.register(plugin);
  }

  return loaded;
}

/**
 * Persists file-plugin import/setup results for the Config Web diagnostics UI.
 * This is intentionally called after PluginManager.setupAll().
 */
export function writeFilePluginStatus(
  ctx: FilePluginsContext,
  filePlugins: Pick<FilePluginLoadResult, 'loaded' | 'failed'>,
  setupReport: PluginSetupReport,
): FilePluginStatusResult {
  const pluginsRoot = requirePluginPath(ctx);
  const configRoot = ctx?.paths?.config;
  if (!isNonEmptyString(configRoot)) {
    throw new Error('file-plugins requires ctx.paths.config');
  }

  const setupFailed = new Map(setupReport.failed.map((item) => [item.pluginId, formatError(item.error)]));
  // 缺少宿主能力时插件被整块跳过：这既不是「加载成功」也不是「它自己坏了」，
  // 但用户必须知道它为什么没生效，所以单独记一档并带上缺了哪些能力。
  const skipped = new Map(
    setupReport.skipped.map((item) => [item.pluginId, `缺少宿主能力：${item.missing.join(' / ')}`]),
  );
  const loadedIds = new Set(setupReport.loaded);
  const status: FilePluginStatusResult = {
    root: pluginsRoot,
    updatedAt: new Date().toISOString(),
    plugins: filePlugins.loaded.map((plugin) => ({
      id: plugin.pluginId,
      file: plugin.file,
      status: setupFailed.has(plugin.pluginId)
        ? 'failed'
        : skipped.has(plugin.pluginId)
          ? 'skipped'
          : loadedIds.has(plugin.pluginId)
            ? 'loaded'
            : 'registered',
      error: setupFailed.get(plugin.pluginId) ?? skipped.get(plugin.pluginId),
    })),
    loadFailed: filePlugins.failed.map((item) => ({
      file: item.file,
      status: 'failed',
      error: formatError(item.error),
    })),
  };

  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, 'plugin-status.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf-8');
  return status;
}

function requirePluginPath(ctx: FilePluginsContext): string {
  const pluginsDir = ctx?.paths?.plugins;
  if (!isNonEmptyString(pluginsDir)) {
    throw new Error('file-plugins requires ctx.paths.plugins');
  }
  return pluginsDir;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
