import { existsSync, readFileSync } from 'node:fs';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import { OFFICIAL_PLUGINS_DIR, officialPluginManifests } from '@packages/mica-official-plugins/manifests.js';
import { getPluginsRootPath, getPluginStatePath, getPluginStatusPath } from './paths.js';
import type { ConfigWebPlugin, ConfigWebPluginsDetails } from '../shared/types.js';

/**
 * 配置页的插件数据层：两个宿主（config-web 的 HTTP 服务、desktop 的 IPC）共用这一份实现。
 *
 * 列表有两段来源，含义不同，页面上也是分开的：
 * - 官方插件：随产品分发，清单在仓库 `plugins/<id>/plugin.json`，编译进单二进制，所以永远「已安装」，
 *   只能启用 / 停用；
 * - 用户插件：`$MICA_HOME/plugins` 下的目录或单文件，装没装、能不能加载都由磁盘决定。
 *
 * 这里只做静态扫描（读清单、列文件），不导入插件代码：加载失败、清单写错的插件同样要能列出来，
 * 否则用户没法在页面上看到哪里错了。
 */
export function getPluginsDetails(): ConfigWebPluginsDetails {
  const root = getPluginsRootPath();
  const disabled = micaPlugin.readDisabledPluginIds();
  const statuses = readPluginStatuses();
  const inspection = micaPlugin.inspectPlugins({ pluginsDir: root });

  const official: ConfigWebPlugin[] = officialPluginManifests.map((manifest) => {
    const status = statuses.get(manifest.id);
    return withState(
      {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        source: 'official',
        format: 'directory',
        location: `${OFFICIAL_PLUGINS_DIR}/${manifest.id}`,
        entryFile: manifest.main,
        manifestFile: `${OFFICIAL_PLUGINS_DIR}/${manifest.id}/${micaPlugin.PLUGIN_MANIFEST_FILE}`,
        // 官方插件的文件已经编译进产物，磁盘上不一定读得到，只列清单声明的部分。
        files: [micaPlugin.PLUGIN_MANIFEST_FILE, manifest.main, ...manifest.assets].map((name) => ({ name })),
        loadStatus: status?.status,
        error: status?.error,
      },
      disabled,
    );
  });

  const user: ConfigWebPlugin[] = inspection.plugins.map((plugin) => {
    const status = statuses.get(plugin.id) ?? statuses.get(plugin.entryFile);
    return withState(
      {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version ?? '0.0.0',
        description: plugin.description,
        source: 'user',
        format: plugin.format,
        location: plugin.root,
        entryFile: plugin.entryFile || undefined,
        manifestFile: plugin.manifestFile,
        files: plugin.files,
        loadStatus: status?.status,
        error: plugin.error ?? status?.error,
      },
      disabled,
    );
  });

  return {
    root,
    statePath: getPluginStatePath(),
    officialDir: OFFICIAL_PLUGINS_DIR,
    plugins: [...official, ...user],
  };
}

/**
 * 启用 / 停用插件。
 *
 * 只写状态文件，不动插件代码：插件在启动阶段才注册，因此已运行的会话不受影响，
 * 改动在下一次启动（新会话）生效——页面会提示这一点。
 */
export function setPluginEnabled(id: string, enabled: boolean): ConfigWebPluginsDetails {
  micaPlugin.setPluginDisabled(id, !enabled);
  return getPluginsDetails();
}

/**
 * 停用优先于加载结果：一个停用的插件根本不会被执行，它的「上次加载失败」已经过时了。
 */
function withState(plugin: Omit<ConfigWebPlugin, 'state'>, disabled: Set<string>): ConfigWebPlugin {
  const state = disabled.has(plugin.id)
    ? 'disabled'
    : plugin.error || plugin.loadStatus === 'failed'
      ? 'failed'
      : 'enabled';
  return { ...plugin, state };
}

type PluginStatusEntry = { status: 'loaded' | 'registered' | 'failed' | 'unknown'; error?: string };

/**
 * 读 `plugin-status.json`，同时按 id 与入口文件建索引。
 *
 * 清单解析失败的插件没有 id，只能靠文件路径对上；两套键并存时页面不用关心是哪一种。
 */
function readPluginStatuses(): Map<string, PluginStatusEntry> {
  const path = getPluginStatusPath();
  if (!existsSync(path)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      plugins?: Array<{ id?: string; file?: string; status?: string; error?: string }>;
      loadFailed?: Array<{ id?: string; file?: string; status?: string; error?: string }>;
    };
    const statuses = new Map<string, PluginStatusEntry>();
    for (const entry of [...(parsed.plugins ?? []), ...(parsed.loadFailed ?? [])]) {
      const value: PluginStatusEntry = { status: normalizeStatus(entry.status), error: entry.error };
      if (typeof entry.id === 'string' && entry.id) statuses.set(entry.id, value);
      if (typeof entry.file === 'string' && entry.file) statuses.set(entry.file, value);
    }
    return statuses;
  } catch {
    return new Map();
  }
}

function normalizeStatus(value: string | undefined): PluginStatusEntry['status'] {
  return value === 'loaded' || value === 'registered' || value === 'failed' ? value : 'unknown';
}
