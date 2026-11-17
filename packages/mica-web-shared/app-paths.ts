/**
 * 运行时端口上「按路径区分的服务」的地址约定。
 *
 * 桌面运行时**只监听一个端口**（默认 8787，常量在 `runtime-port.js`），所有能力靠路径区分，
 * 谁也不额外占端口：
 *
 * - `/` 与 `/mica-web` —— 完整应用（页面产物）；`/mica-web` 是显式名字，两处内容完全相同
 * - `/share` —— 分享视图：`/share?session=<id>` 打开某条会话，`/share` 本身是分享链接列表
 * - `/plugins/pages/<id>` —— 插件整页（清单 `desktop.page`）：一个可独立打开、可复制、
 *   可收藏的地址，页面内容仍是同一份渲染层产物（按路径决定画哪个插件页）
 * - `/terminal-control` —— 终端控制窗口的页面（独立入口 `terminal.html`，窗口由 Electron
 *   主进程创建，页面通过同源 `/remote/terminal/*` 读写真实终端）
 * - `/remote/control/*` —— 受控浏览器（主进程的窗口服务挂在 Unix socket 上，由运行时转发，
 *   见 apps/desktop/src/host/browser-control-proxy.js）
 * - `/mcp/browser`、`/mcp/terminal` —— 两个受控能力给 agent 的 MCP 端点（单 tool，见
 *   apps/desktop/src/host/control-mcp.js）
 * - `/plugin/<id>/mcp` —— 随包插件独立 MCP（命名 helpers 在 mica-plugin/PluginMcp.ts）
 * - `/api/*` —— 运行时能力（invoke / events / env / image）
 *
 * 放在 mica-web-shared 里是因为**两侧都要用同一份判断**：运行时据此路由，渲染器据此决定
 * 自己是不是分享视图（`shareView`）。两边各写一个字符串迟早会分叉。
 */

/** 应用页面的显式基路径；根路径 `/` 同样可用（外壳与已有链接都从根路径进）。 */
export const APP_BASE_PATH = '/mica-web';

/** 分享视图的基路径。它只是「少画一个侧栏」的呈现差别，不是权限边界。 */
export const SHARE_BASE_PATH = '/share';

/** 插件整页的基路径；一篇插件的页面地址是 `/plugins/pages/<插件 id>`。 */
export const PLUGIN_PAGES_BASE_PATH = '/plugins/pages';

/** 终端控制窗口的页面路径：主进程窗口加载运行时上的这个地址。 */
export const TERMINAL_PAGE_PATH = '/terminal-control';

/**
 * 终端服务的代理前缀：主进程的终端服务挂在 Unix socket 上，运行时在 `/remote/terminal`
 * 下转发。端点路径相对这个前缀（`/sessions`、`/events`…），所以 `MICA_TERMINAL_URL`
 * 就等于「运行时地址 + 这个前缀」，页面与 agent 拼出来是同一个地址。
 */
export const TERMINAL_CONTROL_PREFIX = '/remote/terminal';

/** 终端服务的端点地址（`session` 存在时带上订阅参数）。 */
export function terminalControlPath(path = ''): string {
  const suffix = String(path ?? '').trim();
  if (!suffix) return TERMINAL_CONTROL_PREFIX;
  return `${TERMINAL_CONTROL_PREFIX}${suffix.startsWith('/') ? '' : '/'}${suffix}`;
}

/** 折叠重复斜杠、补上前导斜杠、去掉尾部斜杠（根路径除外）。 */
export function normalizePathname(pathname: unknown): string {
  const raw = String(pathname ?? '').trim();
  if (!raw) return '/';
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  const collapsed = withLeading.replace(/\/{2,}/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) return collapsed.replace(/\/+$/, '');
  return collapsed;
}

/** `pathname` 是否落在 `basePath` 下：基路径本身、以及它下面的子路径都算。 */
export function isUnderBasePath(pathname: unknown, basePath: string): boolean {
  const value = normalizePathname(pathname);
  const base = normalizePathname(basePath);
  return value === base || value.startsWith(`${base}/`);
}

/** 是不是分享视图的地址（`/share` 或它下面的子路径）。 */
export function isSharePath(pathname: unknown): boolean {
  return isUnderBasePath(pathname, SHARE_BASE_PATH);
}

/** 是不是终端控制窗口的页面。 */
export function isTerminalPagePath(pathname: unknown): boolean {
  return normalizePathname(pathname) === TERMINAL_PAGE_PATH;
}

/**
 * 插件整页的地址。插件 id 就是清单里的 `id`（`notebook`、`user.foo`），
 * 路径按 URL 段编码，所以带点号 / 下划线的用户插件 id 也能原样往返。
 */
export function pluginPagePath(id: string): string {
  return `${PLUGIN_PAGES_BASE_PATH}/${encodeURIComponent(String(id ?? '').trim())}`;
}

/** 是不是插件整页的地址（只认 `/plugins/pages/<id>` 这一层，不认更深的子路径）。 */
export function isPluginPagePath(pathname: unknown): boolean {
  return readPluginPageId(pathname) !== null;
}

/**
 * 从地址里取出插件 id：`/plugins/pages/notebook?note=…` → `notebook`。
 * 不是插件页、或者 id 形状不合法（可能带路径穿越）时返回 null。
 */
export function readPluginPageId(pathname: unknown): string | null {
  const value = normalizePathname(pathname);
  if (!value.startsWith(`${PLUGIN_PAGES_BASE_PATH}/`)) return null;
  const rest = value.slice(PLUGIN_PAGES_BASE_PATH.length + 1);
  if (!rest || rest.includes('/')) return null;
  let id: string;
  try {
    id = decodeURIComponent(rest);
  } catch {
    return null;
  }
  // 与 mica-plugin 的清单 id 同一套形状：字母数字开头，只含字母数字与 `._-`。
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : null;
}

/** 是不是应用页面（根路径或它下面的子路径，以及 `/mica-web` 这个显式名字）。 */
export function isAppPath(pathname: unknown): boolean {
  const value = normalizePathname(pathname);
  return value === '/' || isUnderBasePath(value, APP_BASE_PATH);
}

/**
 * 把「带服务基路径的地址」换算成静态产物里的路径：`/mica-web/a.js` → `/a.js`、
 * `/share` → `/`。两种基路径都剥掉，其余（`/assets/...` 这类绝对资源地址）原样返回。
 */
export function toAssetPath(pathname: unknown): string {
  const value = normalizePathname(pathname);
  for (const base of [SHARE_BASE_PATH, APP_BASE_PATH]) {
    if (value === base) return '/';
    if (value.startsWith(`${base}/`)) return value.slice(base.length);
  }
  return value;
}
