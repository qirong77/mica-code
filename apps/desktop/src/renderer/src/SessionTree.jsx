import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import {
  IconChevronRight,
  IconDots,
  IconFolder,
  IconFolderOpen,
  IconListTree,
  IconPencil,
  IconPin,
  IconPlus,
  IconSearch,
  IconTerminal2,
  IconX
} from '@tabler/icons-react'
import { relativeTimeShort } from './relative-time'
import { collectGroupStates, liveSessionRowState, mergeRowStates } from './session-state'
import { byUpdatedDesc, orderSessions, resolveDrop } from './session-dnd'
import { draftMenuItems, sessionMenuItems } from './session-menu'
import { childGroups, groupSubtreeIds, sessionSectionOf, sessionsByGroup } from './session-projects'
import { longPressHandlers } from './hooks'

// 会话详情弹窗复用 Stats 页的组件，按需加载——stats 目录的代码不进启动路径。
const SessionDetailModal = lazy(() =>
  import('./stats/SessionDetailModal').then((m) => ({ default: m.SessionDetailModal }))
)

const rowClass =
  'group relative flex min-h-6 cursor-pointer items-center gap-2 rounded-md pr-2 text-sm leading-5 text-white/70 transition-colors hover:bg-white/[.06] hover:text-white active:bg-white/[.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20'

const groupRowClass =
  'group/grow relative flex min-h-6 cursor-pointer items-center gap-2 rounded-md pr-1.5 text-sm leading-5 text-white/70 transition-colors hover:bg-white/[.06] hover:text-white'

const dropShadow = 'inset 0 0 0 1px rgba(90,167,232,.9)'

const RECENT_PREVIEW_LIMIT = 6

const RECENT_PAGE_SIZE = 10

// 侧栏的列栅格：每一行（分区标题 / 分组 / 会话）都是同样的
// `[操作列 w-4][图标列 w-4][名称]`，行内左右各 8px、列间距 8px（gap-2），
// 名称因此落在「行左 + 56px」（绝对 64px）。
// 会话行第一列留空、状态位放进图标列，所以分区标题、分组名、会话标题全在同一个名称列上。
// **只有容器再套容器（分组套分组）才右移 TREE_STEP**：容器里的会话/草稿与容器同列，
// 这样一级分组的会话和 Recent 的会话严格对齐，树的缩进档位只有「每层分组」这一种。
// 改这几列时必须同步 renderSectionHeader 与空状态，否则又会错开一列。
const ROW_PAD = 8

const COLUMN = 16 // w-4

const GAP = 8 // gap-2

// 一层分组恰好右移一整列（列宽 + 列间距）：嵌套分组的箭头正好落在父分组的图标列上。
const TREE_STEP = COLUMN + GAP

const NAME_OFFSET = ROW_PAD + COLUMN + GAP + COLUMN + GAP

const rowIndent = (depth) => ROW_PAD + depth * TREE_STEP

/** 固定宽度的列位：没有内容时也占位，保证各行的名称都在同一列。 */
function Slot({ children }) {
  return <span className="relative grid w-4 shrink-0 place-items-center">{children}</span>
}

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

// 行尾固定右对齐：可选的工作目录标签 + 相对时间。工作目录放在行尾（而不是标题前）
// 是为了让 Recent 的标题都在同一列——标签宽度随目录名变化会把标题推得参差不齐。
function RowTail({ label, labelTitle, relativeTime }) {
  return (
    <span className="relative flex min-w-4 shrink-0 items-center justify-end gap-2">
      {label && (
        <span className="max-w-[88px] truncate text-[11px] text-white/30" title={labelTitle}>
          {label}
        </span>
      )}
      <span className="block shrink-0 text-[11px] tabular-nums text-white/30">{relativeTime}</span>
    </span>
  )
}

// 行首状态位固定 w-4：终端前台进程在跑（如 npm run dev）时显示终端图标，输入框里还
// 有没发出去的文本时显示呼吸的铅笔（切走之后输入框看不见了，只能靠这里提示），Mica
// 对话运行中显示呼吸绿点，上一轮没跑完（中断/崩溃）显示常亮红点，否则显示未读圆点。
// 主图标（终端 / 未发送文本）占状态位、turn 状态缩成右上角小圆点叠在它上面，绝不额外
// 占位——否则这一行整体右推，与相邻行的缩进对不齐。
function RowLeading({ state, unreadKey, terminal, draft }) {
  const unread = state === 'unread'
  const running = state === 'running'
  const errored = state === 'error'
  const icon = terminal ? 'terminal' : draft ? 'draft' : null
  const corner = errored
    ? 'bg-danger'
    : unread
      ? 'bg-info chat-dot-unread'
      : running
        ? 'bg-success chat-dot-running'
        : null
  const cornerTitle = errored ? '上一轮没有正常运行完成' : unread ? '有未读结果' : '对话正在运行'
  return (
    <span className="relative grid w-4 shrink-0 place-items-center">
      {icon === 'terminal' ? (
        <span className="text-success chat-terminal-active" title="该会话有终端在运行">
          <IconTerminal2 size={13} stroke={2} />
        </span>
      ) : icon === 'draft' ? (
        <span className="text-warn chat-draft-pending" title="输入框里还有未发送的内容">
          <IconPencil size={13} stroke={2} />
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
      {icon && corner ? (
        <span
          key={errored ? 'error' : unread ? unreadKey : 'running'}
          className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full ${corner}`}
          title={cornerTitle}
        />
      ) : null}
    </span>
  )
}

// 折叠起来的容器（分组 / 分区 / Recent 的 Show more）自己看不见里面的会话，就替
// 它们显示状态：图标列已被文件夹/分区图标占着，所以圆点按角标叠在图标右上角——
// 和 RowLeading 里「终端图标 + 未读」同一种做法，绝不额外占位，否则这一行的名称
// 会错开一列。`scope` 是容器名，只用来把 tooltip 说清楚。异常中断的会话不上浮
// （见 session-state.js 的 mergeRowStates），所以这里只有 running / unread 两种。
function RowBadge({ state, scope }) {
  if (!state) return null
  const className = state === 'running' ? 'bg-success chat-dot-running' : 'bg-info chat-dot-unread'
  const what = state === 'running' ? '有会话正在运行' : '有未读结果'
  return (
    <span
      // 状态从 running 变 unread 时要重放那一下短闪，和 RowLeading 同款
      key={state}
      className={`absolute -top-0.5 -right-0.5 size-2 rounded-full ${className}`}
      title={scope ? `${scope}里${what}` : what}
    />
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
  draftNodes,
  onOpenSession,
  onSelectDraft,
  onTogglePin,
  onMoveSession,
  onMoveDraft,
  onRenameSession,
  onRenameDraft,
  onDeleteSession,
  onDeleteDraft,
  onReorderSessions,
  onCreateGroup,
  onRenameGroup,
  onMoveGroup,
  onDeleteGroup,
  onCreateSessionInGroup
}) {
  const [menu, setMenu] = useState(null)
  const [detailSessionId, setDetailSessionId] = useState(null)
  const [editing, setEditing] = useState(null) // { kind: 'session'|'draft'|'group', id }
  const [query, setQuery] = useState('')
  const [collapsedSections, setCollapsedSections] = useState({
    pinned: false,
    recent: false,
    project: false
  })
  const [collapsedGroups, setCollapsedGroups] = useState({})
  const [recentLimit, setRecentLimit] = useState(RECENT_PREVIEW_LIMIT)
  const [drag, setDrag] = useState(null) // { kind: 'session'|'draft'|'group', id, section, groupId }
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
  const { rootDrafts, draftsByGroup } = useMemo(() => {
    const root = []
    const byGroup = new Map()
    for (const node of draftTabs) {
      const groupId = draftGroups?.[node.id]
      if (groupId && groupIds.has(groupId)) {
        if (!byGroup.has(groupId)) byGroup.set(groupId, [])
        byGroup.get(groupId).push(node)
      } else {
        root.push(node)
      }
    }
    return { rootDrafts: root, draftsByGroup: byGroup }
  }, [draftGroups, draftTabs, groupIds])

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

  // 侧栏看不见的会话——分组折叠、分区折叠、Recent 的 Show more 分页——由第一个可见的
  // 祖先代为显示状态。行的状态判定与 renderSessionRow/renderDraftRow 共用同一份回调，
  // 否则「代显的状态」和「真正被藏起来的行」会分叉。
  const rowStateOfSession = useCallback(
    (session) =>
      liveSessionRowState({
        notificationState: unread[openBySession[session.id]],
        interrupted: session.interrupted,
        remoteRunning: session.remoteRunning
      }),
    [openBySession, unread]
  )
  const rowStateOfDraft = useCallback(
    (node) => liveSessionRowState({ notificationState: unread[node.id] }),
    [unread]
  )

  /** 分组子树（含后代分组）的合并状态；展开的分组不代显，子行自己会显示。 */
  const hiddenGroupStates = useMemo(
    () =>
      collectGroupStates({
        projects,
        sessionsByGroup: groupSessions,
        draftsByGroup,
        stateOfSession: rowStateOfSession,
        stateOfDraft: rowStateOfDraft
      }),
    [draftsByGroup, groupSessions, projects, rowStateOfDraft, rowStateOfSession]
  )

  /**
   * 折叠起来的容器要代显的状态。每个被藏起来的行只有一个代显者：分区折叠由标题
   * 代显，分组折叠由分组图标代显，Recent 的分页由「Show N more」那一行代显。
   */
  const hiddenStates = useMemo(() => {
    const hidden = (name) => !normalizedQuery && !!collapsedSections[name]
    const overflow = normalizedQuery ? [] : recentCandidates.slice(recentList.length)
    return {
      pinned: hidden('pinned') ? mergeRowStates(pinned.map(rowStateOfSession)) : null,
      project: hidden('project')
        ? mergeRowStates(
            childGroups(projects, null).map((group) => hiddenGroupStates.get(group.id))
          )
        : null,
      // 折叠时整个分区都看不见（根草稿也在里面），展开时只剩被 Show more 截掉的那些
      recent: hidden('recent')
        ? mergeRowStates([
            ...recentCandidates.map(rowStateOfSession),
            ...rootDrafts.map(rowStateOfDraft)
          ])
        : null,
      recentOverflow: mergeRowStates(overflow.map(rowStateOfSession))
    }
  }, [
    collapsedSections,
    hiddenGroupStates,
    normalizedQuery,
    pinned,
    projects,
    recentCandidates,
    recentList,
    rootDrafts,
    rowStateOfDraft,
    rowStateOfSession
  ])

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
    else if (action === 'detail') setDetailSessionId(menuPayload.session.id)
    else if (action === 'rename') setEditing({ kind: 'session', id: menuPayload.session.id })
    else if (action === 'delete')
      menuPayload.session
        ? onDeleteSession(menuPayload.session.id)
        : onDeleteDraft(menuPayload.draft.id)
    else if (action === 'rename-group') setEditing({ kind: 'group', id: menuPayload.group.id })
    else if (action === 'new-subgroup') onCreateGroup(menuPayload.group.id)
    else if (action === 'new-session') onCreateSessionInGroup(menuPayload.group.id)
    else if (action === 'delete-group') onDeleteGroup(menuPayload.group.id)
  }

  const menuItemsFor = (session) =>
    sessionMenuItems({
      pinned: !!pins[session.id],
      inProject: sectionOf(session.id).section === 'project'
    })

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

  /** 分组行的落点是否成立：不能落进自己或自己的子树，也不能是当前父级。 */
  const canNestInto = (draggedId, targetGroupId) => {
    if (!draggedId || !targetGroupId || draggedId === targetGroupId) return false
    if (groupSubtreeIds(projects, draggedId).has(targetGroupId)) return false
    const dragged = (projects?.groups || []).find((group) => group.id === draggedId)
    return (dragged?.parentId ?? null) !== targetGroupId
  }

  // 一次 drop 的统一出口：分组落到分组行/Projects 标题 = 换父级，会话照旧搬分区或重排。
  const applyDrop = (
    source,
    { section, targetId = null, groupId = null, items, order, position }
  ) => {
    const plan = resolveDrop({
      drag: source,
      section,
      targetId,
      groupId,
      groups: projects?.groups || [],
      items,
      order,
      position
    })
    if (!plan) return
    if (plan.kind === 'move') moveDragged(source, plan.target)
    else if (plan.kind === 'move-group') onMoveGroup?.(plan.groupId, plan.parentId)
    else onReorderSessions(sectionOrderKey(section, groupId), plan.ids)
  }

  const hoverRow =
    (section, id, groupId = null) =>
    (event) => {
      if (!drag || drag.id === id) return
      // 分组只落在分组行与 Projects 标题上，落到会话行不做任何反应
      if (drag.kind === 'group') return
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
      if (source?.kind === 'group') return
      const items =
        (section === 'project' ? groupSessions.get(groupId) : sectionItems[section]) || []
      applyDrop(source, {
        section,
        targetId,
        groupId,
        items,
        order: sortOrder[sectionOrderKey(section, groupId)] || [],
        position
      })
    }

  const rowOverState = (section, id, groupId = null) =>
    over?.id === id && over?.section === section && (over?.groupId ?? null) === (groupId ?? null)

  const renderSessionRow = (session, indent, section, groupId = null) => {
    const nodeId = openBySession[session.id]
    const active = !!nodeId && activeSessionId === session.id
    const state = rowStateOfSession(session)
    const unreadState = unread[nodeId]
    const editingThis = editing?.kind === 'session' && editing.id === session.id
    const isOver = rowOverState(section, session.id, groupId)
    const draggingThis = drag?.id === session.id && drag?.kind === 'session'
    const relativeTime = section === 'recent' ? relativeTimeShort(session.updatedAtMs) : ''
    // Recent 行尾显示工作目录名，方便区分同名会话。
    const cwdLabel = section === 'recent' ? baseName(session.cwd) : ''
    return (
      <li key={session.id}>
        <div
          className={`${rowClass} ${active ? 'bg-white/[.1] text-white' : 'text-white/70'} ${draggingThis ? 'opacity-40' : ''}`}
          style={{
            paddingLeft: rowIndent(indent),
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
          // 长按手势必须排在拖拽回调之前：它会带回自己的 onDragStart，排在后面会把 startDrag 顶掉
          {...longPressHandlers((event) =>
            openMenu(event, { session, items: menuItemsFor(session) })
          )}
          onDragStart={(event) => startDrag(event, 'session', section, session.id, groupId)}
          onDragEnd={clearDrag}
          onDragOver={hoverRow(section, session.id, groupId)}
          onDrop={dropRow(section, session.id, groupId)}
          onClick={() => onOpenSession(session)}
          onContextMenu={(event) => openMenu(event, { session, items: menuItemsFor(session) })}
        >
          <Slot />
          <RowLeading
            state={state}
            unreadKey={unreadState?.lastEventAt ?? 'running'}
            terminal={!!session.id && !!terminalSessions?.has(session.id)}
            draft={!!nodeId && !!draftNodes?.has(nodeId)}
          />
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
          <RowTail label={cwdLabel} labelTitle={session.cwd} relativeTime={relativeTime} />
        </div>
      </li>
    )
  }

  const renderDraftRow = (node, indent = 0, groupId = null) => {
    const active = node.id === activeSessionId || node.id === selectedId
    const state = rowStateOfDraft(node)
    const editingThis = editing?.kind === 'draft' && editing.id === node.id
    const dropSection = groupId ? 'project' : 'recent'
    const isOver = rowOverState(dropSection, node.id, groupId)
    const items = draftMenuItems()
    return (
      <li key={node.id}>
        <div
          className={`${rowClass} ${active ? 'bg-white/[.1] text-white' : 'text-white/70'} ${drag?.kind === 'draft' && drag.id === node.id ? 'opacity-40' : ''}`}
          style={{
            paddingLeft: rowIndent(indent),
            boxShadow: isOver ? dropShadow : undefined
          }}
          title="尚未关联真实会话的新对话"
          draggable={!editingThis}
          {...longPressHandlers((event) => openMenu(event, { draft: node, items }))}
          onDragStart={(event) => startDrag(event, 'draft', 'draft', node.id, groupId)}
          onDragEnd={clearDrag}
          onDragOver={hoverRow(dropSection, node.id, groupId)}
          onDrop={dropRow(dropSection, node.id, groupId)}
          onClick={() => onSelectDraft(node)}
          onContextMenu={(event) => openMenu(event, { draft: node, items })}
        >
          <Slot />
          <RowLeading
            state={state}
            unreadKey={unread[node.id]?.lastEventAt ?? 'running'}
            draft={!!draftNodes?.has(node.id)}
          />
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
    // 只有子分组右移一层；分组里的会话/草稿与分组名同列（和 Recent 的会话对齐）。
    const childRows = [
      ...nesting.map((child) => renderGroup(child, depth + 1)).filter(Boolean),
      ...draftsHere.map((node) => renderDraftRow(node, depth, groupId)),
      ...sessionsHere.map((session) => renderSessionRow(session, depth, 'project', groupId))
    ]
    const toggleOpen = () => setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }))
    return (
      <li key={groupId}>
        <div
          className={`${groupRowClass} ${drag?.kind === 'group' && drag.id === groupId ? 'opacity-40' : ''}`}
          style={{ paddingLeft: rowIndent(depth), boxShadow: isOver ? dropShadow : undefined }}
          title={group.name}
          draggable={!editingThis}
          // 长按手势必须排在拖拽回调之前：它会带回自己的 onDragStart，排在后面会把 startDrag 顶掉
          {...longPressHandlers((event) => openMenu(event, { group, items: groupMenuItems() }))}
          onDragStart={(event) =>
            startDrag(event, 'group', 'project', groupId, group.parentId ?? null)
          }
          onDragEnd={clearDrag}
          onClick={toggleOpen}
          onContextMenu={(event) => openMenu(event, { group, items: groupMenuItems() })}
          onDragOver={(event) => {
            if (!drag) return
            if (drag.kind === 'group') {
              // 拖进自己的子树会成环；本来就挂在这个父级下也没什么可做的
              if (!canNestInto(drag.id, groupId)) return
            } else if (drag.section === 'project' && drag.groupId === groupId) return
            event.preventDefault()
            event.stopPropagation()
            setOver({ section: 'project', groupId, onGroup: true })
          }}
          onDrop={(event) => {
            event.preventDefault()
            event.stopPropagation()
            const source = drag
            clearDrag()
            // 落到分组行本身就是「移入这个分组」/「挂到这个分组下」；
            // 已经在里面的会在决策里被判为无操作
            applyDrop(source, { section: 'project', groupId })
          }}
        >
          <Slot>
            <button
              type="button"
              aria-label={open ? `折叠 ${group.name}` : `展开 ${group.name}`}
              aria-expanded={open}
              className="grid size-4 place-items-center rounded text-white/35 hover:text-white"
              // 冒泡到分组行会再触发一次 toggleOpen，两次抵消等于点了没反应
              onClick={(event) => {
                event.stopPropagation()
                toggleOpen()
              }}
            >
              <IconChevronRight
                size={13}
                className={`transition-transform ${open ? 'rotate-90' : ''}`}
              />
            </button>
          </Slot>
          <Slot>
            <span className="text-white/40" title="分组">
              {open ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
            </span>
            <RowBadge state={open ? null : hiddenGroupStates.get(groupId)} scope={group.name} />
          </Slot>
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
    const { onAdd, addTitle, dropSection, accepts, hiddenState } = options
    const isOverHeader = !!dropSection && over?.header === dropSection
    // 默认只接会话/草稿：分组换父级是 Projects 标题与分组行的事，落到别处不做任何反应
    const acceptsDrag = (source) =>
      !!source && (accepts ? accepts(source) : source.kind !== 'group')
    return (
      <div
        className="group/header mt-1 flex h-6 items-center rounded-md"
        style={{ paddingLeft: rowIndent(0), boxShadow: isOverHeader ? dropShadow : undefined }}
        onDragOver={
          dropSection
            ? (event) => {
                if (!acceptsDrag(drag)) return
                event.preventDefault()
                setOver({ header: dropSection })
              }
            : undefined
        }
        onDrop={
          dropSection
            ? (event) => {
                if (!acceptsDrag(drag)) return
                event.preventDefault()
                const source = drag
                clearDrag()
                applyDrop(source, { section: dropSection })
              }
            : undefined
        }
      >
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left text-[13px] font-medium text-white/45 transition-colors hover:bg-white/[.05] hover:text-white/85"
          // sectionOpen 返回的是查询串或布尔值，aria 只接受 "true"/"false"
          aria-expanded={!!sectionOpen(name)}
          onClick={() => toggleSection(name)}
        >
          <Slot>
            <IconChevronRight
              size={14}
              className={`text-white/30 transition-transform ${sectionOpen(name) ? 'rotate-90' : ''}`}
            />
          </Slot>
          <Slot>
            <Icon size={14} className="text-white/30" />
            <RowBadge state={hiddenState} scope={label} />
          </Slot>
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
            {renderSectionHeader('pinned', 'Pinned', IconPin, {
              dropSection: 'pinned',
              hiddenState: hiddenStates.pinned
            })}
            {sectionOpen('pinned') &&
              (pinned.length ? (
                <ul className="flex flex-col gap-px">
                  {pinned.map((session) => renderSessionRow(session, 0, 'pinned'))}
                </ul>
              ) : (
                <p className="py-1 pr-2 text-xs text-white/35" style={{ paddingLeft: NAME_OFFSET }}>
                  暂无置顶会话。
                </p>
              ))}
          </section>

          <section>
            {renderSectionHeader('project', 'Projects', IconFolder, {
              onAdd: () => onCreateGroup(null),
              addTitle: '新建分组',
              // 会话没有「Projects 根」这一级（取消归属是拖到 Recent），这里只接分组
              dropSection: 'project',
              accepts: (source) => source.kind === 'group',
              hiddenState: hiddenStates.project
            })}
            {sectionOpen('project') &&
              (projects?.groups?.length ? (
                <ul role="tree" className="flex flex-col gap-px">
                  {childGroups(projects, null).map((group) => renderGroup(group))}
                </ul>
              ) : (
                <p className="py-1 pr-2 text-xs text-white/35" style={{ paddingLeft: NAME_OFFSET }}>
                  暂无项目分组，先新建一个分组。
                </p>
              ))}
          </section>

          <section>
            {renderSectionHeader('recent', 'Recent', IconListTree, {
              dropSection: 'recent',
              hiddenState: hiddenStates.recent
            })}
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
                      style={{ paddingLeft: rowIndent(0) }}
                      onClick={() => setRecentLimit((prev) => prev + RECENT_PAGE_SIZE)}
                    >
                      <Slot />
                      <Slot>
                        <IconDots size={14} />
                        <RowBadge state={hiddenStates.recentOverflow} scope="Recent" />
                      </Slot>
                      <span className="min-w-0 flex-1 truncate text-left text-[13px]">
                        Show {recentPageSize} more
                      </span>
                    </button>
                  )}
                </>
              ) : (
                <p className="py-1 pr-2 text-xs text-white/35" style={{ paddingLeft: NAME_OFFSET }}>
                  暂无最近会话。
                </p>
              ))}
          </section>
        </div>
      </div>
      {menuNode && (
        <ContextMenu menu={menuNode} onClose={() => setMenu(null)} onAction={runAction} />
      )}
      {detailSessionId &&
        createPortal(
          <Suspense fallback={null}>
            <SessionDetailModal
              sessionId={detailSessionId}
              onClose={() => setDetailSessionId(null)}
            />
          </Suspense>,
          document.body
        )}
    </>
  )
}
