import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconCopy, IconExternalLink, IconLink, IconRefresh, IconTrash } from '@tabler/icons-react'
import { copyText } from './transport'
import { buildShareRows, shareRowTime } from './share-index'

/**
 * `/share` 这个路径上的页面：这台机器分享出去的链接。
 *
 * 分享出去的会话界面不画左侧会话列表（见 App.jsx 的 shareView 分支），所以「哪条会话被
 * 分享过」需要有自己的入口——就是这里。数据一半来自运行时的分享登记（哪些会话被分享过），
 * 一半来自会话清单（标题、工作目录），在 share-index.js 里对成行。
 *
 * 页面本身就是当前这台运行时的一个视口（拿到链接的人也能打开它），所以：
 * - 复制链接给的是运行时算出来的可达地址（不一定是当前 origin），自己点「打开」才留在当前 origin；
 * - 「移除」只是把这条从列表里去掉，链接本身照样能打开（运行时无账号体系，没有撤销这一说）。
 */
export default function ShareIndex() {
  const [state, setState] = useState({ status: 'loading', rows: [], baseUrl: null, error: '' })
  const [copied, setCopied] = useState('')

  const load = useCallback(async () => {
    try {
      const [entriesResult, sessionsResult, accessInfo] = await Promise.all([
        window.mica.share.list(),
        window.mica.stats.listSessions(),
        window.mica.access.info()
      ])
      setState({
        status: 'ready',
        rows: buildShareRows(entriesResult?.entries, sessionsResult?.sessions, {
          baseUrl: accessInfo?.shareBaseUrl || null
        }),
        baseUrl: accessInfo?.shareBaseUrl || null,
        error: ''
      })
    } catch (error) {
      setState((prev) => ({ ...prev, status: 'error', error: error?.message || String(error) }))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  // 回到这个页签时刷新一次：别人刚分享完，这里应该能看到（不做实时广播，免得为一张
  // 很少打开的列表加一条事件通道）。
  useEffect(() => {
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  const copy = useCallback(async (row) => {
    if (!row.url) return
    const ok = await copyText(row.url)
    setCopied(ok === false ? `${row.sessionId}:failed` : `${row.sessionId}:copied`)
  }, [])

  const remove = useCallback(
    async (row) => {
      if (!window.confirm(`把「${row.title}」从分享列表中移除？已发出去的链接仍然可以打开。`))
        return
      try {
        await window.mica.share.remove(row.sessionId)
      } catch (error) {
        window.alert(`移除失败：${error?.message || error}`)
        return
      }
      void load()
    },
    [load]
  )

  const rows = state.rows
  const empty = state.status === 'ready' && rows.length === 0
  const subtitle = useMemo(() => {
    if (state.status === 'loading') return '正在读取…'
    if (state.status === 'error') return state.error
    return `${rows.length} 条分享出去的对话`
  }, [rows.length, state.error, state.status])

  return (
    <div className="safe-top safe-bottom flex h-full min-h-0 flex-col overflow-y-auto bg-canvas">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <IconLink size={15} className="shrink-0 text-fg-muted" />
        <h1 className="text-[13px] font-semibold text-fg-strong">分享链接</h1>
        <span className="min-w-0 truncate text-[11px] text-fg-dim">{subtitle}</span>
        <button
          type="button"
          title="刷新"
          aria-label="刷新"
          className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-overlay hover:text-fg-max"
          onClick={() => void load()}
        >
          <IconRefresh size={14} />
        </button>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-2 p-4">
        {empty && (
          <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-xs leading-relaxed text-fg-muted">
            还没有分享出去的对话。
            <br />
            在桌面端的会话上右键 →「分享链接」，那条会出现在这里。
          </p>
        )}

        {rows.map((row) => (
          <section
            key={row.sessionId}
            className="flex items-start gap-2 rounded-md border border-line bg-panel/80 px-2.5 py-2"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-fg-strong" title={row.title}>
                {row.title}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-fg-dim">
                {[shareRowTime(row), row.cwd].filter(Boolean).join(' · ')}
              </span>
            </span>
            <div className="flex shrink-0 items-center gap-1 pt-0.5">
              <span
                className={`mr-1 text-[10px] ${
                  copied.startsWith(`${row.sessionId}:failed`) ? 'text-danger' : 'text-fg-dim'
                }`}
              >
                {copied.startsWith(`${row.sessionId}:copied`) ? '已复制' : ''}
                {copied.startsWith(`${row.sessionId}:failed`) ? '复制失败' : ''}
              </span>
              <button
                type="button"
                title={row.url ? '复制分享链接' : '这台机器没有可用的分享地址'}
                aria-label="复制分享链接"
                disabled={!row.url}
                className="grid size-7 place-items-center rounded-md text-fg-muted hover:bg-overlay hover:text-fg-max disabled:text-fg-ghost disabled:hover:bg-transparent"
                onClick={() => void copy(row)}
              >
                <IconCopy size={14} />
              </button>
              <button
                type="button"
                title="在本页打开这条对话"
                aria-label="打开"
                className="grid size-7 place-items-center rounded-md text-fg-muted hover:bg-overlay hover:text-fg-max"
                onClick={() =>
                  window.location.assign(
                    `${window.location.pathname}?session=${encodeURIComponent(row.sessionId)}`
                  )
                }
              >
                <IconExternalLink size={14} />
              </button>
              <button
                type="button"
                title="从分享列表中移除"
                aria-label="移除"
                className="grid size-7 place-items-center rounded-md text-fg-muted hover:bg-overlay hover:text-fg-max"
                onClick={() => void remove(row)}
              >
                <IconTrash size={14} />
              </button>
            </div>
          </section>
        ))}

        <p className="mt-2 text-[11px] leading-relaxed text-fg-dim">
          拿到链接的人看到的是同一条对话的完整界面（可以继续对话、看文件与终端），链接里只有会话
          id。这台运行时没有账号体系，请只发给信任的人。
        </p>
      </div>
    </div>
  )
}
