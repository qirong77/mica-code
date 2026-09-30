/**
 * 浮层（tooltip 式）的关闭判定。
 *
 * 输入框上方那几个面板——模型选择、定时任务、自动压缩——的关闭时机必须只有一套规则：
 * 点面板以外的地方、焦点离开面板、按 Esc。这就是「点面板内部也把它关掉」「点自己的按钮
 * 反而关不上」这类分叉的来源，所以判定抽在这里（`Popover.jsx` 的 usePopoverDismiss 只负责
 * 接事件）。
 */

/** 点击非聚焦区域时浏览器会补发一次 focusin：这个时间窗内的焦点变化由点击引起，
 *  外部点击判定已经处理过，不能再按「焦点离开」多关一次。 */
export const POINTER_FOCUS_GRACE_MS = 150

/** 触发按钮自己负责开合（点一下切换），不能被外部点击判定抢先关掉又弹回来。 */
export const POPOVER_TRIGGER_ATTR = 'data-popover-trigger'

/** 触发按钮的选择器：带 `name` 时只认自己那一个，别的面板的按钮照常算「面板外」。 */
export function popoverTriggerSelector(name) {
  return name ? `[${POPOVER_TRIGGER_ATTR}="${name}"]` : `[${POPOVER_TRIGGER_ATTR}]`
}

/** 目标是否落在浮层里（或它的触发按钮里）。 */
export function isInsidePopover(target, { popover, trigger } = {}) {
  if (!target) return false
  // 没给名字时按「任意触发按钮」放行：那种调用方没有第二个面板可以同时打开，
  // 漏放行会让它自己的按钮点不关（先被关掉、点击又打开）。
  if (typeof target.closest === 'function' && target.closest(popoverTriggerSelector(trigger))) {
    return true
  }
  return Boolean(popover?.contains?.(target))
}

/** 这次 focusin 是不是刚刚那次点击的副产物（是的话交给点击路径判定）。 */
export function isPointerDrivenFocusChange({ now, pointerDownAt, grace = POINTER_FOCUS_GRACE_MS }) {
  if (!Number.isFinite(pointerDownAt) || pointerDownAt <= 0) return false
  if (!Number.isFinite(now)) return false
  const elapsed = now - pointerDownAt
  return elapsed >= 0 && elapsed <= grace
}
