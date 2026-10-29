/**
 * 按插件声明读写「本会话」的设置覆盖。
 *
 * 这里是协议与插件声明之间的唯一转换：清单里标了 `perSession` 的字段才会出现在
 * 会话设置里，值是本会话对全局插件设置的覆盖（只存改过的键，其余仍跟随全局）。
 * 内核不认识任何具体插件，因此这段逻辑对每个声明了会话字段的插件都一样。
 */
import {
  readPluginSettings,
  resolveEffectiveSettingValues,
  sessionScopedSettingFields,
  validateSessionSettingValues,
  type PluginSettingIssue,
  type PluginSettingField,
  type PluginSettingValues,
  type PluginSessionSettingsView,
} from '@packages/mica-plugin/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { PluginManager, PluginPanelRegistry } from '@packages/mica-plugin/index.js';

type HostLike = {
  agent: AgentRuntime;
  plugins?: PluginManager;
  /** 插件设置的落盘目录（`$MICA_HOME`）。缺了就只能读到字段默认值。 */
  configDir?: string;
  /** 面板处理器。声明了面板的插件要出现在这一节里，用户从那里打开它。 */
  panels?: PluginPanelRegistry;
};

/**
 * 缺 configDir 时插件设置退化成字段默认值——这不是「没配置」，而是根本读不到
 * 用户配的那份。所以调用方必须把 configDir 传进来，这里只在测试里允许省略。
 */
function globalSettings(plugin: { id: string; manifest?: { settings?: PluginSettingField[] } }, configDir?: string) {
  return readPluginSettings(plugin.id, plugin.manifest?.settings ?? [], { configDir });
}

/** 当前会话里所有可配置插件，按插件表顺序（官方在前）列出。 */
export function listPluginSessionSettings(host: HostLike): PluginSessionSettingsView[] {
  if (!host.plugins) return [];
  const role = host.agent.role;
  return host.plugins.list().flatMap((plugin) => {
    const fields = sessionScopedSettingFields(plugin.manifest?.settings ?? []);
    const panel = panelEntry(host, plugin, role);
    if (fields.length === 0 && !panel) return [];
    const global = globalSettings(plugin, host.configDir);
    const overrides = host.agent.getPluginSessionSettings(plugin.id) ?? {};
    return [
      {
        id: plugin.id,
        name: plugin.name ?? plugin.id,
        description: plugin.manifest?.description ?? null,
        fields,
        values: resolveEffectiveSettingValues(fields, global, overrides),
        overrides,
        panel,
      },
    ];
  });
}

/**
 * 插件在这一节里的面板入口。三条都是硬条件：真的注册了处理器（声明了清单却没调用
 * `ctx.desktop.panel()` 的插件打不开）、清单写了面板、当前会话角色命中。
 */
function panelEntry(
  host: HostLike,
  plugin: { id: string; name?: string; manifest?: { desktopPanel?: { label: string; roles: string[] } | null } },
  role: string
): { label: string } | null {
  const declared = plugin.manifest?.desktopPanel ?? null;
  if (!declared || !host.panels?.get(plugin.id)) return null;
  if (declared.roles.length > 0 && !declared.roles.includes(role)) return null;
  return { label: declared.label || plugin.name || plugin.id };
}

export type ApplyPluginSessionSettingsResult =
  | { ok: true }
  | { ok: false; error: string; issues?: PluginSettingIssue[] };

/**
 * 改一个键也用整体覆盖语义：传 `null` 表示「跟随全局设置」，省略表示不动。
 */
export function applyPluginSessionSettings(
  host: HostLike,
  params: Record<string, unknown>,
): ApplyPluginSessionSettingsResult {
  const pluginId = typeof params.pluginId === 'string' ? params.pluginId : '';
  const plugin = host.plugins?.list().find((entry) => entry.id === pluginId);
  if (!plugin) return { ok: false, error: `插件未启用：${pluginId || '(未指定)'}` };
  const fields = sessionScopedSettingFields(plugin.manifest?.settings ?? []);
  if (fields.length === 0) return { ok: false, error: `插件 ${pluginId} 没有会话级设置` };

  const patch = params.values;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'values 需要是对象' };
  }
  const declared = new Set(fields.map((field) => field.key));

  const next: PluginSettingValues = { ...(host.agent.getPluginSessionSettings(pluginId) ?? {}) };
  const incoming: PluginSettingValues = {};
  for (const [key, raw] of Object.entries(patch as Record<string, unknown>)) {
    if (!declared.has(key)) return { ok: false, error: `插件 ${pluginId} 没有会话设置 ${key}` };
    if (raw === null) {
      delete next[key];
      continue;
    }
    if (typeof raw !== 'string') return { ok: false, error: `${key} 需要是字符串` };
    next[key] = raw;
    incoming[key] = raw;
  }

  const issues = validateSessionSettingValues(fields, incoming);
  if (issues.length > 0) return { ok: false, error: '设置有误', issues };

  host.agent.setPluginSessionSettings(pluginId, Object.keys(next).length > 0 ? next : undefined);
  return { ok: true };
}
