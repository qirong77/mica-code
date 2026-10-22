/**
 * 受控浏览器的纯逻辑：状态投影、owner 解析、cookie 归一化、路由编译、按键映射。
 *
 * 这里刻意不 import electron —— 主进程的窗口/视图部分在 browser-manager.js，这里只放
 * 「不需要 Electron 就能算出来」的部分，好让 bun test 直接覆盖（含路由与请求契约）。
 */

import { join } from 'node:path'
import {
  OWNER_HEADER,
  compileRoutes,
  matchPath,
  normalizeOwner,
  parseBoolean,
  resolveOwner,
  resolveRoute
} from '../shared/endpoint-http.js'

// 路由、归属头与布尔解析与终端控制共用一份实现（见 shared/endpoint-http.js）
export {
  OWNER_HEADER,
  compileRoutes,
  matchPath,
  normalizeOwner,
  parseBoolean,
  resolveOwner,
  resolveRoute
}

export const BROWSER_PARTITION = 'persist:mica-browser'

/**
 * 让「被遮挡」的窗口照常出帧的启动开关。
 *
 * 受控浏览器的窗口默认是隐藏的，而 Chromium 把隐藏/被遮挡的窗口当后台窗口：页面里
 * `requestAnimationFrame` 完全不触发（实测 4 秒 0 次）、`document.visibilityState`
 * 停在 `hidden`。于是靠 rAF 推进的页面（图表、canvas、部分虚拟列表）整页冻结，按可见性
 * 自暂停的 SPA 也主动停下 —— 截图只能拿到冻结前的那一帧。
 *
 * 只有这个开关能解（视图级 `backgroundThrottling: false` 只解定时器节流，rAF 依旧 0；
 * `Page.startScreencast` / `Emulation.setVirtualTimePolicy` / `disable-renderer-backgrounding`
 * / `CalculateNativeWinOcclusion` 都无效）。代价是隐藏窗口持续渲染，见 `browserUnthrottleEnabled`。
 */
export const BROWSER_UNTHROTTLE_SWITCH = 'disable-backgrounding-occluded-windows'

/**
 * Cookie 缓存文件名：按作用域域名派生（`:` → `_`），好让别的进程直接 `cat`。
 * 同一台机器上多个后端（osim000 / osim108 / pre…）各写各的文件，不会互相覆盖。
 */
export function cookieCacheKey(url) {
  let host = ''
  try {
    host = new URL(normalizeUrl(url)).host
  } catch {
    host = ''
  }
  return host.replace(/[^a-zA-Z0-9._-]/g, '_') || 'unknown'
}

/** 缓存写成一对文件：`.txt` 是可直接塞进请求头的 Cookie 头，`.json` 留明细（含过期时间）。 */
export function cookieCachePaths(cacheDir, url) {
  const key = cookieCacheKey(url)
  return {
    key,
    headerPath: join(cacheDir, `${key}.txt`),
    jsonPath: join(cacheDir, `${key}.json`)
  }
}

/** 请求级错误：HTTP 层据此决定状态码（400 参数/状态问题、404 找不到、504 超时） */
export class BrowserRequestError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'BrowserRequestError'
    this.status = status
  }
}

export function notFoundError(message) {
  return new BrowserRequestError(message, 404)
}

export function timeoutError(message) {
  return new BrowserRequestError(message, 504)
}
/** chrome 条（标签 + 只读地址）的高度，视图从它下面开始 */
export const CHROME_HEIGHT = 38
export const DEFAULT_BROWSER_SIZE = { width: 1180, height: 800 }
const TITLE_MAX = 200
const URL_MAX = 2048

function text(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/** 没有协议时按 https 补全：agent 更常直接给 `example.com/path` */
export function normalizeUrl(value) {
  const raw = text(value, URL_MAX)
  if (!raw) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw
  if (raw.startsWith('//')) return `https:${raw}`
  return `https://${raw}`
}

export function normalizeLabel(value, fallback = '受控浏览器') {
  return text(value, 60) || fallback
}

/**
 * 是否让隐藏窗口照常渲染。默认开：受控浏览器的全部意义就是让 agent 看到真实页面，
 * 截到冻结的旧帧等于功能失效。`MICA_BROWSER_UNTHROTTLE=0`（或 false/no/off）关掉，
 * 省下隐藏窗口持续渲染的 CPU —— 代价是上面那段注释里的旧帧问题会回来。
 */
export function browserUnthrottleEnabled(env = {}) {
  return parseBoolean(env.MICA_BROWSER_UNTHROTTLE) !== false
}

/**
 * 把开关挂到 Electron 的 commandLine 上（必须在 app ready 之前调用，晚一点就不生效）。
 * 收成一个函数是为了能单测「默认挂、显式关时不挂」，而不是散在 index.js 里。
 * 返回是否真的挂上了。
 */
export function applyBrowserRenderSwitch(commandLine, env = {}) {
  if (!browserUnthrottleEnabled(env)) return false
  commandLine.appendSwitch(BROWSER_UNTHROTTLE_SWITCH)
  return true
}

/**
 * 操作前是否需要临时把窗口显示出来，返回要恢复的现场（`null` = 窗口本来就在显示面上）。
 *
 * 隐藏窗口没有显示面：`hide()` 之后合成器不再稳定产帧，原生输入事件也会被丢掉。截图轻则
 * 拿到冻结的旧帧，整页截图甚至会一直不返回（实测 20s 超时）；点击/输入只能退回页面内合成。
 * 所以依赖显示面的操作期间先 `showInactive` 露出窗口，做完按这里记下的现场复原 ——
 * 判定与恢复都收成纯函数，好被单测锁住。
 */
export function windowRevealPlan(state = {}) {
  const visible = Boolean(state.visible)
  const minimized = Boolean(state.minimized)
  if (visible && !minimized) return null
  return { visible, minimized }
}

/** 按现场恢复：最小化的还原成最小化，原本隐藏的 hide；原本就可见则什么都不用做 */
export function windowRestoreAction(plan) {
  if (!plan) return null
  if (plan.minimized) return 'minimize'
  return plan.visible ? null : 'hide'
}

/**
 * 临时露出期间要不要把窗口压成透明。
 *
 * 只 `showInactive` 再 `hide` 会让窗口在每次操作时闪一下（截图、点击、输入连着来就是一串闪烁）。
 * 把透明度压到 0 再显示，对 Chromium 来说它仍是「可见窗口」（合成器照常出帧、原生输入照常
 * 生效），对用户则完全看不到。给 `MICA_BROWSER_REVEAL_OPACITY=0` 留了退回开关：设成 0 时
 * 保持旧行为，窗口会真的露出来。
 */
export function windowRevealDimmed(plan, env = {}) {
  if (!plan) return false
  return String(env.MICA_BROWSER_REVEAL_OPACITY ?? '1') !== '0'
}

/**
 * 逻辑可见状态是否需要广播变更。
 *
 * 临时露出会把窗口真的显示出来，但那不是用户点出来的「可见」：直接照窗口事件广播会让顶栏
 * 图标跟着每次操作闪一下。这里只在逻辑状态真的变了时才返回事件名。
 */
export function visibilityEventName(logicalVisible, physicalVisible) {
  const next = Boolean(physicalVisible)
  if (next === Boolean(logicalVisible)) return null
  return next ? 'shown' : 'hidden'
}

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** 目录里只需要「这个窗口是谁的、叫什么、现在在哪」，明细留给 getBrowser */
export function browserSummary(record) {
  if (!record) return null
  const active = tabSummary(activeTab(record))
  return {
    id: record.id,
    owner: record.owner || null,
    label: record.label,
    visible: Boolean(record.visible),
    createdAt: record.createdAt || null,
    title: text(active?.title || record.title || '', TITLE_MAX) || '新标签页',
    url: active?.url || '',
    loading: Boolean(active?.loading),
    activeTabId: record.activeTabId || null,
    tabs: (record.tabs || []).map((tab) => tabSummary(tab))
  }
}

export function tabSummary(tab) {
  if (!tab) return null
  return {
    id: tab.id,
    browserId: tab.browserId || null,
    url: tab.url || '',
    title: text(tab.title || '', TITLE_MAX) || tab.url || '新标签页',
    loading: Boolean(tab.loading),
    active: Boolean(tab.active)
  }
}

export function activeTab(record) {
  if (!record) return null
  return (
    (record.tabs || []).find((tab) => tab.id === record.activeTabId) ||
    (record.tabs || [])[0] ||
    null
  )
}

/**
 * Cookie 头按浏览器自己的顺序拼：path 长的在前，这样同名 cookie 不会取到宽 path 那一个
 * （与 Chromium 的发送顺序一致）。`session` 项的过期时间缺省，按创建时间兜底排序。
 */
export function sortCookiesForHeader(cookies) {
  return [...(cookies || [])].sort((left, right) => {
    const pathDelta = String(right.path || '/').length - String(left.path || '/').length
    if (pathDelta !== 0) return pathDelta
    return (left.creationDate || 0) - (right.creationDate || 0)
  })
}

export function formatCookieHeader(cookies) {
  return sortCookiesForHeader(cookies)
    .map((cookie) => `${cookie.name}=${cookie.value ?? ''}`)
    .join('; ')
}

export function publicCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value ?? '',
    domain: cookie.domain || '',
    path: cookie.path || '/',
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    session: Boolean(cookie.session),
    sameSite: cookie.sameSite || 'unspecified',
    hostOnly: Boolean(cookie.hostOnly),
    expirationDate: cookie.expirationDate ?? null
  }
}

/**
 * 一次 evaluate 的返回值：对象照原样 JSON 化（agent 常常直接读 DOM 数据），
 * 函数/undefined 统一成 null，避免 JSON.stringify 把整个响应变成 undefined。
 */
export function serializeEvaluation(value) {
  if (value === undefined) return null
  try {
    JSON.stringify(value)
    return value
  } catch {
    return String(value)
  }
}

const NETWORK_HEADER_DENY =
  /^(cookie|set-cookie|authorization|proxy-authorization|content-length)$/i
const NETWORK_HEADER_MAX = 200

/**
 * 网络记录里保留的请求头：只去掉 Cookie / Authorization 这类又长又敏感的头。
 *
 * 排查「请求到底打给哪个后端」靠的就是 `nuwa-wings: env=osim149-v` 这类自定义头；之前
 * `network` 只留 method/url/status，agent 只能靠「改一个变量再打一次」反推请求头带没带上。
 */
export function pickNetworkHeaders(headers) {
  const picked = {}
  if (!headers || typeof headers !== 'object') return picked
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName || '')
    if (!name || NETWORK_HEADER_DENY.test(name)) continue
    const value = rawValue == null ? '' : String(rawValue)
    picked[name] =
      value.length > NETWORK_HEADER_MAX ? `${value.slice(0, NETWORK_HEADER_MAX)}…` : value
  }
  return picked
}

/**
 * 等待条件：selector / text / url 任一即可；三个都不给表示「等页面加载完成」。
 *
 * 最后这种空条件是有意支持的：agent 想等一次导航结束时，之前只能自己挑一个近似选择器，
 * 挑不到就只能 `sleep` 硬等（既慢又不可靠）。
 */
export function normalizeWaitCondition(input = {}) {
  const selector = text(input.selector, 500)
  const expected = text(input.text, 500)
  const url = text(input.url, URL_MAX)
  return { selector, text: expected, url, ready: !selector && !expected && !url }
}

const NAMED_KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 }
}

/** 键盘映射只覆盖「agent 真的会按」的那些键，其余一律报错而不是猜 */
export function keyDescriptors(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? [input] : []
  if (list.length === 0) throw new Error('keys 需要一个非空数组')
  return list.map((raw) => {
    const name = String(raw || '')
    const named = NAMED_KEYS[name.toLowerCase()]
    if (named) return named
    if (name.length === 1) {
      const code = name.toUpperCase()
      return { key: name, code: /[A-Za-z]/.test(name) ? `Key${code}` : '', text: name }
    }
    throw new Error(`不支持的按键：${name}`)
  })
}

export function truncateOutput(value, max = 200000) {
  const content = typeof value === 'string' ? value : ''
  if (content.length <= max) return { content, truncated: false }
  return { content: content.slice(0, max), truncated: true }
}
