import { lazyView } from './lazy-view'
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheck,
  IconChevronRight,
  IconClock,
  IconDots,
  IconFolder,
  IconFolderOpen,
  IconFolders,
  IconListTree,
  IconPencil,
  IconPin,
  IconPlus,
  IconSearch,
  IconTerminal2,
  IconX
} from '@tabler/icons-react'
import { activeTimeLabel, relativeTimeShort } from './relative-time'
import { loopForNode, loopProgressLabel, loopStatusLabel, loopTooltip } from './loop-command'
import { collectGroupStates, liveSessionRowState, mergeRowStates } from './session-state'
import { byUpdatedDesc, orderSessions, resolveDrop, rowDropPosition } from './session-dnd'
import { groupRecentRows } from './recent-buckets'
import { orderRecentDrafts } from './recent-drafts'
import { planSessionReveal } from './session-reveal'
import {
  nestSessions,
  paginateSessionTrees,
  sessionDescendants,
  sessionRoots
} from './session-nesting'
import {
  draftMenuItems,
  renameTargetOf,
  sessionMenuItems,
  withExtraMenuItems
} from './session-menu'
import { parseSessionMenuAction } from './session-menu-plugins'
import {
  annotationBadges,
  annotationMenuItems,
  hiddenBadgeCount,
  parseAnnotationAction,
  toggleTarget,
  visibleBadges
} from './session-annotations'
import {
  childGroups,
  collectGroupDigests,
  inheritedSessionSection,
  sessionSectionOf,
  sessionsByGroup
} from './session-projects'
import { longPressHandlers } from './hooks'
import { useSharedState } from './ui-state'
import {
  DEFAULT_SESSION_SEARCH_RANGE,
  SESSION_SEARCH_RANGES,
  SESSION_SEARCH_RESULT_LIMIT,
  buildDraftSearchResults,
  buildSessionSearchResults,
  contentMatchMap,
  rankSearchItems,
  sessionSearchSinceMs,
  tokenizeSearchQuery
} from './session-search'

// 会话详情弹窗复用 Stats 页的组件，按需加载——stats 目录的代码不进启动路径。
const SessionDetailModal = lazyView(
  () => import('./stats/SessionDetailModal'),
  'SessionDetailModal',
  { overlay: true }
)

const rowClassBase =
  'group relative flex min-h-6 cursor-pointer gap-2 rounded-md pr-2 text-sm leading-5 text-nav-fg transition-colors hover:bg-overlay hover:text-fg-max active:bg-overlay-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line-strong'

const rowClass = `${rowClassBase} items-center`

// 搜索结果里的会话多一行正文片段（内容命中的证据）。两行不能靠后写的 items-start 覆盖
// items-center：Tailwind 工具类的胜负由生成顺序决定，不认源码顺序，所以另起一个常量。
const rowClassTall = `${rowClassBase} items-start py-1`

const groupRowClass =
  'group/grow relative flex min-h-6 cursor-pointer items-center gap-2 rounded-md pr-2 text-[12.5px] font-medium leading-5 tracking-wide text-fg-strong transition-colors hover:bg-overlay hover:text-fg-max'

const dropShadow = 'inset 0 0 0 1px rgba(90,167,232,.9)'

const RECENT_PREVIEW_LIMIT = 6

const RECENT_PAGE_SIZE = 10

/** 侧栏里「就是这一条」的闪烁时长：够看清位置，又不至于一直亮着抢注意力。 */
const REVEAL_FLASH_MS = 1600

/** 行上的定位键 → 选择器。会话 id / 草稿节点 id 都是 ASCII，保险起见仍过一遍转义。 */
function revealRowSelector(key) {
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(key)
      : String(key).replace(/["\\]/g, '\\$&')
  return `[data-reveal-key="${escaped}"]`
}

/** 正文搜索的防抖：每次按键都往运行时发一趟请求太吵，慢响应还会互相覆盖。 */
const SESSION_SEARCH_DEBOUNCE_MS = 220

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

// 派生会话（子会话 / fork）**只缩进半档**：整档（TREE_STEP）是「分组套分组」的语义，
// 两者用同一个缩进时，子会话看起来就是一个子分组——用户按分组去折叠它、按会话去点它，
// 都会点错。半档 + 左侧引导线把「派生关系」和「分组层级」分开画。
const NEST_STEP = 12

/** 固定宽度的列位：没有内容时也占位，保证各行的名称都在同一列。 */
function Slot({ children }) {
  return <span className="relative grid w-4 shrink-0 place-items-center">{children}</span>
}

/**
 * 把命中片段渲染成高亮。区间由共享的匹配逻辑给出（已排序、已合并、互不重叠），
 * 组件只负责切分——自己去 indexOf 会与运行时的匹配规则分叉。
 */
/** 命中词的标记样式：侧栏搜索与 ⌘P 快速打开共用同一份，两处高亮否则会不一致。 */
export function Highlighted({ text, ranges }) {
  if (!ranges?.length) return text
  const parts = []
  let at = 0
  ranges.forEach(([start, end], index) => {
    if (start > at) parts.push(text.slice(at, start))
    if (end > start) {
      parts.push(
        <mark key={`hit-${index}`} className="rounded-[2px] bg-warn/25 text-fg-max">
          {text.slice(start, end)}
        </mark>
      )
    }
    at = Math.max(at, end)
  })
  if (at < text.length) parts.push(text.slice(at))
  return parts
}

/** 取路径最后一段作为文件夹名 */
function baseName(cwd) {
  const trimmed = String(cwd || '').replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

/** 一组会话里最近的一次活动时间；空列表返回 0（relativeTimeShort 会给出空串）。 */
function latestUpdatedAt(sessions) {
  let latest = 0
  for (const session of sessions) latest = Math.max(latest, Number(session.updatedAtMs) || 0)
  return latest
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
      className="h-5 min-w-0 flex-1 rounded-sm border border-line bg-overlay px-1.5 text-[13px] text-fg-max"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
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
// 插件给的会话标记（标签点）跟在标题后面而不是行首：行首 w-4 的状态位是「运行中/未读」
// 一类的即时状态，标记是长期分类，混在一起会看不出哪个是哪个。
function RowAnnotationDots({ badges }) {
  if (!badges.length) return null
  const hidden = hiddenBadgeCount(badges)
  const title = badges.map((badge) => badge.label).join(' / ')
  return (
    <span className="flex shrink-0 items-center gap-1" title={title}>
      {visibleBadges(badges).map((badge) => (
        <span
          key={badge.key}
          className="size-1.5 rounded-full ring-1 ring-black/20"
          style={{ backgroundColor: badge.color }}
        />
      ))}
      {hidden > 0 && <span className="text-[10px] leading-none text-fg-muted">+{hidden}</span>}
    </span>
  )
}

function RowTail({ label, labelTitle, relativeTime }) {
  return (
    <span className="relative flex min-w-4 shrink-0 items-center justify-end gap-2">
      {label && (
        <span className="max-w-[88px] truncate text-[11px] text-fg-dim" title={labelTitle}>
          {label}
        </span>
      )}
      <span className="block shrink-0 text-[11px] tabular-nums text-fg-dim">{relativeTime}</span>
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
      className="fixed z-[10000] min-w-[200px] rounded-md border border-line bg-panel/98 p-1 shadow-2xl backdrop-blur"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item, index) => {
        if (item === 'separator')
          return <div key={`sep-${index}`} className="mx-1 my-1 h-px bg-overlay-strong" />
        // 元组是常用的简写；插件给的标记项要带色点和对勾，所以也接受对象。
        const [action, label, danger, dot, checked] = Array.isArray(item)
          ? item
          : [item.action, item.label, item.danger, item.dot, item.checked]
        return (
          <button
            key={action}
            type="button"
            aria-label={label}
            className={`flex h-7 w-full items-center gap-2 px-2 text-left text-[13px] transition-colors hover:bg-overlay-strong ${
              danger ? 'text-danger' : 'text-fg-strong'
            }`}
            onClick={() => {
              onClose()
              onAction(action, menu)
            }}
          >
            {dot ? (
              <span
                className="size-2.5 shrink-0 rounded-full ring-1 ring-line-strong"
                style={{ backgroundColor: dot }}
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {checked ? (
              <IconCheck size={12} stroke={2.5} className="shrink-0 text-fg-soft" />
            ) : null}
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
  loops,
  annotations,
  sessionMenuPlugins,
  sidebarIntent,
  onOpenSession,
  onSelectDraft,
  onTogglePin,
  onMoveSession,
  onSetSessionParent,
  onMoveDraft,
  onRenameSession,
  onRenameDraft,
  onDeleteSession,
  onDeleteDraft,
  onShareSession,
  onForkSession,
  onReorderSessions,
  onCreateGroup,
  onRenameGroup,
  onMoveGroup,
  onDeleteGroup,
  onCreateSessionInGroup,
  onToggleAnnotation,
  onRunSessionMenu
}) {
  const [menu, setMenu] = useState(null)
  const [detailSessionId, setDetailSessionId] = useState(null)
  const [editing, setEditing] = useState(null) // { kind: 'session'|'draft'|'group', id }
  const [query, setQuery] = useState('')
  // 搜索的时间范围：默认只搜最近 3 天。正文搜索要解析会话文件，全部历史都读一遍既慢又
  // 白占内存，而用户找的多半是最近聊过的东西；范围可调，选择随组件存活（与输入框里的
  // 查询串同一档：都是「这次搜索」的临时状态，不进界面状态）。
  const [rangeId, setRangeId] = useState(DEFAULT_SESSION_SEARCH_RANGE)
  const [contentMatches, setContentMatches] = useState(() => new Map())
  const [searchingContent, setSearchingContent] = useState(false)
  const [contentTruncated, setContentTruncated] = useState(false)
  const [searchFocus, setSearchFocus] = useState(0)
  const searchInputRef = useRef(null)
  const searchListRef = useRef(null)
  const [collapsedSections, setCollapsedSections] = useSharedState('sessionTreeCollapsedSections', {
    pinned: false,
    recent: false,
    project: false
  })
  const [collapsedGroups, setCollapsedGroups] = useSharedState('sessionTreeCollapsedGroups', {})
  // 派生会话（子会话 / fork）的折叠：只影响渲染，父子的存续关系由会话文件决定。
  const [collapsedChildIds, setCollapsedChildIds] = useSharedState(
    'sessionTreeCollapsedChildren',
    []
  )
  const collapsedChildren = useMemo(() => new Set(collapsedChildIds), [collapsedChildIds])
  const [recentLimit, setRecentLimit] = useState(RECENT_PREVIEW_LIMIT)
  // 「在侧栏里定位到这条会话」：⌘P 打开的会话可能在折叠的分区/分组里、被 Recent 的
  // 分页截掉，或者干脆滚出了视野。定位做三件事——展开、滚进视野、闪一下。
  const [reveal, setReveal] = useState(null) // { key, nonce }
  const pendingRevealRef = useRef(null)
  const [revealTick, setRevealTick] = useState(0)
  const treeScrollRef = useRef(null)
  const [drag, setDrag] = useState(null) // { kind: 'session'|'draft'|'group', id, section, groupId }
  const [over, setOver] = useState(null) // { section, id?, groupId?, position?, cross?, header? }
  const tokens = useMemo(() => tokenizeSearchQuery(query), [query])
  const searching = tokens.length > 0
  const searchSinceMs = useMemo(() => sessionSearchSinceMs(rangeId, Date.now()), [rangeId])
  const loopBySession = useMemo(() => {
    const map = new Map()
    for (const loop of Array.isArray(loops) ? loops : []) {
      if (loop?.sessionId) map.set(loop.sessionId, loop)
    }
    return map
  }, [loops])
  const sectionOf = useCallback(
    (sessionId) => sessionSectionOf(sessionId, { pins, projects }),
    [pins, projects]
  )

  const roots = useMemo(() => sessionRoots(sessions), [sessions])
  const effectiveSectionOf = useCallback(
    (sessionId) => inheritedSessionSection(sessionId, roots, { pins, projects }),
    [roots, pins, projects]
  )
  const pinned = useMemo(
    () =>
      orderSessions(
        sessions.filter((session) => effectiveSectionOf(session.id).section === 'pinned'),
        sortOrder.pinned || [],
        (a, b) => (pins[b.id] || 0) - (pins[a.id] || 0)
      ),
    [sessions, effectiveSectionOf, pins, sortOrder.pinned]
  )
  const recentCandidates = useMemo(
    () =>
      sessions
        .filter((session) => effectiveSectionOf(session.id).section === 'recent')
        .sort(byUpdatedDesc),
    [sessions, effectiveSectionOf]
  )
  const recentPage = useMemo(
    () => paginateSessionTrees(recentCandidates, roots, recentLimit),
    [recentCandidates, roots, recentLimit]
  )
  const recentList = recentPage.items
  const recentOverflow = recentPage.remainingRoots
  const recentPageSize = Math.min(RECENT_PAGE_SIZE, recentOverflow)

  const pinnedRows = useMemo(
    () => nestSessions(pinned, { collapsed: collapsedChildren }),
    [pinned, collapsedChildren]
  )
  const recentRows = useMemo(
    () => nestSessions(recentList, { collapsed: collapsedChildren }),
    [recentList, collapsedChildren]
  )
  // 时间分桶只影响 Recent 的呈现顺序：结构（父子）不变，桶标题插在根会话之前。
  const recentBlocks = useMemo(() => groupRecentRows(recentRows), [recentRows])

  /**
   * 排队一次「定位到这条会话」。搜索结果还在占着列表时不立刻做——那时树根本没渲染，
   * 展开什么都看不见；请求先挂着，等查询清掉再落地。
   */
  const queueReveal = useCallback((target) => {
    if (!target?.sessionId && !target?.nodeId) return
    pendingRevealRef.current = target
    setRevealTick((value) => value + 1)
  }, [])

  // 宿主发来的侧栏意图：⌘K 聚焦搜索框 / ⌘P 打开会话后定位到它在树里的位置。
  // 侧栏可能正处于收起（桌面）或抽屉关闭（手机）状态，所以聚焦放到下一帧：
  // 那一帧容器已经可见，`focus()` 才不会被 `visibility: hidden` 吃掉。
  useEffect(() => {
    if (!sidebarIntent?.nonce) return
    if (sidebarIntent.kind === 'reveal') {
      queueReveal({ sessionId: sidebarIntent.sessionId })
      return
    }
    const focusSearch = () => {
      const input = searchInputRef.current
      if (!input) return
      input.focus()
      input.select()
    }
    const frame = requestAnimationFrame(() => {
      focusSearch()
      // 侧栏刚展开时这一帧里容器可能还没完成布局，再补一次。
      requestAnimationFrame(() => {
        if (document.activeElement !== searchInputRef.current) focusSearch()
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [queueReveal, sidebarIntent?.kind, sidebarIntent?.nonce, sidebarIntent?.sessionId])

  // 定位的落地：把挡住它的分区 / 分组 / 父会话 / Recent 分页依次展开。
  useEffect(() => {
    const request = pendingRevealRef.current
    if (!request) return
    if (searching) return
    pendingRevealRef.current = null
    const plan = planSessionReveal({
      sessionId: request.sessionId || null,
      nodeId: request.nodeId || null,
      draftGroupId: request.nodeId ? draftGroups?.[request.nodeId] || null : null,
      sessions,
      pins,
      projects,
      collapsedSections,
      collapsedGroups,
      collapsedChildren: collapsedChildIds,
      recentCandidates,
      recentLimit
    })
    if (!plan) return
    if (plan.expandSection) {
      setCollapsedSections((prev) =>
        prev[plan.section] ? { ...prev, [plan.section]: false } : prev
      )
    }
    if (plan.expandGroups.length) {
      setCollapsedGroups((prev) => {
        if (!plan.expandGroups.some((id) => prev[id])) return prev
        const next = { ...prev }
        for (const id of plan.expandGroups) next[id] = false
        return next
      })
    }
    if (plan.expandParents.length) {
      setCollapsedChildIds((prev) => {
        if (!plan.expandParents.some((id) => prev.includes(id))) return prev
        return prev.filter((id) => !plan.expandParents.includes(id))
      })
    }
    if (plan.recentLimit) setRecentLimit((value) => Math.max(value, plan.recentLimit))
    setReveal({ key: plan.key, nonce: revealTick })
  }, [
    collapsedChildIds,
    collapsedGroups,
    collapsedSections,
    draftGroups,
    pins,
    projects,
    recentCandidates,
    recentLimit,
    revealTick,
    searching,
    sessions,
    setCollapsedChildIds,
    setCollapsedGroups,
    setCollapsedSections
  ])

  // 展开是异步的（要等这一轮渲染把行画出来），所以滚进视野放在下一帧再找；
  // 展开链路多时一帧不够，给几帧余量，行始终没出现就放弃（数据变了，别死缠）。
  useEffect(() => {
    if (!reveal?.key) return undefined
    let cancelled = false
    let frame = 0
    let attempts = 0
    const tick = () => {
      if (cancelled) return
      const row = treeScrollRef.current?.querySelector(revealRowSelector(reveal.key))
      if (row instanceof HTMLElement) {
        row.scrollIntoView({ block: 'nearest' })
        return
      }
      attempts += 1
      if (attempts <= 20) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [reveal])

  // 闪烁只亮一下：给一条「它在这儿」的线索，之后恢复常态。
  useEffect(() => {
    if (!reveal?.key) return undefined
    const timer = setTimeout(() => setReveal(null), REVEAL_FLASH_MS)
    return () => clearTimeout(timer)
  }, [reveal])

  const groupSessions = useMemo(() => {
    const map = new Map()
    for (const session of sessions) {
      const { section, groupId } = effectiveSectionOf(session.id)
      if (section !== 'project') continue
      if (!map.has(groupId)) map.set(groupId, [])
      map.get(groupId).push(session)
    }
    for (const [groupId, items] of map) {
      map.set(groupId, orderSessions(items, sortOrder[`project:${groupId}`] || [], byUpdatedDesc))
    }
    return map
  }, [sessions, effectiveSectionOf, sortOrder])

  /** 分组里的渲染顺序（带派生嵌套）。归属与折叠状态仍来自上面那份平铺列表。 */
  const groupRows = useMemo(() => {
    const map = new Map()
    for (const [groupId, items] of groupSessions) {
      map.set(groupId, nestSessions(items, { collapsed: collapsedChildren }))
    }
    return map
  }, [collapsedChildren, groupSessions])

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

  // 每个分组子树的摘要（条数 / 最近活动时间）。收起的分组只剩那一行，靠它说清
  // 「里面有多少条、最近什么时候动过」，不必展开才知道。
  const groupDigests = useMemo(
    () => collectGroupDigests({ projects, sessionsByGroup: groupSessions, draftsByGroup }),
    [draftsByGroup, groupSessions, projects]
  )

  // 分区标题右侧的「条数 · 最近活动」：分区收起时那是唯一的信息，展开时也回答
  // 「这一堆里最新的是什么时候」。
  const sectionMeta = useMemo(() => {
    let projectCount = 0
    let projectLatest = 0
    for (const group of childGroups(projects, null)) {
      const digest = groupDigests.get(group.id)
      if (!digest) continue
      projectCount += digest.count
      projectLatest = Math.max(projectLatest, digest.latestAt)
    }
    return {
      pinned: { count: pinned.length, latestAt: latestUpdatedAt(pinned) },
      project: { count: projectCount, latestAt: projectLatest },
      recent: {
        count: recentCandidates.length + rootDrafts.length,
        latestAt: latestUpdatedAt(recentCandidates)
      }
    }
  }, [groupDigests, pinned, projects, recentCandidates, rootDrafts])

  // 草稿一律排在 Recent 顶部（新建但还没落盘的会话沉到 updatedAt 排出来的列表末尾
  // 等同于「新对话丢了」），彼此之间的顺序固定为页签创建顺序：点哪一条都不重排。
  const recentDrafts = useMemo(() => orderRecentDrafts(rootDrafts), [rootDrafts])

  const sectionOpen = (name) => !collapsedSections[name]
  const toggleSection = (name) => setCollapsedSections((prev) => ({ ...prev, [name]: !prev[name] }))
  const toggleGroupOpen = (groupId) =>
    setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }))

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
    const hidden = (name) => !!collapsedSections[name]
    const overflow = recentPage.overflow
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
    pinned,
    projects,
    recentCandidates,
    recentPage,
    rootDrafts,
    rowStateOfDraft,
    rowStateOfSession
  ])

  // 会话 → 所在分组名。搜索结果行的行尾用它说明「这条原来在哪儿」，用户不必回去翻分区。
  const groupNamesBySession = useMemo(() => {
    const names = new Map()
    const byId = new Map((projects?.groups || []).map((group) => [group.id, group.name]))
    for (const [groupId, ids] of sessionsByGroup(projects)) {
      const name = byId.get(groupId)
      if (!name) continue
      for (const id of ids) names.set(id, name)
    }
    return names
  }, [projects])

  const resultLabelOf = useCallback(
    (sessionId, group) => {
      const section = sectionOf(sessionId).section
      if (section === 'pinned') return '置顶'
      if (section === 'project') return group || '项目'
      return ''
    },
    [sectionOf]
  )

  /**
   * 对话正文只有运行时知道（见 host/stats.js 的 searchSessions），标题/目录/分组名这些
   * 渲染层本来就有，先在本地匹配、再把命中并进来——打字时的即时反馈来自本地那一半。
   */
  useEffect(() => {
    if (!tokens.length) {
      setContentMatches((prev) => (prev.size ? new Map() : prev))
      setSearchingContent(false)
      setContentTruncated(false)
      return
    }
    const term = tokens.join(' ')
    let cancelled = false
    setSearchingContent(true)
    const timer = setTimeout(() => {
      window.mica.stats
        .searchSessions(term, searchSinceMs)
        .then((result) => {
          if (cancelled) return
          setContentMatches(contentMatchMap(result?.results))
          setContentTruncated(!!result?.truncated)
        })
        .catch((error) => {
          if (cancelled) return
          console.error('search sessions failed', error)
          setContentMatches(new Map())
        })
        .finally(() => {
          if (!cancelled) setSearchingContent(false)
        })
    }, SESSION_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [tokens, searchSinceMs])

  // 搜索态是**一张按相关度排的平铺列表**，不再钻回四个分区里去找：命中的会话可能原本在
  // 置顶、某个分组、定时任务或 Recent，按分区渲染就等于让最相关的那条排在第 5 屏。
  // 它原来属于哪里，由行尾的标签说明。
  const searchResults = useMemo(() => {
    if (!tokens.length) return { items: [], overflow: 0 }
    return rankSearchItems([
      ...buildSessionSearchResults({
        sessions,
        tokens,
        sinceMs: searchSinceMs,
        contentMatches,
        loopOf: (id) => loopBySession.get(id) || null,
        groupOf: (id) => groupNamesBySession.get(id) || null,
        sectionLabelOf: resultLabelOf
      }),
      ...buildDraftSearchResults({ drafts: draftTabs, tokens })
    ])
  }, [
    contentMatches,
    draftTabs,
    groupNamesBySession,
    loopBySession,
    resultLabelOf,
    searchSinceMs,
    sessions,
    tokens
  ])
  const searchItems = searchResults.items
  // 计数放在搜索框那一行：结果多的时候列表底部一行早就滚出屏幕了，那里说什么都看不见。
  const searchCountLabel = searchingContent ? '搜索中…' : `${searchItems.length} 个`
  const searchCountTitle = searchingContent
    ? '正在搜索会话内容…'
    : [
        `找到 ${searchItems.length} 个会话`,
        searchResults.overflow > 0 ? `只显示前 ${SESSION_SEARCH_RESULT_LIMIT} 条` : '',
        contentTruncated ? '内容搜索只覆盖了最近的会话' : ''
      ]
        .filter(Boolean)
        .join('；')

  useEffect(() => {
    setSearchFocus(0)
  }, [tokens])

  // 键盘移动时把高亮那一行滚进视野；鼠标悬浮的那一行与它共用同一格。
  useEffect(() => {
    const node = searchListRef.current?.querySelector(`[data-search-index="${searchFocus}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [searchFocus, searchItems])

  const openSearchItem = useCallback(
    (item) => {
      if (!item) return
      if (item.kind === 'draft') {
        if (item.draft) onSelectDraft?.(item.draft)
        if (item.draft) queueReveal({ nodeId: item.draft.id })
        return
      }
      // 只有「正文里真的命中」才带关键词去定位：草稿的词在输入框里，纯标题命中（snippet 为空）
      // 的会话正文里没有这串文字，两种情况带过去都只会得到一个 0 命中的查找条。
      const find = tokens.length && item.snippet ? { find: tokens } : undefined
      if (item.session) {
        onOpenSession?.(item.session, find)
        // 搜索把列表换成了结果行，定位要等查询清掉（那时树才画出来），见 queueReveal。
        queueReveal({ sessionId: item.session.id })
      }
    },
    [onOpenSession, onSelectDraft, queueReveal, tokens]
  )

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
    if (menuPayload.session?.parentSessionId && ['pin', 'unpin', 'unassign'].includes(action))
      return
    const annotation = parseAnnotationAction(action)
    const pluginMenu = parseSessionMenuAction(action)
    if (pluginMenu) {
      // 插件动作在会话的常驻 host 里跑（插件就在那个进程），页面只负责把结果写进剪贴板。
      onRunSessionMenu?.(
        { sessionId: menuPayload.session.id, cwd: menuPayload.session.cwd },
        pluginMenu
      )
    } else if (annotation) {
      const target = toggleTarget(annotations, menuPayload.session.id, annotation)
      onToggleAnnotation?.(menuPayload.session.id, target)
    } else if (action === 'pin' || action === 'unpin') onTogglePin(menuPayload.session.id)
    else if (action === 'unassign') onMoveSession(menuPayload.session.id, { section: 'recent' })
    else if (action === 'detail') setDetailSessionId(menuPayload.session.id)
    else if (action === 'fork') onForkSession?.(menuPayload.session.id)
    else if (action === 'share') onShareSession?.(menuPayload.session.id)
    // 会话行带 session，草稿行（新对话）只有 draft：两者都要认，否则草稿的重命名抛错、
    // 编辑态进不去，表现成「点了没反应」。
    else if (action === 'rename') {
      const target = renameTargetOf(menuPayload)
      if (target) setEditing(target)
    } else if (action === 'delete')
      menuPayload.session
        ? onDeleteSession(menuPayload.session.id)
        : onDeleteDraft(menuPayload.draft.id)
    else if (action === 'rename-group') setEditing({ kind: 'group', id: menuPayload.group.id })
    else if (action === 'new-subgroup') onCreateGroup(menuPayload.group.id)
    else if (action === 'new-session') onCreateSessionInGroup(menuPayload.group.id)
    else if (action === 'delete-group') onDeleteGroup(menuPayload.group.id)
  }

  /** 插件标记项插在删除项之前：删除永远排最后，误点就找不回来了。 */
  const menuItemsFor = (session) => {
    const items = sessionMenuItems({
      pinned: !!pins[session.id],
      inProject: effectiveSectionOf(session.id).section === 'project',
      isChild: !!session.parentSessionId
    })
    // 插件贡献的两类项都插在删除之前：会话标记（数据，画点/勾）与插件动作（跑一段
    // 插件代码，例如把会话导出成 markdown 放进剪贴板）。
    return withExtraMenuItems(items, [
      ...annotationMenuItems(annotations, session.id),
      ...(Array.isArray(sessionMenuPlugins) ? sessionMenuPlugins : [])
    ])
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

  const startDrag = (event, kind, section, id, groupId = null, parentSessionId = null) => {
    setDrag({ kind, section, id, groupId, parentSessionId })
    event.dataTransfer.effectAllowed = 'move'
    // Firefox 不设置 data 就不会真的开始拖拽
    event.dataTransfer.setData('text/plain', id)
  }
  const clearDrag = () => {
    setDrag(null)
    setOver(null)
  }
  const moveDragged = (source, target, options = {}) => {
    if (source.kind === 'draft') onMoveDraft?.(source.id, target)
    else onMoveSession?.(source.id, { ...target, ...options })
  }

  /** 被拖动会话自己的子树：拖进子树会把父子关系弄成环，那种落点不亮也不生效。 */
  const dragSubtree = useMemo(
    () => (drag?.kind === 'session' ? sessionDescendants(sessions, drag.id) : new Set()),
    [drag, sessions]
  )

  const groupDropPosition = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientY - rect.top) / rect.height
    // 中间那条带子默认是「排到前 / 后」，只有按住 ⌥ 才是「变成子分组」：行高 24px，
    // 中间那 12px 太容易误踩，一次手抖就把分组改成了另一个分组的子级。
    return rowDropPosition({ ratio, altKey: event.altKey })
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
      position,
      descendantIds: source?.kind === 'session' ? sessionDescendants(sessions, source.id) : null
    })
    if (!plan) return
    if (plan.kind === 'nest') onSetSessionParent?.(source.id, plan.parentId)
    else if (plan.kind === 'unnest') onSetSessionParent?.(source.id, null)
    else if (plan.kind === 'move')
      moveDragged(source, plan.target, { clearParent: plan.clearParent })
    else if (plan.kind === 'move-group') onMoveGroup?.(plan.groupId, plan.parentId, plan.placement)
    else onReorderSessions(sectionOrderKey(section, groupId), plan.ids)
  }

  const hoverRow =
    (section, id, groupId = null, canNestInto = true) =>
    (event) => {
      if (!drag || drag.id === id) return
      // 分组只落在分组行与 Projects 标题上，落到会话行不做任何反应
      if (drag.kind === 'group') return
      // 按住 ⌥ 拖到会话行中间那条带子 = 成为它的子会话；不按 ⌥ 时整行都是换分区 / 排序。
      // 行高只有 24px，中间带子占一半高度，默认就生效等于「拖一下就可能被嵌套」。
      // 草稿还没落盘、拖进自己的子树会成环，两种都不亮。
      const nestAllowed =
        canNestInto &&
        drag.kind === 'session' &&
        (drag.parentSessionId ?? null) !== id &&
        !dragSubtree.has(id)
      if (nestAllowed) {
        const rect = event.currentTarget.getBoundingClientRect()
        const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
        if (rowDropPosition({ ratio, altKey: event.altKey, canNest: nestAllowed }) === 'into') {
          event.preventDefault()
          event.stopPropagation()
          setOver((current) =>
            current?.section === section &&
            current?.id === id &&
            current?.groupId === groupId &&
            current?.into
              ? current
              : { section, id, groupId, into: true }
          )
          return
        }
      }
      event.preventDefault()
      event.stopPropagation()
      const sameTarget = (drag.groupId ?? null) === (groupId ?? null)
      if (drag.section !== section || !sameTarget) {
        setOver({ section, id, groupId, cross: true })
        return
      }
      // 子会话的位置由父会话决定，Recent 按时间排：两种都不画「插到这一行前后」的线。
      // 但刚才是从中间那条带子移出来的话，得把「拖进来」的高亮撤掉——否则光标已经离开
      // 中间，框还亮着，看起来像还会嵌套进去。
      if (drag.parentSessionId || section === 'recent') {
        setOver((current) => (current?.into && current?.id === id ? null : current))
        return
      }
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
      const landed = over?.section === section && over?.id === targetId
      const position = landed ? (over.into ? 'into' : over.position) : null
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

  /**
   * 一行会话。`nesting` 来自 `nestSessions`：派生会话多缩进一层、行首带分支标记；
   * 父会话在有子会话时第一列变成折叠箭头，收起后状态由父行代显（与分组同一套规则）。
   */
  const renderSessionRow = (session, indent, section, groupId = null, nesting = null) => {
    const nodeId = openBySession[session.id]
    const active = !!nodeId && activeSessionId === session.id
    const ownState = rowStateOfSession(session)
    const state = nesting?.collapsed
      ? mergeRowStates([ownState, ...nesting.hidden.map(rowStateOfSession)])
      : ownState
    const childDepth = nesting?.depth ?? 0
    const canCollapse = (nesting?.childCount ?? 0) > 0
    const childCollapsed = !!nesting?.collapsed
    const unreadState = unread[nodeId]
    const editingThis = editing?.kind === 'session' && editing.id === session.id
    const isOver = rowOverState(section, session.id, groupId)
    const draggingThis = drag?.id === session.id && drag?.kind === 'session'
    // 行尾是「最近结束时间」。Recent 里每行都给（时间就是这一列的语义）；Pinned / Projects
    // 是长期归档，只给 24 小时内活跃过的行，否则整列都是 15d / 4d 的噪声。
    const relativeTime =
      section === 'recent'
        ? relativeTimeShort(session.updatedAtMs)
        : activeTimeLabel(session.updatedAtMs)
    // Recent 行尾显示工作目录名，方便区分同名会话。
    const cwdLabel = section === 'recent' ? baseName(session.cwd) : ''
    // 定时循环按会话认领，侧栏没有单独的「定时任务」分区，所以行**在任何分区**都带时钟标记
    // 与行尾进度——这是「它挂着定时任务」的唯一提示。`running` 只用来区分「这一轮正在跑」
    // 与「在等下一次触发」，两种状态都点亮图标。
    const loop = loopBySession.get(session.id) || null
    const loopRunning = state === 'running'
    const flashing = reveal?.key === `s:${session.id}`
    return (
      <li key={session.id}>
        <div
          data-reveal-key={`s:${session.id}`}
          className={`${rowClass} relative ${active ? 'bg-active text-fg-max' : 'text-nav-fg'} ${draggingThis ? 'opacity-40' : ''} ${flashing ? 'session-row-flash' : ''}`}
          style={{
            paddingLeft: rowIndent(indent) + childDepth * NEST_STEP,
            boxShadow: isOver
              ? over.cross || over.into
                ? dropShadow
                : over.position === 'before'
                  ? 'inset 0 2px 0 rgba(90,167,232,.9)'
                  : 'inset 0 -2px 0 rgba(90,167,232,.9)'
              : undefined
          }}
          title={
            loop
              ? `${session.title || session.id}\n${loopTooltip(loop, Date.now(), loopRunning)}`
              : session.cwd
                ? `${session.title || session.id} — ${session.cwd}`
                : session.title || session.id
          }
          draggable={!editingThis}
          // 长按手势必须排在拖拽回调之前：它会带回自己的 onDragStart，排在后面会把 startDrag 顶掉
          {...longPressHandlers((event) =>
            openMenu(event, {
              session,
              items: menuItemsFor(session)
            })
          )}
          onDragStart={(event) => {
            startDrag(
              event,
              'session',
              section,
              session.id,
              groupId,
              session.parentSessionId ?? null
            )
          }}
          onDragEnd={clearDrag}
          onDragOver={hoverRow(section, session.id, groupId)}
          onDrop={dropRow(section, session.id, groupId)}
          onClick={() => onOpenSession(session)}
          onDoubleClick={() => setEditing({ kind: 'session', id: session.id })}
          onContextMenu={(event) =>
            openMenu(event, {
              session,
              items: menuItemsFor(session)
            })
          }
        >
          {childDepth > 0 && (
            // 派生关系的引导线：从父行缩进处垂下来，把「这是谁的子会话」画在缩进之外，
            // 缩进档位因此可以留给分组层级。
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 w-px bg-line"
              style={{ left: rowIndent(indent) + (childDepth - 1) * NEST_STEP + NEST_STEP / 2 }}
            />
          )}
          {canCollapse ? (
            <Slot>
              <button
                type="button"
                className="grid h-4 w-4 place-items-center rounded text-fg-muted hover:bg-overlay-strong hover:text-fg-strong"
                onDoubleClick={(event) => event.stopPropagation()}
                title={
                  childCollapsed
                    ? `展开 ${nesting.childCount} 个派生会话`
                    : `收起 ${nesting.childCount} 个派生会话`
                }
                onClick={(event) => {
                  // 这一列是行内动作：折叠不能顺带把会话打开。
                  event.stopPropagation()
                  setCollapsedChildIds((prev) => {
                    const next = new Set(prev)
                    if (next.has(session.id)) next.delete(session.id)
                    else next.add(session.id)
                    return [...next]
                  })
                }}
              >
                <IconChevronRight
                  size={12}
                  stroke={2}
                  className={`transition-transform ${childCollapsed ? '' : 'rotate-90'}`}
                />
              </button>
            </Slot>
          ) : (
            <Slot />
          )}
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
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {loop && (
                <span className="shrink-0 text-warn">
                  <IconClock size={12} stroke={2} />
                </span>
              )}
              <span className="min-w-0 truncate">{session.title || session.id}</span>
              <RowAnnotationDots badges={annotationBadges(annotations, session.id)} />
            </span>
          )}
          <RowTail
            label={loop ? loopProgressLabel(loop) : cwdLabel}
            labelTitle={loop ? loop.task : session.cwd}
            relativeTime={loop ? loopStatusLabel(loop, loopRunning) : relativeTime}
          />
        </div>
      </li>
    )
  }

  /**
   * 草稿行。`loop` 传入时表示这条草稿已经挂着定时循环：标题前加时钟、行尾换成循环进度与
   * 状态（与挂着循环的会话行一致）。循环本身只在输入框的时钟面板里改。
   */
  const renderDraftRow = (node, indent = 0, groupId = null, loop = null) => {
    const active = node.id === activeSessionId || node.id === selectedId
    const state = rowStateOfDraft(node)
    const loopRunning = state === 'running'
    const editingThis = editing?.kind === 'draft' && editing.id === node.id
    const dropSection = groupId ? 'project' : 'recent'
    const isOver = rowOverState(dropSection, node.id, groupId)
    const items = draftMenuItems()
    const flashing = reveal?.key === `d:${node.id}`
    return (
      <li key={node.id}>
        <div
          data-reveal-key={`d:${node.id}`}
          className={`${rowClass} ${active ? 'bg-active text-fg-max' : 'text-nav-fg'} ${drag?.kind === 'draft' && drag.id === node.id ? 'opacity-40' : ''} ${flashing ? 'session-row-flash' : ''}`}
          style={{
            paddingLeft: rowIndent(indent),
            boxShadow: isOver ? dropShadow : undefined
          }}
          title={
            loop
              ? `尚未关联真实会话的新对话\n${loopTooltip(loop, Date.now(), loopRunning)}`
              : '尚未关联真实会话的新对话'
          }
          draggable={!editingThis}
          {...longPressHandlers((event) => openMenu(event, { draft: node, items }))}
          onDragStart={(event) => startDrag(event, 'draft', 'draft', node.id, groupId)}
          onDragEnd={clearDrag}
          onDragOver={hoverRow(dropSection, node.id, groupId, false)}
          onDrop={dropRow(dropSection, node.id, groupId)}
          onClick={() => onSelectDraft(node)}
          onDoubleClick={() => setEditing({ kind: 'draft', id: node.id })}
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
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {loop && (
                <span className="shrink-0 text-warn">
                  <IconClock size={12} stroke={2} />
                </span>
              )}
              <span className="min-w-0 truncate">{node.text}</span>
            </span>
          )}
          <RowTail
            label={loop ? loopProgressLabel(loop) : ''}
            labelTitle={loop ? loop.task : ''}
            relativeTime={loop ? loopStatusLabel(loop, loopRunning) : ''}
          />
        </div>
      </li>
    )
  }

  /**
   * 搜索结果行：`[状态位][名称 / 命中片段][来源标签 + 时间]`。
   *
   * 与分区里的会话行共用同一套列栅格（Slot + rowIndent + NAME_OFFSET），所以搜索态和
   * 浏览态的缩进、状态位位置完全一致。差别有两点，都是刻意的：
   * - 不参与拖拽：搜索态没渲染任何分区标题，拖过去也无处可放；
   * - 名称下面多一行「为什么命中」——正文片段（内容命中）或高亮的目录（目录命中）。
   */
  const renderSearchRow = (item, index) => {
    const session = item.session
    const editingThis =
      editing?.kind === (session ? 'session' : 'draft') &&
      editing.id === (session?.id || item.draft.id)
    const tabId = session ? openBySession[session.id] : item.id
    const active = session ? !!tabId && activeSessionId === session.id : item.id === activeSessionId
    const state = session ? rowStateOfSession(session) : rowStateOfDraft(item.draft)
    const loop = session ? loopBySession.get(session.id) || null : null
    const snippet = item.snippet
    const cwdLine = !snippet && item.cwdRanges.length ? item.cwd : null
    const label = loop ? loopProgressLabel(loop) : item.label || baseName(item.cwd)
    const openMenuHere = (event) =>
      session
        ? openMenu(event, { session, items: menuItemsFor(session) })
        : openMenu(event, { draft: item.draft, items: draftMenuItems() })
    return (
      <li key={item.id}>
        <div
          data-search-index={index}
          className={`${snippet || cwdLine ? rowClassTall : rowClass} ${
            active
              ? 'bg-active text-fg-max'
              : searchFocus === index
                ? 'bg-overlay text-fg-max'
                : 'text-nav-fg'
          }`}
          style={{ paddingLeft: rowIndent(0) }}
          title={[
            item.title,
            snippet?.text,
            item.cwd,
            loop ? loopTooltip(loop, Date.now(), state === 'running') : null
          ]
            .filter(Boolean)
            .join('\n')}
          onMouseEnter={() => setSearchFocus(index)}
          onClick={() => openSearchItem(item)}
          onDoubleClick={() =>
            setEditing({ kind: session ? 'session' : 'draft', id: session?.id || item.draft.id })
          }
          onContextMenu={openMenuHere}
          {...longPressHandlers(openMenuHere)}
        >
          <Slot />
          <RowLeading
            state={state}
            unreadKey={unread[tabId]?.lastEventAt ?? 'running'}
            terminal={!!session?.id && !!terminalSessions?.has(session.id)}
            draft={!!tabId && !!draftNodes?.has(tabId)}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              {loop && (
                <span className="shrink-0 text-warn">
                  <IconClock size={12} stroke={2} />
                </span>
              )}
              {editingThis ? (
                <RenameInput
                  value={session ? session.title || session.id : item.draft.text}
                  onCommit={(value) => {
                    const text = value.trim()
                    if (text) {
                      if (session) onRenameSession(session.id, text)
                      else onRenameDraft(item.draft.id, text)
                    }
                    setEditing(null)
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <span className="min-w-0 truncate">
                  <Highlighted text={item.title} ranges={item.titleRanges} />
                </span>
              )}
            </span>
            {snippet && (
              <span className="min-w-0 truncate text-[11px] leading-4 text-fg-muted">
                <Highlighted text={snippet.text} ranges={snippet.ranges} />
              </span>
            )}
            {cwdLine && (
              <span className="min-w-0 truncate text-[11px] leading-4 text-fg-muted">
                <Highlighted text={cwdLine} ranges={item.cwdRanges} />
              </span>
            )}
          </span>
          <RowTail
            label={label}
            labelTitle={loop ? loop.task : session?.cwd || ''}
            relativeTime={
              loop
                ? loopStatusLabel(loop, state === 'running')
                : session
                  ? relativeTimeShort(session.updatedAtMs)
                  : ''
            }
          />
        </div>
      </li>
    )
  }

  const renderGroup = (group, depth = 0) => {
    const nesting = childGroups(projects, group.id)
    const groupId = group.id
    const sessionsHere = groupRows.get(groupId) || []
    const draftsHere = draftsByGroup.get(groupId) || []
    const collapsed = !!collapsedGroups[groupId]
    const open = !collapsed
    const digest = groupDigests.get(groupId)
    // 折叠时才在行尾给一句「多久之前动过」：展开时下面的子行各自带着时间，
    // 分组行再重复一遍就是噪声。条数不画，完整事实都留在 tooltip 里
    const digestTime = collapsed ? activeTimeLabel(digest?.latestAt) : ''
    const editingThis = editing?.kind === 'group' && editing.id === groupId
    const isOver = over?.section === 'project' && over?.groupId === groupId && over?.onGroup
    // 只有子分组右移一层；分组里的会话/草稿与分组名同列（和 Recent 的会话对齐）。
    const childRows = [
      ...nesting.map((child) => renderGroup(child, depth + 1)).filter(Boolean),
      ...draftsHere.map((node) => renderDraftRow(node, depth, groupId)),
      ...sessionsHere.map((row) => renderSessionRow(row.session, depth, 'project', groupId, row))
    ]
    const toggleOpen = () => toggleGroupOpen(groupId)
    return (
      <li key={groupId}>
        <div
          className={`${groupRowClass} ${drag?.kind === 'group' && drag.id === groupId ? 'opacity-40' : ''}`}
          style={{
            paddingLeft: rowIndent(depth),
            boxShadow: isOver
              ? over.position === 'before'
                ? 'inset 0 2px 0 rgba(90,167,232,.9)'
                : over.position === 'after'
                  ? 'inset 0 -2px 0 rgba(90,167,232,.9)'
                  : dropShadow
              : undefined
          }}
          title={
            digest?.latestAt
              ? `${group.name} · ${digest.count} 条 · 最近 ${relativeTimeShort(digest.latestAt)}`
              : group.name
          }
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
            const position = drag.kind === 'group' ? groupDropPosition(event) : null
            if (
              !resolveDrop({
                drag,
                section: 'project',
                groupId,
                groups: projects?.groups || [],
                position
              })
            ) {
              setOver(null)
              return
            }
            event.preventDefault()
            event.stopPropagation()
            setOver({ section: 'project', groupId, onGroup: true, position })
          }}
          onDrop={(event) => {
            event.preventDefault()
            event.stopPropagation()
            const source = drag
            clearDrag()
            // 落到分组行本身就是「移入这个分组」/「挂到这个分组下」；
            // 已经在里面的会在决策里被判为无操作
            applyDrop(source, {
              section: 'project',
              groupId,
              position: source?.kind === 'group' ? groupDropPosition(event) : null
            })
          }}
        >
          <Slot>
            <button
              type="button"
              aria-label={open ? `折叠 ${group.name}` : `展开 ${group.name}`}
              aria-expanded={open}
              className="grid size-4 place-items-center rounded text-fg-dim hover:text-fg-max"
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
            <span className="text-fg-muted" title="分组">
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
          {/* 分组操作浮在行尾：它要是占位，右侧的时间就会被挤得比下面
              会话行的时间靠左；悬浮时让摘要淡出、按钮出现在同一块地方。 */}
          <span className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 rounded-md px-0.5 opacity-0 transition-opacity group-hover/grow:pointer-events-auto group-hover/grow:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 max-md:static max-md:pointer-events-auto max-md:opacity-100">
            <button
              type="button"
              title="在此分组新建会话"
              aria-label={`在 ${group.name} 中新建会话`}
              className="grid size-5 shrink-0 place-items-center rounded text-fg-muted hover:bg-overlay-heavy hover:text-fg-max"
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
              className="grid size-5 shrink-0 place-items-center rounded text-fg-muted hover:bg-overlay-heavy hover:text-fg-max"
              onClick={(event) => openMenuAtElement(event, { group, items: groupMenuItems() })}
            >
              <IconDots size={13} />
            </button>
          </span>
          {digestTime ? (
            <span className="shrink-0 text-[11px] tabular-nums text-fg-dim transition-opacity group-hover/grow:opacity-0">
              {digestTime}
            </span>
          ) : null}
        </div>
        {open && childRows.length > 0 && <ul className="flex flex-col gap-px">{childRows}</ul>}
      </li>
    )
  }

  const menuNode = menu
  const renderSectionHeader = (name, label, Icon, options = {}) => {
    const { onAdd, addTitle, dropSection, accepts, hiddenState, meta } = options
    const isOverHeader = !!dropSection && over?.header === dropSection
    // 分区标题右端不画条数和时间（一列 15d / 4d 只是噪声），事实收进标题的 tooltip
    const metaTitle = meta?.count
      ? meta.latestAt
        ? `${label} 共 ${meta.count} 条，最近 ${relativeTimeShort(meta.latestAt)}`
        : `${label} 共 ${meta.count} 条`
      : undefined
    // 默认只接会话/草稿：分组换父级是 Projects 标题与分组行的事，落到别处不做任何反应
    const acceptsDrag = (source) =>
      !!source && (accepts ? accepts(source) : source.kind !== 'group')
    return (
      <div
        className="group/header relative mt-1 flex h-6 items-center rounded-md pr-2"
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
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left text-[13px] font-medium text-fg-dim transition-colors hover:bg-overlay hover:text-fg-strong"
          // sectionOpen 返回的是查询串或布尔值，aria 只接受 "true"/"false"
          aria-expanded={!!sectionOpen(name)}
          onClick={() => toggleSection(name)}
        >
          <Slot>
            <IconChevronRight
              size={14}
              className={`text-fg-dim transition-transform ${sectionOpen(name) ? 'rotate-90' : ''}`}
            />
          </Slot>
          <Slot>
            <Icon size={14} className="text-fg-dim" />
            <RowBadge state={hiddenState} scope={label} />
          </Slot>
          <span className="flex-1 truncate text-fg-dim" title={metaTitle}>
            {label}
          </span>
        </button>
        {onAdd && (
          <button
            type="button"
            title={addTitle}
            aria-label={addTitle}
            className="absolute top-0 right-1 grid h-6 w-5 place-items-center rounded text-fg-muted opacity-0 transition-opacity group-hover/header:opacity-100 hover:bg-overlay-strong hover:text-fg-max focus-visible:opacity-100 max-md:opacity-100"
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
      <div ref={treeScrollRef} className="min-h-0 flex-1 overflow-auto px-2 pb-2 no-drag">
        {/* 搜索框钉在滚动容器顶部：会话一多就要往下滚，搜索框跟着滚出去的话，想搜索
            还得先滚回顶部。`-mx-2 px-2` 让底色铺满整条，滚过去的内容不会从两侧透出来。 */}
        <div className="sticky top-0 z-10 -mx-2 mb-1.5 bg-panel px-2 pt-0.5 pb-1.5">
          <div className="flex h-7 items-center gap-1.5 rounded-md bg-overlay px-2 transition-colors focus-within:bg-overlay-strong">
            <IconSearch size={13} className="shrink-0 text-fg-dim" />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              placeholder="搜索会话（⌘K）"
              aria-label="搜索会话"
              spellCheck={false}
              className="h-full min-w-0 flex-1 appearance-none bg-transparent text-[13px] text-fg-max placeholder:text-fg-dim focus:outline-none [&::-webkit-search-cancel-button]:hidden"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setSearchFocus((index) =>
                    Math.min(index + 1, Math.max(0, searchItems.length - 1))
                  )
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setSearchFocus((index) => Math.max(0, index - 1))
                } else if (event.key === 'Enter') {
                  if (!searchItems.length) return
                  event.preventDefault()
                  openSearchItem(searchItems[Math.min(searchFocus, searchItems.length - 1)])
                } else if (event.key === 'Escape' && query) {
                  event.preventDefault()
                  setQuery('')
                }
              }}
            />
            {query && (
              <button
                type="button"
                title="清除搜索"
                aria-label="清除搜索"
                className="grid size-5 shrink-0 place-items-center rounded text-fg-muted hover:bg-overlay-strong hover:text-fg-max"
                onClick={() => setQuery('')}
              >
                <IconX size={14} />
              </button>
            )}
          </div>
          {searching && (
            <div
              role="group"
              aria-label="搜索时间范围"
              className="mt-1 flex items-center gap-1 text-[11px]"
            >
              <span className="shrink-0 text-fg-dim">时间</span>
              {SESSION_SEARCH_RANGES.map((range) => (
                <button
                  key={range.id}
                  type="button"
                  aria-pressed={rangeId === range.id}
                  title={
                    range.days > 0 ? `搜索最近 ${range.label}内更新的会话` : '搜索全部历史会话'
                  }
                  className={`rounded px-1.5 py-0.5 transition-colors ${
                    rangeId === range.id
                      ? 'bg-overlay-strong text-fg-strong'
                      : 'text-fg-muted hover:bg-overlay hover:text-fg-soft'
                  }`}
                  onClick={() => setRangeId(range.id)}
                >
                  {range.label}
                </button>
              ))}
              <span className="ml-auto shrink-0 pl-1 text-fg-dim" title={searchCountTitle}>
                {searchCountLabel}
              </span>
            </div>
          )}
          {/* 拖到会嵌套之前，先告诉用户「嵌套要按 ⌥」：默认不再嵌套之后，这条提示是
              唯一的发现路径。放在钉住的头部里，拖动时滚到多远都看得见。 */}
          {drag && !searching && (
            <p className="mt-1 rounded-md bg-overlay px-2 py-1 text-[11px] leading-4 text-fg-dim">
              {drag.kind === 'group'
                ? '拖动可调整顺序；按住 ⌥ 拖到分组中间可变成它的子分组'
                : '拖动可换分区或调顺序；按住 ⌥ 拖到会话中间可成为它的子会话'}
            </p>
          )}
        </div>

        {searching ? (
          <div ref={searchListRef} className="flex flex-col gap-px">
            {searchItems.length ? (
              <ul role="tree" className="flex flex-col gap-px">
                {searchItems.map((item, index) => renderSearchRow(item, index))}
              </ul>
            ) : (
              <p className="py-1 pr-2 text-xs text-fg-dim" style={{ paddingLeft: NAME_OFFSET }}>
                {searchingContent ? '正在搜索会话内容…' : '没有匹配的会话。'}
                {!searchingContent && rangeId !== 'all' && (
                  <button
                    type="button"
                    className="ml-1 text-fg-soft underline-offset-2 hover:text-fg-max hover:underline"
                    onClick={() => setRangeId('all')}
                  >
                    搜索全部时间
                  </button>
                )}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-px">
            <section>
              {renderSectionHeader('pinned', 'Pinned', IconPin, {
                dropSection: 'pinned',
                hiddenState: hiddenStates.pinned,
                meta: sectionMeta.pinned
              })}
              {sectionOpen('pinned') &&
                (pinned.length ? (
                  <ul className="flex flex-col gap-px">
                    {pinnedRows.map((row) => renderSessionRow(row.session, 0, 'pinned', null, row))}
                  </ul>
                ) : (
                  <p className="py-1 pr-2 text-xs text-fg-dim" style={{ paddingLeft: NAME_OFFSET }}>
                    暂无置顶会话。
                  </p>
                ))}
            </section>

            <section>
              {renderSectionHeader('project', 'Projects', IconFolders, {
                onAdd: () => onCreateGroup(null),
                addTitle: '新建分组',
                // 会话没有「Projects 根」这一级（取消归属是拖到 Recent），这里只接分组
                dropSection: 'project',
                accepts: (source) => source.kind === 'group',
                hiddenState: hiddenStates.project,
                meta: sectionMeta.project
              })}
              {sectionOpen('project') &&
                (projects?.groups?.length ? (
                  <ul role="tree" className="flex flex-col gap-px">
                    {childGroups(projects, null).map((group) => renderGroup(group))}
                  </ul>
                ) : (
                  <p className="py-1 pr-2 text-xs text-fg-dim" style={{ paddingLeft: NAME_OFFSET }}>
                    暂无项目分组，先新建一个分组。
                  </p>
                ))}
            </section>

            <section>
              {renderSectionHeader('recent', 'Recent', IconListTree, {
                dropSection: 'recent',
                hiddenState: hiddenStates.recent,
                meta: sectionMeta.recent
              })}
              {sectionOpen('recent') &&
                (recentList.length || rootDrafts.length ? (
                  <>
                    <ul role="tree" className="flex flex-col gap-px">
                      {/* 草稿全部排在最近会话之前（正在用的那条最前）：新建会话还没落盘时
                          它只存在于这里，排在列表末尾等于让用户找不到刚开的对话。挂着循环的
                          草稿同样留在 Recent，只靠行首时钟与行尾进度区分。 */}
                      {recentDrafts.map((node) =>
                        renderDraftRow(node, 0, null, loopForNode(loops, node.id))
                      )}
                      {recentBlocks.map((block) =>
                        block.kind === 'label' ? (
                          <li
                            key={`bucket-${block.bucket}`}
                            className="mt-1 flex h-5 items-center text-[11px] font-medium tracking-wide text-fg-dim"
                            style={{ paddingLeft: rowIndent(0) }}
                          >
                            {block.label}
                          </li>
                        ) : (
                          renderSessionRow(block.row.session, 0, 'recent', null, block.row)
                        )
                      )}
                    </ul>
                    {recentOverflow > 0 && (
                      <button
                        type="button"
                        className={`${rowClass} w-full text-fg-muted hover:text-fg-strong`}
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
                  <p className="py-1 pr-2 text-xs text-fg-dim" style={{ paddingLeft: NAME_OFFSET }}>
                    暂无最近会话。
                  </p>
                ))}
            </section>
          </div>
        )}
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
