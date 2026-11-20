/**
 * 回合日志停靠区的全局展开偏好。
 *
 * 这不是当前会话或当前轮次的临时状态：用户手动展开后，所有会话都沿用这个选择。
 * 没有偏好时必须保持收起，运行状态变化不能偷偷改写它。
 */
export const TURN_LOG_OPEN_STATE_KEY = 'turnLogOpen'
export const DEFAULT_TURN_LOG_OPEN = false

export function turnLogContentCollapsed(open) {
  return open !== true
}

export function toggleTurnLogOpen(open) {
  return open !== true
}
