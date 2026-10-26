import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 插件设置：清单里声明字段，值存在 `$MICA_HOME/plugin-settings/<id>.json`。
 *
 * 值统一按字符串存：配置页就是一个表单，插件自己按需解析（数字、布尔），这样清单、
 * 存储、页面三处都不用为每个类型各写一遍转换。未声明的键一律丢弃——插件读到的永远
 * 是与自己清单一致的一组值。
 */
export const PLUGIN_SETTINGS_DIR = 'plugin-settings';

export type PluginSettingType = 'text' | 'password' | 'textarea' | 'select' | 'number';

export type PluginSettingOption = {
  value: string;
  label: string;
};

export type PluginSettingField = {
  key: string;
  label: string;
  type: PluginSettingType;
  description?: string;
  placeholder?: string;
  /** `select` 的候选项。 */
  options?: PluginSettingOption[];
  /** 用户在页面上没填过时的取值。 */
  default?: string;
};

export type PluginSettingValues = Record<string, string>;

const SETTING_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** 声明字段的类型是否受支持。 */
export function isPluginSettingType(value: unknown): value is PluginSettingType {
  return value === 'text' || value === 'password' || value === 'textarea' || value === 'select' || value === 'number';
}

/** 字段 key 只允许标识符形式：它会变成 JSON 的键，也会被插件按名字读取。 */
export function isValidPluginSettingKey(key: string): boolean {
  return SETTING_KEY_PATTERN.test(key);
}

export function resolvePluginSettingsPath(pluginId: string, configDir: string): string {
  return join(configDir, PLUGIN_SETTINGS_DIR, `${pluginId.replace(/[\\/]/g, '_')}.json`);
}

/**
 * 读设置，只保留清单声明的键，缺的用默认值补。
 *
 * 文件不存在、是坏 JSON、或者里面是数组，一律当作「全用默认值」：设置文件损坏不该让
 * 插件起不来，页面打开后重新保存一次就能修好。
 */
export function readPluginSettings(
  pluginId: string,
  fields: readonly PluginSettingField[],
  options: { configDir?: string } = {},
): PluginSettingValues {
  const stored = readStoredValues(pluginId, options.configDir);
  const values: PluginSettingValues = {};
  for (const field of fields) {
    const value = stored[field.key];
    values[field.key] = typeof value === 'string' ? value : (field.default ?? '');
  }
  return values;
}

/** 写设置：按清单过滤后再落盘，未知键不会进入文件。 */
export function writePluginSettings(
  pluginId: string,
  values: Record<string, unknown>,
  fields: readonly PluginSettingField[],
  options: { configDir?: string } = {},
): PluginSettingValues {
  const configDir = options.configDir;
  if (!configDir) throw new Error('写入插件设置需要 configDir');
  const normalized: PluginSettingValues = {};
  for (const field of fields) {
    const value = values[field.key];
    normalized[field.key] = typeof value === 'string' ? value : (field.default ?? '');
  }
  const file = resolvePluginSettingsPath(pluginId, configDir);
  mkdirSync(join(configDir, PLUGIN_SETTINGS_DIR), { recursive: true });
  writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  return normalized;
}

export type PluginSettingsStore = {
  readonly path: string | null;
  /** 当前生效值；文件变了（配置页改过）会重新读，不需要重启进程。 */
  get(): PluginSettingValues;
};

/**
 * 插件运行期用的读句柄。
 *
 * 按 mtime 缓存：设置属于运行期可改的东西，但也不能每轮都真的读一遍文件。
 */
export function createPluginSettingsStore(
  pluginId: string,
  fields: readonly PluginSettingField[],
  options: { configDir?: string } = {},
): PluginSettingsStore {
  const configDir = options.configDir;
  const path = configDir ? resolvePluginSettingsPath(pluginId, configDir) : null;
  let cached: { mtimeMs: number; values: PluginSettingValues } | null = null;

  const read = (): PluginSettingValues => {
    if (!configDir) return readPluginSettings(pluginId, fields);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path!).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    if (cached && cached.mtimeMs === mtimeMs) return cached.values;
    const values = readPluginSettings(pluginId, fields, { configDir });
    cached = { mtimeMs, values };
    return values;
  };

  return { path, get: read };
}

function readStoredValues(pluginId: string, configDir: string | undefined): Record<string, unknown> {
  if (!configDir) return {};
  const file = resolvePluginSettingsPath(pluginId, configDir);
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
