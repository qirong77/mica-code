import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FilePluginLoadResult } from './FilePluginLoader.js';
import type { PluginSetupReport } from './PluginManager.js';

/**
 * `plugin-status.json`：上一次装配的结论，配置页据此显示「装没装上、为什么没生效」。
 *
 * 两点决定了这份文件的形状：
 *
 * - **记全部插件**，官方与用户一视同仁。只记用户插件时页面没有官方插件的装配记录，
 *   只能靠「官方都随包分发所以都装上了」猜一个 `已加载`——真实情况可能是被跳过了。
 * - **记下是哪个宿主写的**。装配结果只对那个宿主成立：TUI 里没有 `desktop` 这一面，
 *   依赖它的插件会被跳过，这不是插件坏了，桌面宿主里可能一切正常。页面必须把宿主
 *   一起说出来，否则读者会把「某个宿主跳过了它」当成「它坏了」。
 */
export type PluginHostKind = 'tui' | 'app-server';

export type PluginStatusEntry = {
  id: string;
  /** 用户插件的入口文件。官方插件随产品分发，没有磁盘路径可指。 */
  file?: string;
  status: 'failed' | 'loaded' | 'skipped';
  /** `failed` 的异常信息，或 `skipped` 缺少的能力清单。 */
  error?: string;
};

export type PluginStatusFile = {
  /** 写下这份文件的宿主：装配结论只对它成立。 */
  host: PluginHostKind;
  /** 用户插件根目录。官方插件不在它下面。 */
  root: string;
  updatedAt: string;
  plugins: PluginStatusEntry[];
  /** 连清单/入口都没读进来的用户插件：没有可用 id，页面按目录对上。 */
  loadFailed: { file: string; status: 'failed'; error: string }[];
};

/**
 * 写 `plugin-status.json`。
 *
 * 结论来自 `setupReport`（官方 + 用户插件都已装配过）与 `filePlugins`（用户插件的磁盘
 * 加载结果，补上入口路径与那些连清单都没读出来的失败）。
 */
export function writePluginStatus(options: {
  pluginsDir: string;
  configDir: string;
  host: PluginHostKind;
  filePlugins: Pick<FilePluginLoadResult, 'loaded' | 'failed'>;
  setupReport: Pick<PluginSetupReport, 'loaded' | 'failed' | 'skipped'>;
}): PluginStatusFile {
  const setupFailed = new Map(options.setupReport.failed.map((item) => [item.pluginId, formatError(item.error)]));
  const skipped = new Map(
    options.setupReport.skipped.map((item) => [item.pluginId, `缺少宿主能力：${item.missing.join(' / ')}`]),
  );
  const loaded = new Set(options.setupReport.loaded);
  const files = new Map(options.filePlugins.loaded.map((plugin) => [plugin.pluginId, plugin.file]));

  // 装配过的插件全在 report 里，官方插件同样如此——页面因此不需要为「没记录」编一个默认值。
  const ids = [...new Set([...loaded, ...setupFailed.keys(), ...skipped.keys()])].sort();
  const plugins: PluginStatusEntry[] = ids.map((id) => {
    const entry: PluginStatusEntry = {
      id,
      status: setupFailed.has(id) ? 'failed' : skipped.has(id) ? 'skipped' : 'loaded',
    };
    const file = files.get(id);
    if (file) entry.file = file;
    const error = setupFailed.get(id) ?? skipped.get(id);
    if (error) entry.error = error;
    return entry;
  });

  const status: PluginStatusFile = {
    host: options.host,
    root: options.pluginsDir,
    updatedAt: new Date().toISOString(),
    plugins,
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
