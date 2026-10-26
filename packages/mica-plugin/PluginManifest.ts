import {
  isPluginSettingType,
  isValidPluginSettingKey,
  type PluginSettingField,
  type PluginSettingOption,
  type PluginSettingType,
} from './PluginSettings.js';

/**
 * 插件包的清单（`plugin.json`）。
 *
 * 一个插件是一个目录，而不是一个散落的 `.js` 文件——这样它才能带上入口、资源（样式、
 * 文档、图标）、依赖声明和版本身份，和浏览器扩展的组织方式一致：
 *
 * ```
 * ~/.mica/plugins/my-plugin/
 *   plugin.json     ← 清单（本文件的解析对象）
 *   index.js        ← 入口，default 导出 setup(ctx)
 *   styles.css      ← 资源，由清单的 assets 声明
 * ```
 *
 * 没有清单的文件不会被当成插件：插件形态只有一种，加载器不去猜。
 */

export const PLUGIN_MANIFEST_FILE = 'plugin.json';

/** 清单没有声明 `main` 时按这个顺序找入口。 */
export const PLUGIN_ENTRY_CANDIDATES = ['index.js', 'index.mjs'] as const;

/** 当前支持的能力版本；插件清单里的 `mica.apiVersion` 必须与此一致。 */
export const PLUGIN_API_VERSION = 1;

export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  /** 入口文件，相对插件目录。 */
  main: string;
  /** 除入口与清单外随插件一起分发的资源文件，相对插件目录。 */
  assets: string[];
  /** 必须在之前 setup 的插件 id。 */
  dependencies: string[];
  /** setup 失败是否应中断启动。内置插件通常为 true，用户插件为 false。 */
  required: boolean;
  /** 加载顺序，小的先执行。 */
  priority: number;
  apiVersion: number;
  /**
   * 插件自己的配置项。声明之后配置页会渲染对应表单，值存在
   * `$MICA_HOME/plugin-settings/<id>.json`，插件经 `ctx.settings.get()` 读。
   */
  settings: PluginSettingField[];
  /**
   * 插件运行所需的宿主能力。
   *
   * 以前插件在 setup 里 `if (!ctx.tools) throw`，宿主少给一项就等于插件启动失败，
   * `required` 插件甚至会拖垮整个启动。声明成清单数据后，注册阶段就能比对能力并
   * **跳过**（附原因），故障是配置页上的一条状态，而不是一次崩溃。
   */
  requires: PluginRequirement[];
};

/**
 * 宿主可以向插件提供的能力面。取值来自 `PluginContext` 的可选字段，新增能力时两处同步。
 */
export const PLUGIN_REQUIREMENTS = [
  'commands',
  'events',
  'git',
  'hooks',
  'prompt',
  'runtime',
  'session',
  'sessionState',
  'settings',
  'tools',
  'ui',
] as const;

export type PluginRequirement = (typeof PLUGIN_REQUIREMENTS)[number];

export function isPluginRequirement(value: unknown): value is PluginRequirement {
  return typeof value === 'string' && (PLUGIN_REQUIREMENTS as readonly string[]).includes(value);
}

export type PluginManifestParseResult = { ok: true; manifest: PluginManifest } | { ok: false; error: string };

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

/**
 * 解析并校验 `plugin.json` 的内容。
 *
 * 清单是插件的唯一身份来源，所以校验从严：字段缺失、id 不合法、入口越界都会得到一条
 * 可读的错误，直接显示在配置页上，而不是等到导入时抛一个栈。
 */
export function parsePluginManifest(input: unknown): PluginManifestParseResult {
  if (!isRecord(input)) return { ok: false, error: 'plugin.json 的根节点必须是对象' };

  const id = readString(input.id)?.trim();
  if (!id) return { ok: false, error: '缺少 id' };
  if (!PLUGIN_ID_PATTERN.test(id)) {
    return { ok: false, error: `id 只能由小写字母、数字、"." "_" "-" 组成，且以字母或数字开头：${id}` };
  }

  const name = readString(input.name)?.trim();
  if (!name) return { ok: false, error: '缺少 name' };

  const rawVersion = readString(input.version)?.trim();
  if (!rawVersion) return { ok: false, error: '缺少 version' };
  if (!VERSION_PATTERN.test(rawVersion)) {
    return { ok: false, error: `version 需要形如 1.0.0：${rawVersion}` };
  }

  const description = readString(input.description)?.trim() ?? '';
  const author = readString(input.author)?.trim() || undefined;

  const main = (readString(input.main)?.trim() || PLUGIN_ENTRY_CANDIDATES[0]).replace(/^\.\//, '');
  if (!isSafePluginRelativePath(main)) {
    return { ok: false, error: `main 必须是插件目录内的相对路径：${main}` };
  }

  const assets = readStringList(input.assets, 'assets');
  if (!assets.ok) return assets;
  for (const asset of assets.value) {
    if (!isSafePluginRelativePath(asset)) {
      return { ok: false, error: `assets 只能是插件目录内的相对路径：${asset}` };
    }
  }

  const dependencies = readStringList(input.dependencies, 'dependencies');
  if (!dependencies.ok) return dependencies;

  const apiVersion = readApiVersion(input.mica);
  if (typeof apiVersion === 'string') return { ok: false, error: apiVersion };

  const settings = readSettings(input.settings);
  if (!settings.ok) return settings;

  const requires = readRequires(input.requires);
  if (!requires.ok) return requires;

  return {
    ok: true,
    manifest: {
      id,
      name,
      version: rawVersion,
      description,
      author,
      main,
      assets: assets.value,
      dependencies: dependencies.value,
      required: input.required === true,
      priority: typeof input.priority === 'number' && Number.isFinite(input.priority) ? input.priority : 0,
      apiVersion,
      settings: settings.value,
      requires: requires.value,
    },
  };
}

/**
 * 设置字段声明。
 *
 * 校验从严的理由与清单其余部分一样：页面完全按这份声明渲染表单，key 写错、类型不认识
 * 都会让用户填了也不生效，所以在解析阶段就报出来。
 */
function readSettings(input: unknown): { ok: true; value: PluginSettingField[] } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'settings 必须是数组' };

  const fields: PluginSettingField[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (!isRecord(entry)) return { ok: false, error: 'settings 的每一项必须是对象' };
    const key = readString(entry.key)?.trim();
    if (!key) return { ok: false, error: 'settings 项缺少 key' };
    if (!isValidPluginSettingKey(key)) {
      return { ok: false, error: `settings.key 只能由字母、数字、"_" 组成，且以字母开头：${key}` };
    }
    if (seen.has(key)) return { ok: false, error: `settings.key 重复：${key}` };
    seen.add(key);

    const label = readString(entry.label)?.trim();
    if (!label) return { ok: false, error: `settings.${key} 缺少 label` };
    if (!isPluginSettingType(entry.type)) {
      return { ok: false, error: `settings.${key} 的 type 不受支持：${String(entry.type)}` };
    }

    const options = entry.type === 'select' ? readSettingOptions(entry.options, key) : undefined;
    if (options && !options.ok) return options;

    const format = readFormat(entry.format, key);
    if (!format.ok) return format;
    const defaultValue = readString(entry.default) ?? undefined;
    const defaultProblem = validateDefault(entry.type, defaultValue, options?.value, key);
    if (defaultProblem) return { ok: false, error: defaultProblem };

    fields.push({
      key,
      label,
      type: entry.type,
      description: readString(entry.description)?.trim() || undefined,
      placeholder: readString(entry.placeholder)?.trim() || undefined,
      options: options?.value,
      default: defaultValue,
      required: entry.required === true ? true : undefined,
      format: format.value,
      min: readFiniteNumber(entry.min),
      max: readFiniteNumber(entry.max),
      pattern: readString(entry.pattern)?.trim() || undefined,
    });
  }
  return { ok: true, value: fields };
}

function readSettingOptions(
  input: unknown,
  key: string,
): { ok: true; value: PluginSettingOption[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: `settings.${key} 是 select，必须声明 options` };
  }
  const options: PluginSettingOption[] = [];
  for (const entry of input) {
    if (!isRecord(entry)) return { ok: false, error: `settings.${key}.options 的每一项必须是对象` };
    const value = readString(entry.value)?.trim();
    if (!value) return { ok: false, error: `settings.${key}.options 缺少 value` };
    options.push({ value, label: readString(entry.label)?.trim() || value });
  }
  return { ok: true, value: options };
}

/** `format` 只认这两个值：写错的话页面会按「没有约束」渲染，等于悄悄放宽校验。 */
function readFormat(
  input: unknown,
  key: string,
): { ok: true; value: PluginSettingField['format'] } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, value: undefined };
  if (input === 'url' || input === 'number') return { ok: true, value: input };
  return { ok: false, error: `settings.${key}.format 只能是 url 或 number：${String(input)}` };
}

function readFiniteNumber(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

/**
 * 默认值也要能通过同一套校验，否则「清空字段」会把一个非法默认值写进配置，
 * 而用户什么都没做。
 */
function validateDefault(
  type: PluginSettingType,
  value: string | undefined,
  options: PluginSettingOption[] | undefined,
  key: string,
): string | null {
  if (value === undefined || value === '') return null;
  if (type === 'select' && options && !options.some((option) => option.value === value)) {
    return `settings.${key}.default 不在 options 里：${value}`;
  }
  if (type === 'number' && !Number.isFinite(Number(value))) {
    return `settings.${key}.default 必须是数字：${value}`;
  }
  return null;
}

function readRequires(input: unknown): { ok: true; value: PluginRequirement[] } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'requires 必须是数组' };
  const values: PluginRequirement[] = [];
  for (const entry of input) {
    if (!isPluginRequirement(entry)) {
      return {
        ok: false,
        error: `requires 里有未知能力：${String(entry)}（可用：${PLUGIN_REQUIREMENTS.join(' / ')}）`,
      };
    }
    if (!values.includes(entry)) values.push(entry);
  }
  return { ok: true, value: values };
}

/**
 * 插件目录内的相对路径：不能是绝对路径，也不能靠 `..` 跳出插件目录。
 *
 * 加载器会按清单里的 `main` / `assets` 读文件，越界路径等于让清单决定去读插件目录之外的
 * 内容；这里在解析阶段就挡掉，而不是在读取时再判断。
 */
export function isSafePluginRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  return value.split(/[\\/]/).every((segment) => segment !== '..' && segment.length > 0);
}

function readApiVersion(input: unknown): number | string {
  if (input === undefined) return PLUGIN_API_VERSION;
  if (!isRecord(input)) return 'mica 必须是对象';
  const raw = input.apiVersion;
  if (raw === undefined) return PLUGIN_API_VERSION;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return 'mica.apiVersion 必须是整数';
  if (raw !== PLUGIN_API_VERSION) return `不支持的插件能力版本：${raw}（当前为 ${PLUGIN_API_VERSION}）`;
  return raw;
}

function readStringList(input: unknown, field: string): { ok: true; value: string[] } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: `${field} 必须是字符串数组` };
  const value: string[] = [];
  for (const entry of input) {
    if (typeof entry !== 'string' || !entry.trim()) return { ok: false, error: `${field} 里不能有空值` };
    value.push(entry.trim());
  }
  return { ok: true, value };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
