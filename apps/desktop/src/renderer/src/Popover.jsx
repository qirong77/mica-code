import { useEffect, useRef } from 'react'
import { IconX } from '@tabler/icons-react'
import { isInsidePopover, isPointerDrivenFocusChange } from './popover-dismiss'
import { useLatest } from './hooks'

/**
 * 输入框上方的通用浮层外壳（模型选择、定时任务、自动压缩三处共用）。
 *
 * 存在两个理由：
 * - 尺寸只有一份。三处锚在同一个位置（`.chat-popover` 的右下角），宽度、内边距、标题行高
 *   与动作区都由外壳给，切换面板时框不会左右跳。
 * - 关闭时机只有一份。行为像 tooltip：点浮层以外的地方、焦点离开浮层、按 Esc 都关掉，
 *   见 `usePopoverDismiss`。触发按钮自己负责开合（点一下切换），所以要带
 *   `data-popover-trigger="<name>"`——否则外部点击判定会先把它关掉、点击再打开，
 *   表现为「怎么点都关不掉」。
 *
 * 只负责壳，面板内容（表单、列表）仍由各面板自己写。
 */
export function usePopoverDismiss({ active = true, name, ref, onDismiss }) {
  // onDismiss 通常是内联箭头函数、每次渲染都是新的：直接进 deps 会让监听器在面板里每敲
  // 一个字就重挂一次，还会把下面那个 pointerDownAt 一起重置 —— 点击后紧接着补发的那次
  // focusin 就认不出是「点击引起的」，表现为点面板自己的输入框也把面板关掉。
  const dismissRef = useLatest(onDismiss)
  useEffect(() => {
    if (!active) return undefined
    // 点击会让焦点变化，浏览器随后补一次 focusin；那个 focusin 由点击路径负责，
    // 这里记下点击时刻把它跳过（否则点面板内部的空白区域也会被算成「焦点离开」）。
    let pointerDownAt = 0
    const isInside = (target) => isInsidePopover(target, { popover: ref.current, trigger: name })

    const onPointerDown = (event) => {
      pointerDownAt = Date.now()
      if (isInside(event.target)) return
      dismissRef.current?.()
    }
    const onFocusIn = (event) => {
      if (isPointerDrivenFocusChange({ now: Date.now(), pointerDownAt })) return
      if (isInside(event.target)) return
      dismissRef.current?.()
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') dismissRef.current?.()
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [active, dismissRef, name, ref])
}

export function Popover({
  name,
  title,
  icon = null,
  meta = null,
  headerExtra = null,
  onClose,
  closable = true,
  actions = null,
  role = 'dialog',
  className = '',
  children
}) {
  const panelRef = useRef(null)
  usePopoverDismiss({ name, ref: panelRef, onDismiss: onClose })

  return (
    <section
      ref={panelRef}
      role={role}
      aria-label={typeof title === 'string' ? title : undefined}
      className={`chat-popover ${className}`.trim()}
    >
      <header className="chat-popover-head">
        {icon ? (
          <span className="chat-popover-mark" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="chat-popover-title">{title}</span>
        {headerExtra}
        {meta ? <span className="chat-popover-sub">{meta}</span> : null}
        {closable && onClose ? (
          <button type="button" className="chat-popover-close" aria-label="关闭" onClick={onClose}>
            <IconX size={13} />
          </button>
        ) : null}
      </header>
      <div className="chat-popover-body">{children}</div>
      {actions ? <div className="chat-popover-actions">{actions}</div> : null}
    </section>
  )
}
