import {
  validatePluginSettingValues,
  type PluginSettingField,
  type PluginSettingIssue,
  type PluginSettingValues,
} from './PluginSettings.js';

/**
 * 插件设置的会话级覆盖。
 *
 * 两层语义与能力开关一致：
 *
 * - 默认值只有一份（`$MICA_HOME/plugin-settings/<id>.json`，配置页写）；
 * - 会话覆盖只记用户**显式改过**的键，存在会话快照的 `pluginSessionSettings[pluginId]`
 *   里。
 *
 * 只存改过的键是这套东西成立的前提：整份值一起存会把当时的默认值固化进会话，之后
 * 调默认值对老会话完全无效——用户改了默认值却发现「某些会话不听话」。
 *
 * 只有清单里标了 `perSession` 的字段参与覆盖。没标的字段即使快照里有残留也不会生效，
 * 所以删掉一个字段的 `perSession` 标记不需要迁移任何数据。
 */

/** 每条会话里每个插件的覆盖上限（序列化后字节数）。 */
export const MAX_PLUGIN_SESSION_SETTINGS_BYTES = 8 * 1024;

/** 覆盖映射：插件 id → 该会话里改过的键值。 */
export type PluginSessionSettingsRecord = Record<string, PluginSettingValues>;

/** 宿主提供的原始存取：只做「读/写这份会话的覆盖」，字段语义由内核解释。 */
export type PluginSessionSettingsHostApi = {
  read(): PluginSettingValues | undefined;
  write(value: PluginSettingValues | undefined): void;
};

/** 插件看到的会话设置接口。`pluginId` 在绑定阶段固定，读不到也改不到别人的。 */
export type PluginSessionSettingsApi = {
  /** 本会话生效的值：会话覆盖 > 全局设置 > 字段默认值。 */
  get(): PluginSettingValues;
  /** 只返回本会话真正覆盖过的键（界面用它区分「跟随默认」与「本会话已改」）。 */
  overrides(): PluginSettingValues;
  /**
   * 覆盖若干键。值传 `null` 表示删掉这个覆盖、退回跟随默认。
   *
   * 校验不通过直接抛错并且**一个键都不写**：部分写入会让用户看到「改了一半」的状态。
   */
  set(values: Record<string, string | null>): void;
  /** 清空本会话的全部覆盖。 */
  clear(): void;
};

/** 界面描述一个插件的会话设置：字段 + 生效值 + 本会话改过的键。 */
export type PluginSessionSettingsView = {
  id: string;
  name: string;
  description: string | null;
  /** 只有清单里标了 `perSession` 的字段。 */
  fields: PluginSettingField[];
  /** 本会话生效的值（会话覆盖 > 全局设置 > 默认值）。 */
  values: PluginSettingValues;
  /** 本会话真正覆盖过的键；界面据此提示「跟随全局」还是「仅本会话」。 */
  overrides: PluginSettingValues;
  /**
   * 这个插件在会话里有没有可打开的面板（清单 `desktop.panel` + `ctx.desktop.panel()`）。
   *
   * 面板的入口就在这一节：插件既可以只有面板没有会话设置，也可以两者都有。
   * 没有面板时是 null，界面据此不画「打开面板」。
   */
  panel: { label: string } | null;
};

/** 会话里能覆盖的字段：清单声明了 `perSession` 的那些。 */
export function sessionScopedSettingFields(fields: readonly PluginSettingField[]): PluginSettingField[] {
  return fields.filter((field) => field.perSession === true);
}

/**
 * 清洗从磁盘读回来的覆盖记录。
 *
 * 与插件状态同样的处理：不是普通对象、值不是字符串、超配额，整条丢弃。覆盖记错了
 * 只会让某个会话回到默认值，不会让插件拿到用不了的配置。
 */
export function normalizePluginSessionSettingsRecord(input: unknown): PluginSessionSettingsRecord {
  if (!isPlainRecord(input)) return {};
  const result: PluginSessionSettingsRecord = {};
  for (const [pluginId, value] of Object.entries(input)) {
    if (!pluginId.trim()) continue;
    if (!isPlainRecord(value)) continue;
    const overrides: PluginSettingValues = {};
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw !== 'string') continue;
      overrides[key] = raw;
    }
    if (Object.keys(overrides).length === 0) continue;
    if (byteLength(JSON.stringify(overrides)) > MAX_PLUGIN_SESSION_SETTINGS_BYTES) continue;
    result[pluginId] = overrides;
  }
  return result;
}

/** 校验写入请求：只接受声明过 `perSession` 的键，其余按键忽略。 */
export function validateSessionSettingValues(
  fields: readonly PluginSettingField[],
  values: Record<string, string | null>,
): PluginSettingIssue[] {
  const scoped = sessionScopedSettingFields(fields);
  const allowed = new Set(scoped.map((field) => field.key));
  const candidate: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key)) continue;
    if (value === null) continue;
    candidate[key] = value;
  }
  return validatePluginSettingValues(scoped, candidate);
}

/**
 * 把一次写入合进现有覆盖里。
 *
 * `null` 是删除，`''` 是「显式改成空值」（对可选字段等于用默认行为，与全局设置一致），
 * 两者不能混——否则用户把阈值清空时会被当成「没改过」。
 */
export function mergeSessionSettingOverrides(
  fields: readonly PluginSettingField[],
  current: PluginSettingValues,
  patch: Record<string, string | null>,
): PluginSettingValues {
  const allowed = new Set(sessionScopedSettingFields(fields).map((field) => field.key));
  const next: PluginSettingValues = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** 生效值：会话覆盖优先，其余跟随全局设置（全局缺省时已由 `readPluginSettings` 填过默认值）。 */
export function resolveEffectiveSettingValues(
  fields: readonly PluginSettingField[],
  globalValues: PluginSettingValues,
  overrides: PluginSettingValues,
): PluginSettingValues {
  const values: PluginSettingValues = { ...globalValues };
  for (const field of sessionScopedSettingFields(fields)) {
    const override = overrides[field.key];
    if (typeof override === 'string') values[field.key] = override;
  }
  return values;
}

/**
 * 绑一个插件的读写面。
 *
 * 宿主只提供「读这份会话的覆盖 / 写回这份会话」两个动作，字段解析与校验都留在内核，
 * 这样插件与界面读的是同一套合并规则。
 */
export function createPluginSessionSettingsApi(options: {
  fields: readonly PluginSettingField[];
  readGlobal: () => PluginSettingValues;
  readOverrides: () => PluginSettingValues | undefined;
  writeOverrides: (values: PluginSettingValues | undefined) => void;
}): PluginSessionSettingsApi {
  const { fields, readGlobal, readOverrides, writeOverrides } = options;

  const overrides = (): PluginSettingValues => {
    const raw = readOverrides();
    if (!raw) return {};
    return mergeSessionSettingOverrides(fields, {}, raw);
  };

  return {
    get: () => resolveEffectiveSettingValues(fields, readGlobal(), overrides()),
    overrides,
    set: (patch) => {
      const issues = validateSessionSettingValues(fields, patch);
      if (issues.length > 0) {
        throw new Error(issues.map((issue) => `${issue.label}：${issue.message}`).join('；'));
      }
      const next = mergeSessionSettingOverrides(fields, overrides(), patch);
      writeOverrides(Object.keys(next).length > 0 ? next : undefined);
    },
    clear: () => writeOverrides(undefined),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
