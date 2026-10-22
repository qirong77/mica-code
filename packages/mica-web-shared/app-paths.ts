/**
 * 运行时端口上「按路径区分的服务」的地址约定。
 *
 * 桌面运行时**只监听一个端口**（默认 8787），所有能力靠路径区分，谁也不额外占端口：
 *
 * - `/` 与 `/mica-web` —— 完整应用（页面产物）；`/mica-web` 是显式名字，两处内容完全相同
 * - `/share` —— 分享视图：`/share?session=<id>` 打开某条会话，`/share` 本身是分享链接列表
 * - `/terminal-control` —— 终端控制窗口的页面（独立入口 `terminal.html`，窗口由 Electron
 *   主进程创建，页面通过同源 `/remote/terminal/*` 读写真实终端）
 * - `/files` —— 独立文件窗口的页面（独立入口 `files.html`）：只有文件树与编辑器，没有
 *   会话列表；由顶栏的文件夹按钮经 `window.open` 打开，外壳把同源的这个页面开成窗口
 * - `/remote/control/*` —— 受控浏览器（主进程的窗口服务挂在 Unix socket 上，由运行时转发，
 *   见 apps/desktop/src/host/browser-control-proxy.js）
 * - `/api/*` —— 运行时能力（invoke / events / env / image）
 *
 * 放在 mica-web-shared 里是因为**两侧都要用同一份判断**：运行时据此路由，渲染器据此决定
 * 自己是不是分享视图（`shareView`）。两边各写一个字符串迟早会分叉。
 */

/** 应用页面的显式基路径；根路径 `/` 同样可用（外壳与已有链接都从根路径进）。 */
export const APP_BASE_PATH = '/mica-web';

/** 分享视图的基路径。它只是「少画一个侧栏」的呈现差别，不是权限边界。 */
export const SHARE_BASE_PATH = '/share';

/** 终端控制窗口的页面路径：主进程窗口加载运行时上的这个地址。 */
export const TERMINAL_PAGE_PATH = '/terminal-control';

/**
 * 独立文件窗口的页面路径。dev 下页面由 Vite 直接提供（`/files.html`），运行时上走这个
 * 不带扩展名的地址；两者是同一个入口（renderer 的 `files-window.jsx`）。
 */
export const FILES_PAGE_PATH = '/files';

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

/** 是不是独立文件窗口的页面。 */
export function isFilesPagePath(pathname: unknown): boolean {
  return normalizePathname(pathname) === FILES_PAGE_PATH;
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
