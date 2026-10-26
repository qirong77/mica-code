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
};

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
    },
  };
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
