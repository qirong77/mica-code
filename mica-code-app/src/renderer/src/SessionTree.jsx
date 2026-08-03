import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Bell,
  ChevronRight,
  Folder,
  FolderOpen,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  Pin,
  Plus,
  Search,
  X
} from 'lucide-react'
import { relativeTimeShort } from './relative-time'
import { liveSessionRowState } from './session-state'

const rowClass =
  'group relative flex min-h-6.5 cursor-pointer items-center gap-1.5 rounded-sm pr-2 text-[13px] hover:bg-white/[.045] hover:text-white active:bg-white/[.07]'

/** 取路径最后一段作为文件夹名 */
function baseName(cwd) {
  const trimmed = String(cwd || '').replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

/** 父目录的 ~ 缩写提示：/Users/x/a/test -> ~/a */
function parentHint(cwd, homeDir) {
  const trimmed = String(cwd || '').replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  const parent = index > 0 ? trimmed.slice(0, index) : '/'
  if (homeDir && parent === homeDir) return '~'
  if (homeDir && parent.startsWith(`${homeDir}/`)) return `~${parent.slice(homeDir.length)}`
  return parent
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

/** 按 cwd 自动分组：同一路径的 session 归入同一文件夹；保持输入顺序 */
function groupByCwd(sessions, homeDir) {
  const buckets = new Map()
  let index = 0
  for (const session of sessions) {
    const cwd = session.cwd
    const key = cwd || '~'
    const bucket = buckets.get(key)
    const row = { session, cwd, index: index++ }
    if (bucket) bucket.rows.push(row)
    else buckets.set(key, { key, cwd, rows: [row] })
  }
  const groups = [...buckets.values()].map((g) => {
    const label = g.cwd ? baseName(g.cwd) : '未分组'
    return { ...g, label, firstIndex: Math.min(...g.rows.map((r) => r.index)) }
  })
  const labelCounts = new Map()
  for (const g of groups) labelCounts.set(g.label, (labelCounts.get(g.label) || 0) + 1)
  return groups
    .map((g) =>
      labelCounts.get(g.label) > 1 && g.cwd
        ? { ...g, hint: parentHint(g.cwd, homeDir) }
        : { ...g, hint: null }
    )
    .sort((a, b) => a.firstIndex - b.firstIndex)
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

function ContextMenu({ menu, onClose, onAction }) {
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

  const items = menu.items || []
  return createPortal(
    <div
      data-session-menu
      className="fixed z-[10000] min-w-37 rounded-md border border-white/15 bg-[#181818]/98 p-1.5 shadow-2xl backdrop-blur"
      style={{ top: menu.y, left: menu.x }}
    >
      {items.map(([action, label]) => (
        <button
          key={action}
          type="button"
          className={`block w-full rounded-sm px-2.5 py-1.5 text-left text-xs hover:bg-white/[.07] ${action === 'close' ? 'text-[#e75e78]' : 'text-white/90'}`}
          onClick={() => {
            onClose()
            onAction(action, menu)
          }}
        >
          {label}
        </button>
      ))}
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
  homeDir,
  onOpenSession,
  onSelectDraft,
  onTogglePin,
  onRenameSession,
  onRenameDraft,
  onCloseSession,
  onCloseDraft,
  onCreateSession,
  onReorderSessions
}) {
  const [menu, setMenu] = useState(null)
  const [editing, setEditing] = useState(null) // { kind: 'session'|'draft', id }
  const [query, setQuery] = useState('')
  const [collapsedSections, setCollapsedSections] = useState({
    pinned: false,
    sessions: false,
    recent: false
  })
  const [inboxOpen, setInboxOpen] = useState(true)
  const [sessionsCollapsed, setSessionsCollapsed] = useState(new Set())
  const [drag, setDrag] = useState(null) // { section, kind: 'row'|'group', id, key }
  const [over, setOver] = useState(null) // { section, kind, id, key, position: 'before'|'after' }
  const normalizedQuery = query.trim().toLocaleLowerCase()

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
  const sessionList = useMemo(
    () => orderSessions(searchable, sortOrder.sessions || [], byUpdatedDesc),
    [searchable, sortOrder.sessions]
  )
  const sessionGroups = useMemo(() => groupByCwd(sessionList, homeDir), [sessionList, homeDir])
  const recentList = useMemo(() => {
    const sorted = [...searchable].sort(byUpdatedDesc)
    return normalizedQuery ? sorted : sorted.slice(0, 20)
  }, [normalizedQuery, searchable])
  const inboxItems = useMemo(() => {
    const items = []
    for (const session of sessions) {
      const nodeId = openBySession[session.id]
      const state = nodeId ? unread[nodeId] : null
      if (state?.unread || state?.running) items.push({ key: nodeId, nodeId, session, state })
    }
    for (const draft of draftTabs) {
      const state = unread[draft.id]
      if (state?.unread || state?.running) {
        items.push({ key: draft.id, nodeId: draft.id, draft, state })
      }
    }
    return items.sort((a, b) => (b.state.lastEventAt || 0) - (a.state.lastEventAt || 0))
  }, [draftTabs, openBySession, sessions, unread])
  const expandedSessions = (key) => normalizedQuery || !sessionsCollapsed.has(key)
  const sectionOpen = (name) => normalizedQuery || !collapsedSections[name]
  const toggleSection = (name) => setCollapsedSections((prev) => ({ ...prev, [name]: !prev[name] }))
  const toggleSessionGroup = (key) =>
    setSessionsCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const openMenu = (event, payload) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      ...payload,
      x: Math.max(4, Math.min(event.clientX, window.innerWidth - 160)),
      y: Math.max(4, Math.min(event.clientY, window.innerHeight - 190))
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
    if (openBySession[session.id]) items.push(['close', '关闭对话'])
    return items
  }

  const groupKeyOf = (session) => session.cwd || '~'
  const sectionItems = { pinned, sessions: sessionList }
  const orderedIds = (section, items) =>
    orderSessions(items, sortOrder[section] || [], byUpdatedDesc).map((session) => session.id)

  const startDrag = (event, section, kind, id, key) => {
    setDrag({ section, kind, id, key })
    event.dataTransfer.effectAllowed = 'move'
  }
  const clearDrag = () => {
    setDrag(null)
    setOver(null)
  }
  const hoverRow = (section, id) => (event) => {
    if (!drag || drag.section !== section || drag.kind !== 'row' || drag.id === id) return
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setOver((current) =>
      current?.section === section && current?.id === id && current?.position === position
        ? current
        : { section, kind: 'row', id, position }
    )
  }
  const hoverGroup = (section, key) => (event) => {
    if (!drag || drag.section !== section || drag.kind !== 'group' || drag.key === key) return
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setOver((current) =>
      current?.section === section && current?.key === key && current?.position === position
        ? current
        : { section, kind: 'group', key, position }
    )
  }
  const dropRow = (section, targetId) => (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!drag || drag.section !== section || drag.kind !== 'row' || drag.id === targetId) {
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
  const dropGroup = (section, targetKey) => (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!drag || drag.section !== section || drag.kind !== 'group' || drag.key === targetKey) {
      clearDrag()
      return
    }
    const items = sectionItems[section]
    const dragIds = items.filter((session) => groupKeyOf(session) === drag.key).map((s) => s.id)
    const targetIds = items.filter((session) => groupKeyOf(session) === targetKey).map((s) => s.id)
    const ids = orderedIds(section, items).filter((id) => !dragIds.includes(id))
    const at = ids.indexOf(targetIds[0])
    if (at >= 0) {
      const insertAt = over?.position === 'before' ? at : at + targetIds.length
      ids.splice(insertAt, 0, ...dragIds)
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
    const isOver = over?.section === section && over?.kind === 'row' && over?.id === session.id
    const draggingThis = drag?.section === section && drag?.kind === 'row' && drag.id === session.id
    const reorderable = section !== 'recent'
    const relativeTime = section === 'recent' ? relativeTimeShort(session.updatedAtMs) : ''
    return (
      <li key={session.id}>
        <div
          className={`${rowClass} ${active ? 'bg-white/[.075] text-white' : 'text-white/70'} ${draggingThis ? 'opacity-40' : ''}`}
          style={{
            paddingLeft: 7 + indent * 14,
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
          onDragStart={
            reorderable ? (event) => startDrag(event, section, 'row', session.id) : undefined
          }
          onDragEnd={reorderable ? clearDrag : undefined}
          onDragOver={reorderable ? hoverRow(section, session.id) : undefined}
          onDrop={reorderable ? dropRow(section, session.id) : undefined}
          onClick={() => onOpenSession(session)}
        >
          <span className="size-3.5 shrink-0" />
          <span className="grid size-3.5 shrink-0 place-items-center text-white/50">
            <MessageSquare size={14} />
          </span>
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
            <span className="min-w-0 flex-1 truncate">{session.title || session.id}</span>
          )}
          <span className="relative flex min-w-5 shrink-0 items-center justify-end">
            <span
              className={`flex items-center justify-end gap-1.5 transition-opacity ${editingThis ? '' : 'group-hover:opacity-0 group-focus-within:opacity-0'}`}
            >
              {relativeTime && (
                <span
                  className="shrink-0 text-[10px] tabular-nums text-white/30"
                  title={new Date(session.updatedAtMs).toLocaleString()}
                >
                  {relativeTime}
                </span>
              )}
              {state === 'running' && (
                <span
                  className="size-1.75 shrink-0 rounded-full bg-[#46c57a] ring-2 ring-[#46c57a]/15 chat-dot-running"
                  title="Mica 或终端任务正在运行"
                />
              )}
              {state === 'unread' && (
                <span
                  key={unreadState?.lastEventAt ?? 'unread'}
                  className="size-1.75 shrink-0 rounded-full bg-[#5aa7e8] ring-2 ring-[#5aa7e8]/20 chat-dot-unread"
                  title="任务已完成，有未读结果"
                />
              )}
            </span>
            {!editingThis && (
              <button
                type="button"
                title="更多操作"
                aria-label="更多操作"
                className="absolute right-0 grid size-5 place-items-center rounded text-white/40 opacity-0 transition-opacity hover:bg-white/[.1] hover:text-white group-hover:opacity-100 focus:opacity-100"
                onClick={(event) => openMenu(event, { session, items: sessionMenuItems(session) })}
              >
                <MoreHorizontal size={14} />
              </button>
            )}
          </span>
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
          className={`${rowClass} ${active ? 'bg-white/[.075] text-white' : 'text-white/70'}`}
          style={{ paddingLeft: 7 }}
          title="尚未关联真实会话的新对话"
          onClick={() => onSelectDraft(node)}
        >
          <span className="size-3.5 shrink-0" />
          <span className="grid size-3.5 shrink-0 place-items-center text-white/50">
            <MessageSquare size={14} />
          </span>
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
            <span className="min-w-0 flex-1 truncate">{node.text}</span>
          )}
          <span className="relative flex min-w-5 shrink-0 items-center justify-end">
            <span
              className={`flex items-center justify-end gap-1.5 transition-opacity ${editingThis ? '' : 'group-hover:opacity-0 group-focus-within:opacity-0'}`}
            >
              {state === 'running' && (
                <span
                  className="size-1.75 shrink-0 rounded-full bg-[#46c57a] ring-2 ring-[#46c57a]/15 chat-dot-running"
                  title="Mica 或终端任务正在运行"
                />
              )}
              {state === 'unread' && (
                <span
                  key={unread[node.id]?.lastEventAt ?? 'unread'}
                  className="size-1.75 shrink-0 rounded-full bg-[#5aa7e8] ring-2 ring-[#5aa7e8]/20 chat-dot-unread"
                  title="任务已完成，有未读结果"
                />
              )}
            </span>
            {!editingThis && (
              <button
                type="button"
                title="更多操作"
                aria-label="更多操作"
                className="absolute right-0 grid size-5 place-items-center rounded text-white/40 opacity-0 transition-opacity hover:bg-white/[.1] hover:text-white group-hover:opacity-100 focus:opacity-100"
                onClick={(event) =>
                  openMenu(event, {
                    draft: node,
                    items: [
                      ['rename', '重命名'],
                      ['close', '关闭对话']
                    ]
                  })
                }
              >
                <MoreHorizontal size={14} />
              </button>
            )}
          </span>
        </div>
      </li>
    )
  }

  const renderGroup = (group, expanded, onToggle, indent, section) => {
    const isOver = over?.section === section && over?.kind === 'group' && over?.key === group.key
    const draggingThis =
      drag?.section === section && drag?.kind === 'group' && drag.key === group.key
    return (
      <li key={group.key}>
        <div
          className={`${rowClass} text-white/70 ${draggingThis ? 'opacity-40' : ''}`}
          style={{
            paddingLeft: 7 + indent * 14,
            boxShadow:
              isOver && over.position === 'before'
                ? 'inset 0 2px 0 rgba(90,167,232,.9)'
                : isOver && over.position === 'after'
                  ? 'inset 0 -2px 0 rgba(90,167,232,.9)'
                  : undefined
          }}
          title={group.cwd || undefined}
          draggable
          onDragStart={(event) => startDrag(event, section, 'group', null, group.key)}
          onDragEnd={clearDrag}
          onDragOver={hoverGroup(section, group.key)}
          onDrop={dropGroup(section, group.key)}
          onClick={() => onToggle(group.key)}
        >
          <button
            type="button"
            aria-label={expanded ? '折叠' : '展开'}
            className="grid size-3.5 shrink-0 place-items-center text-white/35"
            onClick={(event) => {
              event.stopPropagation()
              onToggle(group.key)
            }}
          >
            <ChevronRight size={13} className={expanded ? 'rotate-90' : ''} />
          </button>
          <span className="grid size-3.5 shrink-0 place-items-center text-white/50">
            {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
          </span>
          <span className="min-w-0 flex-1 truncate">{group.label}</span>
          {group.hint && (
            <span className="shrink-0 truncate text-[11px] text-white/35">{group.hint}</span>
          )}
          <span className="relative grid size-5 shrink-0 place-items-center">
            <span
              className={`text-[11px] text-white/30 transition-opacity ${group.cwd ? 'group-hover:opacity-0 group-focus-within:opacity-0' : ''}`}
            >
              {group.rows.length}
            </span>
            {group.cwd && (
              <button
                type="button"
                draggable={false}
                title={`在 ${group.cwd} 中新建 Session`}
                aria-label={`在 ${group.label} 中新建 Session`}
                className="absolute inset-0 grid place-items-center rounded text-white/45 opacity-0 transition-opacity hover:bg-white/[.1] hover:text-white group-hover:opacity-100 focus:opacity-100"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onCreateSession(group.cwd)
                }}
              >
                <Plus size={14} />
              </button>
            )}
          </span>
        </div>
        {expanded && (
          <ul className="flex flex-col gap-px">
            {group.rows.map((row) => renderSessionRow(row.session, indent + 1, section))}
          </ul>
        )}
      </li>
    )
  }

  const menuNode = menu
  const renderSectionHeader = (name, label, Icon) => (
    <div className="flex h-8 items-center gap-0.5 px-2 pt-1">
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left text-[11px] font-semibold uppercase tracking-[.18em] text-white/75 hover:text-white"
        aria-expanded={sectionOpen(name)}
        onClick={() => toggleSection(name)}
      >
        <ChevronRight
          size={14}
          className={`text-white/55 transition-transform ${sectionOpen(name) ? 'rotate-90' : ''}`}
        />
        <Icon size={14} className="text-white/55" />
        {label}
      </button>
    </div>
  )

  return (
    <>
      <div className="hidden-scrollbar min-h-0 flex-1 overflow-auto px-2 pt-1 no-drag">
        <div className="mb-1 flex items-center gap-1.5 border-b border-transparent px-2 pt-1 focus-within:border-white/20">
          <Search size={14} className="shrink-0 text-white/40" />
          <input
            type="search"
            value={query}
            placeholder="搜索会话..."
            aria-label="搜索会话"
            className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-white placeholder:text-white/35 focus:outline-none"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              title="清除搜索"
              aria-label="清除搜索"
              className="grid size-5 place-items-center rounded text-white/40 hover:bg-white/[.08] hover:text-white"
              onClick={() => setQuery('')}
            >
              <X size={14} />
            </button>
          )}
        </div>

        <section className="mb-1">
          <button
            type="button"
            className="flex h-8 w-full items-center gap-1.5 px-2 pt-1 text-left text-[11px] font-semibold uppercase tracking-[.18em] text-white/75 hover:text-white"
            aria-expanded={inboxOpen}
            onClick={() => setInboxOpen((value) => !value)}
          >
            <ChevronRight
              size={14}
              className={`text-white/55 transition-transform ${inboxOpen ? 'rotate-90' : ''}`}
            />
            <Bell size={14} className="text-white/55" />
            <span className="min-w-0 flex-1">Inbox</span>
            {inboxItems.length > 0 && (
              <span className="rounded-full bg-white/[.08] px-1.5 text-[10px] font-normal tracking-normal text-white/55">
                {inboxItems.length}
              </span>
            )}
          </button>
          {inboxOpen && (
            <div className="flex flex-col gap-px">
              {inboxItems.length ? (
                inboxItems.map((item) => {
                  const active = item.session
                    ? activeSessionId === item.session.id
                    : item.nodeId === selectedId
                  const title = item.session?.title || item.draft?.text || item.nodeId
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`${rowClass} ${active ? 'bg-white/[.075] text-white' : 'text-white/70'}`}
                      title={title}
                      onClick={() =>
                        item.session ? onOpenSession(item.session) : onSelectDraft(item.draft)
                      }
                    >
                      <span className="size-3.5 shrink-0" />
                      <Bell size={13} className="shrink-0 text-white/45" />
                      <span className="min-w-0 flex-1 truncate text-left">{title}</span>
                      <span
                        className={`size-1.75 shrink-0 rounded-full ${item.state.running ? 'bg-[#46c57a] ring-2 ring-[#46c57a]/15 chat-dot-running' : 'bg-[#5aa7e8] ring-2 ring-[#5aa7e8]/20 chat-dot-unread'}`}
                        title={item.state.running ? '正在运行' : '有未读结果'}
                      />
                    </button>
                  )
                })
              ) : (
                <div className="px-7 py-1 text-xs text-white/30">暂无消息</div>
              )}
            </div>
          )}
        </section>

        <div className="flex flex-col gap-px">
          <section>
            {renderSectionHeader('pinned', 'Pinned', Pin)}
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
            {renderSectionHeader('recent', 'Recent', ListTree)}
            {sectionOpen('recent') &&
              (recentList.length ? (
                <ul role="tree" className="flex flex-col gap-px">
                  {recentList.map((session) => renderSessionRow(session, 0, 'recent'))}
                </ul>
              ) : (
                <p className="py-1 pl-7 pr-2 text-xs text-white/35">暂无最近会话。</p>
              ))}
          </section>

          <section>
            {renderSectionHeader('sessions', 'Sessions', ListTree)}
            {sectionOpen('sessions') && (
              <>
                <ul role="tree" className="flex flex-col gap-px">
                  {draftTabs.map((node) => renderDraftRow(node))}
                  {sessionGroups.map((group) =>
                    renderGroup(
                      group,
                      expandedSessions(group.key),
                      toggleSessionGroup,
                      0,
                      'sessions'
                    )
                  )}
                </ul>
                {!sessionGroups.length && !draftTabs.length && (
                  <p className="py-1 pl-7 pr-2 text-xs text-white/35">暂无会话。</p>
                )}
              </>
            )}
          </section>
        </div>
      </div>
      {menuNode && (
        <ContextMenu menu={menuNode} onClose={() => setMenu(null)} onAction={runAction} />
      )}
    </>
  )
}
