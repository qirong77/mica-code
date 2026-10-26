import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  TOOLTIP_CLOSE_DELAY_MS,
  TOOLTIP_OPEN_DELAY_MS,
  shouldShowTooltip,
  tooltipLayout
} from './chat-tooltip'

/**
 * 悬停浮层：折叠起来的长消息，停一下鼠标就展开全文。
 *
 * 不用原生 `title`：它有 1 秒左右的延迟、无样式、长文本被压成一行且常常截断，
 * 滚不动也选不中——正好是「想看折叠掉的那部分」最需要的两件事。
 *
 * 浮层挂到 body（消息所在的滚动容器有 overflow，留在原地会被裁掉），位置由
 * `chat-tooltip.js` 的纯函数算好；浮层自己可滚动，鼠标移进去不收起。
 */
export function useChatTooltip({ text, enabled = true, anchorRef }) {
  const tooltipId = useId()
  const tooltipRef = useRef(null)
  const timersRef = useRef({ open: 0, close: 0 })
  const [layout, setLayout] = useState(null)

  const clearTimer = useCallback((kind) => {
    if (kind !== 'close') window.clearTimeout(timersRef.current.open)
    if (kind !== 'open') window.clearTimeout(timersRef.current.close)
  }, [])

  const hide = useCallback(() => {
    clearTimer()
    setLayout(null)
  }, [clearTimer])

  const open = useCallback(() => {
    const anchor = anchorRef?.current
    if (!anchor) return
    const next = tooltipLayout({
      anchorRect: anchor.getBoundingClientRect(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    })
    if (next) setLayout(next)
  }, [anchorRef])

  const scheduleOpen = useCallback(() => {
    window.clearTimeout(timersRef.current.close)
    window.clearTimeout(timersRef.current.open)
    timersRef.current.open = window.setTimeout(open, TOOLTIP_OPEN_DELAY_MS)
  }, [open])

  const scheduleClose = useCallback(() => {
    window.clearTimeout(timersRef.current.open)
    window.clearTimeout(timersRef.current.close)
    timersRef.current.close = window.setTimeout(() => setLayout(null), TOOLTIP_CLOSE_DELAY_MS)
  }, [])

  useEffect(() => {
    if (!enabled) hide()
  }, [enabled, hide])

  useEffect(
    () => () => {
      window.clearTimeout(timersRef.current.open)
      window.clearTimeout(timersRef.current.close)
    },
    []
  )

  // 打开期间只要位置可能失效就收起：滚动、改窗口大小、Esc、点别处。
  // 浮层内部的滚动不算——那是用户在读被折掉的部分。
  useEffect(() => {
    if (!layout) return undefined
    const onScroll = (event) => {
      const target = event.target
      if (tooltipRef.current && target instanceof Node && tooltipRef.current.contains(target)) {
        return
      }
      hide()
    }
    const onResize = () => hide()
    const onKeyDown = (event) => {
      if (event.key === 'Escape') hide()
    }
    const onPointerDown = (event) => {
      if (tooltipRef.current?.contains(event.target)) return
      if (anchorRef?.current?.contains(event.target)) return
      hide()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [layout, hide, anchorRef])

  const anchorProps = useMemo(
    () => ({
      onPointerEnter: (event) => {
        if (event.buttons) return
        if (!shouldShowTooltip({ enabled, pointerType: event.pointerType, text })) return
        scheduleOpen()
      },
      onPointerLeave: () => scheduleClose(),
      // 按下就开始选文本 / 准备双击编辑：浮层必须让位。
      onPointerDown: () => {
        if (layout) hide()
        else window.clearTimeout(timersRef.current.open)
      },
      'aria-describedby': layout ? tooltipId : undefined
    }),
    [enabled, text, layout, hide, scheduleOpen, scheduleClose, tooltipId]
  )

  const tooltip = layout
    ? createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className={`chat-tooltip chat-tooltip-${layout.placement}`}
          style={{
            left: layout.left,
            width: layout.width,
            maxHeight: layout.maxHeight,
            ...(layout.top != null ? { top: layout.top } : { bottom: layout.bottom })
          }}
          onPointerEnter={() => window.clearTimeout(timersRef.current.close)}
          onPointerLeave={scheduleClose}
        >
          <div className="chat-tooltip-body">{text}</div>
        </div>,
        document.body
      )
    : null

  return { anchorProps, tooltip }
}
