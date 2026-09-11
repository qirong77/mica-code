import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconChevronRight,
  IconDots,
  IconFolder,
  IconListTree,
  IconPin,
  IconPlus,
  IconSearch,
  IconTerminal2,
  IconX
} from '@tabler/icons-react'
import { relativeTimeShort } from './relative-time'
import { liveSessionRowState } from './session-state'
import { byUpdatedDesc, orderSessions, resolveDrop } from './session-dnd'
import { childGroups, sessionSectionOf, sessionsByGroup } from './session-projects'
import { longPressHandlers } from './hooks'

const rowClass =
  'group relative flex min-h-6 cursor-pointer items-center gap-2 rounded-md pr-2 pl-2 text-sm leading-5 text-white/70 transition-colors hover:bg-white/[.06] hover:text-white active:bg-white/[.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20'

const groupRowClass =
  'group/grow relative flex min-h-6 cursor-pointer items-center gap-2 rounded-md pr-1.5 pl-2 text-sm leading-5 text-white/70 transition-colors hover:bg-white/[.06] hover:text-white'

const dropShadow = 'inset 0 0 0 1px rgba(90,167,232,.9)'

const RECENT_PREVIEW_LIMIT = 6

const RECENT_PAGE_SIZE = 10

/** 取路径最后一段作为文件夹名 */
function baseName(cwd) {
  const trimmed = String(cwd || '').replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
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

// 行首状态位固定 w-4：终端前台进程在跑（如 npm run dev）时显示终端图标，Mica 对话
// 运行中显示呼吸绿点，上一轮没跑完（中断/崩溃）显示常亮红点，否则显示未读圆点。
// 终端图标与圆点同时存在时把圆点叠在图标右上角，绝不额外占位——否则这一行整体右推，
// 与相邻行的缩进对不齐。
function RowLeading({ state, unreadKey, terminal }) {
  const unread = state === 'unread'
  const running = state === 'running'
  const errored = state === 'error'
  const corner = errored ? 'bg-danger' : unread ? 'bg-info chat-dot-unread' : null
  return (
    <span className="relative grid w-4 shrink-0 place-items-center">
      {terminal ? (
        <span className="text-success chat-terminal-active" title="该会话有终端在运行">
          <IconTerminal2 size={13} stroke={2} />
        </span>
      ) : running ? (
        <span
          className="size-2 shrink-0 rounded-full bg-success chat-dot-running"
          title="对话正在运行"
        />
      ) : errored ? (
        <span className="size-2 shrink-0 rounded-full bg-danger" title="上一轮没有正常运行完成" />
      ) : unread ? (
        <span
          key={unreadKey}
          className="size-2 shrink-0 rounded-full bg-info chat-dot-unread"
          title="有未读结果"
        />
      ) : null}
      {terminal && corner ? (
        <span
          key={errored ? 'error' : unreadKey}
          className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full ${corner}`}
          title={errored ? '上一轮没有正常运行完成' : '有未读结果'}
        />
      ) : null}
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
      className="fixed z-[10000] min-w-[200px] rounded-md border border-white/12 bg-panel/98 p-1 shadow-2xl backdrop-blur"
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
              danger ? 'text-danger' : 'text-white/90'
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
  projects,
  draftGroups,
  draftTabs,
  openBySession,
  activeSessionId,
  selectedId,
  unread,
  terminalSessions,
  onOpenSession,
  onSelectDraft,
  onTogglePin,
  onMoveSession,
  onMoveDraft,
  onRenameSession,
  onRenameDraft,
  onCloseSession,
  onCloseDraft,
  onReorderSessions,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onCreateSessionInGroup
}) {
  const [menu, setMenu] = useState(null)
  const [editing, setEditing] = useState(null) // { kind: 'session'|'draft'|'group', id }
  const [query, setQuery] = useState('')
  const [collapsedSections, setCollapsedSections] = useState({
    pinned: false,
    recent: false,
    project: false
  })
  const [collapsedGroups, setCollapsedGroups] = useState({})
  const [recentLimit, setRecentLimit] = useState(RECENT_PREVIEW_LIMIT)
  const [drag, setDrag] = useState(null) // { kind, id, section, groupId }
  const [over, setOver] = useState(null) // { section, id?, groupId?, position?, cross?, header? }
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const sectionOf = useCallback(
    (sessionId) => sessionSectionOf(sessionId, { pins, projects }),
    [pins, projects]
  )

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
        searchable.filter((session) => sectionOf(session.id).section === 'pinned'),
        sortOrder.pinned || [],
        (a, b) => (pins[b.id] || 0) - (pins[a.id] || 0)
      ),
    [searchable, sectionOf, pins, sortOrder.pinned]
  )
  const recentCandidates = useMemo(
    () =>
      searchable
        .filter((session) => sectionOf(session.id).section === 'recent')
        .sort(byUpdatedDesc),
    [searchable, sectionOf]
  )
  const recentList = useMemo(
    () => (normalizedQuery ? recentCandidates : recentCandidates.slice(0, recentLimit)),
    [normalizedQuery, recentCandidates, recentLimit]
  )
  const recentOverflow = Math.max(0, recentCandidates.length - recentList.length)
  const recentPageSize = Math.min(RECENT_PAGE_SIZE, recentOverflow)
  useEffect(() => {
    if (normalizedQuery) setRecentLimit(RECENT_PREVIEW_LIMIT)
  }, [normalizedQuery])

  const sessionById = useMemo(
    () => new Map(searchable.map((session) => [session.id, session])),
    [searchable]
  )
  // groupId -> 直接归属该分组的会话（已按分组自己的手动顺序排好）。置顶的会话即便还留着
  // 归属也只在 Pinned 出现，保证同一个会话在侧栏里只有一处。
  const groupSessions = useMemo(() => {
    const byGroup = sessionsByGroup(projects)
    const map = new Map()
    for (const [groupId, ids] of byGroup) {
      const items = ids
        .map((id) => sessionById.get(id))
        .filter((session) => session && !pins[session.id])
      map.set(groupId, orderSessions(items, sortOrder[`project:${groupId}`] || [], byUpdatedDesc))
    }
    return map
  }, [pins, projects, sessionById, sortOrder])

  const groupIds = useMemo(
    () => new Set((projects?.groups || []).map((group) => group.id)),
    [projects]
  )
  const rootDrafts = []
  const draftsByGroup = new Map()
  for (const node of draftTabs) {
    const groupId = draftGroups?.[node.id]
    if (groupId && groupIds.has(groupId)) {
      if (!draftsByGroup.has(groupId)) draftsByGroup.set(groupId, [])
      draftsByGroup.get(groupId).push(node)
    } else {
      rootDrafts.push(node)
    }
  }

  /** 搜索时只保留命中会话所在的分组（含其祖先分组）。 */
  const visibleGroups = useMemo(() => {
    if (!normalizedQuery) return null
    const visible = new Set()
    const walk = (group) => {
      let hit = (groupSessions.get(group.id)?.length || 0) > 0
      for (const child of childGroups(projects, group.id)) if (walk(child)) hit = true
      if (hit) visible.add(group.id)
      return hit
    }
    for (const group of childGroups(projects, null)) walk(group)
    return visible
  }, [projects, groupSessions, normalizedQuery])

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
  const openMenuAtElement = (event, payload) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ ...payload, x: rect.right, y: rect.bottom + 2 })
  }

  const runAction = (action, menuPayload) => {
    if (action === 'pin' || action === 'unpin') onTogglePin(menuPayload.session.id)
    else if (action === 'unassign') onMoveSession(menuPayload.session.id, { section: 'recent' })
    else if (action === 'rename') setEditing({ kind: 'session', id: menuPayload.session.id })
    else if (action === 'close')
      menuPayload.session
        ? onCloseSession(menuPayload.session.id)
        : onCloseDraft(menuPayload.draft.id)
    else if (action === 'rename-group') setEditing({ kind: 'group', id: menuPayload.group.id })
    else if (action === 'new-subgroup') onCreateGroup(menuPayload.group.id)
    else if (action === 'new-session') onCreateSessionInGroup(menuPayload.group.id)
    else if (action === 'delete-group') onDeleteGroup(menuPayload.group.id)
  }

  const sessionMenuItems = (session) => {
    const items = []
    if (pins[session.id]) items.push(['unpin', '取消置顶'])
    else items.push(['pin', '置顶'])
    if (sectionOf(session.id).section === 'project') items.push(['unassign', '移出项目分组'])
    items.push(['rename', '重命名'])
    if (openBySession[session.id]) {
      items.push('separator')
      items.push(['close', '关闭对话', true])
    }
    return items
  }

  const groupMenuItems = () => [
    ['new-session', '在此新建会话'],
    ['new-subgroup', '新建子分组'],
    ['rename-group', '重命名分组'],
    'separator',
    ['delete-group', '删除分组', true]
  ]

  const sectionItems = { pinned }
  const sectionOrderKey = (section, groupId) =>
    section === 'project' ? `project:${groupId}` : section

  const startDrag = (event, kind, section, id, groupId = null) => {
    setDrag({ kind, section, id, groupId })
    event.dataTransfer.effectAllowed = 'move'
    // Firefox 不设置 data 就不会真的开始拖拽
    event.dataTransfer.setData('text/plain', id)
  }
  const clearDrag = () => {
    setDrag(null)
    setOver(null)
  }
  const moveDragged = (source, target) => {
    if (source.kind === 'draft') onMoveDraft?.(source.id, target)
    else onMoveSession?.(source.id, target)
  }

  const hoverRow =
    (section, id, groupId = null) =>
    (event) => {
      if (!drag || drag.id === id) return
      event.preventDefault()
      event.stopPropagation()
      const sameTarget = (drag.groupId ?? null) === (groupId ?? null)
      if (drag.section !== section || !sameTarget) {
        setOver({ section, id, groupId, cross: true })
        return
      }
      if (section === 'recent') return
      const rect = event.currentTarget.getBoundingClientRect()
      const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
      setOver((current) =>
        current?.section === section &&
        current?.id === id &&
        current?.groupId === groupId &&
        current?.position === position
          ? current
          : { section, id, groupId, position }
      )
    }

  const dropRow =
    (section, targetId, groupId = null) =>
    (event) => {
      event.preventDefault()
      event.stopPropagation()
      const source = drag
      const position = over?.section === section && over?.id === targetId ? over.position : null
      clearDrag()
      const items =
        (section === 'project' ? groupSessions.get(groupId) : sectionItems[section]) || []
      const plan = resolveDrop({
        drag: source,
        section,
        targetId,
        groupId,
        items,
        order: sortOrder[sectionOrderKey(section, groupId)] || [],
        position
      })
      if (!plan) return
      if (plan.kind === 'move') moveDragged(source, plan.target)
      else onReorderSessions(sectionOrderKey(section, groupId), plan.ids)
    }

  const rowOverState = (section, id, groupId = null) =>
    over?.id === id && over?.section === section && (over?.groupId ?? null) === (groupId ?? null)

  const renderSessionRow = (session, indent, section, groupId = null) => {
    const nodeId = openBySession[session.id]
    const active = !!nodeId && activeSessionId === session.id
    const state = liveSessionRowState({
      notificationState: unread[nodeId],
      interrupted: session.interrupted
    })
    const unreadState = unread[nodeId]
    const editingThis = editing?.kind === 'session' && editing.id === session.id
    const isOver = rowOverState(section, session.id, groupId)
    const draggingThis = drag?.id === session.id && drag?.kind === 'session'
    const relativeTime = section === 'recent' ? relativeTimeShort(session.updatedAtMs) : ''
    // Recent 行首显示工作目录名，方便区分同名会话。
    const cwdLabel = section === 'recent' ? baseName(session.cwd) : ''
    return (
      <li key={session.id}>
        <div
          className={`${rowClass} ${active ? 'bg-white/[.1] text-white' : 'text-white/70'} ${draggingThis ? 'opacity-40' : ''}`}
          style={{
            paddingLeft: 8 + indent * 13,
            boxShadow: isOver
              ? over.cross
                ? dropShadow
                : over.position === 'before'
                  ? 'inset 0 2px 0 rgba(90,167,232,.9)'
                  : 'inset 0 -2px 0 rgba(90,167,232,.9)'
              : undefined
          }}
          title={
            session.cwd
              ? `${session.title || session.id} — ${session.cwd}`
              : session.title || session.id
          }
          draggable={!editingThis}
          onDragStart={(event) => startDrag(event, 'session', section, session.id, groupId)}
          onDragEnd={clearDrag}
          onDragOver={hoverRow(section, session.id, groupId)}
          onDrop={dropRow(section, session.id, groupId)}
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
            <span className="min-w-0 flex-1 truncate">{session.title || session.id}</span>
          )}
          <RowTail relativeTime={relativeTime} />
        </div>
      </li>
    )
  }

  const renderDraftRow = (node, indent = 0, groupId = null) => {
    const active = node.id === activeSessionId || node.id === selectedId
    const state = liveSessionRowState({ notificationState: unread[node.id] })
    const editingThis = editing?.kind === 'draft' && editing.id === node.id
    const dropSection = groupId ? 'project' : 'recent'
    const isOver = rowOverState(dropSection, node.id, groupId)
    const items = [['rename', '重命名'], 'separator', ['close', '关闭对话', true]]
    return (
      <li key={node.id}>
        <div
          className={`${rowClass} ${active ? 'bg-white/[.1] text-white' : 'text-white/70'} ${drag?.kind === 'draft' && drag.id === node.id ? 'opacity-40' : ''}`}
          style={{
            paddingLeft: 8 + indent * 13,
            boxShadow: isOver ? dropShadow : undefined
          }}
          title="尚未关联真实会话的新对话"
          draggable={!editingThis}
          onDragStart={(event) => startDrag(event, 'draft', 'draft', node.id, groupId)}
          onDragEnd={clearDrag}
          onDragOver={hoverRow(dropSection, node.id, groupId)}
          onDrop={dropRow(dropSection, node.id, groupId)}
          onClick={() => onSelectDraft(node)}
          onContextMenu={(event) => openMenu(event, { draft: node, items })}
          {...longPressHandlers((event) => openMenu(event, { draft: node, items }))}
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
            <span className="min-w-0 flex-1 truncate">{node.text}</span>
          )}
          <RowTail relativeTime="" />
        </div>
      </li>
    )
  }

  const renderGroup = (group, depth = 0) => {
    if (visibleGroups && !visibleGroups.has(group.id)) return null
    const nesting = childGroups(projects, group.id)
    const groupId = group.id
    const sessionsHere = groupSessions.get(groupId) || []
    const draftsHere = draftsByGroup.get(groupId) || []
    const collapsed = !!collapsedGroups[groupId]
    const open = normalizedQuery ? true : !collapsed
    const editingThis = editing?.kind === 'group' && editing.id === groupId
    const isOver = over?.section === 'project' && over?.groupId === groupId && over?.onGroup
    const childRows = [
      ...nesting.map((child) => renderGroup(child, depth + 1)).filter(Boolean),
      ...draftsHere.map((node) => renderDraftRow(node, depth + 1, groupId)),
      ...sessionsHere.map((session) => renderSessionRow(session, depth + 1, 'project', groupId))
    ]
    const toggleOpen = () => setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }))
    return (
      <li key={groupId}>
        <div
          className={groupRowClass}
          style={{ paddingLeft: 8 + depth * 13, boxShadow: isOver ? dropShadow : undefined }}
          title={group.name}
          onClick={toggleOpen}
          onContextMenu={(event) => openMenu(event, { group, items: groupMenuItems() })}
          {...longPressHandlers((event) => openMenu(event, { group, items: groupMenuItems() }))}
          onDragOver={(event) => {
            if (!drag) return
            if (drag.section === 'project' && drag.groupId === groupId) return
            event.preventDefault()
            event.stopPropagation()
            setOver({ section: 'project', groupId, onGroup: true })
          }}
          onDrop={(event) => {
            event.preventDefault()
            event.stopPropagation()
            const source = drag
            clearDrag()
            // 落到分组行本身就是「移入这个分组」；已经在该分组里的会话会在决策里被判为无操作
            const plan = resolveDrop({ drag: source, section: 'project', targetId: null, groupId })
            if (plan?.kind === 'move') moveDragged(source, plan.target)
          }}
        >
          <button
            type="button"
            aria-label={open ? `折叠 ${group.name}` : `展开 ${group.name}`}
            aria-expanded={open}
            className="grid size-4 shrink-0 place-items-center rounded text-white/35 hover:text-white"
            onClick={toggleOpen}
          >
            <IconChevronRight
              size={13}
              className={`transition-transform ${open ? 'rotate-90' : ''}`}
            />
          </button>
          {editingThis ? (
            <RenameInput
              value={group.name}
              onCommit={(value) => {
                const text = value.trim()
                if (text) onRenameGroup(groupId, text)
                setEditing(null)
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{group.name}</span>
          )}
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/grow:opacity-100 focus-within:opacity-100 max-md:opacity-100">
            <button
              type="button"
              title="在此分组新建会话"
              aria-label={`在 ${group.name} 中新建会话`}
              className="grid size-5 shrink-0 place-items-center rounded text-white/45 hover:bg-white/[.12] hover:text-white"
              onClick={(event) => {
                event.stopPropagation()
                onCreateSessionInGroup(groupId)
              }}
            >
              <IconPlus size={13} />
            </button>
            <button
              type="button"
              title="分组操作"
              aria-label={`${group.name} 分组操作`}
              className="grid size-5 shrink-0 place-items-center rounded text-white/45 hover:bg-white/[.12] hover:text-white"
              onClick={(event) => openMenuAtElement(event, { group, items: groupMenuItems() })}
            >
              <IconDots size={13} />
            </button>
          </span>
        </div>
        {open && childRows.length > 0 && <ul className="flex flex-col gap-px">{childRows}</ul>}
      </li>
    )
  }

  const menuNode = menu
  const renderSectionHeader = (name, label, Icon, options = {}) => {
    const { onAdd, addTitle, dropSection } = options
    const isOverHeader = !!dropSection && over?.header === dropSection
    return (
      <div
        className="group/header mt-1 flex h-6 items-center rounded-md"
        style={{ boxShadow: isOverHeader ? dropShadow : undefined }}
        onDragOver={
          dropSection
            ? (event) => {
                if (!drag) return
                event.preventDefault()
                setOver({ header: dropSection })
              }
            : undefined
        }
        onDrop={
          dropSection
            ? (event) => {
                event.preventDefault()
                const source = drag
                clearDrag()
                const plan = resolveDrop({
                  drag: source,
                  section: dropSection,
                  targetId: null,
                  groupId: null
                })
                if (plan?.kind === 'move') moveDragged(source, plan.target)
              }
            : undefined
        }
      >
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
        {onAdd && (
          <button
            type="button"
            title={addTitle}
            aria-label={addTitle}
            className="mr-1 grid size-5 shrink-0 place-items-center rounded text-white/40 opacity-0 transition-opacity group-hover/header:opacity-100 hover:bg-white/[.1] hover:text-white focus-visible:opacity-100 max-md:opacity-100"
            onClick={onAdd}
          >
            <IconPlus size={14} />
          </button>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2 no-drag">
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
            {renderSectionHeader('pinned', 'Pinned', IconPin, { dropSection: 'pinned' })}
            {sectionOpen('pinned') &&
              (pinned.length ? (
                <ul className="flex flex-col gap-px">
                  {pinned.map((session) => renderSessionRow(session, 0, 'pinned'))}
                </ul>
              ) : (
                <p className="py-1 pl-8 pr-2 text-xs text-white/35">暂无置顶会话。</p>
              ))}
          </section>

          <section>
            {renderSectionHeader('project', 'Projects', IconFolder, {
              onAdd: () => onCreateGroup(null),
              addTitle: '新建分组'
            })}
            {sectionOpen('project') &&
              (projects?.groups?.length ? (
                <ul role="tree" className="flex flex-col gap-px">
                  {childGroups(projects, null).map((group) => renderGroup(group))}
                </ul>
              ) : (
                <p className="py-1 pl-8 pr-2 text-xs text-white/35">
                  暂无项目分组，先新建一个分组。
                </p>
              ))}
          </section>

          <section>
            {renderSectionHeader('recent', 'Recent', IconListTree, { dropSection: 'recent' })}
            {sectionOpen('recent') &&
              (recentList.length || rootDrafts.length ? (
                <>
                  <ul role="tree" className="flex flex-col gap-px">
                    {rootDrafts.map((node) => renderDraftRow(node))}
                    {recentList.map((session) => renderSessionRow(session, 0, 'recent'))}
                  </ul>
                  {recentOverflow > 0 && !normalizedQuery && (
                    <button
                      type="button"
                      className={`${rowClass} w-full text-white/45 hover:text-white/75`}
                      style={{ paddingLeft: 8 }}
                      onClick={() => setRecentLimit((prev) => prev + RECENT_PAGE_SIZE)}
                    >
                      <span className="grid w-4 shrink-0 place-items-center text-white/35">
                        <IconDots size={14} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-left text-[13px]">
                        Show {recentPageSize} more
                      </span>
                    </button>
                  )}
                </>
              ) : (
                <p className="py-1 pl-8 pr-2 text-xs text-white/35">暂无最近会话。</p>
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
