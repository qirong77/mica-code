import { useEffect, useState } from 'react'
import { IconWorld } from '@tabler/icons-react'
import { ArcoAction, ArcoPopover, MenuItem, MenuList } from '@mica-config-ui/web'
import { browserButtonTitle, browserCountBadge, browserMenuRows } from './browser-control'
import { longPressHandlers } from './hooks'

/**
 * 顶栏的浏览器入口：**一枚常驻按钮**，当前会话开了几扇受控浏览器窗口都只占这一格。
 *
 * 以前是一个窗口一枚图标：窗口一多就在顶栏排成一排、把别的入口挤走，还没法一眼看出
 * 一共有几个。现在窗口数量写在按钮右下角（一个窗口时不写），多于一个时悬停或点一下
 * 展开窗口列表——一行一扇窗口，点哪行就显示 / 收起哪个，在行上右键仍是关闭那扇窗口
 * （宿主会先确认）。没有窗口时按钮留着但禁用：位置稳定，也不用猜「这次为什么没有」。
 *
 * 窗口的开关仍然走 `browser-control` 的同一套接口；这里只决定「点的是哪一扇」。
 */
export function BrowserWindowsButton({ browsers = [], flashes = {}, onToggle, onClose }) {
  const [open, setOpen] = useState(false)
  const rows = browserMenuRows(browsers)
  const multiple = rows.length > 1
  // 只有一扇窗口时右键 / 长按关的就是它；多扇时「关哪个」不成立，交给下拉里的行。
  const single = rows.length === 1 ? browsers.find((item) => item?.id === rows[0].id) : null
  const badge = browserCountBadge(browsers)
  const title = browserButtonTitle(browsers)
  // 任何一扇窗口被 agent 调用，按钮都闪一下；计数相加，连着两次调用就闪两次。
  const flashSeq = rows.reduce((sum, row) => sum + (flashes[`browser:${row.id}`] || 0), 0)
  const loading = rows.some((row) => row.loading)
  const visible = rows.some((row) => row.visible)

  // 关到只剩一扇（或全关）时下拉没有存在的意义：跟着收起，别等再开第二扇时自己弹出来。
  useEffect(() => {
    if (!multiple && open) setOpen(false)
  }, [multiple, open])

  const browserOf = (id) => browsers.find((item) => item?.id === id)

  const button = (
    <ArcoAction
      iconOnly
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={visible}
      aria-expanded={multiple ? open : undefined}
      aria-haspopup={multiple ? 'menu' : undefined}
      disabled={!rows.length}
      {...(single ? longPressHandlers(() => onClose?.(single)) : {})}
      onContextMenu={
        single
          ? (event) => {
              event.preventDefault()
              onClose?.(single)
            }
          : undefined
      }
      // 悬停已经会展开；点一下是给触控板 / 键盘用户的同一个入口，不再「点一下关掉」。
      onClick={() => {
        if (!rows.length) return
        if (multiple) {
          setOpen(true)
          return
        }
        onToggle?.(browsers.find((item) => item?.id === rows[0].id))
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

  if (!multiple) return button

  return (
    <ArcoPopover
      className="mica-menu-popover"
      content={
        <MenuList
          className="browser-windows-menu"
          aria-label="浏览器窗口"
          onClose={() => setOpen(false)}
        >
          {rows.map((row) => (
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
