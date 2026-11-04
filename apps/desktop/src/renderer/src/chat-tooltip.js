/**
 * 悬停浮层的定位规则。
 *
 * 纯计算：调用方把锚点的 `getBoundingClientRect()` 与视口尺寸传进来，
 * 返回可直接摊到 `style` 上的位置。浮层**不量自身尺寸**——内容长度差得太多，
 * 量完再定位会闪：
 * - 宽度交给 CSS（`width: max-content` + 这里给的 `maxWidth`），一行短说明就是
 *   一小块，长文本才撑到上限；
 * - 高度只给上限，向上摆时用 `bottom` 锚定，浮层自然向上生长。
 */

/** 悬停多久才弹：路过时不弹，停住看才弹。 */
export const TOOLTIP_OPEN_DELAY_MS = 300
/** 离开锚点 / 浮层后多久收起：留出跨过两者之间 8px 间隙的时间。 */
export const TOOLTIP_CLOSE_DELAY_MS = 160
/** 浮层与锚点之间的空隙。 */
export const TOOLTIP_GAP = 8
/** 浮层与视口边缘至少留出的距离。 */
export const TOOLTIP_MARGIN = 12
export const TOOLTIP_MAX_HEIGHT = 440
export const TOOLTIP_MAX_WIDTH = 560
/** 视口窄到极限时浮层也至少要有这么宽（再窄就只剩几个字一行）。 */
const TOOLTIP_MIN_WIDTH = 200
/** 下方至少要有这么高的空间，才优先摆在下方：只放得下一两行时不如摆上方。 */
const TOOLTIP_PREFER_BELOW = 220
/** 哪边都放不下时也不做成比这更矮的滚动框。 */
const TOOLTIP_MIN_HEIGHT = 96

/**
 * 触屏没有悬停，长按也不该弹一个盖住消息的浮层；空文本没有可展示的内容。
 */
export function shouldShowTooltip({ enabled = true, pointerType, text } = {}) {
  if (!enabled) return false
  if (pointerType === 'touch') return false
  return String(text ?? '').trim().length > 0
}

/**
 * 浮层位置：优先摆在锚点下方并与锚点左缘对齐，下方太窄时摆上方；
 * 左右都收在视口内，宽高只给上限，实际大小由内容和 CSS 决定。
 */
export function tooltipLayout({
  anchorRect,
  viewportWidth,
  viewportHeight,
  maxHeight = TOOLTIP_MAX_HEIGHT
} = {}) {
  const width = Number(viewportWidth) || 0
  const height = Number(viewportHeight) || 0
  if (!anchorRect || width <= 0 || height <= 0) return null

  const below = height - anchorRect.bottom - TOOLTIP_GAP - TOOLTIP_MARGIN
  const above = anchorRect.top - TOOLTIP_GAP - TOOLTIP_MARGIN
  const placement =
    below >= Math.min(maxHeight, TOOLTIP_PREFER_BELOW) || below >= above ? 'below' : 'above'
  const available = placement === 'below' ? below : above

  const maxWidth = Math.round(
    Math.min(TOOLTIP_MAX_WIDTH, Math.max(TOOLTIP_MIN_WIDTH, width - TOOLTIP_MARGIN * 2))
  )
  const left = Math.round(
    Math.max(TOOLTIP_MARGIN, Math.min(anchorRect.left, width - maxWidth - TOOLTIP_MARGIN))
  )

  return {
    placement,
    left,
    maxWidth,
    maxHeight: Math.round(Math.max(TOOLTIP_MIN_HEIGHT, Math.min(maxHeight, available))),
    ...(placement === 'below'
      ? { top: Math.round(anchorRect.bottom + TOOLTIP_GAP) }
      : { bottom: Math.round(height - anchorRect.top + TOOLTIP_GAP) })
  }
}
