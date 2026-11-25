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
/** 浮层每行高度（px，与 browser-chrome.css 的 `.recent-item` 一致）。 */
export const RECENT_ROW_HEIGHT = 34
/** 浮层上下内边距（px）。 */
export const RECENT_PAD = 8
/** 一屏最多显示几行，超出的在浮层里滚动。 */
export const RECENT_MAX_ROWS = 8
/** 浮层最小宽度：地址框窄的时候也不至于挤成一条。 */
export const RECENT_MIN_WIDTH = 320
const TITLE_MAX = 120

/**
 * 记一次访问：同一个地址只留一条，重复访问把它挪到最前面（并刷新标题与时间）。
 * 返回新数组，不原地改——调用方拿它去比较/推送。
 */
export function pushRecent(list, { url = '', title = '' } = {}, { at = Date.now(), limit = RECENT_LIMIT } = {}) {
  const target = String(url || '').trim()
  if (!isRecentUrl(target)) return Array.isArray(list) ? list : []
  const entry = {
    url: target,
    title: String(title || '').trim().slice(0, TITLE_MAX),
    at
  }
  const rest = (Array.isArray(list) ? list : []).filter((item) => item && item.url !== target)
  return [entry, ...rest].slice(0, Math.max(1, limit))
}

/**
 * 浮层窗口的屏幕坐标。
 *
 * - `anchor`：地址框在页面里的矩形（CSS px，页面坐标 = 窗口内容坐标）
 * - `content`：浏览器窗口的内容区（`win.getContentBounds()`，屏幕 DIP）
 * - `workArea`：所在显示器的可用区域（没有就退回内容区自己）
 *
 * 窗口宽度至少跟地址框一样，且不窄于 `RECENT_MIN_WIDTH`；右侧放不下就往左收，底部放不下
 * 就翻到顶栏上方——两条都只做「别跑到屏幕外」，不做动画。
 */
export function recentBounds({ anchor, content, rows, workArea } = {}) {
  const box = content || { x: 0, y: 0, width: 0, height: 0 }
  const bar = anchor || { left: 0, top: 0, width: 0, height: 0 }
  const count = Math.max(1, Math.min(Number(rows) || 0, RECENT_MAX_ROWS))
  const area = workArea || box
  const height = count * RECENT_ROW_HEIGHT + RECENT_PAD
  const width = Math.max(
    160,
    Math.min(
      Math.max(Math.round(Number(bar.width) || 0), RECENT_MIN_WIDTH),
      Math.max(160, Math.round(area.width) - 16)
    )
  )
  const minX = Math.round(area.x) + 8
  const maxX = Math.round(area.x + area.width - width - 8)
  const minY = Math.round(area.y) + 8
  const maxY = Math.round(area.y + area.height - height - 8)
  // 紧贴顶栏下沿：列表看起来是从地址栏长出来的，而不是浮在下面的一张卡片
  const below = Math.round(box.y + CHROME_HEIGHT)
  // 向上翻时紧贴顶栏上沿
  const above = Math.round(box.y - height)
  // 优先贴在顶栏下方；下方放不下就翻到上方，上方也放不下就贴屏幕底部（还能滚）
  const y = below <= maxY ? below : above >= minY ? above : Math.min(below, maxY)
  return {
    x: Math.min(maxX, Math.max(minX, Math.round(box.x + (Number(bar.left) || 0)))),
    y: Math.max(minY, Math.min(maxY, y)),
    width,
    height
  }
}
