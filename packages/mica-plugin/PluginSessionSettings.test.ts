import { describe, expect, it } from 'vitest';
import {
  mergeSessionSettingOverrides,
  normalizePluginSessionSettingsRecord,
  resolveEffectiveSettingValues,
  sessionScopedSettingFields,
  validateSessionSettingValues,
  createPluginSessionSettingsApi,
  type PluginSettingField,
} from './index.js';

const FIELDS: PluginSettingField[] = [
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

describe('sessionScopedSettingFields', () => {
  it('只取声明了 perSession 的字段', () => {
    expect(sessionScopedSettingFields(FIELDS).map((field) => field.key)).toEqual(['enabled', 'threshold']);
  });

  it('没声明过就是空：界面据此不显示这一节', () => {
    expect(sessionScopedSettingFields(FIELDS.filter((field) => !field.perSession))).toEqual([]);
  });
});

describe('resolveEffectiveSettingValues', () => {
  it('未覆盖的键跟随全局设置', () => {
    const values = resolveEffectiveSettingValues(FIELDS, { enabled: 'true', threshold: '300' }, {});
    expect(values).toEqual({ enabled: 'true', threshold: '300' });
  });

  it('本会话覆盖优先于全局设置', () => {
    const values = resolveEffectiveSettingValues(FIELDS, { enabled: 'true', threshold: '300' }, { threshold: '500' });
    expect(values.threshold).toBe('500');
    expect(values.enabled).toBe('true');
  });

  it('没标 perSession 的键即使残留覆盖也不生效', () => {
    const values = resolveEffectiveSettingValues(FIELDS, { apiKey: 'global-key' }, { apiKey: 'stale' });
    expect(values.apiKey).toBe('global-key');
  });

  it('之后调默认值，没被覆盖的会话跟着变', () => {
    const overrides = { threshold: '500' };
    const before = resolveEffectiveSettingValues(FIELDS, { enabled: 'true', threshold: '300' }, overrides);
    const after = resolveEffectiveSettingValues(FIELDS, { enabled: 'false', threshold: '300' }, overrides);
    expect(before.enabled).toBe('true');
    expect(after.enabled).toBe('false');
    expect(after.threshold).toBe('500');
  });
});

describe('mergeSessionSettingOverrides', () => {
  it('null 删除覆盖，空串是显式改成空值', () => {
    const next = mergeSessionSettingOverrides(
      FIELDS,
      { threshold: '500', enabled: 'false' },
      {
        enabled: null,
        threshold: '',
      },
    );
    expect(next).toEqual({ threshold: '' });
  });

  it('忽略没有声明 perSession 的键', () => {
    expect(mergeSessionSettingOverrides(FIELDS, {}, { apiKey: 'leak' })).toEqual({});
  });
});

describe('validateSessionSettingValues', () => {
  it('按清单约束校验范围', () => {
    const issues = validateSessionSettingValues(FIELDS, { threshold: '120' });
    expect(issues.map((issue) => issue.key)).toEqual(['threshold']);
  });

  it('switch 只接受 true / false', () => {
    expect(validateSessionSettingValues(FIELDS, { enabled: 'yes' }).length).toBe(1);
    expect(validateSessionSettingValues(FIELDS, { enabled: 'false' })).toEqual([]);
  });

  it('不校验全局专属字段', () => {
    expect(validateSessionSettingValues(FIELDS, { apiKey: '' })).toEqual([]);
  });
});

describe('normalizePluginSessionSettingsRecord', () => {
  it('丢弃非字符串值与非对象条目', () => {
    expect(
      normalizePluginSessionSettingsRecord({
        'auto-compact': { enabled: 'false', threshold: 300 as unknown as string },
        broken: [],
        '': { enabled: 'true' },
      }),
    ).toEqual({ 'auto-compact': { enabled: 'false' } });
  });

  it('坏输入整体当空，不让插件拿到半份配置', () => {
    expect(normalizePluginSessionSettingsRecord(null)).toEqual({});
    expect(normalizePluginSessionSettingsRecord('x')).toEqual({});
  });

  it('超配额的条目丢弃', () => {
    const huge = { threshold: '9'.repeat(9000) };
    expect(normalizePluginSessionSettingsRecord({ 'auto-compact': huge })).toEqual({});
  });
});

describe('createPluginSessionSettingsApi', () => {
  function harness(overrides: Record<string, string> = {}) {
    let current: Record<string, string> | undefined = { ...overrides };
    const api = createPluginSessionSettingsApi({
      fields: FIELDS,
      readGlobal: () => ({ enabled: 'true', threshold: '300', apiKey: 'key' }),
      readOverrides: () => current,
      writeOverrides: (value) => {
        current = value;
      },
    });
    return { api, overrides: () => current };
  }

  it('get 返回会话生效值，overrides 只给改过的键', () => {
    const { api } = harness({ threshold: '500' });
    expect(api.get()).toMatchObject({ threshold: '500', enabled: 'true' });
    expect(api.overrides()).toEqual({ threshold: '500' });
  });

  it('set 传 null 退回跟随默认值', () => {
    const { api, overrides } = harness({ threshold: '500' });
    api.set({ threshold: null });
    expect(overrides()).toBeUndefined();
    expect(api.get().threshold).toBe('300');
  });

  it('校验不过时一个键都不写', () => {
    const { api, overrides } = harness();
    expect(() => api.set({ threshold: '10' })).toThrow(/阈值/);
    expect(overrides()).toEqual({});
  });

  it('clear 清空覆盖', () => {
    const { api, overrides } = harness({ enabled: 'false' });
    api.clear();
    expect(overrides()).toBeUndefined();
    expect(api.get().enabled).toBe('true');
  });
});
