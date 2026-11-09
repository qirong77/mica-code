import { useEffect, useState } from 'react'

/**
 * 可折叠区域：展开与收起都走真实高度过渡。
 *
 * `height: auto` 不能过渡，用 JS 量高度再写 px 会在内容变化或窗口缩放时留下旧值。
 * 这里用 `grid-template-rows: 0fr ↔ 1fr`：浏览器自己解算内容高度，两个方向都成立，
 * 也不需要任何测量（样式见 app.css 的 `.motion-collapse`）。
 *
 * 收起时必须让内容多留一帧动画的时间再卸载，否则收起是瞬间消失。展开方向相反：
 * 新挂上的这一帧必须还是 0fr，下一帧再放开，否则没有起始值可插值、展开也是瞬跳。
 */
export const COLLAPSE_DURATION = 160

export default function Collapse({
  open,
  children,
  className = '',
  duration = COLLAPSE_DURATION
}) {
  // `present` 管挂载，`expanded` 管 0fr/1fr：收起动画播放期间两者不同步。
  const [present, setPresent] = useState(open)
  const [expanded, setExpanded] = useState(open)

  useEffect(() => {
    if (!open) {
      setExpanded(false)
      if (!present) return undefined
      const timer = setTimeout(() => setPresent(false), duration)
      return () => clearTimeout(timer)
    }
    if (!present) {
      setPresent(true)
      return undefined
    }
    const frame = requestAnimationFrame(() => setExpanded(true))
    return () => cancelAnimationFrame(frame)
  }, [open, present, duration])

  if (!present) return null

  return (
    <div
      className={`motion-collapse${expanded ? ' is-expanded' : ''}${
        className ? ` ${className}` : ''
      }`}
      aria-hidden={open ? undefined : 'true'}
    >
      <div className="motion-collapse-clip">
        <div className="motion-collapse-body">{children}</div>
      </div>
    </div>
  )
}
