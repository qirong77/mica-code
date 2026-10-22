import { useLayoutEffect, useState } from 'react'

/** 面板与窗口边缘之间至少留出的距离（px）。 */
export const QUICK_PICK_MARGIN = 8
/** 面板与触发按钮之间的空隙（px）：贴太近会盖住按钮本身。 */
export const QUICK_PICK_GAP = 6
/** 面板再窄也要留出的宽度 / 再矮也要留出的高度（px）。 */
const MIN_WIDTH = 240
const MIN_HEIGHT = 120

/**
 * 把 quick pick 面板摆到触发按钮的**上方**，让「分支切换」「项目切换」这类
 * 从底栏打开的面板出现在鼠标附近，而不是跑到屏幕顶部居中。
 *
 * - `align: 'start'`：面板左边缘与按钮左边缘对齐（左下角的分支按钮）。
 * - `align: 'end'`：面板右边缘与按钮右边缘对齐（右下角的目录按钮）。
 *
 * 宽高都不写死，而是从按钮到窗口边缘的可用空间倒推：面板始终完整落在视口内，
 * 也不会盖住触发按钮。窗口太小、算不出可用空间时返回 null，调用方退回居中布局。
 */
export function anchoredQuickPickStyle({ rect, viewportWidth, viewportHeight, align = 'start' }) {
  const width = Number(viewportWidth) || 0
  const height = Number(viewportHeight) || 0
  if (!rect || width <= 0 || height <= 0) return null
  const style = {
    bottom: Math.round(Math.max(QUICK_PICK_MARGIN, height - rect.top + QUICK_PICK_GAP)),
    maxHeight: Math.round(Math.max(MIN_HEIGHT, rect.top - QUICK_PICK_GAP - QUICK_PICK_MARGIN))
  }
  if (align === 'end') {
    style.right = Math.round(Math.max(QUICK_PICK_MARGIN, width - rect.right))
    style.maxWidth = Math.round(Math.max(MIN_WIDTH, rect.right - QUICK_PICK_MARGIN))
    return style
  }
  const left = Math.round(Math.max(QUICK_PICK_MARGIN, rect.left))
  style.left = left
  style.maxWidth = Math.round(Math.max(MIN_WIDTH, width - left - QUICK_PICK_MARGIN))
  return style
}

/**
 * 打开期间跟随触发按钮定位：打开时量一次，窗口尺寸变化时重量。
 *
 * 面板只在打开期间存在，底栏本身不随滚动移动，所以不需要滚动/观察者监听；
 * 拿不到 anchor（没有 ref、已卸载）就返回 null，让面板回到默认的居中样式。
 */
export function useQuickPickAnchor(anchorRef, { align = 'start', enabled = true } = {}) {
  const [style, setStyle] = useState(null)
  useLayoutEffect(() => {
    if (!enabled) {
      setStyle(null)
      return undefined
    }
    const measure = () => {
      const anchor = anchorRef?.current
      if (!anchor) {
        setStyle(null)
        return
      }
      setStyle(
        anchoredQuickPickStyle({
          rect: anchor.getBoundingClientRect(),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          align
        })
      )
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [align, anchorRef, enabled])
  return style
}
