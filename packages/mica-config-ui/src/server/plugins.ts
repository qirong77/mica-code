import { existsSync, readFileSync } from 'node:fs';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import type { PluginSettingField } from '@packages/mica-plugin/index.js';
import { DESKTOP_CHECKS } from '@packages/mica-plugin/index.js';
import { OFFICIAL_PLUGINS_DIR, officialPluginManifests } from '@packages/mica-official-plugins/manifests.js';
import { getConfigRootPath, getPluginsRootPath, getPluginStatePath, getPluginStatusPath } from './paths.js';
import type {
  ConfigWebPlugin,
  ConfigWebPluginCheck,
  ConfigWebPluginSettings,
  ConfigWebPluginsDetails,
} from '../shared/types.js';

/**
 * 配置页的插件数据层：两个宿主（config-web 的 HTTP 服务、desktop 的 IPC）共用这一份实现。
 *
 * 列表有两段来源，含义不同，页面上也是分开的：
 * - 官方插件：随产品分发，清单在仓库 `plugins/<id>/plugin.json`，编译进单二进制，所以永远「已安装」，
 *   只能启用 / 停用；
 * - 用户插件：`$MICA_HOME/plugins` 下的插件目录，装没装、能不能加载都由磁盘决定。
 *
 * 这里只做静态扫描（读清单、列文件、读设置），不导入插件代码：加载失败、清单写错的插件
 * 同样要能列出来，否则用户没法在页面上看到哪里错了。
 */
export function getPluginsDetails(): ConfigWebPluginsDetails {
  const root = getPluginsRootPath();
  const configRoot = getConfigRootPath();
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
        icon: manifest.icon,
        author: manifest.author,
        source: 'official',
        location: `${OFFICIAL_PLUGINS_DIR}/${manifest.id}`,
        entryFile: manifest.main,
        manifestFile: `${OFFICIAL_PLUGINS_DIR}/${manifest.id}/${micaPlugin.PLUGIN_MANIFEST_FILE}`,
        // 官方插件的文件已经编译进产物，磁盘上不一定读得到，只列清单声明的部分。
        files: [micaPlugin.PLUGIN_MANIFEST_FILE, manifest.main, ...manifest.assets].map((name) => ({ name })),
        settings: readSettings(manifest.id, manifest.settings, configRoot),
        desktopChecks: resolveDesktopChecks(manifest.desktopChecks),
        health: micaPlugin.readPluginHealth(manifest.id, { configDir: configRoot }),
        logFile: micaPlugin.pluginLogPath(manifest.id),
        loadStatus: status?.status,
        error: status?.error,
      },
      disabled,
    );
  });

  const user: ConfigWebPlugin[] = inspection.plugins.map((plugin) => {
    const status = statuses.get(plugin.id) ?? statuses.get(plugin.root);
    return withState(
      {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version ?? '0.0.0',
        description: plugin.description,
        // 图标暂由界面兜底：插件检查结果里的 icon 字段还没进这个提交。
        icon: '',
        source: 'user',
        location: plugin.root,
        entryFile: plugin.entryFile || undefined,
        manifestFile: plugin.manifestFile,
        files: plugin.files,
        settings: readSettings(plugin.id, plugin.settings, configRoot),
        desktopChecks: resolveDesktopChecks(plugin.desktopChecks),
        health: micaPlugin.readPluginHealth(plugin.id, { configDir: configRoot }),
        logFile: micaPlugin.pluginLogPath(plugin.id),
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
 * 保存插件设置。
 *
 * 与启停不同，设置是运行期生效的：插件读的时候按文件 mtime 判断，不需要重开会话。
 * 未声明的键在这里就被丢掉，插件永远读不到清单之外的东西。
 */
export function setPluginSettings(id: string, values: Record<string, unknown>): ConfigWebPluginsDetails {
  const fields = findSettingFields(id);
  if (!fields) throw new Error(`插件没有声明设置项：${id}`);
  // 校验失败时会抛 PluginSettingsValidationError，带着逐字段的原因；传输层把它转给页面，
  // 页面据此在对应输入框下面提示，而不是「显示已保存」却存进一组用不了的值。
  micaPlugin.writePluginSettings(id, values, fields, { configDir: getConfigRootPath() });
  return getPluginsDetails();
}

function findSettingFields(id: string): PluginSettingField[] | null {
  const official = officialPluginManifests.find((manifest) => manifest.id === id);
  if (official) return official.settings;
  const inspected = micaPlugin.inspectPlugins({ pluginsDir: getPluginsRootPath() }).plugins.find((p) => p.id === id);
  return inspected ? inspected.settings : null;
}

function readSettings(id: string, fields: PluginSettingField[], configRoot: string): ConfigWebPluginSettings {
  const values = micaPlugin.readPluginSettings(id, fields, { configDir: configRoot });
  // 磁盘上可能是旧版本写下的、或手改过的值：页面要能把它们标出来，而不是照样显示「已保存」。
  return { fields, values, issues: micaPlugin.validatePluginSettingValues(fields, values) };
}

/**
 * 清单只声明检查项 id，文案与系统设置入口都来自宿主的检查目录（`DESKTOP_CHECKS`）。
 *
 * 页面因此不需要认识任何检查项，也不需要把插件包导进浏览器：它能显示的每一样东西
 * 都由这份数据决定。
 */
function resolveDesktopChecks(ids: readonly string[]): ConfigWebPluginCheck[] {
  return ids.flatMap((id) => {
    const definition = DESKTOP_CHECKS.find((check) => check.id === id);
    if (!definition) return [];
    return [
      {
        id: definition.id,
        label: definition.label,
        description: definition.description,
        pane: definition.pane,
      },
    ];
  });
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

type PluginStatusEntry = {
  status: 'loaded' | 'registered' | 'failed' | 'skipped' | 'unknown';
  error?: string;
};

/**
 * 读 `plugin-status.json`：加载成功的按 id 建索引，加载失败的按插件目录建索引。
 *
 * 清单坏掉、入口导入失败的插件没有可用的 id，只能靠目录路径对上；页面按 id → 目录的顺序查。
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
