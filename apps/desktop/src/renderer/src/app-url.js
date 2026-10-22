/**
 * 地址栏里的应用状态。
 *
 * 页面就是「某台运行时上的一个应用」，所以「正在看哪个会话」这类状态本来就该能落在 URL 上：
 * 刷新、复制地址、换台设备打开都能回到同一个会话。
 *
 * 分享链接就是「带一个会话 id 的地址」：它不做权限判断，打开的人拿到的是**和分享者一样
 * 的完整客户端**（同一个运行时、同一份状态、同一批终端），只是从这条会话开始看。
 *
 * 这里只做纯字符串处理，读写 `window.location` 的接线在 App.jsx。
 */

export const SESSION_PARAM = 'session'

/**
 * 独立文件窗口的页面：顶栏的文件夹按钮把文件视图开成一个**只有文件树与编辑器**的窗口
 * （见 `detachedFilesUrl`），主窗口因此留在对话里。运行时上它挂在 `/files`，dev 下页面
 * 由 Vite 直接提供、走 `/files.html`；两者是同一个入口（`files-window.jsx`）。
 */
export const FILES_PAGE_PATH = '/files'
export const FILES_PAGE_FILE = '/files.html'

/** 独立窗口要显示哪个目录。 */
export const CWD_PARAM = 'cwd'

/** 从 `window.location.search` 读出页面级状态；参数缺失或非法一律回落默认值。 */
export function readAppUrl(search) {
  const params = new URLSearchParams(String(search || ''))
  const sessionId = (params.get(SESSION_PARAM) || '').trim()
  return { sessionId: sessionId || null }
}

/** 文件窗口的地址参数：要显示的工作目录（缺省为空，由页面自己提示选一个会话）。 */
export function readFilesUrl(search) {
  const params = new URLSearchParams(String(search || ''))
  return { cwd: (params.get(CWD_PARAM) || '').trim() || null }
}

function parseUrl(href) {
  try {
    return new URL(String(href))
  } catch {
    return null
  }
}

/**
 * 当前地址 + 新状态：只动 session 参数，其余（`?layout=` 之类）原样保留——
 * 那些是页面自己的调试开关，不该因为切换会话被顺手抹掉。
 * `sessionId` 为空表示「没有打开的会话」，把这个参数删掉。
 */
export function urlWithState(href, { sessionId = null } = {}) {
  const url = parseUrl(href)
  if (!url) return null
  if (sessionId) url.searchParams.set(SESSION_PARAM, sessionId)
  else url.searchParams.delete(SESSION_PARAM)
  return url.toString()
}

/**
 * 独立文件窗口的地址：同一个 origin 上的文件页（dev 是 `files.html`，运行时是 `/files`），
 * 带上要显示的目录。目录放在查询串里，窗口刷新后仍然打开同一个目录；没有目录时也开得出来，
 * 页面会提示先选一个会话。
 *
 * 不能用 `location.href` 直接换参数：那是主应用页面，另开出来的窗口会连左栏一起带上。
 */
export function detachedFilesUrl(href, cwd) {
  const url = parseUrl(href)
  if (!url) return null
  // dev 下主页面是 Vite 的 `/index.html`，独立页也得走 `/files.html`；运行时是 `/files`。
  const dev = url.pathname.toLowerCase().endsWith('.html')
  url.pathname = dev ? FILES_PAGE_FILE : FILES_PAGE_PATH
  url.search = ''
  url.hash = ''
  const dir = String(cwd || '').trim()
  if (dir) url.searchParams.set(CWD_PARAM, dir)
  return url.toString()
}

/**
 * 发给别人的分享地址：**必须落在对方能到达的地址上**。
 *
 * `baseUrl` 由运行时给出（网卡上的局域网地址，或配置的公网地址），不能用页面自己的
 * `location.origin`——本机窗口的 origin 是 `127.0.0.1`，对方点开连的是他自己的机器。
 * 地址里只有会话 id：对方打开后看到的是同一个运行时上的同一个界面（左中右面板都在），
 * 只是从这个会话开始看。
 */
export function sessionShareUrl(baseUrl, sessionId) {
  if (!sessionId) return null
  const url = parseUrl(baseUrl)
  if (!url) return null
  url.search = ''
  url.searchParams.set(SESSION_PARAM, sessionId)
  url.hash = ''
  return url.toString()
}
