import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconChevronRight,
  IconDots,
  IconListTree,
  IconPin,
  IconSearch,
  IconTerminal2,
  IconX
} from '@tabler/icons-react'
import { relativeTimeShort } from './relative-time'
import { liveSessionRowState } from './session-state'
import { longPressHandlers } from './hooks'

const rowClass =
  'group relative flex min-h-6 cursor-pointer items-center gap-2 rounded-md pr-2 pl-2 text-sm leading-5 text-white/70 transition-colors hover:bg-white/[.06] hover:text-white active:bg-white/[.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20'

const RECENT_PREVIEW_LIMIT = 6

/** 取路径最后一段作为文件夹名 */
function baseName(cwd) {
  const trimmed = String(cwd || '').replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

/** 按手动顺序排序，未收录的新会话按 fallback 追加到末尾 */
function orderSessions(items, order, fallback) {
  const byId = new Map(items.map((session) => [session.id, session]))
  const known = order.map((id) => byId.get(id)).filter(Boolean)
  const seen = new Set(known.map((session) => session.id))
  const rest = items.filter((session) => !seen.has(session.id)).sort(fallback)
  return [...known, ...rest]
}

function byUpdatedDesc(a, b) {
  return (b.updatedAtMs || 0) - (a.updatedAtMs || 0)
}

function RenameInput({ value, onCommit, onCancel }) {
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      defaultValue={value}
      spellCheck={false}
      className="h-5 min-w-0 flex-1 rounded-sm border border-white/20 bg-white/[.06] px-1.5 text-[13px] text-white"
      onClick={(event) => event.stopPropagation()}
      onBlur={(event) => onCommit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
    />
  )
}

function RowTail({ relativeTime }) {
  return (
    <span className="relative flex min-w-4 shrink-0 items-center justify-end">
      <span className="block shrink-0 text-[11px] tabular-nums text-white/30">{relativeTime}</span>
    </span>
  )
}

// 行首状态位固定 w-4：终端前台进程在跑（如 npm run dev）时显示终端图标，否则显示
// 未读圆点。两者同时存在时把未读点叠在图标右上角，绝不额外占位——否则这一行整体
// 右推，与相邻行的缩进对不齐。运行中的会话改用标题文字呼吸绿，不再有旋转图标。
function RowLeading({ state, unreadKey, terminal }) {
  const unread = state === 'unread'
  return (
    <span className="relative grid w-4 shrink-0 place-items-center">
      {terminal ? (
        <span className="text-[#46c57a] chat-terminal-active" title="该会话有终端在运行">
          <IconTerminal2 size={13} stroke={2} />
        </span>
      ) : unread ? (
        <span
          key={unreadKey}
          className="size-2 shrink-0 rounded-full bg-[#5aa7e8] chat-dot-unread"
          title="有未读结果"
        />
      ) : null}
      {terminal && unread && (
        <span
          key={unreadKey}
          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-[#5aa7e8] chat-dot-unread"
          title="有未读结果"
        />
      )}
    </span>
  )
}

function ContextMenu({ menu, onClose, onAction }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })
  useEffect(() => {
    const close = (event) => {
      if (!event.target.closest?.('[data-session-menu]')) onClose()
    }
    const escape = (event) => event.key === 'Escape' && onClose()
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [onClose])

  useLayoutEffect(() => {
    if (!ref.current) return
    const w = ref.current.offsetWidth
    const h = ref.current.offsetHeight
    let px = menu.x
    let py = menu.y
    if (px + w > window.innerWidth - 4) px = Math.max(4, window.innerWidth - w - 4)
    if (py + h > window.innerHeight - 4) py = Math.max(4, window.innerHeight - h - 4)
    setPos({ x: px, y: py })
  }, [menu.x, menu.y])

  const items = menu.items || []
  return createPortal(
    <div
      ref={ref}
      data-session-menu
      className="fixed z-[10000] min-w-[200px] rounded-md border border-white/12 bg-[#1c1c1e]/98 p-1 shadow-2xl backdrop-blur"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item, index) => {
        if (item === 'separator')
          return <div key={`sep-${index}`} className="mx-1 my-1 h-px bg-white/10" />
        const [action, label, danger] = item
        return (
          <button
            key={action}
            type="button"
            aria-label={label}
            className={`flex h-7 w-full items-center px-2 text-left text-[13px] transition-colors hover:bg-white/[.08] ${
              danger ? 'text-[#e75e78]' : 'text-white/90'
            }`}
            onClick={() => {
              onClose()
              onAction(action, menu)
            }}
          >
            {label}
          </button>
        )
      })}
    </div>,
    document.body
  )
}

export function SessionTree({
  sessions,
  pins,
  sortOrder,
  draftTabs,
  openBySession,
  activeSessionId,
  selectedId,
  unread,
  terminalSessions,
  onOpenSession,
  onSelectDraft,
  onTogglePin,
  onRenameSession,
  onRenameDraft,
  onCloseSession,
  onCloseDraft,
  onReorderSessions
}) {
  const [menu, setMenu] = useState(null)
  const [editing, setEditing] = useState(null) // { kind: 'session'|'draft', id }
  const [query, setQuery] = useState('')
  const [collapsedSections, setCollapsedSections] = useState({
    pinned: false,
    recent: false
  })
  const [expandedRecent, setExpandedRecent] = useState(false)
  const [drag, setDrag] = useState(null) // { section, id }
  const [over, setOver] = useState(null) // { section, id, position: 'before'|'after' }
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const groupKeyOf = (session) => session.cwd || '~'

  const searchable = useMemo(
    () =>
      sessions.filter(
        (session) =>
          !normalizedQuery ||
          (session.title || '').toLocaleLowerCase().includes(normalizedQuery) ||
          (session.cwd || '').toLocaleLowerCase().includes(normalizedQuery)
      ),
    [sessions, normalizedQuery]
  )
  const pinned = useMemo(
    () =>
      orderSessions(
        searchable.filter((session) => pins[session.id]),
        sortOrder.pinned || [],
        (a, b) => (pins[b.id] || 0) - (pins[a.id] || 0)
      ),
    [searchable, pins, sortOrder.pinned]
  )
  const recentCandidates = useMemo(
    () => [...searchable].filter((session) => !pins[session.id]).sort(byUpdatedDesc),
    [pins, searchable]
  )
  const recentList = useMemo(
    () =>
      normalizedQuery || expandedRecent
        ? recentCandidates
        : recentCandidates.slice(0, RECENT_PREVIEW_LIMIT),
    [expandedRecent, normalizedQuery, recentCandidates]
  )
  const recentOverflow = Math.max(0, recentCandidates.length - recentList.length)
  useEffect(() => {
    if (normalizedQuery) setExpandedRecent(false)
  }, [normalizedQuery])
  const sectionOpen = (name) => normalizedQuery || !collapsedSections[name]
  const toggleSection = (name) => setCollapsedSections((prev) => ({ ...prev, [name]: !prev[name] }))
  const openMenu = (event, payload) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      ...payload,
      x: event.clientX,
      y: event.clientY
    })
  }

  const runAction = (action, menuPayload) => {
    if (action === 'pin') onTogglePin(menuPayload.session.id)
    else if (action === 'unpin') onTogglePin(menuPayload.session.id)
    else if (action === 'rename') setEditing({ kind: 'session', id: menuPayload.session.id })
    else if (action === 'close')
      menuPayload.session
        ? onCloseSession(menuPayload.session.id)
        : onCloseDraft(menuPayload.draft.id)
  }

  const sessionMenuItems = (session) => {
    const items = []
    if (pins[session.id]) items.push(['unpin', '取消置顶'])
    else items.push(['pin', '置顶'])
    items.push(['rename', '重命名'])
    if (openBySession[session.id]) {
      items.push('separator')
      items.push(['close', '关闭对话', true])
    }
    return items
  }

  const sectionItems = { pinned }
  const orderedIds = (section, items) =>
    orderSessions(items, sortOrder[section] || [], byUpdatedDesc).map((session) => session.id)

  const startDrag = (event, section, id) => {
    setDrag({ section, id })
    event.dataTransfer.effectAllowed = 'move'
  }
  const clearDrag = () => {
    setDrag(null)
    setOver(null)
  }
  const hoverRow = (section, id) => (event) => {
    if (!drag || drag.section !== section || drag.id === id) return
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setOver((current) =>
      current?.section === section && current?.id === id && current?.position === position
        ? current
        : { section, id, position }
    )
  }
  const dropRow = (section, targetId) => (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!drag || drag.section !== section || drag.id === targetId) {
      clearDrag()
      return
    }
    const items = sectionItems[section]
    const byId = new Map(items.map((session) => [session.id, session]))
    if (groupKeyOf(byId.get(drag.id)) !== groupKeyOf(byId.get(targetId))) {
      clearDrag()
      return
    }
    const ids = orderedIds(section, items)
    const from = ids.indexOf(drag.id)
    const to = ids.indexOf(targetId)
    if (from >= 0 && to >= 0) {
      ids.splice(from, 1)
      const at = ids.indexOf(targetId)
      ids.splice(over?.position === 'before' ? at : at + 1, 0, drag.id)
      onReorderSessions(section, ids)
    }
    clearDrag()
  }

  const renderSessionRow = (session, indent, section) => {
    const nodeId = openBySession[session.id]
    const active = !!nodeId && activeSessionId === session.id
    const state = liveSessionRowState({
      notificationState: unread[nodeId],
      persistedTurnState: session.turnState
    })
    const unreadState = unread[nodeId]
    const editingThis = editing?.kind === 'session' && editing.id === session.id
    const isOver = over?.section === section && over?.id === session.id
    const draggingThis = drag?.section === section && drag.id === session.id
    const reorderable = section !== 'recent'
    const relativeTime = section === 'recent' ? relativeTimeShort(session.updatedAtMs) : ''
    // Recent 行首显示工作目录名，方便区分同名会话。
    const cwdLabel = section === 'recent' ? baseName(session.cwd) : ''
    return (
      <li key={session.id}>
        <div
          className={`${rowClass} ${active ? 'bg-white/[.1] text-white' : 'text-white/70'} ${draggingThis ? 'opacity-40' : ''}`}
          style={{
            paddingLeft: 8 + indent * 13,
            boxShadow:
              isOver && over.position === 'before'
                ? 'inset 0 2px 0 rgba(90,167,232,.9)'
                : isOver && over.position === 'after'
                  ? 'inset 0 -2px 0 rgba(90,167,232,.9)'
                  : undefined
          }}
          title={
            session.cwd
              ? `${session.title || session.id} — ${session.cwd}`
              : session.title || session.id
          }
          draggable={reorderable && !editingThis}
          onDragStart={reorderable ? (event) => startDrag(event, section, session.id) : undefined}
          onDragEnd={reorderable ? clearDrag : undefined}
          onDragOver={reorderable ? hoverRow(section, session.id) : undefined}
          onDrop={reorderable ? dropRow(section, session.id) : undefined}
          onClick={() => onOpenSession(session)}
          onContextMenu={(event) => openMenu(event, { session, items: sessionMenuItems(session) })}
          {...longPressHandlers((event) =>
            openMenu(event, { session, items: sessionMenuItems(session) })
          )}
        >
          <RowLeading
            state={state}
            unreadKey={unreadState?.lastEventAt ?? 'running'}
            terminal={!!session.id && !!terminalSessions?.has(session.id)}
          />
          {cwdLabel && (
            <span
              className="max-w-[45%] shrink-0 truncate text-[11px] text-white/30"
              title={session.cwd}
            >
              {cwdLabel}
            </span>
          )}
          {editingThis ? (
            <RenameInput
              value={session.title || session.id}
              onCommit={(value) => {
                const text = value.trim()
                if (text) onRenameSession(session.id, text)
                setEditing(null)
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <span
              className={`min-w-0 flex-1 truncate ${state === 'running' ? 'chat-running-text' : ''}`}
            >
              {session.title || session.id}
            </span>
          )}
          <RowTail relativeTime={relativeTime} />
        </div>
      </li>
    )
  }

  const renderDraftRow = (node) => {
    const active = node.id === activeSessionId || node.id === selectedId
    const state = liveSessionRowState({ notificationState: unread[node.id] })
    const editingThis = editing?.kind === 'draft' && editing.id === node.id
    return (
      <li key={node.id}>
        <div
          className={`${rowClass} ${active ? 'bg-white/[.1] text-white' : 'text-white/70'}`}
          style={{ paddingLeft: 8 }}
          title="尚未关联真实会话的新对话"
          onClick={() => onSelectDraft(node)}
          onContextMenu={(event) =>
            openMenu(event, {
              draft: node,
              items: [['rename', '重命名'], 'separator', ['close', '关闭对话', true]]
            })
          }
          {...longPressHandlers((event) =>
            openMenu(event, {
              draft: node,
              items: [['rename', '重命名'], 'separator', ['close', '关闭对话', true]]
            })
          )}
        >
          <RowLeading state={state} unreadKey={unread[node.id]?.lastEventAt ?? 'running'} />
          {editingThis ? (
            <RenameInput
              value={node.text}
              onCommit={(value) => {
                const text = value.trim()
                if (text) onRenameDraft(node.id, text)
                setEditing(null)
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <span
              className={`min-w-0 flex-1 truncate ${state === 'running' ? 'chat-running-text' : ''}`}
            >
              {node.text}
            </span>
          )}
          <RowTail relativeTime="" />
        </div>
      </li>
    )
  }

  const menuNode = menu
  const renderSectionHeader = (name, label, Icon) => (
    <div className="mt-1 flex h-6 items-center">
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[13px] font-medium text-white/45 transition-colors hover:bg-white/[.05] hover:text-white/85"
        aria-expanded={sectionOpen(name)}
        onClick={() => toggleSection(name)}
      >
        <IconChevronRight
          size={14}
          className={`shrink-0 text-white/30 transition-transform ${sectionOpen(name) ? 'rotate-90' : ''}`}
        />
        <Icon size={14} className="shrink-0 text-white/30" />
        <span className="flex-1 truncate text-white/50">{label}</span>
      </button>
    </div>
  )

  return (
    <>
      <div className="hidden-scrollbar min-h-0 flex-1 overflow-auto px-2 pb-2 no-drag">
        <div className="mb-1.5 flex h-7 items-center gap-1.5 rounded-md bg-white/[.05] px-2 transition-colors focus-within:bg-white/[.08]">
          <IconSearch size={13} className="shrink-0 text-white/35" />
          <input
            type="search"
            value={query}
            placeholder="搜索会话..."
            aria-label="搜索会话"
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-white placeholder:text-white/35 focus:outline-none"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              title="清除搜索"
              aria-label="清除搜索"
              className="grid size-5 shrink-0 place-items-center rounded text-white/40 hover:bg-white/[.1] hover:text-white"
              onClick={() => setQuery('')}
            >
              <IconX size={14} />
            </button>
          )}
        </div>

        <div className="flex flex-col gap-px">
          <section>
            {renderSectionHeader('pinned', 'Pinned', IconPin)}
            {sectionOpen('pinned') &&
              (pinned.length ? (
                <ul className="flex flex-col gap-px">
                  {pinned.map((session) => renderSessionRow(session, 0, 'pinned'))}
                </ul>
              ) : (
                <p className="py-1 pl-7 pr-2 text-xs text-white/35">暂无置顶会话。</p>
              ))}
          </section>

          <section>
            {renderSectionHeader('recent', 'Recent', IconListTree)}
            {sectionOpen('recent') &&
              (recentList.length || draftTabs.length ? (
                <>
                  <ul role="tree" className="flex flex-col gap-px">
                    {draftTabs.map((node) => renderDraftRow(node))}
                    {recentList.map((session) => renderSessionRow(session, 0, 'recent'))}
                  </ul>
                  {recentOverflow > 0 && !normalizedQuery && (
                    <button
                      type="button"
                      className={`${rowClass} w-full text-white/45 hover:text-white/75`}
                      style={{ paddingLeft: 8 }}
                      onClick={() => setExpandedRecent(true)}
                    >
                      <span className="grid w-4 shrink-0 place-items-center text-white/35">
                        <IconDots size={14} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-left text-[13px]">
                        Show {recentOverflow} more
                      </span>
                    </button>
                  )}
                </>
              ) : (
                <p className="py-1 pl-7 pr-2 text-xs text-white/35">暂无最近会话。</p>
              ))}
          </section>
        </div>
      </div>
      {menuNode && (
        <ContextMenu menu={menuNode} onClose={() => setMenu(null)} onAction={runAction} />
      )}
    </>
  )
}
