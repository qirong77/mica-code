import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PluginIcon } from '@mica-config-ui/plugin-icons'
import { useIsMobile } from './hooks'
import { createPluginHostApi } from './plugin-host'
import { usePluginEntries } from './plugin-entries'

/**
 * 插件在桌面端的入口容器 + 卡片。
 *
 * 宿主只做容器，位置由清单的 `desktop.entry.placement` 决定：`sidebar`（默认）是侧栏里
 * 一行文字加图标、点开/悬停时把卡片浮在行右侧（手机上原地展开）；`header` 是主区顶栏的
 * 一枚图标按钮、点开时卡片浮在按钮下面。两处画的是同一个 `desktop.jsx`，宿主不知道里面
 * 是什么——「连接」「排期」「待办」全都是同一个形状。
 *
 * 卡片的样式、定宽、浮层定位、Esc / 点外面收起都在这里，插件只管画内容。
 */

const CARD_WIDTH = 320
// 卡片与入口行之间留 6px：鼠标从行滑到卡片要跨过这段，它必须算在 wrapper 的盒内
const CARD_GAP = 6
// 与行右边缘相距不超过这个值的祖先，算「同一条侧栏」——侧栏内的内边距（行左侧 px-2）
// 都在这条线以内，再往外就是主区了。
const SIDEBAR_EDGE_SLACK = 40

/** 打开后：Esc 与点卡片外面都收起。点入口本身由 onClick 管，这里不拦截。 */
function useDismissOnOutside(open, setOpen, anchorRef) {
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onPointerDown = (event) => {
      if (event.target.closest?.('[data-plugin-entry-card]')) return
      if (anchorRef.current?.contains(event.target)) return
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, setOpen, anchorRef])
}

export function PluginEntries({ onOpenPage }) {
  const entries = usePluginEntries()
  return entries
    .filter((entry) => entry.placement !== 'header')
    .map((entry) => <PluginEntryRow key={entry.id} entry={entry} onOpenPage={onOpenPage} />)
}

/**
 * 顶栏右侧的入口（清单 `desktop.entry.placement: "header"`）。
 *
 * 顶栏只有 32px 高，所以这里只画图标，文案进 tooltip；点开的行为与侧栏那一行一致——
 * 声明了 `desktop.page` 的开整页，否则在按钮下面浮出卡片。位置由 App 决定（放在顶栏右侧
 * 那一簇的最左边，窗口类图标仍然贴在最右），这里只管画按钮和卡片。
 */
export function PluginHeaderEntries({ onOpenPage }) {
  const entries = usePluginEntries()
  return entries
    .filter((entry) => entry.placement === 'header')
    .map((entry) => <PluginHeaderEntry key={entry.id} entry={entry} onOpenPage={onOpenPage} />)
}

function PluginHeaderEntry({ entry, onOpenPage }) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef(null)
  const api = useMemo(() => createPluginHostApi(entry.id), [entry.id])
  const isPage = Boolean(entry.page) && typeof onOpenPage === 'function'

  useDismissOnOutside(open, setOpen, anchorRef)

  const Card = entry.module.default
  const card = Card ? (
    <section
      data-plugin-entry-card
      className="rounded-md border border-line bg-panel/98 p-3.5 shadow-2xl backdrop-blur"
      style={{ width: CARD_WIDTH }}
    >
      <Card api={api} onClose={() => setOpen(false)} />
    </section>
  ) : null

  return (
    <>
      <div ref={anchorRef} className="shrink-0">
        <button
          type="button"
          aria-expanded={open}
          title={`${entry.label}（${entry.id} 插件）`}
          aria-label={entry.label}
          className={`grid size-6 place-items-center rounded-md transition-colors ${
            open
              ? 'bg-overlay-strong text-fg-max hover:bg-overlay-heavy'
              : 'text-fg-soft hover:bg-overlay hover:text-fg-max'
          }`}
          onClick={isPage ? () => onOpenPage(entry) : () => setOpen((value) => !value)}
        >
          <PluginIcon name={entry.icon} size={14} />
        </button>
      </div>
      {open && card && (
        <EntryPopover anchorRef={anchorRef} placement="below">
          {card}
        </EntryPopover>
      )}
    </>
  )
}

function PluginEntryRow({ entry, onOpenPage }) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const rowRef = useRef(null)
  const closeTimer = useRef(null)
  const api = useMemo(() => createPluginHostApi(entry.id), [entry.id])
  // 声明了 `desktop.page` 的入口点开的是整页（时间轴、表格这类要宽要高的东西），
  // 悬停卡片那条路对它没有意义：整页由 App 盖住整个窗口渲染。
  const isPage = Boolean(entry.page) && typeof onOpenPage === 'function'

  // 触屏没有悬停：那里点一下才展开，鼠标环境移到行上就打开
  const coarsePointer = useMemo(
    () => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
    []
  )
  const hoverOpens = !isPage && !isMobile && !coarsePointer

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

  useDismissOnOutside(open, setOpen, rowRef)

  const Card = entry.module.default
  // 入口行右侧那一行状态（「本机」「3 台」）由插件自己给：宿主不知道它的业务含义
  const summary = entry.module.summary?.(api) ?? ''
  const card = Card ? (
    <section
      data-plugin-entry-card
      className="rounded-md border border-line bg-panel/98 p-3.5 shadow-2xl backdrop-blur"
      style={{ width: CARD_WIDTH }}
    >
      <Card api={api} onClose={closeRow} />
    </section>
  ) : null

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
          className={`flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors hover:bg-overlay hover:text-fg-max ${
            open ? 'bg-overlay text-fg-max' : 'text-fg-soft'
          }`}
          onClick={
            isPage
              ? () => onOpenPage(entry)
              : hoverOpens
                ? openRow
                : () => setOpen((value) => !value)
          }
        >
          <PluginIcon name={entry.icon} size={14} className="shrink-0 opacity-75" />
          <span className="shrink-0">{entry.label}</span>
          {summary && (
            <span className="ml-auto min-w-0 truncate text-[11px] text-fg-dim">{summary}</span>
          )}
        </button>
        {/* 手机上卡片跟着行走：抽屉里没有「浮在右边」的位置 */}
        {open && isMobile && card && <div className="mt-1">{card}</div>}
      </div>
      {open && !isMobile && card && (
        <EntryPopover anchorRef={rowRef} onPointerEnter={openRow} onPointerLeave={scheduleClose}>
          {card}
        </EntryPopover>
      )}
    </>
  )
}

/**
 * 卡片贴在侧栏右边界上（而不是贴着这一行的右边缘）：行有内边距，按行算会让卡片压在
 * 分隔线上、差几个像素。这里从行往上找同一条侧栏里最靠右的那条边。
 */
function sidebarRightEdge(rowEl) {
  const rowRight = rowEl.getBoundingClientRect().right
  let edge = rowRight
  let el = rowEl.parentElement
  while (el && el !== document.body) {
    const right = el.getBoundingClientRect().right
    if (right - rowRight > SIDEBAR_EDGE_SLACK) break
    edge = Math.max(edge, right)
    el = el.parentElement
  }
  return edge
}

/**
 * 卡片浮层。`placement` 决定贴哪一边：`side` 贴在侧栏右边界上并桥接那 6px 缝隙（鼠标划
 * 过去不会先触发关闭），`below` 贴在顶栏按钮下面、与按钮右对齐。
 */
function EntryPopover({ anchorRef, placement = 'side', onPointerEnter, onPointerLeave, children }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  const place = useCallback(() => {
    const anchorEl = anchorRef.current
    const anchor = anchorEl?.getBoundingClientRect()
    const wrap = ref.current?.getBoundingClientRect()
    if (!anchor || !wrap) return
    // wrapper 的 pl-1.5 / pt-1.5 就是那 6px 缝隙，所以卡片本身落在边界上
    let left
    let top
    if (placement === 'below') {
      left = anchor.right - wrap.width
      top = anchor.bottom
    } else {
      left = sidebarRightEdge(anchorEl) - CARD_GAP
      top = anchor.top
    }
    if (left + wrap.width > window.innerWidth - 4)
      left = Math.max(4, window.innerWidth - wrap.width - 4)
    if (top + wrap.height > window.innerHeight - 4)
      top = Math.max(4, window.innerHeight - wrap.height - 4)
    setPos({ left, top })
  }, [anchorRef, placement])

  useLayoutEffect(() => {
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [place])

  return createPortal(
    <div
      ref={ref}
      className={`fixed z-[10500] overflow-y-auto ${placement === 'below' ? 'pt-1.5' : 'pl-1.5'}`}
      // 卡片内容由插件决定，长的能有好几屏（一个排期卡片能列出十几天的节点）。宿主管的是
      // 这块容器，所以高度上限也在这里：超出窗口的部分在卡片内滚动，而不是被窗口边缘切掉。
      //
      // 上限跟着 `top` 走而不是写成 `100vh - 8px`：`place()` 只在打开时量过一次高度，而
      // 卡片的数据多半是异步到的（先渲染空态、再长高），那时量到的高度做不准离窗口底还有
      // 多少。按落点算则与内容何时变高无关。
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        maxHeight: pos ? `calc(100vh - ${Math.round(pos.top) + 8}px)` : undefined,
        overscrollBehavior: 'contain'
      }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      {children}
    </div>,
    document.body
  )
}
