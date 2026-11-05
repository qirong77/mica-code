import { useCallback, useLayoutEffect, useRef, useState } from 'react'

// 主阅读列至少约 760px，右侧过程栏至少 340px，再留出分隔与边距。
const PROCESS_SIDEBAR_MIN_WIDTH = 1120

export function turnLogVisible({ roundCount, running, hasPlan, canSidebar, interrupted }) {
  return Boolean((roundCount > 0 || running || hasPlan) && (running || canSidebar || (interrupted && roundCount > 0)))
}

export function useProcessLayout({ running, hasActivity, hasPlan }) {
  const layoutRef = useRef(null)
  const [processRoom, setProcessRoom] = useState(false)
  const [processAtBottom, setProcessAtBottom] = useState(false)
  const toggleProcessPlacement = useCallback(() => setProcessAtBottom((value) => !value), [])

  // 量实际内容宽度：侧栏、BTW 抽屉让出的空间已经扣掉，不按整个窗口猜。
  useLayoutEffect(() => {
    const layout = layoutRef.current
    if (!layout || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      // 缓存会话隐藏时宽度为 0，保留布局选择，重新显示后再测。
      if (entry.contentRect.width > 0) {
        setProcessRoom(entry.contentRect.width >= PROCESS_SIDEBAR_MIN_WIDTH)
      }
    })
    observer.observe(layout)
    return () => observer.disconnect()
  }, [])

  return {
    layoutRef,
    processRoom,
    processSidebar: processRoom && !processAtBottom && (running || hasActivity || hasPlan),
    toggleProcessPlacement
  }
}
