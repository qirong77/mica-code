import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * 悬浮菜单的壳与行。资源管理器、源代码管理、Git 变更树都用它，样式因此天然一致
 * （VS Code 的菜单：圆角 6px、1px 边框、面板底色、行高 28px）。
 */
export function FloatingMenu({ x, y, minWidth, onClose, ignoreSelector, children }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ x, y })
  useEffect(() => {
    // 常驻按钮自己负责开合：按压事件不关菜单，否则按下即关、点开又被重新打开，无法收起
    const close = (event) => {
      if (ignoreSelector && event.target?.closest?.(ignoreSelector)) return
      onClose()
    }
    const keydown = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', keydown)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', keydown)
    }
  }, [ignoreSelector, onClose])
  useLayoutEffect(() => {
    if (!ref.current) return
    const w = ref.current.offsetWidth
    const h = ref.current.offsetHeight
    let px = x
    let py = y
    if (px + w > window.innerWidth - 4) px = Math.max(4, window.innerWidth - w - 4)
    if (py + h > window.innerHeight - 4) py = Math.max(4, window.innerHeight - h - 4)
    setPos({ x: px, y: py })
  }, [x, y])
  return (
    <div
      ref={ref}
      className="fixed z-[10000] rounded-md border border-white/12 bg-panel/98 p-1 shadow-2xl backdrop-blur"
      style={{ left: pos.x, top: pos.y, minWidth }}
      role="menu"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  )
}

export function MenuSeparator() {
  return <div className="mx-1 my-1 h-px bg-white/10" />
}

export function MenuItem({ icon: Icon, label, hint, danger, disabled, onClick }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={`flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[13px] hover:bg-white/[.08] disabled:opacity-40 disabled:hover:bg-transparent ${
        danger ? 'text-danger-soft' : 'text-white/90 hover:text-white'
      }`}
      onClick={onClick}
    >
      <span className="grid w-4 shrink-0 place-items-center">
        <Icon size={14} className="shrink-0 opacity-75" />
      </span>
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-white/35">{hint}</span>}
    </button>
  )
}
