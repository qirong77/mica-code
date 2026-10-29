import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginSettingField } from '@packages/mica-plugin/index.js';
import { applyPluginSessionSettings, listPluginSessionSettings } from './pluginSessionSettings.js';

const AUTO_COMPACT_FIELDS: PluginSettingField[] = [
  { key: 'enabled', label: '启用', type: 'switch', default: 'true', perSession: true },
  {
    key: 'threshold',
    label: '阈值',
    type: 'number',
    default: '300',
    min: 150,
    max: 1000,
    perSession: true,
  },
  { key: 'apiKey', label: 'Key', type: 'password', default: '' },
];

const WEB_SEARCH_FIELDS: PluginSettingField[] = [{ key: 'url', label: '地址', type: 'text', default: '' }];

let configDir = '';

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'mica-plugin-session-settings-'));
  mkdirSync(join(configDir, 'plugin-settings'), { recursive: true });
  // 全局设置文件：会话面板必须显示这份值，而不是字段默认值。
  writeFileSync(join(configDir, 'plugin-settings', 'auto-compact.json'), JSON.stringify({ threshold: '400' }), 'utf-8');
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

type StubPlugin = {
  id: string;
  name: string;
  manifest: { settings?: PluginSettingField[]; desktopPanel?: { label: string; roles: string[] } | null };
};

const basePlugins: StubPlugin[] = [
  { id: 'auto-compact', name: 'Auto Compact', manifest: { settings: AUTO_COMPACT_FIELDS } },
  { id: 'web-search', name: 'Web Search', manifest: { settings: WEB_SEARCH_FIELDS } },
];

function createHost(
  initial: Record<string, Record<string, string>> = {},
  options: { role?: string; plugins?: StubPlugin[]; panelIds?: string[] } = {}
) {
  const store: Record<string, Record<string, string>> = { ...initial };
  const plugins = options.plugins ?? basePlugins;
  const panelIds = new Set(options.panelIds ?? []);
  return {
    store,
    configDir,
    plugins: { list: () => plugins },
    panels: { get: (pluginId: string) => (panelIds.has(pluginId) ? {} : null) },
    agent: {
      role: options.role ?? 'default',
      getPluginSessionSettings: (pluginId: string) => store[pluginId],
      setPluginSessionSettings: (pluginId: string, value: Record<string, string> | undefined) => {
        if (value) store[pluginId] = value;
        else delete store[pluginId];
      },
    },
  } as never as Parameters<typeof listPluginSessionSettings>[0] & {
    store: Record<string, Record<string, string>>;
  };
}

describe('listPluginSessionSettings', () => {
  it('只列出声明了 perSession 的插件，并且带上全局设置的值', () => {
    const list = listPluginSessionSettings(createHost());
    expect(list.map((entry) => entry.id)).toEqual(['auto-compact']);
    expect(list[0].fields.map((field) => field.key)).toEqual(['enabled', 'threshold']);
    // 全局文件里 threshold=400：显示默认值 300 就意味着「读不到用户配的那份」。
    expect(list[0].values.threshold).toBe('400');
    expect(list[0].values.enabled).toBe('true');
  });

  it('会话覆盖压在全局设置之上，并单独暴露改过的键', () => {
    const list = listPluginSessionSettings(createHost({ 'auto-compact': { threshold: '900' } }));
    expect(list[0].values.threshold).toBe('900');
    expect(list[0].overrides).toEqual({ threshold: '900' });
  });

  it('插件表缺失时返回空列表，不抛错', () => {
    expect(listPluginSessionSettings({ agent: {} as never })).toEqual([]);
  });

  it('没有会话字段但有面板的插件也会出现，带上开关面板的文案', () => {
    const list = listPluginSessionSettings(
      createHost(
        {},
        {
          plugins: [
            ...basePlugins,
            { id: 'mobile-relay', name: 'Mobile Relay', manifest: { desktopPanel: { label: '手机访问', roles: [] } } },
          ],
          panelIds: ['mobile-relay'],
        }
      )
    );
    expect(list.map((entry) => entry.id)).toEqual(['auto-compact', 'mobile-relay']);
    expect(list[1].fields).toEqual([]);
    expect(list[1].panel).toEqual({ label: '手机访问' });
    // 没有会话字段就没有覆盖，界面不该显示「仅本会话」
    expect(list[1].overrides).toEqual({});
  });

  it('清单声明了面板但插件没注册处理器时不出现：那个按钮点不开', () => {
    const list = listPluginSessionSettings(
      createHost(
        {},
        {
          plugins: [{ id: 'mobile-relay', name: 'Mobile Relay', manifest: { desktopPanel: { label: '手机访问', roles: [] } } }],
          panelIds: [],
        }
      )
    );
    expect(list).toEqual([]);
  });

  it('面板的角色门槛按当前会话角色判定', () => {
    const plugins = [
      { id: 'ops', name: 'Ops', manifest: { desktopPanel: { label: '运维', roles: ['需求开发'] } } },
    ];
    expect(listPluginSessionSettings(createHost({}, { plugins, panelIds: ['ops'], role: '需求开发' }))).toHaveLength(1);
    expect(listPluginSessionSettings(createHost({}, { plugins, panelIds: ['ops'], role: 'default' }))).toEqual([]);
  });
});

describe('applyPluginSessionSettings', () => {
  it('写入合法值时只存改过的键', () => {
    const host = createHost();
    const result = applyPluginSessionSettings(host, {
      pluginId: 'auto-compact',
      values: { threshold: '800' },
    });
    expect(result).toEqual({ ok: true });
    expect(host.store['auto-compact']).toEqual({ threshold: '800' });
  });

  it('null 表示退回跟随全局设置', () => {
    const host = createHost({ 'auto-compact': { threshold: '800', enabled: 'false' } });
    const result = applyPluginSessionSettings(host, {
      pluginId: 'auto-compact',
      values: { threshold: null },
    });
    expect(result).toEqual({ ok: true });
    expect(host.store['auto-compact']).toEqual({ enabled: 'false' });
  });

  it('全部退回后不留空对象', () => {
    const host = createHost({ 'auto-compact': { enabled: 'false' } });
    applyPluginSessionSettings(host, { pluginId: 'auto-compact', values: { enabled: null } });
    expect(host.store['auto-compact']).toBeUndefined();
  });

  it('越界值整条拒绝，一个键都不写', () => {
    const host = createHost();
    const result = applyPluginSessionSettings(host, {
      pluginId: 'auto-compact',
      values: { threshold: '10' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues?.map((issue) => issue.key)).toEqual(['threshold']);
    expect(host.store['auto-compact']).toBeUndefined();
  });

  it('拒绝未声明的键：否则拼错的键会静默不生效', () => {
    const result = applyPluginSessionSettings(createHost(), {
      pluginId: 'auto-compact',
      values: { thresold: '800' },
    });
    expect(result.ok).toBe(false);
  });

  it('拒绝没有 perSession 字段的插件与未知插件', () => {
    expect(applyPluginSessionSettings(createHost(), { pluginId: 'web-search', values: {} }).ok).toBe(false);
    expect(applyPluginSessionSettings(createHost(), { pluginId: 'nope', values: {} }).ok).toBe(false);
  });

  it('values 不是对象时明确报错', () => {
    expect(applyPluginSessionSettings(createHost(), { pluginId: 'auto-compact', values: [] }).ok).toBe(false);
  });
});
