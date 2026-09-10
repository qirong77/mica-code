import { useCallback, useEffect, useRef, useState } from 'react'

/** 移动端断点：< 768px 时 shell 从三栏网格切换为单栏 + 抽屉 */
export const MOBILE_QUERY = '(max-width: 767px)'

/** `?layout=mobile` / `?layout=desktop` 可强制布局，便于在大屏上预览紧凑布局 */
function forcedMobileLayout() {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get('layout')
  if (value === 'mobile') return true
  if (value === 'desktop') return false
  return null
}

export function useIsMobile() {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches
  )
  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY)
    const onChange = (event) => setMobile(event.matches)
    setMobile(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  const forced = forcedMobileLayout()
  return forced === null ? mobile : forced
}

/**
 * 触屏长按等价于右键：只在非鼠标指针下生效，桌面端的右键菜单行为完全不受影响。
 *
 * 计时器挂在元素上（WeakMap）而不是组件 state，因此可以在列表的 render 函数里
 * 按行直接创建，不必为每个节点单独包一个组件。
 */
const longPressTimers = new WeakMap()
const longPressOrigins = new WeakMap()

export function longPressHandlers(onLongPress, { delay = 450, moveThreshold = 12 } = {}) {
  if (!onLongPress) return {}

  const cancel = (event) => {
    const target = event.currentTarget
    const timer = longPressTimers.get(target)
    if (timer) {
      clearTimeout(timer)
      longPressTimers.delete(target)
    }
  }

  return {
    onPointerDown(event) {
      if (event.pointerType === 'mouse') return
      const target = event.currentTarget
      cancel(event)
      longPressOrigins.set(target, { x: event.clientX, y: event.clientY })
      longPressTimers.set(
        target,
        setTimeout(() => {
          longPressTimers.delete(target)
          onLongPress(event)
        }, delay)
      )
    },
    onPointerMove(event) {
      const origin = longPressOrigins.get(event.currentTarget)
      if (!origin || !longPressTimers.has(event.currentTarget)) return
      if (
        Math.abs(event.clientX - origin.x) > moveThreshold ||
        Math.abs(event.clientY - origin.y) > moveThreshold
      ) {
        cancel(event)
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onDragStart: cancel
  }
}

export function useLatest(value) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

export function usePaneWidth({ storageKey, initial, min, minRight, containerRef, onLayout }) {
  const saved = Number(localStorage.getItem(storageKey))
  const [width, setWidth] = useState(Number.isFinite(saved) && saved > 0 ? saved : initial)
  const [resizing, setResizing] = useState(false)

  const clamp = useCallback(
    (value) => {
      const available = containerRef.current?.clientWidth || value + minRight
      return Math.round(Math.min(Math.max(value, min), Math.max(min, available - minRight)))
    },
    [containerRef, min, minRight]
  )

  const resize = useCallback(
    (clientX, persist = false) => {
      const left = containerRef.current?.getBoundingClientRect().left || 0
      const next = clamp(clientX - left)
      setWidth(next)
      if (persist) localStorage.setItem(storageKey, String(next))
      requestAnimationFrame(() => onLayout?.())
    },
    [clamp, containerRef, onLayout, storageKey]
  )

  useEffect(() => {
    if (!resizing) return undefined
    document.body.classList.add('is-resizing')
    return () => document.body.classList.remove('is-resizing')
  }, [resizing])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    const observer = new ResizeObserver(() => setWidth((current) => clamp(current)))
    observer.observe(container)
    return () => observer.disconnect()
  }, [clamp, containerRef])

  const separatorProps = {
    'data-resizing': resizing,
    onPointerDown(event) {
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      setResizing(true)
    },
    onPointerMove(event) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX)
    },
    onPointerUp(event) {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
      resize(event.clientX, true)
      event.currentTarget.releasePointerCapture(event.pointerId)
      setResizing(false)
    },
    onPointerCancel(event) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      setResizing(false)
    },
    onDoubleClick() {
      setWidth(initial)
      localStorage.setItem(storageKey, String(initial))
      requestAnimationFrame(() => onLayout?.())
    },
    onKeyDown(event) {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      const next = clamp(width + (event.key === 'ArrowLeft' ? -16 : 16))
      setWidth(next)
      localStorage.setItem(storageKey, String(next))
      requestAnimationFrame(() => onLayout?.())
    }
  }

  return { width: clamp(width), separatorProps }
}
