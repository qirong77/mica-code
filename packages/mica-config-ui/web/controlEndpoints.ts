import type { ConfigWebBrowserControlEndpoint, ConfigWebBrowserControlEndpointParam } from '../src/shared/types.js';

/**
 * 受控浏览器与终端控制共用的端点展示逻辑：分组、一行摘要、curl 示例。
 *
 * 两份服务的文档形状相同（都由各自的端点目录生成，见 `terminal-docs.js` /
 * `browser-docs.js`），只是地址与环境变量不同。抽在这里是为了让两个设置页用同一套排版，
 * 也避免「改了一边忘了另一边」的漂移。
 */

/** 方法分组的固定顺序：常见的读/写在前，其余按字母排。 */
export const CONTROL_METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function methodOf(endpoint: ConfigWebBrowserControlEndpoint | null | undefined): string {
  const method = typeof endpoint?.method === 'string' ? endpoint.method.trim().toUpperCase() : '';
  return method || 'GET';
}

export function endpointSummaryLine(endpoint: ConfigWebBrowserControlEndpoint | null | undefined): string {
  const path = typeof endpoint?.path === 'string' ? endpoint.path.trim() : '';
  return `${methodOf(endpoint)} ${path}`.trim();
}

function methodRank(method: string): number {
  const index = CONTROL_METHOD_ORDER.indexOf(method);
  return index === -1 ? CONTROL_METHOD_ORDER.length : index;
}

function compareEndpoints(left: ConfigWebBrowserControlEndpoint, right: ConfigWebBrowserControlEndpoint): number {
  const pathCompare = String(left?.path ?? '').localeCompare(String(right?.path ?? ''));
  if (pathCompare !== 0) return pathCompare;
  return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
}

export type ControlEndpointGroup = {
  method: string;
  label: string;
  endpoints: ConfigWebBrowserControlEndpoint[];
};

/** 按 method 分组：组序固定（GET/POST/…，其余按字母），组内按 path、id 稳定排序。 */
export function groupEndpoints(
  endpoints: ConfigWebBrowserControlEndpoint[] | null | undefined,
): ControlEndpointGroup[] {
  const groups = new Map<string, ConfigWebBrowserControlEndpoint[]>();
  for (const endpoint of Array.isArray(endpoints) ? endpoints : []) {
    if (!endpoint || typeof endpoint !== 'object') continue;
    const method = methodOf(endpoint);
    const list = groups.get(method) ?? [];
    list.push(endpoint);
    groups.set(method, list);
  }
  return [...groups.entries()]
    .map(([method, list]) => ({ method, label: method, endpoints: [...list].sort(compareEndpoints) }))
    .sort(
      (left, right) => methodRank(left.method) - methodRank(right.method) || left.method.localeCompare(right.method),
    );
}

/** 路径里的 `:id` 之类的占位段换成可读示例值（`id` 用 `abc123`，其余用 `example-<name>`）。 */
export function pathWithSampleParams(path: string): string {
  return String(path ?? '').replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) =>
    name === 'id' ? 'abc123' : `example-${name}`,
  );
}

function sampleValue(name: string): string {
  if (name === 'url') return 'https://example.com';
  if (name === 'id') return 'abc123';
  return `example-${name}`;
}

function sampleBody(params: ConfigWebBrowserControlEndpointParam[]): Record<string, string> {
  const body: Record<string, string> = {};
  for (const param of params) {
    if (param?.in === 'body' && param.required) body[param.name] = sampleValue(param.name);
  }
  return body;
}

/**
 * 拼一份可直接复制的 curl 示例：地址用传入的 baseUrl（没传就用 `$<urlEnv>` 占位），
 * 始终带上 `x-mica-owner` 头 —— agent 靠它把窗口 / 终端挂到当前会话上。
 */
export function controlCurlExample(
  endpoint: ConfigWebBrowserControlEndpoint | null | undefined,
  { baseUrl, urlEnv, ownerEnv }: { baseUrl: string; urlEnv: string; ownerEnv: string },
): string {
  const urlFallback = `$${urlEnv.replace(/^\$/, '')}`;
  const ownerFallback = `$${ownerEnv.replace(/^\$/, '')}`;
  const base =
    String(baseUrl ?? '')
      .trim()
      .replace(/\/+$/, '') || urlFallback;
  const url = `${base}${pathWithSampleParams(endpoint?.path ?? '')}`;
  const method = methodOf(endpoint);
  const lines = [`curl -X ${method} "${url}"`, `  -H "x-mica-owner: ${ownerFallback}"`];
  const body = sampleBody(Array.isArray(endpoint?.params) ? endpoint.params : []);
  if (Object.keys(body).length > 0) {
    lines.push('  -H "content-type: application/json"');
    lines.push(`  -d '${JSON.stringify(body)}'`);
  }
  return lines.join(' \\\n');
}

/** 环境变量说明：地址来自 `url`，归属来自 `owner`。 */
export function controlEnvHint(
  envVars: { url?: string; owner?: string } | null | undefined,
  fallback: { url: string; owner: string },
): string {
  const url = envVars?.url || fallback.url;
  const owner = envVars?.owner || fallback.owner;
  return `agent 用 $${url} 拿服务地址、用 $${owner} 认领归属（curl 时加 -H "x-mica-owner: $${owner}"）。`;
}
