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

export type PluginSettingType = 'text' | 'password' | 'textarea' | 'select' | 'number' | 'switch';

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
  /**
   * 必填：空值视为非法。
   *
   * 没有这一条时，插件只能靠自己在运行期判断「配置齐了吗」，而页面永远显示「已保存」，
   * 用户看不出配置其实是残缺的。
   */
  required?: boolean;
  /** 值的形态约束。`url` 要求 http/https，`number` 要求可解析的有限数字。 */
  format?: 'url' | 'number';
  /** `format: 'number'`（或 `type: 'number'`）的取值下限 / 上限。 */
  min?: number;
  max?: number;
  /** 数字项的步进（页面的 −/+ 按钮按它走）；缺省 1。 */
  step?: number;
  /** 数字项的单位，显示在控件右侧（`k tokens` / `分钟` / `次`）。 */
  unit?: string;
  /** 额外的正则约束，作用于字符串值。 */
  pattern?: string;
};

export type PluginSettingValues = Record<string, string>;

/** 某个字段为什么不合法。`key` 指向清单里的字段，页面据此把提示放到对应输入框下。 */
export type PluginSettingIssue = {
  key: string;
  /** 字段声明里的显示名，页面直接拿来展示，不用再回查清单。 */
  label: string;
  message: string;
};

/**
 * 设置校验失败。
 *
 * 抛异常而不是「记一条日志然后照旧写盘」：配置页要能把逐字段的错误显示出来，
 * 插件运行期也要能判断「这组值不能用」，两边读的都是同一个错误对象。
 */
export class PluginSettingsValidationError extends Error {
  constructor(
    readonly pluginId: string,
    readonly issues: PluginSettingIssue[],
  ) {
    // 每行一条「key: 原因」。传输层只能传字符串（HTTP / IPC 都把错误压成 message），
    // 而页面要把提示放到具体输入框下面，所以这里定一个稳定、人也能读的格式。
    super([`${pluginId} 的设置不合法`, ...issues.map((issue) => `${issue.key}: ${issue.message}`)].join('\n'));
    this.name = 'PluginSettingsValidationError';
  }
}

const SETTING_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** 声明字段的类型是否受支持。 */
export function isPluginSettingType(value: unknown): value is PluginSettingType {
  return (
    value === 'text' ||
    value === 'password' ||
    value === 'textarea' ||
    value === 'select' ||
    value === 'number' ||
    value === 'switch'
  );
}

/** 字段 key 只允许标识符形式：它会变成 JSON 的键，也会被插件按名字读取。 */
export function isValidPluginSettingKey(key: string): boolean {
  return SETTING_KEY_PATTERN.test(key);
}

export function resolvePluginSettingsPath(pluginId: string, configDir: string): string {
  return join(configDir, PLUGIN_SETTINGS_DIR, `${pluginId.replace(/[\\/]/g, '_')}.json`);
}

/**
 * 校验一组设置值。
 *
 * 唯一的校验来源：写入（配置页保存）与读取（插件运行期）都调它，所以页面拦下的问题和
 * 插件看到的问题永远是同一套规则，不会出现「页面显示已保存、插件却认为配置不可用」。
 */
export function validatePluginSettingValues(
  fields: readonly PluginSettingField[],
  values: Record<string, unknown>,
): PluginSettingIssue[] {
  const issues: PluginSettingIssue[] = [];
  for (const field of fields) {
    const raw = values[field.key];
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (field.type === 'switch') {
      // 开关只有两种合法取值：页面写 'true' / 'false'，其它一律算配置坏了，
      // 否则插件读到 'yes' 之类的值时无法判断用户到底想要哪一种。
      if (value && value !== 'true' && value !== 'false') {
        issues.push({ key: field.key, label: field.label, message: '只能是 true / false' });
      }
      continue;
    }

    if (!value) {
      // 空值只在 required 时算错：可选字段留空是「用默认行为」，不是配置残缺。
      if (field.required) issues.push({ key: field.key, label: field.label, message: '不能为空' });
      continue;
    }

    if (field.type === 'select') {
      const allowed = field.options ?? [];
      if (allowed.length > 0 && !allowed.some((option) => option.value === value)) {
        issues.push({
          key: field.key,
          label: field.label,
          message: `只能是 ${allowed.map((option) => option.value).join(' / ')}`,
        });
      }
      continue;
    }

    if (field.format === 'number' || field.type === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        issues.push({ key: field.key, label: field.label, message: '必须是数字' });
      } else if (field.min !== undefined && parsed < field.min) {
        issues.push({ key: field.key, label: field.label, message: `不能小于 ${field.min}` });
      } else if (field.max !== undefined && parsed > field.max) {
        issues.push({ key: field.key, label: field.label, message: `不能大于 ${field.max}` });
      }
      continue;
    }

    if (field.format === 'url') {
      const problem = urlProblem(value);
      if (problem) issues.push({ key: field.key, label: field.label, message: problem });
    }

    if (field.pattern) {
      let matched = true;
      try {
        matched = new RegExp(field.pattern).test(value);
      } catch {
        // 清单里的正则写坏了是插件作者的问题，不能变成「用户配置非法」。
        matched = true;
      }
      if (!matched) issues.push({ key: field.key, label: field.label, message: `需要匹配 ${field.pattern}` });
    }
  }
  return issues;
}

function urlProblem(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return '需要是完整的 URL，例如 https://api.openai.com/v1';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '只支持 http/https';
  return null;
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

/**
 * 写设置：按清单过滤、校验通过后再落盘，未知键不会进入文件。
 *
 * 校验失败时**不写盘**并抛 `PluginSettingsValidationError`：以前是照单全收，
 * 页面显示「已保存」、插件读到的却是一组用不了的值，故障只能靠翻日志发现。
 */
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
  const issues = validatePluginSettingValues(fields, normalized);
  if (issues.length > 0) throw new PluginSettingsValidationError(pluginId, issues);
  const file = resolvePluginSettingsPath(pluginId, configDir);
  mkdirSync(join(configDir, PLUGIN_SETTINGS_DIR), { recursive: true });
  writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  return normalized;
}

export type PluginSettingsStore = {
  readonly path: string | null;
  readonly fields: readonly PluginSettingField[];
  /** 当前生效值；文件变了（配置页改过）会重新读，不需要重启进程。 */
  get(): PluginSettingValues;
  /** 当前生效值的校验结果；空数组表示这组配置可用。 */
  validate(): PluginSettingIssue[];
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

  return {
    path,
    fields,
    get: read,
    validate: () => validatePluginSettingValues(fields, read()),
  };
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
