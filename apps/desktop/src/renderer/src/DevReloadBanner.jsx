/**
 * 「构建完成，准备重载」的顶部提示条（只在开发期出现——运行时没有构建 stamp 时状态恒为 idle）。
 *
 * 摆在最上面是因为它要交代的是「你现在能不能信这界面」：倒计时数字、正在跑的会话数、
 * 以及一个「立即重载」。不做成弹窗：弹窗会挡住对话，而用户常常想先看完正在流的那段。
 *
 * 倒计时结束后的软停阶段（`draining`）也照常显示：那时正在等每一轮走到下一次请求之前，
 * 最多 15s。它不会像以前那样转成「要不要现在掐断」——这一轮已经注定被换掉，续跑是自动的。
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@mica-config-ui/web'

const LEVEL_LABELS = {
  renderer: '界面',
  cli: '插件与工具',
  runtime: '运行时',
  shell: '应用外壳'
}

export function DevReloadBanner() {
  const [state, setState] = useState(null)
  const reloadedRef = useRef(false)

  useEffect(() => {
    const api = window.mica?.devReload
    if (!api) return undefined
    let alive = true
    api
      .getState()
      .then((next) => {
        if (alive) setState(next)
      })
      .catch(() => {})
    const off = api.onState((next) => {
      if (alive) setState(next)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  // 运行时说了「可以重载」再重载：宿主已经腾空，此刻刷新不会打断任何一轮。
  useEffect(() => {
    if (state?.phase !== 'reload' || reloadedRef.current) return
    reloadedRef.current = true
    const timer = setTimeout(() => window.location.reload(), 400)
    return () => clearTimeout(timer)
  }, [state?.phase])

  if (!state || state.phase === 'idle') return null

  const label = LEVEL_LABELS[state.level] || '产物'
  const seconds = Math.max(0, Math.ceil((state.remainingMs || 0) / 1000))
  const busy = state.busyHosts || 0

  let text = ''
  if (state.phase === 'countdown') {
    text = `${label}有更新 · ${seconds}s 后重载`
  } else if (state.phase === 'draining') {
    text = busy > 0 ? `等 ${busy} 个会话停在下一次请求前，最多 15s · 之后自动继续` : '正在收尾…'
  } else if (state.phase === 'applying') {
    text = '正在重启会话宿主 · 重启后自动继续'
  } else if (state.phase === 'reload') {
    text = '正在重载界面…'
  } else if (state.phase === 'restart') {
    text = '正在重启应用…'
  }

  const pending = state.phase === 'countdown'

  return (
    // 浮在内容之上而不是挤进布局：这一条是临时的，不该让整页高度重新算一遍
    // （移动端的高度补偿依赖真实的可视高度）。
    <div className="mica-config-ui fixed inset-x-0 top-0 z-[60]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 text-xs text-[var(--chat-text)] shadow-sm">
        <span className="text-[var(--chat-text-dim)]">{text}</span>
        {state.changed?.length ? (
          <span className="text-[11px] text-[var(--chat-text-dim)]">
            {state.changed.join(' / ')}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {pending ? (
            <>
              <Button
                size="compact"
                variant="ghost"
                onClick={() => void window.mica?.devReload?.act('later')}
              >
                稍后
              </Button>
              <Button
                size="compact"
                variant="primary"
                onClick={() => void window.mica?.devReload?.act('now')}
              >
                立即重载
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
