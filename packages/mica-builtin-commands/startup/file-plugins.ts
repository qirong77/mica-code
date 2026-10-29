import { readDisabledPluginIds } from '@packages/mica-plugin/index.js';
import type { FilePluginLoaderOptions, FilePluginLoadResult } from '@packages/mica-plugin/index.js';

type FilePluginsContext = {
  paths?: { plugins?: string };
  plugins?: { has(id: string): boolean; register(plugin: unknown): void };
  loadFilePlugins?: (options?: FilePluginLoaderOptions) => Promise<FilePluginLoadResult>;
  logger?: FilePluginLoaderOptions['logger'];
};

/**
 * Loads user-owned plugin packages ($MICA_HOME/plugins/<id>/plugin.json) and
 * registers them with the runtime plugin manager before setupAll() is called.
 *
 * 装配结论不在这里写盘：`mica-plugin` 的 `writePluginStatus()` 负责
 * `plugin-status.json`（含官方插件与「哪个宿主装配的」），宿主自己调它。
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

function requirePluginPath(ctx: FilePluginsContext): string {
  const pluginsDir = ctx?.paths?.plugins;
  if (!isNonEmptyString(pluginsDir)) {
    throw new Error('file-plugins requires ctx.paths.plugins');
  }
  return pluginsDir;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
