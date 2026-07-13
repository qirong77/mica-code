import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads user-owned single-file plugins and registers them with the runtime
 * plugin manager before setupAll() is called.
 */
export default async function setupFilePlugins(ctx) {
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
export function writeFilePluginStatus(ctx, filePlugins, setupReport) {
  const pluginsRoot = requirePluginPath(ctx);
  const configRoot = ctx?.paths?.config;
  if (!isNonEmptyString(configRoot)) {
    throw new Error('file-plugins requires ctx.paths.config');
  }

  const setupFailed = new Map(setupReport.failed.map((item) => [item.pluginId, formatError(item.error)]));
  const loadedIds = new Set(setupReport.loaded);
  const status = {
    root: pluginsRoot,
    updatedAt: new Date().toISOString(),
    plugins: filePlugins.loaded.map((plugin) => ({
      id: plugin.pluginId,
      file: plugin.file,
      status: setupFailed.has(plugin.pluginId) ? 'failed' : loadedIds.has(plugin.pluginId) ? 'loaded' : 'registered',
      error: setupFailed.get(plugin.pluginId),
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

function requirePluginPath(ctx) {
  const pluginsDir = ctx?.paths?.plugins;
  if (!isNonEmptyString(pluginsDir)) {
    throw new Error('file-plugins requires ctx.paths.plugins');
  }
  return pluginsDir;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
