import type {
  ConfigWebBrowserControlDetails,
  ConfigWebBrowserControlEndpoint,
  ConfigWebBrowserControlEndpointParam,
} from '../src/shared/types.js';

/**
 * 配置页「Browser Control」一节的纯逻辑：技能文档、接口分组与 curl 示例。
 *
 * 受控浏览器活在桌面运行时里（窗口在 Electron 主进程、运行时经本机 HTTP 服务读写，见
 * `apps/desktop/src/host/browser-control.js`），页面只是把详情读出来展示（**不管窗口**：
 * 开、显示、隐藏、关闭都由 agent 调接口或顶栏图标完成）。这里不碰数据源，只把详情翻译成
 * 界面文案 —— 与 `autoCompact.ts` 同一条边界：能测的判断都抽出来，组件里只接线。
 */

/** 没有服务地址时，示例里用环境变量占位，agent 拿到手就是可移植的一份。 */
export const BROWSER_URL_ENV_FALLBACK = '$MICA_BROWSER_URL';
export const BROWSER_OWNER_ENV_FALLBACK = '$MICA_BROWSER_OWNER';

/** 宿主拿不到受控浏览器数据时的说明（既可能是非桌面宿主，也可能是应用里的服务没起来）。 */
export const BROWSER_CONTROL_DISABLED_REASON = '当前页面读不到受控浏览器服务：它由 Mica Code 桌面应用的主进程提供。';

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
  '打开 Mica Code 桌面应用，再从这里进入「Browser Control」：会显示服务状态、写给 agent 的技能文档与完整接口文档。',
];

/**
 * 技能文档这一节要说明的「谁是源头」：页面显示的是应用**生成**的那一份，用户目录里的
 * `SKILL.md` 只是它落到磁盘的副本。要改文档就改应用里的源头（`browser-docs.js`），
 * 改副本会被下次启动覆盖 —— 否则同一份文档会分叉成两份。
 */
export const SKILL_SOURCE_NOTE =
  '下面这份文档由应用生成，启动时同步写入上面的技能文件。要改它请改应用里的源头（apps/desktop/src/main/browser/browser-docs.js），改用户目录里的副本会被下次启动覆盖。';

/** 方法分组的固定顺序：常见的读/写在前，其余按字母排。 */
export const BROWSER_METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function methodOf(endpoint: ConfigWebBrowserControlEndpoint | null | undefined): string {
  const method = typeof endpoint?.method === 'string' ? endpoint.method.trim().toUpperCase() : '';
  return method || 'GET';
}

/**
 * 技能文档全文（页面要能完整看到它，而不是只看到一个路径）。
 *
 * 读磁盘上的副本没有意义：那份是应用写出去的，`details.skillMarkdown` 已经是生成结果。
 * 缺失（服务没起来）时给空串，由页面显示「未开启」而不是显示一段空白。
 */
export function skillMarkdownOf(details: ConfigWebBrowserControlDetails | null | undefined): string {
  const markdown = details?.skillMarkdown;
  return typeof markdown === 'string' ? markdown.trim() : '';
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
