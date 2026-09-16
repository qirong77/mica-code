import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconPencil, IconServer, IconTrash } from '@tabler/icons-react'
import {
  LOCAL_SERVER_URL,
  MAX_SERVER_NOTE,
  isLoopbackServer,
  isSameServer,
  serverEntryFor,
  serverEntryLabel
} from './servers'

/**
 * 「切换 Mica 服务器」的卡片。
 *
 * 切换就是一次整页导航（页面由哪台运行时托管，就代表在用哪台），所以这里先让运行时探活
 * （跨源探测浏览器做不到），确认是 Mica Code 之后再跳。卡片不是弹窗：桌面上把鼠标移到
 * 侧栏的 Server 行就浮在右侧（ServerPopover），手机上点一下在同处展开。
 */

const CARD_WIDTH = 320

function NoteInput({ value, placeholder, onCommit, onCancel }) {
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      defaultValue={value}
      maxLength={MAX_SERVER_NOTE}
      spellCheck={false}
      placeholder={placeholder}
      className="h-6 min-w-0 flex-1 rounded-sm border border-white/25 bg-white/[.06] px-1.5 text-xs text-white"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // 输入框在清单行里面：按键绝不能冒泡到行的「回车即连接」，否则改个名字就跳走了
        event.stopPropagation()
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur()
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
      onBlur={(event) => onCommit(event.currentTarget.value)}
    />
  )
}

export function ServerCard({
  current,
  servers,
  onServersChange,
  onSwitch,
  onDismiss,
  width,
  className = ''
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState('')
  const entries = Array.isArray(servers) ? servers : []
  const currentEntry = serverEntryFor(entries, current)
  const rows = entries.filter((entry) => !isSameServer(entry.url, LOCAL_SERVER_URL))
  // 已经在回环地址上就说明人就在这台机器上，「本机」这个回程入口没有意义（页面可能跑在
  // 非默认端口上，那时 127.0.0.1:8787 甚至不是当前这台）
  const showLocal = !isLoopbackServer(current)

  const connect = async (address) => {
    const target = String(address || '').trim()
    if (!target || busy) return
    if (isSameServer(target, current)) {
      onDismiss()
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
        onDismiss()
        return
      }
      // 本机是固定的快捷入口，不进清单
      if (!isLoopbackServer(result.url)) {
        onServersChange(await window.mica.app.servers.remember(result.url))
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
      onServersChange(await window.mica.app.servers.forget(url))
    } catch (caught) {
      setError(caught?.message || String(caught))
    }
  }

  const saveNote = async (url, note) => {
    setEditing('')
    try {
      onServersChange(await window.mica.app.servers.note(url, note))
    } catch (caught) {
      setError(caught?.message || String(caught))
    }
  }

  const rowClass = (url) =>
    `group flex h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-xs ${
      isSameServer(url, current)
        ? 'text-white/85'
        : 'text-white/45 hover:bg-white/[.05] hover:text-white/80'
    }`

  const rowActions = (entry) => (
    <>
      <button
        type="button"
        title="改备注"
        aria-label="改备注"
        className="grid size-5 shrink-0 place-items-center rounded-sm text-white/25 opacity-0 hover:bg-white/10 hover:text-white/70 group-hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation()
          setEditing(entry.url)
        }}
      >
        <IconPencil size={11} />
      </button>
      <button
        type="button"
        title="从列表移除"
        aria-label="从列表移除"
        className="grid size-5 shrink-0 place-items-center rounded-sm text-white/25 opacity-0 hover:bg-white/10 hover:text-white/70 group-hover:opacity-100"
        onClick={(event) => void forget(entry.url, event)}
      >
        <IconTrash size={11} />
      </button>
    </>
  )

  return (
    <section
      data-server-card
      className={`rounded-md border border-line bg-panel/98 p-3.5 shadow-2xl backdrop-blur ${className}`}
      style={width ? { width } : undefined}
    >
      <h2 className="mb-1 text-sm font-semibold text-white/95">Mica 服务器</h2>
      <p className="mb-2.5 text-[11px] leading-4 text-white/40">
        切换到另一台机器上的 Mica 运行时，文件、终端、会话都来自那台机器。
      </p>

      <div className="mb-2.5 flex items-center gap-2 rounded-sm border border-line bg-white/[.03] px-2.5 py-1.5">
        <IconServer size={14} className="shrink-0 text-white/45" />
        <span className="shrink-0 text-xs text-white/80">
          {currentEntry ? serverEntryLabel(currentEntry) : ''}
        </span>
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
          <div className="mb-1 text-[10px] text-white/35">连接过的机器</div>
          {rows.map((entry) => (
            <div
              key={entry.url}
              role="button"
              tabIndex={0}
              title={entry.url}
              className={rowClass(entry.url)}
              onClick={() => editing !== entry.url && void connect(entry.url)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && editing !== entry.url) void connect(entry.url)
              }}
            >
              <span className="w-3 shrink-0 text-center text-[10px] text-green-400/80">
                {isSameServer(entry.url, current) ? <IconCheck size={11} /> : ''}
              </span>
              {editing === entry.url ? (
                <NoteInput
                  value={entry.note || ''}
                  placeholder="给这台机器起个名字"
                  onCommit={(note) => void saveNote(entry.url, note)}
                  onCancel={() => setEditing('')}
                />
              ) : (
                <>
                  {/* 备注是主标签，但最长只占一半，好让右侧的地址留得下 host:port */}
                  <span className="max-w-[52%] shrink-0 truncate">{serverEntryLabel(entry)}</span>
                  {/* 没备注时主标签本身就是 host:port，再来一遍地址只是噪音 */}
                  {entry.note?.trim() ? (
                    <span className="min-w-0 flex-1 truncate text-[10px] text-white/30">
                      {entry.url}
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1" />
                  )}
                </>
              )}
              {busy === entry.url && <span className="shrink-0 text-[10px]">连接中…</span>}
              {editing !== entry.url && rowActions(entry)}
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
      <p className="mt-2 text-[10px] leading-4 text-white/30">桌面应用内可用 ⇧⌘M 随时回到本机。</p>
    </section>
  )
}

/** 桌面端：把卡片浮在 Server 行右侧，并桥接这 6px 缝隙（鼠标划过去不会先触发关闭） */
function ServerPopover({ anchorRef, onPointerEnter, onPointerLeave, children }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  const place = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect()
    const wrap = ref.current?.getBoundingClientRect()
    if (!anchor || !wrap) return
    // 贴着行的右边缘起算，6px 的间距由 pl-1.5 撑出来（那段留白也算 wrapper 的盒内，可悬停）
    let left = anchor.right
    let top = anchor.top
    if (left + wrap.width > window.innerWidth - 4)
      left = Math.max(4, window.innerWidth - wrap.width - 4)
    if (top + wrap.height > window.innerHeight - 4)
      top = Math.max(4, window.innerHeight - wrap.height - 4)
    setPos({ left, top })
  }, [anchorRef])

  useLayoutEffect(() => {
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [place])

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[10500] pl-1.5"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      {children}
    </div>,
    document.body
  )
}

/** 桌面端的完整形态：定宽卡片 + 悬停桥接。手机上直接用 ServerCard 内联展开。 */
export function ServerCardPopover({ anchorRef, onPointerEnter, onPointerLeave, ...cardProps }) {
  return (
    <ServerPopover
      anchorRef={anchorRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <ServerCard width={CARD_WIDTH} {...cardProps} />
    </ServerPopover>
  )
}
