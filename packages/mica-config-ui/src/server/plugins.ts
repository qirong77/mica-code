import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { micaConfig } from '@packages/mica-config/index.js';
import { probeModelConnection } from '@packages/mica-agent/index.js';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import type {
  PluginLlmMainInfo,
  PluginLlmSpec,
  PluginModelRequest,
  PluginSettingField,
  PluginStatusField,
} from '@packages/mica-plugin/index.js';
import { DESKTOP_CHECKS } from '@packages/mica-plugin/index.js';
import { OFFICIAL_PLUGINS_DIR, officialPluginManifests } from '@packages/mica-official-plugins/manifests.js';
import { getConfigRootPath, getPluginsRootPath, getPluginStatePath, getPluginStatusPath } from './paths.js';
import type {
  ConfigWebPlugin,
  ConfigWebPluginCheck,
  ConfigWebPluginLlm,
  ConfigWebPluginLlmTest,
  ConfigWebPluginSettings,
  ConfigWebPluginStatusField,
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
  const lastRun = readPluginStatusFile();
  const statuses = lastRun.entries;
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
        settings: readSettings(manifest.id, manifest.settings, configRoot),
        llm: readLlm(manifest.id, manifest.llm, manifest.settings, configRoot),
        desktopChecks: resolveDesktopChecks(manifest.desktopChecks),
        desktopEntry: manifest.desktopEntry,
        desktopPage: manifest.desktopPage,
        status: readStatus(manifest.id, manifest.status, configRoot),
        actions: manifest.actions,
        desktopPanel: manifest.desktopPanel,
        desktopSessionMenu: manifest.desktopSessionMenu,
        health: micaPlugin.readPluginHealth(manifest.id, { configDir: configRoot }),
        logFile: micaPlugin.pluginLogPath(manifest.id),
        loadStatus: status?.status,
        loadHost: status ? lastRun.host : undefined,
        // 跳过的说明是「这个宿主没有这一面」，不是「插件坏了」：它只进 skipReason，
        // 不能变成红色错误，否则 TUI 里跑一次就足以让桌面端把整个插件报成失败。
        error: status?.status === 'failed' ? status.error : undefined,
        skipReason: status?.status === 'skipped' ? status.error : undefined,
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
        icon: plugin.icon,
        source: 'user',
        location: plugin.root,
        entryFile: plugin.entryFile || undefined,
        manifestFile: plugin.manifestFile,
        settings: readSettings(plugin.id, plugin.settings, configRoot),
        llm: readLlm(plugin.id, plugin.llm, plugin.settings, configRoot),
        desktopChecks: resolveDesktopChecks(plugin.desktopChecks),
        // 用户插件没有打包进页面的前端模块，声明了 `desktop.entry` 也渲染不出入口。
        desktopEntry: null,
        desktopPage: null,
        status: readStatus(plugin.id, plugin.status ?? [], configRoot),
        actions: plugin.actions ?? [],
        // 面板反过来是数据驱动的，所以用户插件声明了就有。
        desktopPanel: plugin.desktopPanel,
        desktopSessionMenu: plugin.desktopSessionMenu ?? [],
        health: micaPlugin.readPluginHealth(plugin.id, { configDir: configRoot }),
        logFile: micaPlugin.pluginLogPath(plugin.id),
        loadStatus: status?.status,
        loadHost: status ? lastRun.host : undefined,
        error: plugin.error ?? (status?.status === 'failed' ? status.error : undefined),
        skipReason: status?.status === 'skipped' ? status.error : undefined,
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

function findManifest(id: string): { llm: PluginLlmSpec | null; settings: PluginSettingField[] } | null {
  const official = officialPluginManifests.find((manifest) => manifest.id === id);
  if (official) return { llm: official.llm, settings: official.settings };
  const inspected = micaPlugin.inspectPlugins({ pluginsDir: getPluginsRootPath() }).plugins.find((p) => p.id === id);
  return inspected ? { llm: inspected.llm, settings: inspected.settings } : null;
}

/**
 * 「测试连接」。
 *
 * 用的是插件真正会走的那一次请求（`probeModelConnection` → `runModelTextRequest`，
 * 与 `ctx.llm.request` 同一条实现），所以测通了就代表插件能工作，不会出现「测试用一条
 * 路、实际用另一条路」。测试本身不记账：它不属于任何会话。
 *
 * `values` 可选：页面在用户改完还没落盘时也能先测一次。不传就读磁盘上的生效值。
 */
export async function testPluginLlm(id: string, values?: Record<string, unknown>): Promise<ConfigWebPluginLlmTest> {
  const manifest = findManifest(id);
  if (!manifest?.llm) throw new Error(`插件没有声明模型接口：${id}`);
  // 与保存走同一套校验：非法值先在这里拦下，不必发一次注定失败的请求。
  const merged =
    values === undefined
      ? micaPlugin.readPluginSettings(id, manifest.settings, { configDir: getConfigRootPath() })
      : micaPlugin.normalizePluginSettingValues(manifest.settings, values);
  const issues = micaPlugin.validatePluginSettingValues(manifest.settings, merged);
  if (issues.length > 0) {
    return {
      ok: false,
      message: issues.map((issue) => `${issue.label} ${issue.message}`).join('；'),
      latencyMs: 0,
      model: '',
    };
  }

  const config = micaPlugin.resolvePluginLlmConfig(merged);
  let target: { baseUrl: string; apiKey: string; protocol: PluginModelRequest['protocol']; model: string };
  if (config.useMainProvider) {
    const main = micaConfig.readActiveProviderConfig();
    target = {
      baseUrl: main.baseUrl,
      apiKey: main.apiKey,
      protocol: main.protocol,
      model: main.model,
    };
  } else {
    target = { baseUrl: config.baseUrl, apiKey: config.apiKey, protocol: config.protocol, model: config.model };
  }
  return probeModelConnection(target);
}

function readSettings(id: string, fields: PluginSettingField[], configRoot: string): ConfigWebPluginSettings {
  const values = micaPlugin.readPluginSettings(id, fields, { configDir: configRoot });
  // 磁盘上可能是旧版本写下的、或手改过的值：页面要能把它们标出来，而不是照样显示「已保存」。
  return { fields, values, issues: micaPlugin.validatePluginSettingValues(fields, values) };
}

/**
 * 运行状态：清单只声明「哪几行、叫什么、能不能点」，值由插件写进自己的数据文件。
 *
 * 读不出来（没写过、JSON 坏了）就当作「还没上报」，页面显示占位——配置页不去猜插件的
 * 运行态，也不为了让页面好看而编一个值。
 */
function readStatus(id: string, fields: PluginStatusField[], configRoot: string): ConfigWebPluginStatusField[] {
  if (fields.length === 0) return [];
  let data: Record<string, unknown> = {};
  try {
    const file = join(micaPlugin.pluginDataDir(configRoot, id), 'data.json');
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // 插件正在写文件时可能读到半截，下一次刷新再显示。
  }

  return fields.map((field) => {
    const raw = data[field.key];
    const text = typeof raw === 'string' ? raw : isToneValue(raw) ? raw.text : null;
    const tone = isToneValue(raw) ? (raw.tone ?? null) : null;
    return { key: field.key, label: field.label, type: field.type, value: text || null, tone };
  });
}

/** 插件可以用 `{ text, tone }` 表达「通/不通」，页面只按语气上色。 */
function isToneValue(value: unknown): value is { text: string; tone?: 'ok' | 'warn' | 'error' } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== 'string') return false;
  return record.tone === undefined || record.tone === 'ok' || record.tone === 'warn' || record.tone === 'error';
}

/**
 * 模型接口面板的数据：声明 + 生效值摘要 + 现在能不能用。
 *
 * 「能不能用」对「跟随主配置」还要看主配置里有没有可用 provider——那种情况页面若只
 * 显示「已配置」，用户会在插件静默失败时才回头排查。
 */
function readLlm(
  id: string,
  spec: PluginLlmSpec | null,
  fields: PluginSettingField[],
  configRoot: string,
): ConfigWebPluginLlm | null {
  if (!spec) return null;
  const values = micaPlugin.readPluginSettings(id, fields, { configDir: configRoot });
  const config = micaPlugin.resolvePluginLlmConfig(values);
  // 复用当前会话模型时，「会话」在配置页是全局 provider：没有会话上下文，用它算
  // 摘要与可用性；会话设置那边由 app-server 按当前会话的模型另算一份。
  let main: PluginLlmMainInfo | undefined;
  if (config.useMainProvider) {
    try {
      const active = micaConfig.readActiveProviderConfig();
      const model = active.model;
      const protocol = active.protocol === 'openai_responses' ? 'Responses' : 'Chat Completions';
      main = {
        summary: model ? `复用当前会话 · ${protocol} · ${model}` : '当前会话没有可用的模型',
        available: Boolean(active.baseUrl && model),
      };
    } catch (error) {
      main = { summary: error instanceof Error ? error.message : '当前会话模型不可用', available: false };
    }
  }
  return micaPlugin.describePluginLlmView(spec, values, main);
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
  status: 'loaded' | 'failed' | 'skipped' | 'unknown';
  error?: string;
};

/**
 * 读 `plugin-status.json`：装配过的插件按 id 建索引，加载失败的按插件目录建索引。
 *
 * 清单坏掉、入口导入失败的插件没有可用的 id，只能靠目录路径对上；页面按 id → 目录的顺序查。
 * `host` 跟着记录一起回给页面：装配结论只对写下它的那个宿主成立（TUI 没有 `desktop`，
 * 桌面宿主没有 TUI 的输入框），页面要连宿主一起说，读者才不会把跨宿主的跳过当成故障。
 */
function readPluginStatusFile(): { host?: string; entries: Map<string, PluginStatusEntry> } {
  const path = getPluginStatusPath();
  const entries = new Map<string, PluginStatusEntry>();
  if (!existsSync(path)) return { entries };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      host?: string;
      plugins?: Array<{ id?: string; file?: string; status?: string; error?: string }>;
      loadFailed?: Array<{ id?: string; file?: string; status?: string; error?: string }>;
    };
    for (const entry of [...(parsed.plugins ?? []), ...(parsed.loadFailed ?? [])]) {
      const value: PluginStatusEntry = { status: normalizeStatus(entry.status), error: entry.error };
      if (typeof entry.id === 'string' && entry.id) entries.set(entry.id, value);
      if (typeof entry.file === 'string' && entry.file) entries.set(entry.file, value);
    }
    return { host: typeof parsed.host === 'string' ? parsed.host : undefined, entries };
  } catch {
    return { entries };
  }
}

function normalizeStatus(value: string | undefined): PluginStatusEntry['status'] {
  return value === 'loaded' || value === 'failed' || value === 'skipped' ? value : 'unknown';
}
