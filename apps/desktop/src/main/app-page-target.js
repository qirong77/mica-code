/**
 * `window.open` 的目标判定：哪些目标该由外壳开成「应用窗口」，以及重复打开时怎么认出
 * 「同一个窗口」。
 *
 * 页面里需要独立窗口的视图（顶栏的文件夹 → 运行时的 `/files` 页面）走的就是
 * `window.open(自己的 origin + 页面路径)`：外壳把它当成一次「再开一个窗口」（与切换服务器
 * 同一个动作），而不是当成外链丢给系统浏览器。纯逻辑留在这里，`main/index.js` 只用结果。
 */

import { APP_BASE_PATH, FILES_PAGE_PATH } from '@packages/mica-web-shared/app-paths.js'
import { relayTokenOf } from '@packages/mica-web-shared/runtime-address.js'

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
 * 页面身份：剥掉 `/mica-web` 这类服务前缀与 dev 的 `.html` 后缀，`index.html` 就是根，
 * 于是「同一个页面」在 dev（`/files.html`）与运行时（`/files`）里是同一个值。
 */
export function appPagePath(value) {
  let path = pathnameOf(value)
  for (const base of [APP_BASE_PATH]) {
    if (path === base) path = '/'
    else if (path.startsWith(`${base}/`)) path = path.slice(base.length)
  }
  if (path === '/index.html' || path === '/index') return '/'
  if (path === '/files.html') return FILES_PAGE_PATH
  return path
}

/**
 * 哪些页面可以由页面自己开成窗口。只列「应用页面」：主界面与独立文件窗口。终端控制窗口、
 * `/remote/*` 这些不是页面自己的入口，落到这里只会被当成外链。
 */
export const APP_PAGE_PATHS = ['/', FILES_PAGE_PATH]

/** `target` 是不是 `origins` 里某台运行时上的一个应用页面（查询串不参与判定）。 */
export function isAppPageTarget(target, { origins = [] } = {}) {
  const url = parseUrl(target)
  if (!url) return false
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (!origins.some((origin) => origin && origin === url.origin)) return false
  return APP_PAGE_PATHS.includes(appPagePath(url))
}

/** 同一个窗口的判定键：忽略 hash 与尾部斜杠，查询串参与比较（不同目录是不同的窗口内容）。 */
export function appPageKey(value) {
  const url = parseUrl(value)
  if (!url) return ''
  url.hash = ''
  url.pathname = pathnameOf(url)
  return url.toString()
}

/**
 * 中转机入口的窗口身份：`origin + t`。
 *
 * 一台中转机后面可以接多台机器（每台一个访问口令），只比 origin 会让「点 B 的链接却端出
 * A 的窗口」。同一台机器的不同 `?session=` 仍算同一个窗口，所以只取 `t`。
 * 不是中转机入口（没有 `t`）时返回空串，调用方回落到「按服务器认窗口」。
 */
export function relayEntryKey(value) {
  const token = relayTokenOf(value)
  const url = parseUrl(value)
  return token && url ? `${url.origin}?t=${token}` : ''
}
