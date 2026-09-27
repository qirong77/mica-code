import { useEffect, useState } from 'react'
import { loopBadgeText } from './loop-command'

/**
 * 输入框边框右上角的定时循环徽标，形状与 CLI `PromptFrame` 的 loop 徽标一致：
 * `⏰ 每 30 分钟 · 下次 3 分 12 秒 · 第 3 次`。
 *
 * 倒计时按秒自走，但**只有这一个组件**每秒重渲染——挂在 ChatView 里会让整篇对话跟着
 * 一秒一刷（长会话里那是几十毫秒一次的全量重排）。一轮正在跑时不需要倒计时，直接停表。
 */
export function LoopBadge({ loop, running = false }) {
  const [now, setNow] = useState(() => Date.now())
  const ticking = loop?.status === 'active' && !running

  useEffect(() => {
    if (!ticking) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking, loop?.nodeId, loop?.nextFireAt])

  return (
    <span className="chat-composer-frame-label chat-loop-badge">
      {loopBadgeText(loop, now, running)}
    </span>
  )
}
