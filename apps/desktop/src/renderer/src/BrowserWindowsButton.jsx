import { useEffect, useState } from 'react'
import { IconWorld } from '@tabler/icons-react'
import { ArcoAction, ArcoPopover, MenuItem, MenuList } from '@mica-config-ui/web'
import {
  browserButtonTitle,
  browserClickAction,
  browserCountBadge,
  browserMenuRows
} from './browser-control'
import { longPressHandlers } from './hooks'

/**
 * 顶栏的浏览器入口：**一枚常驻按钮**，当前会话开了几扇受控浏览器窗口都只占这一格。
 *
 * 以前是一个窗口一枚图标：窗口一多就在顶栏排成一排、把别的入口挤走，还没法一眼看出
 * 一共有几个。现在窗口数量写在按钮右下角（一个窗口时不写），多于一个时悬停展开窗口列表
 * ——一行一扇窗口，点哪行就显示 / 收起哪个，在行上右键仍是关闭那扇窗口（宿主会先确认）。
 *
 * 按钮**永远可点**，不按「有没有窗口」禁用：没有窗口时点一下就给当前会话新建一个（人自己
 * 想看网页，不该先去求 agent），有窗口时作用在固定顺序里的第一扇（见 `browserClickAction`）。
 * 要多扇里挑别的，悬停出下拉。
 *
 * 窗口的开关仍然走 `browser-control` 的同一套接口；这里只决定「点的是哪一扇」。
 */
export function BrowserWindowsButton({
  browsers = [],
  flashes = {},
  onToggle,
  onClose,
  onCreate
}) {
  const [open, setOpen] = useState(false)
  const rows = browserMenuRows(browsers)
  const multiple = rows.length > 1
  // 空列表也提供下拉入口；按钮本身仍支持直接点击新建。
  const hasMenu = multiple || rows.length === 0
  // 只有一扇窗口时右键 / 长按关的就是它；多扇时「关哪个」不成立，交给下拉里的行。
  const action = browserClickAction(browsers)
  const single = multiple ? null : action.browser
  const badge = browserCountBadge(browsers)
  const title = browserButtonTitle(browsers)
  // 任何一扇窗口被 agent 调用，按钮都闪一下；计数相加，连着两次调用就闪两次。
  const flashSeq = rows.reduce((sum, row) => sum + (flashes[`browser:${row.id}`] || 0), 0)
  const loading = rows.some((row) => row.loading)
  const visible = rows.some((row) => row.visible)

  // 关到只剩一扇（或全关）时下拉没有存在的意义：跟着收起，别等再开第二扇时自己弹出来。
  useEffect(() => {
    if (!hasMenu && open) setOpen(false)
  }, [hasMenu, open])

  const browserOf = (id) => browsers.find((item) => item?.id === id)

  const button = (
    <ArcoAction
      iconOnly
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={visible}
      aria-expanded={hasMenu ? open : undefined}
      aria-haspopup={hasMenu ? 'menu' : undefined}
      {...(single ? longPressHandlers(() => onClose?.(single)) : {})}
      onContextMenu={
        single
          ? (event) => {
              event.preventDefault()
              onClose?.(single)
            }
          : undefined
      }
      // 悬停已经会展开列表；点一下只作用于「默认的那一扇」（没有就新建），所以同一下点击
      // 不会顺带把列表弹出来。
      onClick={() => {
        if (action.kind === 'create') {
          onCreate?.()
          return
        }
        onToggle?.(action.browser)
      }}
      className="relative grid size-6 shrink-0 place-items-center transition-colors"
    >
      <IconWorld
        key={flashSeq}
        size={14}
        className={
          [loading && 'animate-pulse', flashSeq && 'control-icon-flash']
            .filter(Boolean)
            .join(' ') || undefined
        }
      />
      {badge ? (
        <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 text-[8px] leading-none text-fg-muted">
          {badge}
        </span>
      ) : null}
    </ArcoAction>
  )

  if (!hasMenu) return button

  return (
    <ArcoPopover
      className="mica-menu-popover"
      content={
        <MenuList
          className="browser-windows-menu"
          aria-label="浏览器窗口"
          onClose={() => setOpen(false)}
        >
          {!rows.length ? (
            <MenuItem
              className="browser-window-create"
              onClick={() => {
                setOpen(false)
                onCreate?.()
              }}
            >
              <span className="browser-window-text">
                <span className="browser-window-name">新建浏览器窗口</span>
                <span className="browser-window-detail">为当前会话打开一扇受控浏览器</span>
              </span>
            </MenuItem>
          ) : rows.map((row) => (
            <MenuItem
              key={row.id}
              title={row.tooltip}
              // 勾选态 = 这扇窗口此刻显示着：点它就是收起，未勾选就是唤出。
              selected={row.visible}
              onClick={() => {
                setOpen(false)
                onToggle?.(browserOf(row.id))
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                setOpen(false)
                onClose?.(browserOf(row.id))
              }}
            >
              <span className="browser-window-text">
                <span className="browser-window-name">{row.name}</span>
                {row.detail ? <span className="browser-window-detail">{row.detail}</span> : null}
              </span>
              <span className="browser-window-status">{row.status}</span>
            </MenuItem>
          ))}
        </MenuList>
      }
      popupVisible={open}
      onVisibleChange={setOpen}
      trigger="hover"
      position="br"
      // 窗口列表是菜单而不是 tooltip：不要那个指回按钮的小箭头，离按钮也留近一点。
      triggerProps={{
        mouseEnterDelay: 120,
        mouseLeaveDelay: 160,
        showArrow: false,
        popupAlign: { bottom: 6 }
      }}
      getPopupContainer={() => document.body}
    >
      {button}
    </ArcoPopover>
  )
}
