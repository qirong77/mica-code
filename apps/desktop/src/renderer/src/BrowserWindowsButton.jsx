import { useState } from 'react'
import { IconPlus, IconWorld } from '@tabler/icons-react'
import { ArcoAction, ArcoPopover, MenuItem, MenuList, MenuSeparator } from '@mica-config-ui/web'
import { browserButtonTitle, browserCountBadge, browserMenuRows } from './browser-control'

/**
 * 顶栏的浏览器入口：**一枚常驻按钮**，当前会话开了几扇受控浏览器窗口都只占这一格。
 *
 * 以前是一个窗口一枚图标：窗口一多就在顶栏排成一排、把别的入口挤走，还没法一眼看出
 * 一共有几个。现在窗口数量写在按钮右下角（有一扇就写 1），点一下展开窗口列表——一行一扇
 * 窗口，点哪行就显示 / 收起哪个，在行上右键仍是关闭那扇窗口（宿主会先确认）。
 *
 * 点击**只展开列表**，不顺手新建、也不直接开某一扇：「新建」与「切到哪一扇」都必须是用户
 * 在列表里自己选的那一下（以前的点是「有窗口就开第一扇、没窗口就新建」，同一个动作两种结果，
 * 想要的窗和真正打开的窗很容易对不上）。列表最后一行永远是「新建浏览器窗口」。
 *
 * 窗口的开关仍然走 `browser-control` 的同一套接口；这里只决定「点的是哪一扇」。
 */
export function BrowserWindowsButton({ browsers = [], flashes = {}, onToggle, onClose, onCreate }) {
  const [open, setOpen] = useState(false)
  const rows = browserMenuRows(browsers)
  const badge = browserCountBadge(browsers)
  const title = browserButtonTitle(browsers)
  // 任何一扇窗口被 agent 调用，按钮都闪一下；计数相加，连着两次调用就闪两次。
  const flashSeq = rows.reduce((sum, row) => sum + (flashes[`browser:${row.id}`] || 0), 0)
  const loading = rows.some((row) => row.loading)
  const visible = rows.some((row) => row.visible)

  const browserOf = (id) => browsers.find((item) => item?.id === id)

  const button = (
    <ArcoAction
      iconOnly
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={visible}
      aria-expanded={open}
      aria-haspopup="menu"
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
              icon={<IconWorld size={16} aria-hidden="true" />}
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
              <span className="mica-menu-label">{row.name}</span>
              {row.detail ? <span className="browser-window-url">{row.detail}</span> : null}
            </MenuItem>
          ))}
          {rows.length ? <MenuSeparator /> : null}
          {/* 「新建」常驻列表末尾：哪怕一扇窗口都没有，这一行也在同一个位置 */}
          <MenuItem
            icon={<IconPlus size={16} aria-hidden="true" />}
            onClick={() => {
              setOpen(false)
              onCreate?.()
            }}
          >
            <span className="mica-menu-label">新建浏览器窗口</span>
          </MenuItem>
        </MenuList>
      }
      popupVisible={open}
      onVisibleChange={setOpen}
      // 点开而不是悬停：按钮的每一次点击都只做一件事（展开列表），列表里人自己挑
      trigger="click"
      position="br"
      // 窗口列表是菜单而不是 tooltip：不要那个指回按钮的小箭头，离按钮也留近一点。
      triggerProps={{
        showArrow: false,
        popupAlign: { bottom: 6 }
      }}
      getPopupContainer={() => document.body}
    >
      {button}
    </ArcoPopover>
  )
}
