import {
  isPluginSettingType,
  isValidPluginSettingKey,
  type PluginSettingField,
  type PluginSettingOption,
  type PluginSettingType,
} from './PluginSettings.js';
import { pluginLlmSettingFields, type PluginLlmSpec } from './PluginLlm.js';
import {
  isDesktopCheckId,
  type DesktopCheckId,
  type PluginDesktopEntry,
} from './PluginDesktop.js';

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
  /**
   * 界面代表插件的图标名。
   *
   * 取值是界面图标库里的 kebab-case 名称（见 `mica-config-ui/web/pluginIcons.tsx` 的
   * `PLUGIN_ICONS`），空字符串表示由界面用默认图标兜底：插件页与桌面端的插件菜单都读这一份。
   */
  icon: string;
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
   * 插件要自己调模型时的声明（起标题、写提交说明、整理记忆）。
   *
   * 四个配置字段已经展开进 `settings`（`group: 'llm'`），这里只留声明本身：页面用它
   * 生成面板标题、说明、是否允许「跟随主配置」，插件用 `ctx.llm` 拿到解析好的配置。
   */
  llm: PluginLlmSpec | null;
  /**
   * 插件运行所需的宿主能力。
   *
   * 以前插件在 setup 里 `if (!ctx.tools) throw`，宿主少给一项就等于插件启动失败，
   * `required` 插件甚至会拖垮整个启动。声明成清单数据后，注册阶段就能比对能力并
   * **跳过**（附原因），故障是配置页上的一条状态，而不是一次崩溃。
   */
  requires: PluginRequirement[];
  /**
   * 插件依赖的桌面端运行条件。声明式数据：宿主负责探测状态，并在插件自己的设置页里
   * 展示「开了没有 / 去哪里开」——插件代码只跑在 app-server 子进程里，探测不到这些。
   */
  desktopChecks: DesktopCheckId[];
  /**
   * 桌面端侧栏入口（清单 `desktop.entry`）。声明了就有一行入口，卡片内容由插件目录里的
   * `desktop.jsx` 渲染；没声明（null）的插件在侧栏里不占位置。
   */
  desktopEntry: PluginDesktopEntry | null;
};

/**
 * 宿主可以向插件提供的能力面。取值来自 `PluginContext` 的可选字段，新增能力时两处同步。
 */
export const PLUGIN_REQUIREMENTS = [
  'agent',
  'background',
  'commands',
  'desktop',
  'events',
  'git',
  'hooks',
  'llm',
  'prompt',
  'runtime',
  'session',
  'sessionSettings',
  'models',
  'sessionState',
  'settings',
  'skills',
  'subagents',
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
/** 图标名要进界面图标表查：写错了界面只能回退成默认图标，不如解析阶段就报出来。 */
const PLUGIN_ICON_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

  const icon = readString(input.icon)?.trim() ?? '';
  if (icon && !PLUGIN_ICON_PATTERN.test(icon)) {
    return { ok: false, error: `icon 只能由小写字母、数字与 "-" 组成：${icon}` };
  }

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

  const llm = readLlm(input.llm);
  if (!llm.ok) return llm;
  // `llm` 声明展开成普通设置字段：存储、校验、按会话覆盖都只有一条路径，
  // 页面则按 `group: 'llm'` 把它们收进同一个面板（带「测试」按钮）。
  const llmFields = llm.value ? pluginLlmSettingFields(llm.value) : [];
  for (const field of llmFields) {
    if (settings.value.some((declared) => declared.key === field.key)) {
      return { ok: false, error: `settings 不能重复声明 llm 的字段：${field.key}` };
    }
  }

  const requires = readRequires(input.requires);
  if (!requires.ok) return requires;

  const desktop = readDesktop(input.desktop, name);
  if (!desktop.ok) return desktop;

  return {
    ok: true,
    manifest: {
      id,
      name,
      version: rawVersion,
      description,
      icon,
      author,
      main,
      assets: assets.value,
      dependencies: dependencies.value,
      required: input.required === true,
      priority: typeof input.priority === 'number' && Number.isFinite(input.priority) ? input.priority : 0,
      apiVersion,
      settings: [...settings.value, ...llmFields],
      llm: llm.value ?? null,
      requires: requires.value,
      desktopChecks: desktop.value.checks,
      desktopEntry: desktop.value.entry,
    },
  };
}

/**
 * `llm` 声明：插件要一个模型接口，字段由 `pluginLlmSettingFields` 统一生成。
 *
 * 校验从严与 settings 一致——面板完全按这份声明显示，写错的字段（例如 `followMain`
 * 给了字符串）会让页面渲染出一个不可用的表单，不如在加载阶段就报错。
 */
function readLlm(input: unknown): { ok: true; value: PluginLlmSpec | null } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, value: null };
  if (!isRecord(input)) return { ok: false, error: 'llm 必须是对象' };

  for (const key of ['label', 'description', 'modelPlaceholder', 'baseUrlPlaceholder'] as const) {
    const value = input[key];
    if (value !== undefined && typeof value !== 'string') {
      return { ok: false, error: `llm.${key} 必须是字符串` };
    }
  }
  for (const key of ['followMain', 'required'] as const) {
    const value = input[key];
    if (value !== undefined && typeof value !== 'boolean') {
      return { ok: false, error: `llm.${key} 必须是布尔值` };
    }
  }

  return {
    ok: true,
    value: {
      label: typeof input.label === 'string' && input.label.trim() ? input.label.trim() : undefined,
      description: typeof input.description === 'string' && input.description.trim() ? input.description.trim() : undefined,
      followMain: input.followMain === true,
      modelPlaceholder:
        typeof input.modelPlaceholder === 'string' && input.modelPlaceholder.trim()
          ? input.modelPlaceholder.trim()
          : undefined,
      baseUrlPlaceholder:
        typeof input.baseUrlPlaceholder === 'string' && input.baseUrlPlaceholder.trim()
          ? input.baseUrlPlaceholder.trim()
          : undefined,
      required: input.required === true,
    },
  };
}

/**
 * `desktop` 段：运行条件（`checks`）与侧栏入口（`entry`）。
 *
 * 校验从严的理由与设置项一致：设置页与侧栏完全按这份声明显示，检查项 id 写错就等于
 * 永远显示不出一行状态——用户在配置页看到一条可读的错误，比看到一个缺项的面板强。
 */
function readDesktop(
  input: unknown,
  pluginName: string,
): { ok: true; value: { checks: DesktopCheckId[]; entry: PluginDesktopEntry | null } } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, value: { checks: [], entry: null } };
  if (!isRecord(input)) return { ok: false, error: 'desktop 必须是对象' };

  const rawChecks = input.checks;
  const checks: DesktopCheckId[] = [];
  if (rawChecks !== undefined) {
    if (!Array.isArray(rawChecks)) return { ok: false, error: 'desktop.checks 必须是数组' };
    for (const check of rawChecks) {
      if (!isDesktopCheckId(check)) {
        return { ok: false, error: `desktop.checks 里有未知检查项：${String(check)}` };
      }
      if (!checks.includes(check)) checks.push(check);
    }
  }

  const rawEntry = input.entry;
  if (rawEntry === undefined) return { ok: true, value: { checks, entry: null } };
  if (!isRecord(rawEntry)) return { ok: false, error: 'desktop.entry 必须是对象' };
  const rawLabel = rawEntry.label;
  if (rawLabel !== undefined && typeof rawLabel !== 'string') {
    return { ok: false, error: 'desktop.entry.label 必须是字符串' };
  }
  // 侧栏那一行只有一行的宽度：文案留空的退化成语义（用插件名）而不是画一行空白。
  const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : pluginName;
  return { ok: true, value: { checks, entry: { label } } };
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
      step: readFiniteNumber(entry.step),
      unit: readString(entry.unit)?.trim() || undefined,
      pattern: readString(entry.pattern)?.trim() || undefined,
      perSession: entry.perSession === true ? true : undefined,
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
  if (type === 'switch' && value !== 'true' && value !== 'false') {
    return `settings.${key}.default 只能是 true / false：${value}`;
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
