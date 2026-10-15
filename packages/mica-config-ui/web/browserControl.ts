import type {
  ConfigWebBrowserControlBrowser,
  ConfigWebBrowserControlDetails,
  ConfigWebBrowserControlEndpoint,
  ConfigWebBrowserControlEndpointParam,
} from '../src/shared/types.js';

/**
 * 配置页「Browser Control」一节的纯逻辑：窗口状态文案、归属文案、接口分组与 curl 示例。
 *
 * 受控浏览器活在桌面运行时里（窗口在 Electron 主进程、运行时经本机 HTTP 服务读写，见
 * `apps/desktop/src/host/browser-control.js`），页面只是把详情读出来展示。这里不碰数据源，
 * 只把详情翻译成界面文案 —— 与 `autoCompact.ts` 同一条边界：能测的判断都抽出来，组件里只接线。
 */

/** 没有服务地址时，示例里用环境变量占位，agent 拿到手就是可移植的一份。 */
export const BROWSER_URL_ENV_FALLBACK = '$MICA_BROWSER_URL';
export const BROWSER_OWNER_ENV_FALLBACK = '$MICA_BROWSER_OWNER';

/** 宿主拿不到受控浏览器数据时的说明（既可能是非桌面宿主，也可能是应用里的服务没起来）。 */
export const BROWSER_CONTROL_DISABLED_REASON =
  '当前页面读不到受控浏览器服务：它由 Mica Code 桌面应用的主进程提供。';

/**
 * 「这一节永远在侧栏里，但没有服务」时的详情。
 *
 * 侧栏条目不再按宿主能力隐藏（见 `layout/Sidebar.tsx`），因为「看不到入口」和「服务没开」
 * 对用户是两件完全不同的事：前者让人以为 Mica 没有这个能力，后者才是真实状态。所以
 * 拿不到数据时给出这份显式「不可用」的详情，页面据此提示未开启、并说清怎么开。
 */
export function unavailableBrowserControlDetails(
  reason: string | null = BROWSER_CONTROL_DISABLED_REASON,
): ConfigWebBrowserControlDetails {
  return {
    available: false,
    serviceUrl: null,
    version: 0,
    skillPath: null,
    error: reason || BROWSER_CONTROL_DISABLED_REASON,
    browsers: [],
    endpoints: [],
    markdown: '',
    skillMarkdown: '',
    envVars: {
      url: BROWSER_URL_ENV_FALLBACK.slice(1),
      owner: BROWSER_OWNER_ENV_FALLBACK.slice(1),
    },
  };
}

/** 未开启时页面要讲清的四件事：这是什么、谁提供、为什么这里看不到、怎么打开。 */
export const BROWSER_CONTROL_DISABLED_STEPS = [
  '受控浏览器是「给 AI 用的」浏览器：窗口开在 Mica Code 应用里，agent 用一套本机接口开页面、点击、读内容、截图、读 cookie。',
  '它由桌面应用的主进程提供，只有从应用里打开的设置页才连得上；纯浏览器宿主（CLI 的 mica --config-web、npm run start:web）读不到它。',
  '打开 Mica Code 桌面应用，再从这里进入「Browser Control」：会显示服务状态、窗口列表与完整接口文档。',
];

/** 方法分组的固定顺序：常见的读/写在前，其余按字母排。 */
export const BROWSER_METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function methodOf(endpoint: ConfigWebBrowserControlEndpoint | null | undefined): string {
  const method = typeof endpoint?.method === 'string' ? endpoint.method.trim().toUpperCase() : '';
  return method || 'GET';
}

/** 归属为空时不说「无」，而是明确「未归属」——这类窗口正是 agent 待认领的对象。 */
export function ownerLabel(owner: string | null | undefined): string {
  const value = typeof owner === 'string' ? owner.trim() : '';
  return value || '未归属';
}

/** 窗口状态三态：加载中 > 可见 > 隐藏。 */
export function browserStatusLabel(browser: ConfigWebBrowserControlBrowser | null | undefined): string {
  if (browser?.loading) return '加载中';
  if (browser?.visible) return '可见';
  return '隐藏';
}

export function browserStatusTone(
  browser: ConfigWebBrowserControlBrowser | null | undefined,
): 'default' | 'green' | 'blue' {
  if (browser?.loading) return 'blue';
  if (browser?.visible) return 'green';
  return 'default';
}

/** 标签页摘要：数量 + 当前标签标题（没有标签时如实说明）。 */
export function tabSummary(browser: ConfigWebBrowserControlBrowser | null | undefined): string {
  const tabs = Array.isArray(browser?.tabs) ? browser.tabs : [];
  if (tabs.length === 0) return '无标签页';
  const active = tabs.find((tab) => tab.active) ?? tabs[0];
  const title = active?.title || active?.url || active?.id || '';
  return title ? `${tabs.length} 个标签页 · ${title}` : `${tabs.length} 个标签页`;
}

export function endpointSummaryLine(endpoint: ConfigWebBrowserControlEndpoint | null | undefined): string {
  const path = typeof endpoint?.path === 'string' ? endpoint.path.trim() : '';
  return `${methodOf(endpoint)} ${path}`.trim();
}

function methodRank(method: string): number {
  const index = BROWSER_METHOD_ORDER.indexOf(method);
  return index === -1 ? BROWSER_METHOD_ORDER.length : index;
}

function compareEndpoints(left: ConfigWebBrowserControlEndpoint, right: ConfigWebBrowserControlEndpoint): number {
  const pathCompare = String(left?.path ?? '').localeCompare(String(right?.path ?? ''));
  if (pathCompare !== 0) return pathCompare;
  return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
}

export type BrowserEndpointGroup = {
  method: string;
  label: string;
  endpoints: ConfigWebBrowserControlEndpoint[];
};

/** 按 method 分组：组序固定（GET/POST/…，其余按字母），组内按 path、id 稳定排序。 */
export function groupEndpoints(
  endpoints: ConfigWebBrowserControlEndpoint[] | null | undefined,
): BrowserEndpointGroup[] {
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
 * 拼一份可直接复制的 curl 示例：地址用传入的 baseUrl（默认 `$MICA_BROWSER_URL`），
 * 始终带上 `x-mica-owner` 头 —— agent 靠它把窗口挂到当前会话上。
 */
export function curlExample(
  endpoint: ConfigWebBrowserControlEndpoint | null | undefined,
  baseUrl: string = BROWSER_URL_ENV_FALLBACK,
): string {
  const base =
    String(baseUrl ?? '')
      .trim()
      .replace(/\/+$/, '') || BROWSER_URL_ENV_FALLBACK;
  const url = `${base}${pathWithSampleParams(endpoint?.path ?? '')}`;
  const method = methodOf(endpoint);
  const lines = [`curl -X ${method} "${url}"`, `  -H "x-mica-owner: ${BROWSER_OWNER_ENV_FALLBACK}"`];
  const body = sampleBody(Array.isArray(endpoint?.params) ? endpoint.params : []);
  if (Object.keys(body).length > 0) {
    lines.push('  -H "content-type: application/json"');
    lines.push(`  -d '${JSON.stringify(body)}'`);
  }
  return lines.join(' \\\n');
}

/** 环境变量的说明文案：服务地址来自 `url`，归属来自 `owner`。 */
export function browserEnvHint(envVars: { url?: string; owner?: string } | null | undefined): string {
  const url = envVars?.url || BROWSER_URL_ENV_FALLBACK.slice(1);
  const owner = envVars?.owner || BROWSER_OWNER_ENV_FALLBACK.slice(1);
  return `agent 用 $${url} 拿服务地址、用 $${owner} 认领归属（curl 时加 -H "x-mica-owner: $${owner}"）。`;
}
