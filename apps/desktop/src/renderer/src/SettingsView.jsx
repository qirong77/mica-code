import { useEffect, useState } from 'react'

/** Settings 视图：在主进程拉起/复用 mica 的 Config Web 后，用 iframe 内嵌加载配置页面 */
export function SettingsView({ visible }) {
  const [snap, setSnap] = useState({ status: 'idle' })
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    if (!visible) return undefined
    let alive = true
    setSnap({ status: 'starting' })
    window.mica.settings
      .open()
      .then((info) => {
        if (alive) setSnap({ status: 'ready', url: info?.url || '' })
      })
      .catch((error) => {
        if (alive) setSnap({ status: 'error', message: error?.message || String(error) })
      })
    return () => {
      alive = false
    }
  }, [visible, retryTick])

  return (
    <section
      className={`min-h-0 flex-1 flex-col overflow-hidden ${visible ? 'flex' : 'hidden'}`}
      aria-hidden={!visible}
    >
      {snap.status === 'ready' && snap.url ? (
        <iframe title="Mica 配置" src={snap.url} className="size-full border-0 bg-[#0e0e0e]" />
      ) : (
        <div className="grid size-full place-items-center">
          <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center">
            {snap.status === 'error' ? (
              <>
                <p className="text-sm text-white/70">配置页面启动失败</p>
                <p className="text-xs leading-5 text-white/40">{snap.message}</p>
                <button
                  type="button"
                  onClick={() => setRetryTick((value) => value + 1)}
                  className="mt-2 rounded-sm border border-white/10 bg-white/[.06] px-3 py-1 text-xs text-white hover:bg-white/10"
                >
                  重试
                </button>
              </>
            ) : (
              <p className="text-sm text-white/45">正在启动配置页面…</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
