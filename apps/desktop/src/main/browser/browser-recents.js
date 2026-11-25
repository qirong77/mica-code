/**
 * 「最近访问」的数据与浮层几何。
 *
 * 这里只有纯函数（不 import electron）：窗口怎么摆、哪些地址值得记、输入什么就筛出什么，
 * 都能直接喂数字断言。数据本身按**会话（owner）**存，活在主进程内存里——受控浏览器窗口
 * 本来就是临时现场（闲置 30 分钟回收），把地址簿落盘等于给这个能力加一份新的持久状态，
 * 不值得；同一个会话开着的多个窗口共用一份，关掉窗口也不会丢。
 */

import { isRecentUrl } from '@packages/mica-web-shared'
import { CHROME_HEIGHT } from './browser-core.js'

/** 一个会话最多记多少条：超过就丢最旧的。 */
export const RECENT_LIMIT = 50
/**
 * 浮层每行高度（px）。这是组件库 `.mica-menu-item.arco-btn` 的高度：浮层里用的就是
 * 设置页那套菜单（`MenuList` / `MenuItem`），行高由组件库决定，这里只跟着它算窗口大小。
 */
export const RECENT_ROW_HEIGHT = 32
/**
 * 浮层除列表以外的固定高度（px）：菜单上下内边距 6 + 6，加 1px 下边框。
 * 上边不留边框——浮层紧贴顶栏下沿，那条线由顶栏自己的分隔线画。
 */
export const RECENT_PAD = 13
/** 一屏最多显示几行，超出的在浮层里滚动。 */
export const RECENT_MAX_ROWS = 8
/** 地址框的宽度拿不到时（`anchor` 缺失）退回的宽度。正常情况一律与地址框同宽。 */
export const RECENT_MIN_WIDTH = 320
const TITLE_MAX = 120

/**
 * 浮层窗口的选项。单独拎出来是为了能被断言：这几项决定它看起来是不是「连在地址栏下面
 * 的一条」，而不是一张飘着的小卡片。
 *
 * - `roundedCorners: false`：macOS 默认给无边框窗口裁圆角，裁剪发生在窗口层，CSS 的
 *   `border-radius: 0` 压不掉——上沿会被裁成圆的，看起来就跟地址栏断开了。
 * - `hasShadow: true`：菜单要有投影才看得出来是浮在网页之上。窗口与菜单同尺寸，所以系统
 *   画的是菜单自己的影子（跟着页面里的圆角走）；上沿紧贴顶栏，那一侧的影子会被窗口边界
 *   裁掉，不会糊到顶栏上，看起来就是「从地址栏底下长出来的一条」。
 * - macOS 的 `type: 'panel'`：跟着父窗口走、不参与应用切换。
 */
export function recentWindowOptions({ platform = process.platform } = {}) {
  return {
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: false,
    ...(platform === 'darwin' ? { type: 'panel' } : {})
  }
}

/**
 * 记一次访问：同一个地址只留一条，重复访问把它挪到最前面（并刷新标题与时间）。
 * 返回新数组，不原地改——调用方拿它去比较/推送。
 */
export function pushRecent(
  list,
  { url = '', title = '', favicon = '' } = {},
  { at = Date.now(), limit = RECENT_LIMIT } = {}
) {
  const target = String(url || '').trim()
  if (!isRecentUrl(target)) return Array.isArray(list) ? list : []
  const previous = (Array.isArray(list) ? list : []).find((item) => item && item.url === target)
  const entry = {
    url: target,
    title: String(title || '').trim().slice(0, TITLE_MAX),
    // 图标通常比这一次访问晚到（页面先报地址、后报图标）。这一次没带图标就沿用已有的，
    // 不然每刷新一次页面都会先把图标清空一遍。
    favicon: keepFavicon(favicon, previous?.favicon),
    at
  }
  const rest = (Array.isArray(list) ? list : []).filter((item) => item && item.url !== target)
  return [entry, ...rest].slice(0, Math.max(1, limit))
}

/** 图标只能是内联的 `data:image/*`：浮层页的 CSP 不放行远程图片。 */
export function isFaviconDataUrl(value) {
  return typeof value === 'string' && /^data:image\//i.test(value)
}

/** 这一次带来的图标优先；没有就沿用同一个地址上一次记下的那个。 */
function keepFavicon(next, previous) {
  if (isFaviconDataUrl(next)) return next
  return isFaviconDataUrl(previous) ? previous : ''
}

/**
 * `page-favicon-updated` 一次给一串候选（16/32/180px、svg…）。挑一个能直接用的：
 * 优先页面自己内联的 `data:` 图标（不必再发一次请求），否则第一个 http(s) 地址。
 * 页面里写的可能是 `/static/favicon.ico` 这种相对地址，按 `base`（当前页地址）补全。
 */
export function pickFaviconSource(favicons, base = '') {
  const values = (Array.isArray(favicons) ? favicons : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
  const inline = values.find((value) => isFaviconDataUrl(value))
  if (inline) return inline
  for (const value of values) {
    const resolved = resolveFaviconUrl(value, base)
    if (resolved) return resolved
  }
  return ''
}

function resolveFaviconUrl(value, base) {
  if (/^https?:\/\//i.test(value)) return value
  try {
    const url = new URL(value, base || undefined)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

/**
 * 浮层窗口的屏幕坐标。
 *
 * - `anchor`：地址框在页面里的矩形（页面 CSS px，原点在页面左上角）
 * - `content`：浏览器窗口的内容区（`win.getContentBounds()`，屏幕 DIP）
 * - `zoom`：页面的缩放倍数（`webContents.getZoomFactor()`）
 *
 * 窗口宽度**等于地址框在屏幕上的宽度**（用户要的是从地址栏底下长出来的一条，宽窄跟它
 * 一致），左边缘与上边缘分别对齐地址框与顶栏下沿——不做任何「往屏幕里收」的裁剪：地址框
 * 本来就在用户眼前，把它挪到别处只会让列表和地址栏错开。
 *
 * `zoom` 不能省：Chromium 会按 host 记住 zoomLevel（比如 127.0.0.1 上残留一条 0.5，页面就
 * 比窗口坐标大 1.095 倍），此时页面里的 CSS px 与窗口坐标（DIP）不是一个单位。不换算的话
 * 浮层会窄一圈、并整体向左偏——这正是「下拉跟地址栏对不上」的成因。
 */
export function recentBounds({ anchor, content, rows, zoom } = {}) {
  const box = content || { x: 0, y: 0, width: 0, height: 0 }
  const bar = anchor || { left: 0, top: 0, width: 0, height: 0 }
  const scale = Number(zoom) > 0 ? Number(zoom) : 1
  const count = Math.max(1, Math.min(Number(rows) || 0, RECENT_MAX_ROWS))
  return {
    x: Math.round(box.x + (Number(bar.left) || 0) * scale),
    // 紧贴顶栏下沿：列表看起来是从地址栏长出来的，而不是浮在下面的一张卡片
    y: Math.round(box.y + CHROME_HEIGHT * scale),
    // 与地址框同宽；地址框宽度拿不到（没有 anchor）时才退回兜底宽度
    width: Math.round((Number(bar.width) || 0) * scale) || RECENT_MIN_WIDTH,
    // 向上取整：窗口比内容矮半像素就会让菜单出现滚动条
    height: Math.ceil((count * RECENT_ROW_HEIGHT + RECENT_PAD) * scale)
  }
}
