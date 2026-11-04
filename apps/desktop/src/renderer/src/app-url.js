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

/** 从 `window.location.search` 读出页面级状态；参数缺失或非法一律回落默认值。 */
export function readAppUrl(search) {
  const params = new URLSearchParams(String(search || ''))
  const sessionId = (params.get(SESSION_PARAM) || '').trim()
  return { sessionId: sessionId || null }
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
