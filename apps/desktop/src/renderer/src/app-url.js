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
 * 主区视图。它平时是「这一屏自己的」界面状态，但独立窗口要靠地址说清自己开的是哪一屏：
 * 顶栏的文件夹按钮把同一个应用页面以 `?view=files` 开成新窗口（`main/index.js` 把同源
 * 页面开成应用窗口），那个窗口刷新后还得停在文件视图。
 */
export const VIEW_PARAM = 'view'

/** 合法的主区视图，与 App.jsx 里 `view` 的取值保持一致。 */
export const APP_VIEWS = ['chat', 'files', 'stats', 'settings']

/** 地址里的 `view` 认得出就返回视图名，认不出返回 null（手写进去的内容不参与渲染）。 */
export function normalizeAppView(value) {
  const text = String(value ?? '').trim()
  return APP_VIEWS.includes(text) ? text : null
}

/** 从 `window.location.search` 读出页面级状态；参数缺失或非法一律回落默认值。 */
export function readAppUrl(search) {
  const params = new URLSearchParams(String(search || ''))
  const sessionId = (params.get(SESSION_PARAM) || '').trim()
  return { sessionId: sessionId || null, view: normalizeAppView(params.get(VIEW_PARAM)) }
}

function parseUrl(href) {
  try {
    return new URL(String(href))
  } catch {
    return null
  }
}

/**
 * 当前地址 + 新状态：只动传进来的那两个参数，其余（`?layout=` 之类）原样保留——
 * 那些是页面自己的调试开关，不该因为切换会话被顺手抹掉。
 * 传 `null` 表示「没有这个状态」，把参数删掉；不传（`undefined`）表示这次不改它。
 */
export function urlWithState(href, { sessionId, view } = {}) {
  const url = parseUrl(href)
  if (!url) return null
  if (sessionId !== undefined) {
    if (sessionId) url.searchParams.set(SESSION_PARAM, sessionId)
    else url.searchParams.delete(SESSION_PARAM)
  }
  if (view !== undefined) {
    if (view) url.searchParams.set(VIEW_PARAM, view)
    else url.searchParams.delete(VIEW_PARAM)
  }
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
