import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconPencil, IconServer } from '@tabler/icons-react'
import {
  LOCAL_SERVER_URL,
  MAX_SERVER_NOTE_LENGTH,
  findServerEntry,
  isLoopbackServer,
  isSameServer,
  readRecentServers,
  rememberServer,
  setServerNote,
  serverListRows
} from './servers'

/**
 * 「切换 Mica 服务器」的卡片。
 *
 * 页面由哪台运行时托管就代表在用哪台，所以切换 = 打开另一台的地址：桌面应用里由外壳
 * 弹出新窗口（见 src/main/index.js 的 will-navigate），浏览器里开新标签页。这里先让
 * 运行时探活（跨源探测浏览器做不到），确认是 Mica Code 之后才把地址交出去。卡片不是
 * 弹窗：桌面上把鼠标移到侧栏的 Server 行就浮在右侧（ServerPopover），手机上点一下在
 * 同处展开。
 *
 * 连接过的服务器由页面自己记着（`servers.js` 的 remembered 清单，存在本地），于是点
 * 一下就切回去，不必再抄地址；记不住 IP 的话可以给每条起个备注（悬停行尾的铅笔）。
 */

const CARD_WIDTH = 320

export function ServerCard({ current, onSwitch, onDismiss, width, className = '' }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [recent, setRecent] = useState(() => readRecentServers())
  // 正在改备注的那条（地址），空串表示没在编辑
  const [noteTarget, setNoteTarget] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  // 已经在回环地址上就说明人就在这台机器上，「本机」这个回程入口没有意义（页面可能跑在
  // 非默认端口上，那时 127.0.0.1:8787 甚至不是当前这台）
  const showLocal = !isLoopbackServer(current)
  const rows = serverListRows(current, recent)
  const currentEntry = findServerEntry(current, recent)

  const startNoteEdit = (url) => {
    setNoteTarget(url)
    setNoteDraft(findServerEntry(url, recent)?.note ?? '')
  }
  const saveNote = () => {
    if (!noteTarget) return
    setRecent(setServerNote(noteTarget, noteDraft))
    setNoteTarget('')
  }

  // 卡片是悬停浮层，鼠标滑出去就整张收起来了：正在敲的备注在卸载时直接落盘，
  // 免得「滑出去一下就白打」。Esc 取消已经把 noteTarget 清空，这里自然不会写。
  const pendingNote = useRef(null)
  useEffect(() => {
    pendingNote.current = noteTarget ? { url: noteTarget, note: noteDraft } : null
  }, [noteTarget, noteDraft])
  useEffect(
    () => () => {
      const pending = pendingNote.current
      if (pending) setServerNote(pending.url, pending.note)
    },
    []
  )

  const connect = async (address) => {
    const target = String(address || '').trim()
    if (!target || busy) return
    setError('')
    setBusy(target)
    setNoteTarget('')
    try {
      const result = await window.mica.app.servers.probe(target)
      if (!result?.ok) {
        setError(result?.error || '连接失败')
        return
      }
      // 探通了才记：地址已经规范成 origin，下次直接从这里点回去
      setRecent(rememberServer(result.url))
      if (isSameServer(result.url, current)) {
        onDismiss()
        return
      }
      onSwitch(result.url)
      // 外壳里是「另开一个窗口」，本窗口的卡片自己收起；浏览器里这个页面已经走了
      onDismiss()
    } catch (caught) {
      setError(caught?.message || String(caught))
    } finally {
      setBusy('')
    }
  }

  const noteInput = (
    <NoteInput
      value={noteDraft}
      onChange={setNoteDraft}
      onSave={saveNote}
      onCancel={() => setNoteTarget('')}
    />
  )

  return (
    <section
      data-server-card
      className={`rounded-md border border-line bg-panel/98 p-3.5 shadow-2xl backdrop-blur ${className}`}
      style={width ? { width } : undefined}
    >
      <h2 className="mb-1 text-sm font-semibold text-white/95">Mica 服务器</h2>
      <p className="mb-2.5 text-[11px] leading-4 text-white/40">
        切换到另一台机器上的 Mica 运行时，文件、终端、会话都来自那台机器（在当前窗口之外打开）。
      </p>

      <div className="mb-2.5 rounded-sm border border-line bg-white/[.03]">
        <div className="group/server flex items-center gap-2 px-2.5 py-1.5">
          <IconServer size={14} className="shrink-0 text-white/45" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] text-white/35">{current}</span>
            {currentEntry?.note && (
              <span className="block truncate text-[11px] text-white/60">{currentEntry.note}</span>
            )}
          </span>
          <span className="shrink-0 text-[10px] text-green-400/70">当前</span>
          {currentEntry && <NoteEditButton onClick={() => startNoteEdit(currentEntry.url)} />}
        </div>
        {noteTarget && isSameServer(noteTarget, current) && noteInput}
      </div>

      {rows.map((entry) => (
        <div
          key={entry.url}
          className="mb-1.5 rounded-sm border border-line bg-white/[.03] hover:border-white/25 hover:bg-white/[.07]"
        >
          <div className="group/server flex items-center gap-2 px-2.5 py-1.5">
            <IconServer size={14} className="shrink-0 text-white/45" />
            <button
              type="button"
              disabled={Boolean(busy)}
              className="min-w-0 flex-1 text-left disabled:opacity-60"
              onClick={() => void connect(entry.url)}
            >
              <span className="block truncate text-[11px] text-white/35">{entry.url}</span>
              {entry.note && (
                <span className="block truncate text-[11px] text-white/60">{entry.note}</span>
              )}
            </button>
            {busy === entry.url && (
              <span className="shrink-0 text-[10px] text-white/40">连接中…</span>
            )}
            <NoteEditButton onClick={() => startNoteEdit(entry.url)} />
          </div>
          {noteTarget === entry.url && noteInput}
        </div>
      ))}

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
      <p className="mt-2 text-[10px] leading-4 text-white/30">桌面应用内可用 ⇧⌘M 回到本机窗口。</p>
    </section>
  )
}

/** 行尾的铅笔：鼠标移到这一行才浮出来（触屏没有悬停，常显） */
function NoteEditButton({ onClick }) {
  return (
    <button
      type="button"
      title="备注"
      aria-label="备注"
      className="shrink-0 rounded-sm p-0.5 text-white/35 opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover/server:opacity-100 max-md:opacity-100"
      onClick={onClick}
    >
      <IconPencil size={12} />
    </button>
  )
}

/**
 * 备注的就地编辑器：回车或失焦保存、Esc 取消（Esc 不能冒泡出去，否则整张卡片会跟着关掉）。
 */
function NoteInput({ value, onChange, onSave, onCancel }) {
  const cancelled = useRef(false)
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      cancelled.current = true
      onCancel()
      return
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      onSave()
    }
  }
  const onBlur = () => {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    onSave()
  }

  return (
    <div className="flex items-center gap-2 border-t border-line px-2.5 py-1.5">
      <input
        autoFocus
        value={value}
        maxLength={MAX_SERVER_NOTE_LENGTH}
        spellCheck={false}
        placeholder="备注，如「办公室的 Mac」"
        className="h-7 min-w-0 flex-1 rounded-sm border border-white/15 bg-white/[.04] px-2 text-[11px] text-white placeholder:text-white/25 focus:border-white/30"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      <span className="shrink-0 text-[10px] text-white/30">回车保存</span>
    </div>
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
