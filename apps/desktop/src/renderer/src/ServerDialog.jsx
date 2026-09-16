import { useEffect, useRef, useState } from 'react'
import { IconCheck, IconServer, IconTrash } from '@tabler/icons-react'
import { LOCAL_SERVER_URL, isLoopbackServer, isSameServer, serverLabel } from './servers'

/**
 * 「切换 Mica 服务器」对话框。
 *
 * 切换到另一台运行时就是一次整页导航（页面由哪台运行时托管，就代表在用哪台），
 * 所以这里先让运行时探活（跨源探测浏览器做不到），确认是 Mica Code 之后再跳。
 */
export function ServerDialog({ current, onClose, onSwitch }) {
  const [servers, setServers] = useState([])
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    let alive = true
    window.mica.app.servers
      .list()
      .then((list) => {
        if (alive) setServers(Array.isArray(list) ? list : [])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const connect = async (address) => {
    const target = String(address || '').trim()
    if (!target || busy) return
    if (isSameServer(target, current)) {
      onClose()
      return
    }
    setError('')
    setBusy(target)
    try {
      const result = await window.mica.app.servers.probe(target)
      if (!result?.ok) {
        setError(result?.error || '连接失败')
        return
      }
      if (isSameServer(result.url, current)) {
        onClose()
        return
      }
      // 本机是固定的快捷入口，不进「最近使用」列表
      if (!isLoopbackServer(result.url)) {
        setServers(await window.mica.app.servers.remember(result.url))
      }
      onSwitch(result.url)
    } catch (caught) {
      setError(caught?.message || String(caught))
    } finally {
      setBusy('')
    }
  }

  const forget = async (url, event) => {
    event.stopPropagation()
    try {
      setServers(await window.mica.app.servers.forget(url))
    } catch (caught) {
      setError(caught?.message || String(caught))
    }
  }

  const rows = servers.filter((entry) => !isSameServer(entry.url, LOCAL_SERVER_URL))
  const showLocal = !isSameServer(current, LOCAL_SERVER_URL)

  return (
    <div
      className="fixed inset-0 z-[11000] grid place-items-center bg-black/45 no-drag"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        className="w-[min(460px,calc(100vw-32px))] rounded-md border border-line bg-panel/98 p-3.5 shadow-2xl"
      >
        <h2 className="mb-1 text-sm font-semibold text-white/95">Mica 服务器</h2>
        <p className="mb-2.5 text-[11px] leading-4 text-white/40">
          切换到另一台机器上的 Mica 运行时，文件、终端、会话都来自那台机器。
        </p>

        <div className="mb-2.5 flex items-center gap-2 rounded-sm border border-line bg-white/[.03] px-2.5 py-1.5">
          <IconServer size={14} className="shrink-0 text-white/45" />
          <span className="shrink-0 text-xs text-white/80">{serverLabel(current)}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-white/35">{current}</span>
          <span className="shrink-0 text-[10px] text-green-400/70">当前</span>
        </div>

        {showLocal && (
          <button
            type="button"
            disabled={Boolean(busy)}
            className="mb-2 flex h-8 w-full items-center gap-2 rounded-sm border border-dashed border-white/15 bg-white/[.02] px-2.5 text-left text-xs text-white/60 hover:border-white/35 hover:text-white disabled:text-white/25"
            onClick={() => void connect(LOCAL_SERVER_URL)}
          >
            <IconServer size={13} className="shrink-0" />
            <span className="shrink-0">本机</span>
            <span className="min-w-0 flex-1 truncate text-[10px] text-white/30">
              {LOCAL_SERVER_URL}
            </span>
            {busy === LOCAL_SERVER_URL && <span className="text-[10px]">连接中…</span>}
          </button>
        )}

        {rows.length > 0 && (
          <div className="mb-2 max-h-52 overflow-y-auto">
            <div className="mb-1 text-[10px] text-white/35">最近使用</div>
            {rows.map((entry) => (
              <div
                key={entry.url}
                role="button"
                tabIndex={0}
                title={entry.url}
                className={`group flex h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-xs ${
                  isSameServer(entry.url, current)
                    ? 'text-white/85'
                    : 'text-white/45 hover:bg-white/[.05] hover:text-white/80'
                }`}
                onClick={() => void connect(entry.url)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void connect(entry.url)
                }}
              >
                <span className="w-3 shrink-0 text-center text-[10px] text-green-400/80">
                  {isSameServer(entry.url, current) ? <IconCheck size={11} /> : ''}
                </span>
                <span className="shrink-0">{serverLabel(entry.url)}</span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-white/30">
                  {entry.url}
                </span>
                {busy === entry.url && <span className="shrink-0 text-[10px]">连接中…</span>}
                <button
                  type="button"
                  title="从列表移除"
                  aria-label="从列表移除"
                  className="grid size-5 shrink-0 place-items-center rounded-sm text-white/25 opacity-0 hover:bg-white/10 hover:text-white/70 group-hover:opacity-100"
                  onClick={(event) => void forget(entry.url, event)}
                >
                  <IconTrash size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="mb-2 rounded-sm border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs leading-relaxed text-red-300">
            {error}
          </div>
        )}

        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={value}
            spellCheck={false}
            placeholder="另一台机器的地址，如 192.168.1.5:8787"
            className="h-8 min-w-0 flex-1 rounded-sm border border-white/15 bg-white/[.04] px-2.5 text-xs text-white focus:border-white/30"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void connect(value)
              }
            }}
          />
          <button
            type="button"
            disabled={!value.trim() || Boolean(busy)}
            className="h-8 shrink-0 rounded-sm bg-white/10 px-3.5 text-xs text-white/85 hover:bg-white/15 disabled:text-white/25"
            onClick={() => void connect(value)}
          >
            连接
          </button>
        </div>
        <p className="mt-2 text-[10px] leading-4 text-white/30">
          桌面应用内可用 ⇧⌘M 随时回到本机。
        </p>
      </section>
    </div>
  )
}
