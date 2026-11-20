import type { PluginDataApi } from './PluginData.js';
import type { PluginSettingsStore } from './PluginSettings.js';

/**
 * 随包插件 api.ts 的独立宿主：应用现有端口上的一个机读 HTTP 接口。
 *
 * 与 mcp.ts 的区别只在「协议由谁定义」——MCP 由 SDK 定义，模型看到的是工具；
 * 这里由插件自己给出端点表与路由处理，模型（或任何 HTTP 客户端）看到的是接口文档。
 * 上下文只有插件身份、绑定的数据与只读设置：不提供 agent、会话或任意 socket。
 */
export type PluginApiContext = {
  pluginId: string;
  pluginVersion: string;
  data: PluginDataApi;
  settings: Pick<PluginSettingsStore, 'get'>;
};

export type PluginApiMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** 路径段已解码、已校验（不含空段、`.`、`..` 与斜杠）；查询参数只有字符串值。 */
export type PluginApiRequest = {
  method: PluginApiMethod;
  /** `/plugin/<id>/api` 之后的路径段；`GET /plugin/<id>/api` 本身由宿主回答文档，不会到这里。 */
  path: readonly string[];
  query: Readonly<Record<string, string>>;
  /** 已解析的 JSON 请求体；没有请求体时为 undefined。 */
  body: unknown;
  signal: AbortSignal;
};

/** 失败请抛 `PluginApiError`：宿主只透出状态码、稳定 code 与这句话，不回传内部异常。 */
export type PluginApiResponse = {
  /** 默认 200。 */
  status?: number;
  /** 必须是可 JSON 序列化的值；宿主包成 `{ ok: true, data }` 返回。 */
  body: unknown;
};

export type PluginApiParameter = {
  name: string;
  in: 'path' | 'query' | 'body';
  type: string;
  required?: boolean;
  description: string;
};

/** 端点表就是接口文档本身：模型先读它，再照它调。 */
export type PluginApiEndpoint = {
  method: PluginApiMethod;
  /** 相对 `/plugin/<id>/api` 的路径，用 `:name` 表示路径段。 */
  path: string;
  summary: string;
  params?: readonly PluginApiParameter[];
  /** 成功时 `data` 的形状说明。 */
  returns: string;
  example?: string;
};

/** default createApi(context) 的返回值；插件停用或应用退出时释放。 */
export type PluginApiHandler = {
  /** 一句话说明这个接口是做什么的。 */
  description?: string;
  /** 调用纪律（不可信数据、版本校验、可恢复删除等），原样进文档。 */
  guide?: string;
  endpoints: readonly PluginApiEndpoint[];
  handle(request: PluginApiRequest): PluginApiResponse | Promise<PluginApiResponse>;
  dispose?(): void | Promise<void>;
};

/** 宿主只回传 status/code/message；details 仅供测试与日志，不进响应。 */
export class PluginApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PluginApiError';
    this.status = status;
    this.code = code;
  }
}

export const PLUGIN_API_PREFIX = '/plugin';
export const PLUGIN_API_METHODS: readonly PluginApiMethod[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

export function pluginApiBasePath(pluginId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId) || pluginId.includes('..')) throw new Error('插件 id 非法');
  return `${PLUGIN_API_PREFIX}/${encodeURIComponent(pluginId)}/api`;
}

/** 插件自己拼文档里的完整地址；不带 path 时就是接口根（文档端点）。 */
export function pluginApiPath(pluginId: string, path = ''): string {
  const base = pluginApiBasePath(pluginId);
  const suffix = String(path).replace(/^\/+/, '');
  return suffix ? `${base}/${suffix}` : base;
}

/** 只认 `/plugin/<id>/api` 与其子路径；其它路径返回 null。 */
export function pluginApiId(pathname: string): string | null {
  return /^\/plugin\/([a-z0-9][a-z0-9._-]*)\/api(?:\/|$)/.exec(pathname)?.[1] ?? null;
}

/** 校验并解码路径段；非法路径（空段、`.`、`..`、编码后的分隔符）返回 null。 */
export function pluginApiSegments(pathname: string): readonly string[] | null {
  const pluginId = pluginApiId(pathname);
  if (!pluginId) return null;
  const rest = pathname.slice(pluginApiBasePath(pluginId).length);
  if (!rest) return Object.freeze([]);
  if (!rest.startsWith('/')) return null;
  const segments: string[] = [];
  for (const raw of rest.slice(1).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
      return null;
    }
    if (segment.length > 128) return null;
    segments.push(segment);
  }
  return Object.freeze(segments);
}

export function isPluginApiMethod(value: unknown): value is PluginApiMethod {
  return typeof value === 'string' && (PLUGIN_API_METHODS as readonly string[]).includes(value);
}
