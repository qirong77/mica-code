/**
 * `window.open` 的目标判定：哪些目标该由外壳开成「应用窗口」，以及重复打开时怎么认出
 * 「同一个窗口」。
 *
 * 页面里需要独立窗口的视图（顶栏的文件夹 → 同一个应用页面加 `?view=files`）走的就是
 * `window.open(自己的地址 + 参数)`：外壳把它当成一次「再开一个窗口」（与切换服务器同一个
 * 动作），而不是当成外链丢给系统浏览器。纯逻辑留在这里，`main/index.js` 只用结果。
 */

function parseUrl(value) {
  try {
    return new URL(String(value ?? ''))
  } catch {
    return null
  }
}

/** 折叠重复斜杠、去掉尾部斜杠（根路径除外）；入参可以是完整地址，也可以只是路径。 */
function pathnameOf(value) {
  const url = parseUrl(value)
  const raw = url ? url.pathname : String(value ?? '').trim()
  const collapsed = raw.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return collapsed || '/'
}

/**
 * `target` 是不是 `origins` 里某台运行时上、与 `page` 同一个页面的地址。
 *
 * 只认「同源 + 同一个页面路径」：查询串换成别的（`?view=`、`?session=`）仍旧是同一个
 * 应用页面，而 `/terminal-control`、`/remote/*` 这些别的路径不是——它们不该被开成一个
 * 装着应用界面的窗口。
 */
export function isAppPageTarget(target, { origins = [], page = '/' } = {}) {
  const url = parseUrl(target)
  if (!url) return false
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (!origins.some((origin) => origin && origin === url.origin)) return false
  return pathnameOf(url) === pathnameOf(page)
}

/** 同一个窗口的判定键：忽略 hash 与尾部斜杠，查询串参与比较。 */
export function appPageKey(value) {
  const url = parseUrl(value)
  if (!url) return ''
  url.hash = ''
  url.pathname = pathnameOf(url)
  return url.toString()
}
