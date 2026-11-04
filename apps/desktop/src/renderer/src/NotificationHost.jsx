/**
 * 顶部通知宿主：把 `notify()` 推进来的每一条画成窗口顶部居中的一张小卡片。
 *
 * 为什么浮在上面而不是挤进布局：通知是临时的，插进文档流会让整页高度重算一遍，
 * 移动端的高度补偿（`--vvh`）与聊天区的滚动位置都会跟着跳。
 *
 * 为什么居中而不是占满整行：占满整行的那条读起来像「页面状态变了」（例如顶栏提示），
 * 居中的一条读起来才是「刚刚发生了一件事」。要用满整行语义的地方不要用这里。
 */
import { useEffect, useState } from 'react'
import { Button } from '@mica-config-ui/web'
import {
  dismissNotification,
  getNotifications,
  notify,
  subscribeNotifications
} from './notify'

const LEVEL_DOTS = {
  info: 'bg-accent',
  success: 'bg-[var(--color-git-added)]',
  warning: 'bg-[var(--color-git-modified)]',
  error: 'bg-[var(--color-git-deleted)]'
}

export function NotificationHost() {
  const [items, setItems] = useState(getNotifications)

  useEffect(() => subscribeNotifications(setItems), [])

  if (items.length === 0) return null

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[12000] flex flex-col items-center gap-1.5 px-3 pt-2"
      role="status"
      aria-live="polite"
    >
      {items.map((item) => (
        <NotificationCard key={item.id} item={item} />
      ))}
    </div>
  )
}

function NotificationCard({ item }) {
  // `createdAt` 也进依赖：同一条通知被更新（倒计时刷新）时重新计时，而不是沿用旧的那个。
  useEffect(() => {
    if (!item.timeout) return undefined
    const timer = setTimeout(() => dismissNotification(item.id), item.timeout)
    return () => clearTimeout(timer)
  }, [item.id, item.timeout, item.createdAt])

  const actions = item.actions || []

  return (
    // 整条垂直居中：圆点、文字与右侧按钮同一条中轴。两行文字（正文 + 说明）时
    // 按钮跟着居中，不要贴在第一行上——那样看起来像是掉上去的。
    <div className="no-drag pointer-events-auto flex w-fit max-w-[min(560px,100%)] items-center gap-2.5 rounded-md border border-line bg-panel px-3 py-2 text-xs text-fg-strong shadow-lg">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL_DOTS[item.level] || LEVEL_DOTS.info}`}
        aria-hidden="true"
      />
      <div className="min-w-0">
        {item.text ? <div className="leading-5">{item.text}</div> : null}
        {item.detail ? (
          <div className="mt-0.5 text-[11px] leading-4 text-fg-dim">{item.detail}</div>
        ) : null}
      </div>
      {actions.length > 0 ? (
        // 共享 `Button` 的样式全部限定在 `.mica-config-ui` 里，放进应用自己的容器时
        // 必须带上 `is-embed` 这一层，否则渲染出来是浏览器原生按钮（高度、内边距、字体
        // 全不对，看起来就是「歪了」）。
        <div className="mica-config-ui is-embed flex shrink-0 items-center gap-1">
          {actions.map((action) => (
            <Button
              key={action.label}
              size="compact"
              variant={action.variant || 'ghost'}
              disabled={action.disabled}
              onClick={() => {
                // 点了就收掉：这类通知几乎都是「点一下表示知道了」。
                dismissNotification(item.id)
                action.onClick?.()
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
