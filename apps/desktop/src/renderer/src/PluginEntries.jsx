import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PluginIcon } from '@mica-config-ui/plugin-icons'
import { useIsMobile } from './hooks'
import { createPluginHostApi } from './plugin-host'
import { usePluginEntries } from './plugin-entries'

/**
 * 插件在侧栏里的入口行 + 卡片容器。
 *
 * 宿主只做容器：一行文字加图标、点开/悬停时把卡片浮在行右侧（手机上原地展开）。卡片
 * 内容由插件自己的 `desktop.jsx` 画，宿主不知道里面是什么——「连接」「看板」「待办」
 * 全都是同一个形状。
 *
 * 卡片的样式、定宽、浮层定位、Esc / 点外面收起都在这里，插件只管画内容。
 */

const CARD_WIDTH = 320

export function PluginEntries() {
  const entries = usePluginEntries()
  return entries.map((entry) => <PluginEntryRow key={entry.id} entry={entry} />)
}

function PluginEntryRow({ entry }) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const rowRef = useRef(null)
  const closeTimer = useRef(null)
  const api = useMemo(() => createPluginHostApi(entry.id), [entry.id])

  // 触屏没有悬停：那里点一下才展开，鼠标环境移到行上就打开
  const coarsePointer = useMemo(
    () => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
    []
  )
  const hoverOpens = !isMobile && !coarsePointer

  const openRow = useCallback(() => {
    clearTimeout(closeTimer.current)
    setOpen(true)
  }, [])
  const closeRow = useCallback(() => {
    clearTimeout(closeTimer.current)
    setOpen(false)
  }, [])
  const scheduleClose = useCallback(() => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 160)
  }, [])

  useEffect(() => () => clearTimeout(closeTimer.current), [])

  // 打开后：Esc 与点卡片外面都收起。点行本身由 onClick 管，这里不拦截。
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onPointerDown = (event) => {
      if (event.target.closest?.('[data-plugin-entry-card]')) return
      if (rowRef.current?.contains(event.target)) return
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  const Card = entry.module.default
  // 入口行右侧那一行状态（「本机」「3 台」）由插件自己给：宿主不知道它的业务含义
  const summary = entry.module.summary?.(api) ?? ''
  const card = (
    <section
      data-plugin-entry-card
      className="rounded-md border border-line bg-panel/98 p-3.5 shadow-2xl backdrop-blur"
      style={{ width: CARD_WIDTH }}
    >
      <Card api={api} onClose={closeRow} />
    </section>
  )

  return (
    <>
      <div
        ref={rowRef}
        onMouseEnter={hoverOpens ? openRow : undefined}
        onMouseLeave={hoverOpens ? scheduleClose : undefined}
      >
        <button
          type="button"
          aria-expanded={open}
          title={`${entry.label}（${entry.id} 插件）`}
          className={`flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors hover:bg-white/[.05] hover:text-white ${
            open ? 'bg-white/[.05] text-white' : 'text-white/60'
          }`}
          onClick={hoverOpens ? openRow : () => setOpen((value) => !value)}
        >
          <PluginIcon name={entry.icon} size={14} className="shrink-0 opacity-75" />
          <span className="shrink-0">{entry.label}</span>
          {summary && (
            <span className="ml-auto min-w-0 truncate text-[11px] text-white/35">{summary}</span>
          )}
        </button>
        {/* 手机上卡片跟着行走：抽屉里没有「浮在右边」的位置 */}
        {open && isMobile && <div className="mt-1">{card}</div>}
      </div>
      {open && !isMobile && (
        <EntryPopover anchorRef={rowRef} onPointerEnter={openRow} onPointerLeave={scheduleClose}>
          {card}
        </EntryPopover>
      )}
    </>
  )
}

/** 把卡片浮在入口行右侧，并桥接这 6px 缝隙（鼠标划过去不会先触发关闭） */
function EntryPopover({ anchorRef, onPointerEnter, onPointerLeave, children }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  const place = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect()
    const wrap = ref.current?.getBoundingClientRect()
    if (!anchor || !wrap) return
    // 贴着行的右边缘起算，6px 的间距由 pl-1.5 撑出来（那段留白也算 wrapper 的盒内，可悬停）
    let left = anchor.right
    let top = anchor.top
    if (left + wrap.width > window.innerWidth - 4)
      left = Math.max(4, window.innerWidth - wrap.width - 4)
    if (top + wrap.height > window.innerHeight - 4)
      top = Math.max(4, window.innerHeight - wrap.height - 4)
    setPos({ left, top })
  }, [anchorRef])

  useLayoutEffect(() => {
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [place])

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[10500] pl-1.5"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      {children}
    </div>,
    document.body
  )
}
