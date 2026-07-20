import { useCallback, useEffect, useRef, useState } from 'react'

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
