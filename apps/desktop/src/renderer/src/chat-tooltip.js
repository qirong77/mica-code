/**
 * 长消息折叠态悬停浮层的定位规则。
 *
 * 纯计算：调用方把锚点的 `getBoundingClientRect()` 与视口尺寸传进来，
 * 返回可直接摊到 `style` 上的位置。浮层**不量自身高度**——内容长度差得太多，
 * 量完再定位会闪；向上摆时改用 `bottom` 锚定，浮层自然向上生长。
 */

/** 悬停多久才弹：路过时不弹，停住看才弹。 */
export const TOOLTIP_OPEN_DELAY_MS = 320
/** 离开锚点 / 浮层后多久收起：留出跨过两者之间 6px 间隙的时间。 */
export const TOOLTIP_CLOSE_DELAY_MS = 160
/** 浮层与锚点之间的空隙。 */
export const TOOLTIP_GAP = 6
/** 浮层与视口边缘至少留出的距离。 */
export const TOOLTIP_MARGIN = 8
export const TOOLTIP_MAX_HEIGHT = 420
export const TOOLTIP_MAX_WIDTH = 640
export const TOOLTIP_MIN_WIDTH = 240
/** 下方放不下时以这个空间为界改摆上方。 */
const TOOLTIP_PREFER_BELOW = 160

/**
 * 触屏没有悬停，长按也不该弹一个盖住消息的浮层；空文本没有可展示的内容。
 */
export function shouldShowTooltip({ enabled = true, pointerType, text } = {}) {
  if (!enabled) return false
  if (pointerType === 'touch') return false
  return String(text ?? '').trim().length > 0
}

/**
 * 浮层位置：优先摆在锚点下方并与内容左对齐，下方空间不足时摆上方；
 * 宽度跟随锚点（上限 640），左右都收在视口内。
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

  const availableWidth = Math.max(TOOLTIP_MIN_WIDTH, width - TOOLTIP_MARGIN * 2)
  const boxWidth = Math.round(
    Math.max(TOOLTIP_MIN_WIDTH, Math.min(anchorRect.width, TOOLTIP_MAX_WIDTH, availableWidth))
  )
  const left = Math.round(
    Math.max(TOOLTIP_MARGIN, Math.min(anchorRect.left, width - boxWidth - TOOLTIP_MARGIN))
  )

  return {
    placement,
    left,
    width: boxWidth,
    maxHeight: Math.round(Math.max(96, Math.min(maxHeight, available))),
    ...(placement === 'below'
      ? { top: Math.round(anchorRect.bottom + TOOLTIP_GAP) }
      : { bottom: Math.round(height - anchorRect.top + TOOLTIP_GAP) })
  }
}
