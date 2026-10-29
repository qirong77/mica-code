import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFilePlugins, type FilePluginLoadResult, type FilePluginLoaderOptions } from './FilePluginLoader.js';
import { readDisabledPluginIds } from './PluginState.js';
import type { PluginSetupReport } from './PluginManager.js';
import type { PluginManager } from './PluginManager.js';

/**
 * 把 `$MICA_HOME/plugins` 下的用户插件装进 manager，并把结果写进
 * `plugin-status.json`（配置页读它显示「装没装上、为什么没生效」）。
 *
 * 常驻宿主（TUI、`mica app-server`）都要做同一件事，写盘的形状也必须一致，否则配置页
 * 在两种宿主下会给出不同结论。所以这两步收在这里，宿主只决定「要不要装」。
 */

export type UserPluginStatus = {
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 加载并注册用户插件。
 *
 * 停用发生在 import 之前：停用的插件连代码都不执行，避免它在 setup 之外留下副作用。
 * 同一 id 已经注册过（例如官方插件与用户插件撞名）时保留先注册的那个。
 */
export async function loadUserPlugins(
  manager: PluginManager,
  options: { pluginsDir: string; disabled?: string[] } & FilePluginLoaderOptions,
): Promise<FilePluginLoadResult> {
  const loaded = await loadFilePlugins({
    pluginsDir: options.pluginsDir,
    disabled: options.disabled ?? readDisabledPluginIds(),
    logger: options.logger,
  });
  for (const plugin of loaded.plugins) {
    if (manager.has(plugin.id)) continue;
    manager.register(plugin);
  }
  return loaded;
}

/** 写 `plugin-status.json`：缺宿主能力（skipped）与 setup 抛错（failed）要能分清。 */
export function writeUserPluginStatus(options: {
  pluginsDir: string;
  configDir: string;
  filePlugins: Pick<FilePluginLoadResult, 'loaded' | 'failed'>;
  setupReport: Pick<PluginSetupReport, 'loaded' | 'failed' | 'skipped'>;
}): UserPluginStatus {
  const setupFailed = new Map(options.setupReport.failed.map((item) => [item.pluginId, formatError(item.error)]));
  const skipped = new Map(
    options.setupReport.skipped.map((item) => [item.pluginId, `缺少宿主能力：${item.missing.join(' / ')}`]),
  );
  const loadedIds = new Set(options.setupReport.loaded);
  const status: UserPluginStatus = {
    root: options.pluginsDir,
    updatedAt: new Date().toISOString(),
    plugins: options.filePlugins.loaded.map((plugin) => ({
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
    loadFailed: options.filePlugins.failed.map((item) => ({
      file: item.file,
      status: 'failed',
      error: formatError(item.error),
    })),
  };
  mkdirSync(options.configDir, { recursive: true });
  writeFileSync(join(options.configDir, 'plugin-status.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf-8');
  return status;
}
