import { IconDownload, IconRefresh } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArcoAction } from '@mica-config-ui/web'
import { updateButtonState, updateCheckUrl } from './app-update.js'

const POLL_MS = 10 * 60 * 1000

async function readRemoteUpdate(force = false) {
  const response = await fetch(updateCheckUrl(force), { cache: 'no-store' })
  if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`)
  return response.json()
}

export function AppUpdateAction() {
  const [remote, setRemote] = useState(null)
  const [native, setNative] = useState(null)
  const [busy, setBusy] = useState(false)
  const bridge = typeof window !== 'undefined' ? window.micaClient?.appUpdate : null

  const check = useCallback(
    async (force = false) => {
      try {
        const value = await readRemoteUpdate(force)
        if (value?.ok) setRemote(value)
      } catch {
        // 更新检查是辅助能力，网络失败不应在底栏制造错误状态。
      }
      if (bridge?.check) {
        const result = await bridge.check().catch(() => null)
        if (result?.status) setNative(result.status)
      }
    },
    [bridge]
  )

  useEffect(() => {
    void check()
    const timer = window.setInterval(() => void check(), POLL_MS)
    const onVisible = () => {
      if (!document.hidden) void check(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    const unsubscribe = bridge?.onStatus?.((status) => setNative(status))
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribe?.()
    }
  }, [bridge, check])

  const button = useMemo(() => updateButtonState(remote, native), [remote, native])
  if (!button.visible) return null

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (native?.status === 'downloaded') {
        await bridge?.install?.()
        return
      }
      if (native?.status === 'available') {
        const result = await bridge?.download?.()
        if (result?.status) setNative(result.status)
        return
      }
      if (bridge?.check) {
        const result = await bridge.check().catch(() => null)
        if (result?.status) setNative(result.status)
        if (result?.ok !== false && result?.status?.status !== 'not-available') return
      }
      // 普通浏览器或远程页面没有本机安装器，只能把用户带到对应提交。
      const target = remote?.latestUrl || remote?.repository
      if (target) window.open(target, '_blank', 'noopener,noreferrer')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ArcoAction
      type="button"
      title={remote?.latestMessage || '发现 Mica 新版本'}
      aria-label={button.label}
      className="-ml-1.5 flex h-full shrink-0 items-center gap-1 px-1.5 text-accent hover:text-accent-hover"
      disabled={busy || native?.status === 'downloading'}
      onClick={onClick}
    >
      {native?.status === 'downloaded' ? <IconRefresh size={13} /> : <IconDownload size={13} />}
      <span>{button.label}</span>
    </ArcoAction>
  )
}
