import { ArcoAction, ArcoPopover } from '@mica-config-ui/web'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { MAX_EDITOR_TEXT } from '../../../../../packages/mica-plugin/PluginPanel.ts'
// 控件全部来自设置页那同一套（见 packages/mica-config-ui）：插件面板里不另写按钮、
// 输入框、标签，否则同一个应用里会出现三种按钮高度和两套状态色。
import {
  Alert,
  Button,
  Checkbox,
  CollapsiblePanel,
  ConfigSwitch,
  Empty,
  Input,
  PluginIcon,
  SecretInput,
  Segmented,
  SettingRow,
  SplitView,
  Tag
} from '@mica-config-ui/web'
import { ModalShell } from './chat-modal'
import '../assets/plugin-cards.css'
import { FloatingMenu } from './FloatingMenu'
import { ShortcutButton } from './ShortcutButton'
import { notify } from './notify'
import { createReadQueue } from './read-queue'
import { pageIsActive, usePageVisible } from './use-page-visible'
// 分区正文的 Markdown 直接用对话区那一套渲染：同一个应用里不该有两份 Markdown 排版，
// 「需求描述」「角色描述」看起来才和对话里的内容一致。ChatView 也 import 本模块，
// 但两边都只在组件渲染时取值（不在模块顶层读），ESM 的活绑定在这里是安全的。
import { Markdown } from './ChatView'
import {
  applyPanelResult,
  createPanelActionQueue,
  isCompletedToolEvent,
  isOpenableLink,
  menuCacheKey,
  notifyPluginPanelStatusChanged,
  observePanelCardImpression,
  PANEL_RETRY_DELAYS,
  panelDraftKey,
  panelDrafts,
  panelViewContext,
  panelCardImpressionKey,
  panelNeedsQuickbarView,
  pluginPanelCards,
  pluginPanelTabs,
  pluginQuickbarItems,
  quickbarMenuItems,
  quickbarMenuTable,
  readMenuCache,
  readPanelView,
  reconcilePanelActionDrafts,
  reconcilePanelDrafts,
  sectionDrafts,
  subscribePluginPanelStatus,
  writePanelView,
  writeMenuCache,
  usePluginPanels
} from './plugin-panels'

/** 鼠标从按钮上滑过不算「要看这一组」：停一下才展开，划过整排不会连开好几个菜单。 */
const HOVER_DELAY_MS = 140
/**
 * 挂载后台预热一次视图。
 *
 * 动态菜单的条目要问插件（分支属于会话事实，清单里写不出来）。等用户真的把鼠标移上去
 * 才开始问，问的又偏偏是本地已有的数据，只会得到一句「正在读取」。所以在页面空下来之后
 * 先问一次，真正的悬停就总是命中缓存。
 */
const PREFETCH_DELAY_MS = 900

/**
 * 对话右侧的插件面板：仓库侧那一条按钮 + 点开的抽屉。
 *
 * 宿主不认识任何具体插件——按钮来自清单（`desktop.panel`），抽屉里的内容是插件给的
 * **数据**（`ctx.desktop.panel()` 返回的视图：标题、只读行、条目、输入框、按钮），
 * 宿主只负责画与回传动作。这样用户装在自己 `$MICA_HOME/plugins` 里的插件也能有界面，
 * 而它没有、也不需要前端模块。
 *
 * 视图里没有富文本：插件要表达「一个频道、一条建议、一次运行结果」，都落到条目与行上。
 * 每个 section 画成一块独立的折叠卡片，插件用 `collapsed` 决定初始状态。
 */

/** 打开时每隔一会儿重新取一次视图：插件有自己的定时器（复盘），界面得跟上。 */
const REFRESH_MS = 4000

/**
 * 插件声明的状态色调 → 共享 `Tag` 的色板。
 *
 * 插件说 `warn` 是「需要注意但没坏」，与 `error` 的「出错了」必须能分开看，所以
 * warn 落到 amber 而不是和默认灰混在一起。
 */
const TAG_TONES = {
  ok: 'green',
  error: 'red',
  warn: 'amber',
  accent: 'blue',
  muted: 'default'
}

/** 动作的 `tone` → 共享 `Button` 的变体；没声明的一律是行内次要动作。 */
const BUTTON_VARIANTS = { primary: 'primary', danger: 'danger', default: 'default' }
const CARD_BUTTON_VARIANTS = {
  primary: 'accent', default: 'default', ghost: 'ghost', danger: 'danger-ghost'
}

export const PREVIEW_HOVER_DELAY_MS = 180
/** 指针离开按钮后多久收起悬停卡片：够从按钮挪进卡片，又不至于让卡片一直挂着。 */
const PREVIEW_LEAVE_GRACE_MS = 160

function previewActionId(action) {
  if (typeof action?.action === 'string' && action.action.trim()) return action.action.trim()
  if (typeof action?.id === 'string' && action.id.trim()) return action.id.trim()
  return ''
}

export function QuickbarPreview({
  preview,
  anchor,
  onClose,
  onRun,
  onPointerEnter,
  onPointerLeave
}) {
  const markdown = typeof preview?.markdown === 'string' ? preview.markdown : ''
  const text = typeof preview?.text === 'string' ? preview.text : ''
  const columns = Array.isArray(preview?.columns) ? preview.columns : []
  const rows = Array.isArray(preview?.rows) ? preview.rows : []
  const actions = Array.isArray(preview?.actions)
    ? preview.actions.filter((action) => previewActionId(action) && action?.label)
    : []

  useEffect(() => {
    const close = (event) => {
      if (event.target?.closest?.('.chat-plugin-quickbar-group, .chat-plugin-quickbar-preview')) return
      onClose()
    }
    const keydown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    const focus = (event) => {
      if (event.target?.closest?.('.chat-plugin-quickbar-group, .chat-plugin-quickbar-preview')) return
      onClose()
    }
    const viewport = (event) => {
      if (event.target?.closest?.('.chat-plugin-quickbar-preview')) return
      onClose()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', keydown)
    window.addEventListener('focusin', focus)
    window.addEventListener('resize', viewport)
    window.addEventListener('scroll', viewport, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('focusin', focus)
      window.removeEventListener('resize', viewport)
      window.removeEventListener('scroll', viewport, true)
    }
  }, [onClose])

  const content = (
    <div
      className="chat-plugin-quickbar-preview-content"
      role="dialog"
      aria-label={preview?.title || '快捷按钮预览'}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {(preview?.title || preview?.subtitle) && (
        <header className="chat-plugin-quickbar-preview-head">
          {preview.title && <strong className="chat-plugin-quickbar-preview-title">{preview.title}</strong>}
          {preview.subtitle && <span className="chat-plugin-quickbar-preview-subtitle">{preview.subtitle}</span>}
        </header>
      )}
      {(markdown || text) && (
        <div className="chat-plugin-quickbar-preview-body">
          {markdown ? <Markdown text={markdown} /> : <p>{text}</p>}
        </div>
      )}
      {columns.length > 0 && rows.length > 0 && (
        <div className="chat-plugin-quickbar-preview-table-wrap">
          <table className="chat-plugin-table is-compact chat-plugin-quickbar-preview-table">
            <thead>
              <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className={cell?.tone ? `tone-${cell.tone}` : undefined}>
                      <span title={cell?.text || ''}>{cell?.text || ''}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(preview?.note || actions.length > 0) && (
        /* 说明和动作是同一件事（「这几个按钮是干什么的」），收在一块页脚里：中间不再夹
           一条飘在正文下面的灰字，页脚也只有一条分隔线。 */
        <footer className="chat-plugin-quickbar-preview-foot">
          {preview?.note && <p className="chat-plugin-quickbar-preview-note">{preview.note}</p>}
          {actions.length > 0 && (
            <div
              className="chat-plugin-quickbar-preview-actions"
              role="group"
              aria-label="预览操作"
            >
              {actions.map((action) => (
                <ArcoAction
                  key={`${previewActionId(action)}:${action.key || ''}`}
                  /* 次要动作是文字按钮：整卡只有一颗带底色的主操作，其余按钮各带一层
                     灰底时，页脚会变成一排一样重的方块，谁是真的下一步看不出来。 */
                  appearance={action.tone === 'primary' ? 'primary' : 'text'}
                  tone={action.tone === 'danger' ? 'danger' : action.tone === 'primary' ? 'accent' : undefined}
                  onClick={() => {
                    onClose()
                    onRun(action)
                  }}
                >
                  {action.label}
                </ArcoAction>
              ))}
            </div>
          )}
        </footer>
      )}
    </div>
  )

  return createPortal(
    <ArcoPopover
      className="chat-plugin-quickbar-preview"
      content={content}
      popupVisible
      trigger={[]}
      position="tl"
      getPopupContainer={() => document.body}
      style={{ maxWidth: 'min(400px, calc(100vw - 16px))', zIndex: 10000 }}
      triggerProps={{ showArrow: false, popupAlign: { top: 8, bottom: 8 } }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'fixed', pointerEvents: 'none', left: anchor.left, top: anchor.top,
          width: anchor.right - anchor.left, height: anchor.bottom - anchor.top
        }}
      />
    </ArcoPopover>,
    document.body
  )
}

/**
 * 协议里的图标名 → 具体图标。
 *
 * 清单里只有名字（`icon: 'trash'`），画哪一个由这里决定；认不出的名字当没写，退回文字
 * 按钮。映射表与 `PLUGIN_PANEL_ICONS` 一一对应，加名字时两边一起改。
 */
const PANEL_ICONS = {
  add: Plus,
  trash: Trash2,
  edit: Pencil,
  refresh: RefreshCw,
  save: Save,
  external: ExternalLink,
  close: X,
  check: Check
}

const panelIcon = (name) => {
  const Icon = PANEL_ICONS[name]
  if (!Icon) return null
  return <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
}

/**
 * 弹窗里「去配置」要知道是哪个插件。
 *
 * 插件只声明「这里该有个跳去配置的按钮」，具体打开哪一页由页面负责——而页面要的
 * `pluginId` 不在弹窗数据里，所以由调动作的这一侧补上（它一定知道自己在操作谁）。
 */
function withPluginDialog(dialog, pluginId) {
  return pluginId ? { ...dialog, pluginId } : dialog
}

const tagTone = (tone) => TAG_TONES[tone] || 'default'
/**
 * 没声明 `tone` 的动作按共享 `Button` 的默认样式画（带描边与底色）。
 *
 * 以前落到 `ghost`：按钮常态没有边框，鼠标悬停才浮出来，看着像一段能点的文字。行内动作
 * 该不该收掉边框由插件说了算（显式写 `tone: 'ghost'`），宿主不替它决定。
 */
const buttonVariant = (tone) => BUTTON_VARIANTS[tone] || 'default'

/**
 * 面板里的一个动作按钮（分区底部、条目行尾、表行行尾共用）。
 *
 * 带 `icon` 的**只画图标**：`label` 退成 `title` / 无障碍名。清单里每行挂一个带字的
 * 「删除」，表格就成了一列按钮墙；行内动作该是一颗安静的图标。没带图标的照旧画文字——
 * 「同步频道」「连接」这类主按钮，字才是它的意思。
 */
function PanelActionButton({ action, variant, size, busy, busyKey, run }) {
  const icon = action.icon ? panelIcon(action.icon) : null
  return (
    <Button
      variant={variant}
      size={size}
      icon={icon || undefined}
      title={action.hint || action.label}
      disabled={action.disabled || Boolean(busy)}
      loading={busy === busyKey}
      onClick={() => void run(action)}
    >
      {icon ? null : action.label}
    </Button>
  )
}

/** 纯数据摘要用宿主控件排版；只有挂载后的可见性观察能触发曝光。 */
function PluginSummaryCard({ card, panel, busy, onRun, onImpression }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!onImpression || !card.impressionAction) return undefined
    return observePanelCardImpression(ref.current, onImpression)
  }, [card.impressionAction, onImpression])
  return (
    <article
      ref={ref}
      className={`plugin-summary-card tone-${card.tone || 'muted'}`}
      aria-label={`${panel.label} · ${card.title}`}
    >
      <div className="plugin-summary-card-heading">
        <span className="plugin-summary-card-owner" title={panel.label}>{panel.label}</span>
        <strong className="plugin-summary-card-title" title={card.title}>{card.title}</strong>
      </div>
      {card.summary && <p className="plugin-summary-card-summary">{card.summary}</p>}
      {card.detail && (
        <details className="plugin-summary-card-detail">
          <summary>详情<span className="sr-only">：{card.title}</span></summary>
          <p>{card.detail}</p>
        </details>
      )}
      {card.actions?.length > 0 && (
        <div className="plugin-summary-card-actions" role="group" aria-label={`${card.title}操作`}>
          {card.actions.map((action) => (
            <Button
              key={action.id}
              size="compact"
              variant={CARD_BUTTON_VARIANTS[action.tone] || 'ghost'}
              title={action.label}
              disabled={Boolean(busy)}
              loading={busy === action.id}
              onClick={() => onRun(action)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </article>
  )
}

/**
 * 输入框上方那排快捷按钮（悬浮在输入框之上，左对齐）。
 *
 * 按钮来自清单 `desktop.panel.shortcuts`：`action` 点了直接把动作交给插件（例如「立刻
 * 检查」立刻投递一轮），`section` 点了打开面板并展开那一块（频道设置 / 复盘设置），
 * `items` 是一组写死的子项（「频道」→ 同步频道 / 频道设置），`menu` 的子项由面板视图
 * 现算（「Pull Request」→ 当前会话认领的每个副本）。插件因此能把「马上要做的事」
 * 「要改的配置」「要评审的分支」分开放，而宿主只管渲染。
 */
export function PluginQuickBar({
  nodeId,
  sessionId,
  cwd,
  role,
  visible = true,
  openPlugin,
  focusSection,
  onTogglePanel,
  onCompose,
  onLaunchSession,
  onDialog,
  onOpenPath,
  onOpenReview
}) {
  const pageVisible = usePageVisible(visible, true)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const panels = usePluginPanels(role)
  const [pending, setPending] = useState('')
  // 动作可以回一句话（「先添加频道」这类）：显示在按钮旁边，几秒后自己消失。
  const [feedback, setFeedback] = useState('')
  const [openMenu, setOpenMenu] = useState('')
  const [previewState, setPreviewState] = useState(null)
  const previewCloseTimer = useRef(0)
  // 子项菜单的落点按触发按钮的矩形现算（菜单本体是共享的 FloatingMenu，自己会收敛视口）。
  const [menuPos, setMenuPos] = useState(null)
  // 动态菜单要问插件要条目（分支是会话事实，清单里写不出来）。条目在页面层按会话缓存
  // （`plugin-panels.js` 的 menuCache），换页签、重挂载都直接命中。
  const [menuViews, setMenuViews] = useState({})
  const inflight = useRef(new Map())
  const [shortcutViews, setShortcutViews] = useState({})
  // 视图在运行期给的按钮（清单 `dynamicShortcuts`）：模型在会话里刚建的那一排。
  // 按插件 id 存，跟着 `loadView` 一起换成最新的一份。
  const [runtimeShortcuts, setRuntimeShortcuts] = useState({})
  // 面板视图里的常驻状态（`statusBar`）：关着面板也要看得见的事实（某个能力是否生效、
  // 连着哪台机器）。按插件 id 存，和 shortcutStates 一起随视图刷新。
  const [statusBars, setStatusBars] = useState({})
  const [cardViews, setCardViews] = useState(null)
  // 去重集合贯穿组件生命周期；切角色、轮询、卡片重新挂载都不会重复记同一版本。
  const impressions = useRef(new Set())
  const context = panelViewContext(nodeId, sessionId, cwd, role)
  // 身份对象还区分 A → B → A：第一次 A 的请求不能回填第二次 A。
  const scope = useMemo(() => ({ active: true, pending: '', inflight: new Map() }), [context])
  const contextRef = useRef(scope)
  contextRef.current = scope
  inflight.current = scope.inflight
  const panelsRef = useRef(panels)
  panelsRef.current = panels
  const isCurrent = useCallback((panel) => scope.active && contextRef.current === scope &&
    panelsRef.current.some((entry) => entry.id === panel.id), [scope])
  const canReadPanel = useCallback(
    (panel) => isCurrent(panel) && visibleRef.current && pageIsActive(),
    [isCurrent]
  )
  useEffect(() => {
    scope.active = true
    return () => { scope.active = false }
  }, [scope])
  const hoverTimer = useRef(0)
  const barRef = useRef(null)
  useEffect(() => {
    if (!feedback) return undefined
    const timer = setTimeout(() => setFeedback(''), 4000)
    return () => clearTimeout(timer)
  }, [feedback])
  useEffect(() => {
    if (!openMenu) return undefined
    // FloatingMenu 自己处理点外部与 Esc；这里只补「滚动/缩放时落点就失效了」。
    const onViewport = () => setOpenMenu('')
    window.addEventListener('resize', onViewport)
    window.addEventListener('scroll', onViewport, true)
    return () => {
      window.removeEventListener('resize', onViewport)
      window.removeEventListener('scroll', onViewport, true)
    }
  }, [openMenu])
  const items = useMemo(
    () => pluginQuickbarItems(panels, runtimeShortcuts),
    [panels, runtimeShortcuts]
  )

  const clearHover = useCallback(() => {
    if (!hoverTimer.current) return
    clearTimeout(hoverTimer.current)
    hoverTimer.current = 0
  }, [])
  useEffect(() => clearHover, [clearHover])
  // 收起卡片的定时器同样不能活过卸载：会话一关，它还会对着已卸掉的组件 setState。
  useEffect(() => () => clearTimeout(previewCloseTimer.current), [])

  // 同一插件的菜单和状态共用一次视图请求。上下文包含会话与目录，旧请求不能回填新会话。
  const loadView = useCallback(
    async (panel) => {
      const requestKey = `${context}\u0000${panel.id}`
      if (!canReadPanel(panel)) return null
      if (scope.inflight.has(requestKey)) return scope.inflight.get(requestKey)
      const request = (async () => {
        let result = null
        // 冷启动时会话宿主还在拉起（`view` 要现 spawn 一个进程），一次失败不代表插件不可用：
        // 状态行是「这个能力现在生效没有」的唯一提示，值得多试几次再放弃。
        for (let attempt = 0; attempt < PANEL_RETRY_DELAYS.length + 1; attempt += 1) {
          result = await window.mica.chat.pluginPanels
            .view(nodeId, { pluginId: panel.id, sessionId, cwd, hidden: !visibleRef.current })
            .catch(() => null)
          if (result && result.ok !== false) break
          if (attempt < PANEL_RETRY_DELAYS.length) {
            await new Promise((resolve) => setTimeout(resolve, PANEL_RETRY_DELAYS[attempt]))
            if (!canReadPanel(panel)) return null
          }
        }
        if (!isCurrent(panel)) return null
        if (result?.ok !== false && result) {
          const view = result.view || result
          writePanelView(context, panel.id, view)
          setShortcutViews((current) => ({ ...current, [requestKey]: view.shortcutStates || {} }))
          setStatusBars((current) => ({ ...current, [panel.id]: view.statusBar || null }))
          setCardViews((current) => {
            const cards = view.cards || []
            if (current?.scope === scope && JSON.stringify(current.cards[panel.id] || []) === JSON.stringify(cards)) return current
            return { scope, cards: { ...(current?.scope === scope ? current.cards : {}), [panel.id]: cards } }
          })
          // 没有按钮时清成空数组：视图不再给那几个按钮，这一排就该收起来。内容没变就不换
          // 引用——这一份直接决定 `items` 要不要重算，30 秒一次的轮询不该让整排重渲染。
          setRuntimeShortcuts((current) => {
            const next = view.shortcuts || []
            if (JSON.stringify(current[panel.id] || []) === JSON.stringify(next)) return current
            return { ...current, [panel.id]: next }
          })
          return { view }
        }
        return { error: result?.error || '读取失败，请重试' }
      })()
      scope.inflight.set(requestKey, request)
      try {
        return await request
      } finally {
        scope.inflight.delete(requestKey)
      }
    },
    [context, cwd, nodeId, sessionId, scope, isCurrent, canReadPanel]
  )

  const loadMenu = useCallback(
    async (panel, shortcut, key, { force = false } = {}) => {
      if (!shortcut?.menu || !isCurrent(panel)) return
      const cacheKey = menuCacheKey(context, panel.id, shortcut.menu)
      if (!force) {
        const cached = readMenuCache(cacheKey)
        if (cached) {
          setMenuViews((current) => ({ ...current, [key]: cached.entry }))
          if (!cached.stale) return
        }
      }
      const result = await loadView(panel)
      if (!result || !isCurrent(panel)) return
      const entry = result.error
        ? {
            table: { columns: [], rows: [] },
            ready: true,
            note: result.error,
            failed: true
          }
        : {
            table: quickbarMenuTable(result.view, shortcut.menu),
            ready: true,
            note: ''
          }
      if (!result.error) writeMenuCache(cacheKey, entry)
      setMenuViews((current) => ({ ...current, [key]: entry }))
    },
    [context, loadView, isCurrent]
  )

  useEffect(() => {
    clearHover()
    setMenuViews({})
    setOpenMenu('')
    setPreviewState(null)
    setShortcutViews({})
    setStatusBars({})
    setRuntimeShortcuts({})
    setCardViews(null)
    setPending('')
    setFeedback('')
  }, [context, clearHover])

  useEffect(() => {
    // 每个会话的 ChatView 都挂着这一排按钮（`chat-cache` 保留 5 个实例），
    // 而其中只有一个在屏幕上。不按可见性收窄，同一份视图会被 5 个实例各问一遍：
    // 实测 8 小时的日志里 8388 次 `chat:plugin-panel-view`、p75 3.5 秒，全部来自这里。
    if (!pageVisible) return undefined
    const wanted = items.filter(({ shortcut }) => shortcut.menu || shortcut.id)
    // 声明了 panel.status 的插件即使没有快捷按钮，也要为首屏取一次视图：输入框上方那条
    // 常驻状态就来自这里，不能等用户点开面板才出现。按钮由视图给的面板同理——不问就没有那
    // 一排按钮，而它正是这个面板存在的全部理由。
    // 摘要卡复用 dynamicShortcuts 的动态视图声明，静态面板不参与后台轮询。
    const statusOnly = panels.filter((panel) =>
      panelNeedsQuickbarView(panel) && !wanted.some((entry) => entry.panel.id === panel.id))
    if (!wanted.length && !statusOnly.length) return undefined
    const refresh = () => {
      if (!pageIsActive()) return
      const statusPanels = new Set()
      for (const { panel, shortcut, key } of wanted) {
        if (shortcut.menu) void loadMenu(panel, shortcut, key)
        if (!statusPanels.has(panel.id)) {
          statusPanels.add(panel.id)
          void loadView(panel)
        }
      }
      for (const panel of statusOnly) {
        if (statusPanels.has(panel.id)) continue
        statusPanels.add(panel.id)
        void loadView(panel)
      }
    }
    const timer = setTimeout(refresh, PREFETCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [items, panels, loadMenu, loadView, pageVisible])

  useEffect(() => {
    if (!pageVisible) return undefined
    const dynamicPanels = panels.filter(panelNeedsQuickbarView)
    if (!dynamicPanels.length) return undefined
    const refresh = () => {
      if (pageIsActive()) for (const panel of dynamicPanels) void loadView(panel)
    }
    // 抽屉里的动作改的是同一份插件状态：开关一拨，这条状态行要立刻变，不能等下一轮轮询。
    const unsubscribe = subscribePluginPanelStatus(refresh)
    const timer = setInterval(refresh, 30_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      unsubscribe()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [panels, loadView, pageVisible])

  useEffect(() => {
    if (!pageVisible) return undefined
    // 视图给按钮的面板即使此刻一个按钮都没有也要接工具事件：模型刚建的那一排就是在
    // 一次工具调用之后出现的，等 30 秒轮询等于让用户以为没做成。
    const viewPanels = panels.filter(panelNeedsQuickbarView)
    if (!nodeId) return undefined
    if (!items.some(({ shortcut }) => shortcut.menu || shortcut.id) && viewPanels.length === 0)
      return undefined
    let timer
    let active = true
    const refreshAfterTool = async () => {
      // 工具完成时旧的视图请求可能仍在途；先等它结束，再读取工具写入后的数据。
      await Promise.allSettled([...inflight.current.values()])
      if (!active || contextRef.current !== scope || !scope.active || !pageIsActive()) return
      const dynamic = new Set()
      for (const { panel, shortcut, key } of items) {
        if (shortcut.menu) void loadMenu(panel, shortcut, key, { force: true })
        if (shortcut.id && !dynamic.has(panel.id)) {
          dynamic.add(panel.id)
          void loadView(panel)
        }
      }
      for (const panel of viewPanels) {
        if (dynamic.has(panel.id)) continue
        dynamic.add(panel.id)
        void loadView(panel)
      }
    }
    const unsubscribe = window.mica.chat.onEvent((payload) => {
      if (!isCompletedToolEvent(payload, nodeId)) return
      clearTimeout(timer)
      timer = setTimeout(() => void refreshAfterTool(), 100)
    })
    return () => {
      active = false
      clearTimeout(timer)
      unsubscribe()
    }
  }, [context, items, loadMenu, loadView, nodeId, panels, pageVisible, scope])

  // 状态贴在哪一块面板上也要知道：点它进的是那块面板。
  const statusOwner = panels.find((panel) => statusBars[panel.id]?.label) || null
  const statusBar = statusOwner ? statusBars[statusOwner.id] : null
  const cards = pluginPanelCards(panels, cardViews?.scope === scope ? cardViews.cards : {})

  const openSection = (panel, section) => {
    const active = openPlugin === panel.id && focusSection === section
    onTogglePanel(active ? '' : panel.id, active ? '' : section)
  }

  const runAction = async (panel, action, key, buttonKey, { impression = false, values } = {}) => {
    if (!isCurrent(panel) || (!impression && scope.pending)) return
    if (!impression) {
      scope.pending = buttonKey || `${panel.id}:${action}`
      setPending(scope.pending)
    }
    try {
      const result = await window.mica.chat.pluginPanels
        .action(nodeId, { pluginId: panel.id, action, key, sessionId, cwd, ...(values ? { values } : {}) })
        .catch((cause) => ({ ok: false, error: String(cause?.message || cause) }))
      if (!isCurrent(panel)) return
      if (!impression) applyPanelResult(result, {
        onCompose,
        onLaunchSession,
        onDialog: (dialog) => onDialog?.(withPluginDialog(dialog, panel.id)),
        onOpenPath,
        onOpenReview
      })
      if (!impression) setFeedback(result?.ok === false ? result.error || '动作失败' : result?.message || '')
      // 等旧读请求结束再刷新，不能把动作前的在途视图当作动作后的结果。
      await scope.inflight.get(`${context}\u0000${panel.id}`)
      if (!isCurrent(panel)) return
      void loadView(panel)
      for (const entry of items.filter(
        (item) => item.panel.id === panel.id && item.shortcut.menu
      )) {
        void loadMenu(panel, entry.shortcut, entry.key, { force: true })
      }
    } finally {
      if (!impression) {
        scope.pending = ''
        if (contextRef.current === scope && scope.active) setPending('')
      }
    }
  }

  const runTarget = (panel, target) => {
    if (target.section) openSection(panel, target.section)
    else void runAction(panel, target.action, target.key)
  }

  const showMenu = (rect, panel, shortcut, key) => {
    // 菜单开在按钮正上方：这一排紧贴输入框，往下开就出屏了。FloatingMenu 会再按视口
    // 收敛一次，所以这里给一个「大致在按钮上面」的落点就够。
    if (rect)
      setMenuPos({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width)
      })
    setOpenMenu(key)
    void loadMenu(panel, shortcut, key)
  }

  const hoverMenu = (event, panel, shortcut, key) => {
    const rect = event?.currentTarget?.getBoundingClientRect?.() || null
    clearHover()
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = 0
      showMenu(rect, panel, shortcut, key)
    }, HOVER_DELAY_MS)
  }

  const runShortcut = async (event, panel, shortcut, key) => {
    clearHover()
    setPreviewState(null)
    // `menu` 说的是悬停看到什么，`section` / `action` 说的是点击做什么：两者共存时点击
    // 应该真的进面板改配置，而不是停在预览上。
    if (shortcut.section) {
      setOpenMenu('')
      openSection(panel, shortcut.section)
      return
    }
    if (shortcut.action) {
      // `key` 是「点的是哪一个」：一排运行期按钮共用同一个动作 id，靠它分辨。
      await runAction(panel, shortcut.action, shortcut.key, key)
      return
    }
    if (openMenu === key) setOpenMenu('')
    else showMenu(event?.currentTarget?.getBoundingClientRect?.() || null, panel, shortcut, key)
  }

  const showPreview = useCallback((eventOrRect, panel, shortcut, key, source = 'focus') => {
    if (!shortcut?.preview) return
    const rect = eventOrRect?.currentTarget?.getBoundingClientRect?.() || eventOrRect
    if (!rect) return
    clearHover()
    clearTimeout(previewCloseTimer.current)
    setOpenMenu('')
    setPreviewState({
      key,
      panel,
      shortcut,
      source,
      anchor: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        right: Math.round(rect.right)
      }
    })
  }, [clearHover])

  const hoverPreview = useCallback((event, panel, shortcut, key) => {
    if (!shortcut?.preview) return
    clearHover()
    const rect = event?.currentTarget?.getBoundingClientRect?.()
    if (!rect) return
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = 0
      showPreview(rect, panel, shortcut, key, 'hover')
    }, PREVIEW_HOVER_DELAY_MS)
  }, [clearHover, showPreview])

  // 悬停打开的卡片跟着鼠标走：离开按钮一小会儿就收起，但这点时间足够把指针移到卡片
  // 上——移上去就取消收起，于是「瞄一眼」和「认真读并点里面按钮」都不会被打断。
  // 点击/键盘打开的不受这条规则管，那种卡片本来就该等用户处理完。
  const schedulePreviewClose = useCallback(() => {
    if (previewState?.source !== 'hover') return
    clearTimeout(previewCloseTimer.current)
    previewCloseTimer.current = window.setTimeout(() => {
      previewCloseTimer.current = 0
      setPreviewState(null)
    }, PREVIEW_LEAVE_GRACE_MS)
  }, [previewState])

  const cancelPreviewClose = useCallback(() => clearTimeout(previewCloseTimer.current), [])

  // 提前返回必须排在所有 hook 之后：视图回来之前这一排是空的，先返回一次再渲染出按钮
  // 会让这次的 hook 数比上一次多（React #310）。只有状态栏没有按钮时也要画——那正是
  // 「功能开着、但不需要一个动作按钮」的形态。
  if (items.length === 0 && !statusBar && cards.length === 0 && !feedback) return null

  return (
    <div className="chat-plugin-quickbar-stack">
      {cards.length > 0 && (
        <div className="mica-config-ui plugin-summary-cards" role="region" aria-label="插件摘要">
          {cards.map(({ panel, card, key }) => (
            <PluginSummaryCard
              key={key}
              card={card}
              panel={panel}
              busy={pending ? (pending.startsWith(`${key}:`) ? pending.slice(key.length + 1) : true) : ''}
              onRun={(action) => void runAction(panel, action.id, action.key, `${key}:${action.id}`, {
                values: { cardId: card.id, revision: card.revision }
              })}
              onImpression={visible && card.impressionAction ? () => {
                if (!isCurrent(panel) || !pageIsActive()) return
                const impressionKey = panelCardImpressionKey(nodeId, sessionId, panel.id, card)
                if (impressions.current.has(impressionKey)) return
                impressions.current.add(impressionKey)
                void runAction(panel, card.impressionAction, card.revision, '', {
                  impression: true, values: { cardId: card.id, revision: card.revision }
                })
              } : undefined}
            />
          ))}
        </div>
      )}
      {(items.length > 0 || statusBar || feedback) && <div className="chat-plugin-quickbar" role="toolbar" aria-label="插件快捷操作" ref={barRef}>
        {/* 状态与快捷键同排：输入框上方已经有附件缩略图、引用条，再为一行状态单开一层，
            三行叠起来就把对话挤没了。它是一颗按钮——点开面板看详情。 */}
        {statusBar && (
          <ArcoAction
            type="button"
            appearance="outline"
            className={`chat-plugin-quickbar-button chat-plugin-statusbar tone-${statusBar.tone || 'muted'}`}
            title={`${statusBar.label}${statusBar.detail ? ` · ${statusBar.detail}` : ''} · 点开面板`}
            onClick={() => onTogglePanel(statusOwner.id, statusBar.section || '')}
          >
            <span className="chat-plugin-statusbar-dot" aria-hidden="true" />
            <span className="chat-plugin-statusbar-label">{statusBar.label}</span>
            {statusBar.detail && (
              <span className="chat-plugin-statusbar-detail">{statusBar.detail}</span>
            )}
          </ArcoAction>
        )}
        {items.map(({ panel, shortcut, key, first }) => {
          const state = shortcut.id
            ? shortcutViews[`${context}\u0000${panel.id}`]?.[shortcut.id]
            : null
          const disabled = state?.disabled === true
          const active =
            Boolean(shortcut.section) &&
            openPlugin === panel.id &&
            focusSection === shortcut.section
          const group = Boolean(shortcut.items || shortcut.menu)
          // 静态分组（清单直接给 items）不需要等面板视图；动态分组才读插件返回的那一块。
          const menuItems = shortcut.items ? quickbarMenuItems(shortcut) : []
          const menuTable = shortcut.menu
            ? (menuViews[key]?.table ?? { columns: [], rows: [] })
            : { columns: [], rows: [] }
          const menuEmpty = menuItems.length === 0 && menuTable.rows.length === 0
          return (
            <div
              key={key}
              className={`chat-plugin-quickbar-group${first && panels.length > 1 ? ' is-plugin-start' : ''}`}
              onMouseEnter={!disabled ? (event) => {
                // 从隔壁按钮直接挪过来时，别让上一颗按钮的收起定时器把卡片闪掉。
                cancelPreviewClose()
                if (shortcut.preview) hoverPreview(event, panel, shortcut, key)
                else if (group) hoverMenu(event, panel, shortcut, key)
              } : undefined}
              onMouseLeave={() => {
                clearHover()
                schedulePreviewClose()
              }}
            >
              <ShortcutButton
                shortcut={shortcut}
                panelLabel={panel.label}
                active={active}
                loading={pending === key}
                hasMenu={group}
                badge={state?.badge}
                title={state?.disabledReason || undefined}
                aria-expanded={group ? openMenu === key : undefined}
                disabled={Boolean(pending) || disabled}
                onFocus={(event) => showPreview(event, panel, shortcut, key)}
                onClick={(event) => void runShortcut(event, panel, shortcut, key)}
              />
              {group &&
                !disabled &&
                openMenu === key &&
                menuPos &&
                createPortal(
                  <FloatingMenu
                    key={`${key}:${menuItems.length}:${menuTable.rows.length}:${menuViews[key]?.ready || false}`}
                    x={menuPos.x}
                    y={menuPos.y}
                    minWidth={Math.max(menuPos.width, menuTable.rows.length > 0 ? 320 : 176)}
                    /* 这一排紧贴输入框，往下开会压住输入框：整组向上开。 */
                    placement="above"
                    /* 菜单本身也要豁免：否则 pointerdown 先关菜单，click 永远到不了菜单项。 */
                    ignoreSelector=".chat-plugin-quickbar-group, .chat-plugin-quickbar-menu"
                    onClose={() => setOpenMenu('')}
                  >
                    <div className="chat-plugin-quickbar-menu">
                      {menuEmpty ? (
                        shortcut.menu && !menuViews[key]?.ready ? (
                          <span className="plugin-menu-skeleton" aria-hidden="true">
                            <span className="plugin-menu-skeleton-row" />
                            <span className="plugin-menu-skeleton-row is-short" />
                          </span>
                        ) : (
                          <span className="plugin-menu-loading">
                            {menuViews[key]?.note || '暂时没有可选项'}
                            {menuViews[key]?.failed && (
                              <ArcoAction
                                type="button"
                                onClick={() => void loadMenu(panel, shortcut, key, { force: true })}
                              >
                                重试
                              </ArcoAction>
                            )}
                          </span>
                        )
                      ) : (
                        <>
                          {menuTable.rows.length > 0 && (
                            <QuickbarMenuTable
                              table={menuTable}
                              onRun={(row) => {
                                setOpenMenu('')
                                runTarget(panel, row)
                              }}
                            />
                          )}
                          {menuItems.map((item) => (
                            <ArcoAction
                              key={`${item.label}:${item.action || item.section}`}
                              type="button"
                              role="menuitem"
                              className="plugin-menu-item"
                              onClick={() => {
                                setOpenMenu('')
                                runTarget(panel, item)
                              }}
                            >
                              <span className="truncate">{item.label}</span>
                              {item.detail && (
                                <span className="plugin-menu-hint">{item.detail}</span>
                              )}
                            </ArcoAction>
                          ))}
                        </>
                      )}
                    </div>
                  </FloatingMenu>,
                  document.body
                )}
            </div>
          )
        })}
        {feedback && (
          <span className="chat-plugin-quickbar-note" role="status">
            {feedback}
          </span>
        )}
      </div>}
      {previewState?.shortcut?.preview && (
        <QuickbarPreview
          preview={previewState.shortcut.preview}
          anchor={previewState.anchor}
          onClose={() => setPreviewState(null)}
          onPointerEnter={cancelPreviewClose}
          onPointerLeave={schedulePreviewClose}
          onRun={(action) => {
            const id = previewActionId(action)
            if (id) void runAction(
              previewState.panel,
              id,
              typeof action.key === 'string' ? action.key : undefined,
              `${previewState.key}:preview:${id}`
            )
          }}
        />
      )}
    </div>
  )
}

/** 抽屉本体：只画 `openPlugin` 指定的那一块。 */
export function PluginPanels({
  nodeId,
  sessionId,
  cwd,
  role,
  visible = true,
  openPlugin,
  focusSection,
  onClose,
  onCompose,
  onLaunchSession,
  onDialog,
  onOpenPath,
  onOpenReview
}) {
  const panels = usePluginPanels(role)
  const open = panels.find((panel) => panel.id === openPlugin) || null

  // 角色换掉（或插件被停用）时收起：面板是按角色出现的，留着会变成一块无主的浮层
  useEffect(() => {
    if (openPlugin && !open) onClose()
  }, [onClose, open, openPlugin])

  if (!open) return null
  return (
    <PluginPanelDock
      key={`${panelViewContext(nodeId, sessionId, cwd, role)}:${open.id}`}
      pluginId={open.id}
      visible={visible}
      label={open.label}
      display={open.display}
      nodeId={nodeId}
      sessionId={sessionId}
      cwd={cwd}
      role={role}
      focusSection={focusSection}
      onClose={onClose}
      onCompose={onCompose}
      onLaunchSession={onLaunchSession}
      onDialog={onDialog}
      onOpenPath={onOpenPath}
      onOpenReview={onOpenReview}
    />
  )
}

function PluginPanelDock({
  pluginId,
  visible,
  label,
  display,
  nodeId,
  sessionId,
  cwd,
  role,
  focusSection,
  onClose,
  onCompose,
  onLaunchSession,
  onDialog,
  onOpenPath,
  onOpenReview
}) {
  const pageVisible = usePageVisible(visible, true)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  // 菜单那边刚问过同一份视图时直接拿它开局：点开抽屉不该先看到一句「正在读取」。
  const context = panelViewContext(nodeId, sessionId, cwd, role)
  const seeded = useRef(readPanelView(context, pluginId))
  const [view, setView] = useState(() => seeded.current?.view || null)
  const viewRef = useRef(seeded.current?.view || null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [drafts, setDrafts] = useState(() => panelDrafts(seeded.current?.view))
  const draftsRef = useRef(drafts)
  const updateDrafts = useCallback((update) => {
    draftsRef.current = typeof update === 'function' ? update(draftsRef.current) : update
    setDrafts(draftsRef.current)
  }, [])
  // 弹窗形态下的当前页签（存 section 标题）。抽屉形态不用它。
  const [activeTab, setActiveTab] = useState('')
  const aliveRef = useRef(true)
  const readsRef = useRef(null)
  const actionsRef = useRef(0)

  // 分区动作也能回一句话（注册成功/失败原因）：显示在面板顶部，几秒后自己消失。
  const [feedback, setFeedback] = useState('')
  useEffect(() => {
    if (!feedback) return undefined
    const timer = setTimeout(() => setFeedback(''), 8000)
    return () => clearTimeout(timer)
  }, [feedback])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const applyView = useCallback(
    (result, { resetDrafts = false, mergeDrafts = false, submitted, draftScope } = {}) => {
      if (!aliveRef.current) return
      if (result?.ok && result.view) {
        // 每 4 秒拉一次视图：没有变化就别换引用，否则整块面板连同滚动位置一起白重渲染。
        const same =
          viewRef.current && JSON.stringify(viewRef.current) === JSON.stringify(result.view)
        const baseline = panelDrafts(viewRef.current)
        viewRef.current = result.view
        if (!same) setView(result.view)
        setError('')
        writePanelView(context, pluginId, result.view)
        const next = panelDrafts(result.view)
        updateDrafts((previous) => {
          if (mergeDrafts) return { ...next, ...previous }
          if (resetDrafts && submitted) {
            return reconcilePanelActionDrafts(previous, baseline, next, submitted, draftScope)
          }
          return reconcilePanelDrafts(previous, baseline, next)
        })
      } else {
        setError(result?.error || '插件面板不可用')
      }
    },
    [context, pluginId, updateDrafts]
  )

  useEffect(() => {
    const reads = createReadQueue(
      async (isCurrent) => {
        const result = await window.mica.chat.pluginPanels
          .view(nodeId, { pluginId, sessionId, cwd, hidden: !visibleRef.current })
          .catch((cause) => ({ ok: false, error: String(cause?.message || cause) }))
        if (!isCurrent()) return
        applyView(result)
      },
      {
        canRead: () => visibleRef.current && pageIsActive() && actionsRef.current === 0
      }
    )
    readsRef.current = reads
    void reads.refresh()
    return () => {
      reads.dispose()
      readsRef.current = null
    }
  }, [applyView, cwd, nodeId, pluginId, sessionId])

  const load = useCallback(() => readsRef.current?.refresh(), [])

  useEffect(() => {
    // 抽屉只在看得见时才刷新：切到别的会话后这个实例仍然挂着，继续每 4 秒叫醒一个
    // 没人看的会话宿主，既费 IO 也让那个 host 永远「刚从活动过」而不被回收。
    if (!pageVisible) return undefined
    // 恢复可见时立刻补读。慢于 4 秒的读取与首屏读取共用队列，不叠请求，也不重置草稿。
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [load, pageVisible])

  const performAction = useCallback(
    async ({ action, key, extraValues, options, submitted }) => {
      const reads = readsRef.current
      // 动作返回的视图更新，不能被动作之前发出的慢轮询覆盖。
      reads?.invalidate()
      actionsRef.current += 1
      if (aliveRef.current) setBusy(key ? `${action}:${key}` : action)
      const result = await window.mica.chat.pluginPanels
        .action(nodeId, {
          pluginId,
          action,
          key,
          // 动作只属于发起它的那块分区：草稿按分区存，交出去时还原成插件认识的扁平字段表。
          values: {
            ...(options.draftScope === undefined ? {} : sectionDrafts(submitted, options.draftScope)),
            ...extraValues
          },
          // 就地编辑器提交的是整篇正文（`section.editor`）：它不进 `values`——那一列是
          // 「一行状态」，每个值 2000 字上限，装不下一份文件。
          ...(typeof options.text === 'string' ? { text: options.text } : {}),
          sessionId,
          cwd
        })
        .catch((cause) => ({ ok: false, error: String(cause?.message || cause) }))
      actionsRef.current -= 1
      if (!aliveRef.current) {
        if (result?.ok === false) notify({
          key: `plugin-panel-save:${context}:${pluginId}`,
          text: `${label}：自动保存失败`,
          detail: result.error || '动作失败，请重新打开面板重试',
          level: 'error'
        })
        return result
      }
      if (reads !== readsRef.current) return result
      setBusy('')
      // 表格里的勾选是一次状态切换，不是提交表单：换视图时不能让用户正在填的表单归位。
      // 插件也可以用 `keepDrafts` 说同一件事（输入停顿后的自动提交、提交失败）。
      applyView(
        result,
        options.keepDrafts === true || result?.keepDrafts === true || result?.ok === false
          ? { mergeDrafts: true }
          : { resetDrafts: true, submitted, draftScope: options.draftScope }
      )
      applyPanelResult(result, {
        onCompose,
        onLaunchSession,
        onDialog: (dialog) => onDialog?.(withPluginDialog(dialog, pluginId)),
        onOpenPath,
        onOpenReview
      })
      setFeedback(result?.ok === false ? result.error || '动作失败' : result?.message || '')
      // 动作可能改了插件状态（开关、连接、增删机器）：快捷栏的状态行与菜单要跟着变。
      notifyPluginPanelStatusChanged()
      // 就地编辑器要据此决定「留在编辑态还是收起」：保存失败时不能把用户刚写的字丢了。
      return result
    },
    [
      applyView,
      context,
      cwd,
      label,
      nodeId,
      onCompose,
      onDialog,
      onLaunchSession,
      onOpenPath,
      onOpenReview,
      pluginId,
      sessionId
    ]
  )

  const performRef = useRef(performAction)
  performRef.current = performAction
  const queue = useMemo(() => createPanelActionQueue((task) => performRef.current(task)), [])
  useEffect(() => () => queue.flush(), [queue])
  const runAction = useCallback((action, key, extraValues, options = {}) =>
    queue.action(options.draftScope, {
      action, key, extraValues, options, submitted: { ...draftsRef.current }
    }), [queue])
  const commitDrafts = useCallback((action, draftScope) => queue.commit(draftScope, {
    action, options: { keepDrafts: true, draftScope }, submitted: { ...draftsRef.current }
  }), [queue])

  const sections = useMemo(() => view?.sections || [], [view])
  const statusTone = view?.status?.tone || 'muted'

  const { tabs, activeIndex: initialTabIndex } = useMemo(
    () => pluginPanelTabs(sections, focusSection),
    [sections, focusSection]
  )
  const sectionKeys = useMemo(() => tabs.map((tab) => tab.key), [tabs])
  // 快捷按钮点名的是分区标题，页签的 key 里带着位置（同名分区不能共用一个 key）。
  const focusTab = focusSection ? tabs.find((tab) => tab.title === focusSection) : undefined

  // `focusSection` 只在它变化时生效一次：否则每 4 秒刷新都会把用户刚点开的其它块重新收起。
  const appliedFocusRef = useRef(null)

  useEffect(() => {
    if (sections.length === 0) return
    const focusKey = focusSection ? `${pluginId}:${focusSection}` : ''
    if (appliedFocusRef.current === focusKey) return
    appliedFocusRef.current = focusKey
    // 弹窗形态：快捷按钮点名的那一块直接切到它；没点名就停在当前页签，
    // 页签被删掉（插件改了分区）才回落到第一块。
    if (focusTab) setActiveTab(focusTab.key)
    else setActiveTab((previous) => (sectionKeys.includes(previous) ? previous : sectionKeys[0]))
  }, [focusSection, focusTab, pluginId, sectionKeys, sections])

  const renderSection = (section, index, key, { tabbed = false } = {}) => (
    <PluginPanelSection
      key={key}
      section={section}
      // 草稿与动作都按分区隔离：两块都叫「地址」的输入框不能共用一个字符串。
      draftScope={index}
      tabbed={tabbed}
      // 抽屉里的折叠由 <details> 自己管（用户点开就是点开，4 秒刷新不会把它翻回去）；
      // 快捷按钮点名的那一块靠 key 变化重挂载来强制展开。
      focused={focusTab?.key === key}
      drafts={drafts}
      setDrafts={updateDrafts}
      // 输入停顿后的自动提交不能让整块草稿跟着服务端视图归位：请求在途时用户还在打字，
      // 那几笔没提交过的字符会被直接抹掉（下一拍才又被当成新改动）。
      commit={
        section.commit
          ? () => commitDrafts(section.commit, index)
          : null
      }
      flushCommit={() => queue.flush(index)}
      busy={busy}
      runAction={runAction}
    />
  )

  const placeholder = (
    <>
      {error && <Alert message={error} />}
      {!view && !error && (
        <p className="chat-plugin-loading">
          <Loader2 size={13} className="chat-plugin-spin" /> 正在读取…
        </p>
      )}
    </>
  )

  // 呈现形态由清单决定（`desktop.panel.display`）：同一份视图数据，只换外壳。
  //
  // 弹窗走共用 ModalShell，Esc / 点遮罩 / 关闭按钮的行为与其它弹窗一致；里面是
  // **左侧分区 + 右侧详情**（复用设置页的 SplitView）。以前是横排页签：分区一多就挤成
  // 一行小字，而每块内容的长度差得很远（一行状态 vs 几千字的需求描述）——左栏固定宽度、
  // 右栏自己滚，两种都稳。高度由 .chat-plugin-modal 定死，切分区时不伸不缩。
  if (display === 'modal') {
    const focused = tabs.findIndex((tab) => tab.key === activeTab)
    const tabIndex = focused >= 0 ? focused : initialTabIndex
    const activeSection = sections[tabIndex]
    return (
      <ModalShell
        title={view?.title || label}
        subtitle={view?.subtitle || null}
        className="chat-plugin-modal"
        actions={
          <>
            {view?.status && <Tag tone={tagTone(statusTone)}>{view.status.label}</Tag>}
            {feedback && (
              <span className="chat-plugin-feedback" role="status">
                {feedback}
              </span>
            )}
          </>
        }
        onClose={onClose}
      >
        {/* 设置页那套控件与配色：左栏是 .split-item，行是 SettingRow，按钮 / 标签 /
            空态 / 错误条都来自 @mica-config-ui/web，内容外面套 .mica-config-ui。 */}
        <div className="mica-config-ui is-embed chat-plugin-panel">
          {sections.length > 0 && (
            <SplitView
              rail={
                <div className="split-rail-list" role="tablist" aria-label="面板分区">
                  {tabs.map((tab, index) => (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      aria-selected={index === tabIndex}
                      className={`split-item${index === tabIndex ? ' is-active' : ''}`}
                      onClick={() => setActiveTab(tab.key)}
                    >
                      <span className="split-item-copy">
                        <span className="split-item-title">{tab.label}</span>
                      </span>
                    </button>
                  ))}
                </div>
              }
            >
              <div className="chat-plugin-detail">
                <header className="chat-plugin-detail-head">
                  <h2>{activeSection?.title || view?.title || label}</h2>
                  {activeSection?.subtitle ? <p>{activeSection.subtitle}</p> : null}
                </header>
                <div className="chat-plugin-detail-body">
                  {placeholder}
                  {activeSection &&
                    renderSection(activeSection, tabIndex, sectionKeys[tabIndex], { tabbed: true })}
                </div>
              </div>
            </SplitView>
          )}
          {sections.length === 0 && <div className="chat-plugin-panel-body">{placeholder}</div>}
        </div>
      </ModalShell>
    )
  }

  const body = (
    <>
      {placeholder}
      {sections.map((section, index) => renderSection(section, index, sectionKeys[index]))}
    </>
  )

  return (
    <aside className="chat-plugin-dock" aria-label={`${view?.title || label} 插件面板`}>
      <header className="chat-plugin-dock-head">
        {/* 标题旁的状态徽标来自共享控件库：套上作用域才拿到 Tag 自己的底色与圆角 */}
        <div className="chat-plugin-dock-title mica-config-ui is-embed">
          <span>{view?.title || label}</span>
          {view?.status && <Tag tone={tagTone(statusTone)}>{view.status.label}</Tag>}
        </div>
        <ArcoAction type="button" iconOnly className="chat-plugin-close" title="收起" aria-label="收起" onClick={onClose}>
          <X size={13} />
        </ArcoAction>
      </header>
      {view?.subtitle && <p className="chat-plugin-dock-subtitle">{view.subtitle}</p>}
      {feedback && (
        <p className="chat-plugin-feedback" role="status">
          {feedback}
        </p>
      )}
      <div className="mica-config-ui is-embed chat-plugin-dock-body">{body}</div>
    </aside>
  )
}

/**
 * 一块折叠卡片：标题行可点，内容只在展开时渲染。
 *
 * 导出是为了让渲染冒烟测试能真的把一块分区画出来：分区里的每个动作按钮都必须拿到
 * 自己的 `action`，漏传时整块面板会崩（React 的错误边界兜不住运行时异常）。
 */
export function PluginPanelSection({
  section,
  tabbed = false,
  focused,
  drafts,
  setDrafts,
  draftScope = 0,
  commit,
  flushCommit,
  busy,
  runAction
}) {
  const flushRef = useRef(flushCommit)
  flushRef.current = flushCommit
  useEffect(() => () => flushRef.current?.(), [])

  const changeDraft = (key, value) => {
    setDrafts((previous) => ({ ...previous, [key]: value }))
    commit?.()
  }

  // 这块分区里的所有动作（字段、行尾按钮、表格、编辑器）都带上同一个作用域：
  // 提交给插件的 `values` 只装这一块自己的字段，别处同名输入框的字不会串进来。
  const act = (action, key, extraValues, options = {}) =>
    runAction(action, key, extraValues, { ...options, draftScope })

  const body = (
    <PluginPanelRows
      section={section}
      drafts={drafts}
      draftScope={draftScope}
      changeDraft={changeDraft}
      busy={busy}
      runAction={act}
    />
  )

  // 弹窗形态：标题已经在左栏与详情头里，再套一层折叠卡片就是三遍同名标题。
  if (tabbed) return <div className="chat-plugin-pane">{body}</div>

  // 抽屉形态沿用设置页的折叠卡片（details），折叠状态归它自己管。
  return (
    <CollapsiblePanel
      // key 带上分区标题：插件改了分区顺序也不会把折叠状态串到另一块上。
      // 被快捷按钮点名时换成 'focus'，重挂载一次以强制展开。
      key={`${section.title || ''}:${focused ? 'focus' : section.collapsed ? 'closed' : 'open'}`}
      title={section.title || '未命名'}
      meta={section.subtitle || null}
      defaultOpen={focused || !section.collapsed}
    >
      {body}
    </CollapsiblePanel>
  )
}

/** 一块分区的内容：只读行、条目、输入框、动作，全部落在共享 `SettingRow` 上。 */
function PluginPanelRows({ section, drafts, draftScope = 0, changeDraft, busy, runAction }) {
  const hasBody = Boolean(section.text || section.markdown || section.editor)
  const tableRows = section.table?.rows || []
  const hasRows = (section.rows?.length || 0) + (section.items?.length || 0) + tableRows.length > 0
  // 草稿按分区存：同名 `key` 出现在两块分区里时，输入的字不会互相串。
  const draftOf = (key) => drafts[panelDraftKey(draftScope, key)]
  const changeField = (key, value) => changeDraft(panelDraftKey(draftScope, key), value)
  return (
    <div className="chat-plugin-rows">
      {/* 正文：一整段话（需求描述、结论）。行是「标签 — 一个值」，这里没有标签也不省略。
          插件说是 Markdown 就按对话区那套排版画（标题、列表、表格），否则只保留换行。 */}
      {section.editor ? (
        <PluginPanelEditor editor={section.editor} busy={busy} runAction={runAction} />
      ) : section.markdown ? (
        <div className="chat-plugin-markdown">
          <Markdown text={section.markdown} />
        </div>
      ) : (
        hasBody && <p className="chat-plugin-text">{section.text}</p>
      )}
      {section.rows?.map((row, index) => (
        // 行是位置数据，标签可能重复（一个仓库一行「位置」这类）：用序号做 key，
        // 别让 React 因为同名把两行认成同一行。
        <SettingRow key={`${row.label}-${index}`} label={row.label}>
          <span
            className={`chat-plugin-value${row.tone ? ` tone-${row.tone}` : ''}${
              row.wrap === true ? ' is-wrap' : ''
            }`}
            title={row.value || undefined}
          >
            {row.link && isOpenableLink(row.link) ? (
              <ArcoAction
                type="button"
                className="chat-plugin-link"
                title={row.value || row.link}
                onClick={() => window.mica.terminal.openExternal(row.link).catch(() => {})}
              >
                {row.value || row.link}
              </ArcoAction>
            ) : (
              (row.value ?? '—')
            )}
          </span>
        </SettingRow>
      ))}
      {section.items?.map((item) => (
        <SettingRow key={item.key} label={item.label}>
          <span className="chat-plugin-item">
            <span
              className={`chat-plugin-value tone-${item.tone || 'muted'}`}
              title={item.value || undefined}
            >
              {item.value || ''}
            </span>
            {item.actions?.length > 0 && (
              <span className="chat-plugin-item-actions">
                {item.actions.map((action) => (
                  <PanelActionButton
                    key={action.id}
                    action={action}
                    variant={buttonVariant(action.tone)}
                    busy={busy}
                    busyKey={`${action.id}:${item.key}`}
                    run={(entry) => runAction(entry.id, item.key)}
                  />
                ))}
              </span>
            )}
          </span>
        </SettingRow>
      ))}
      {/* 没有正文也没有行/条目时才画空态：只有输入框的 section（加频道）也该先说明
          「现在还没有」，表单本身不算内容。 */}
      {!hasBody && !hasRows && section.empty ? <Empty description={section.empty} /> : null}
      {tableRows.length > 0 && (
        <PluginPanelTable table={section.table} busy={busy} runAction={runAction} />
      )}
      {section.fields?.map((field) =>
        field.action ? (
          // 「填一项，加一条」：输入与提交是同一个动作，所以同一行。写成「上面一个带标签的
          // 输入行 + 下面一个按钮」，读起来像两件事，中间还隔着一列标签的空白。
          <div className="chat-plugin-add-row" key={field.key}>
            <Input
              id={`chat-plugin-field-${field.key}`}
              className="text-input"
              type="text"
              aria-label={field.label}
              title={field.hint || field.label}
              placeholder={field.placeholder || field.label}
              value={draftOf(field.key) ?? ''}
              onChange={(value) => changeField(field.key, value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                void runAction(field.action.id)
              }}
            />
            <PanelActionButton
              action={field.action}
              variant={buttonVariant(field.action.tone)}
              busy={busy}
              busyKey={field.action.id}
              run={(entry) => runAction(entry.id)}
            />
          </div>
        ) : (
          <SettingRow
            key={field.key}
            label={field.label}
            hint={field.hint}
            htmlFor={`chat-plugin-field-${field.key}`}
          >
            {field.type === 'switch' ? (
              <ConfigSwitch
                id={`chat-plugin-field-${field.key}`}
                label={field.label}
                checked={(draftOf(field.key) ?? field.value) === 'true'}
                disabled={Boolean(busy)}
                onChange={(next) => changeField(field.key, next ? 'true' : 'false')}
              />
            ) : field.type === 'select' ? (
              <Segmented
                id={`chat-plugin-field-${field.key}`}
                value={draftOf(field.key) ?? ''}
                options={field.options || []}
                ariaLabel={field.label}
                disabled={Boolean(busy)}
                onChange={(next) => changeField(field.key, next)}
              />
            ) : field.type === 'password' ? (
              <SecretInput
                id={`chat-plugin-field-${field.key}`}
                value={draftOf(field.key) ?? ''}
                placeholder={field.placeholder || ''}
                ariaLabel={field.label}
                onChange={(next) => changeField(field.key, next)}
              />
            ) : (
              <Input
                id={`chat-plugin-field-${field.key}`}
                className="text-input"
                type="text"
                inputMode={field.type === 'number' ? 'numeric' : undefined}
                value={draftOf(field.key) ?? ''}
                placeholder={field.placeholder || ''}
                onChange={(value) => changeField(field.key, value)}
              />
            )}
          </SettingRow>
        )
      )}
      {section.actions?.length > 0 && (
        <div className="chat-plugin-section-actions">
          {section.actions.map((action) => (
            <PanelActionButton
              key={action.id}
              action={action}
              variant={buttonVariant(action.tone)}
              busy={busy}
              busyKey={action.id}
              run={(entry) => runAction(entry.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 就地编辑器：一块正文，点一下就换成文本框，保存时整篇回给插件。
 *
 * 正文不做 Markdown 渲染——这里改的是文件本身，看到的就该是磁盘上那份文本，光标落在
 * 第几行就是文件里的第几行。（「读起来好看」是分区里 `markdown` 那块的事。）
 *
 * 草稿只在**不在编辑时**跟随视图刷新：面板每几秒取一次视图，拿新值盖掉正在写的字是最
 * 难受的一种丢失。保存失败同样留在编辑态——那句失败原因就是让你改完再存一次。
 */
function PluginPanelEditor({ editor, busy, runAction }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(editor.value)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!editing) setDraft(editor.value)
  }, [editor.value, editing])

  const cancel = () => {
    setDraft(editor.value)
    setEditing(false)
  }

  const save = async () => {
    if (busy) return
    if (draft.length > MAX_EDITOR_TEXT) {
      setError(`正文超过 ${MAX_EDITOR_TEXT} 字符，未保存；请缩短正文或使用文件编辑器`)
      return
    }
    setError('')
    const result = await runAction(editor.action, undefined, {}, { text: draft, keepDrafts: true })
    if (result?.ok !== false) setEditing(false)
  }

  if (editing) {
    return (
      <div className="chat-plugin-editor">
        {error && <Alert message={error} />}
        <Input.TextArea
          className="chat-plugin-editor-input"
          aria-label={editor.editLabel || '编辑正文'}
          value={draft}
          spellCheck={false}
          placeholder={editor.placeholder || ''}
          onChange={setDraft}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
            event.preventDefault()
            void save()
          }}
        />
        <div className="chat-plugin-editor-actions">
          <span className="chat-plugin-editor-count">{draft.length.toLocaleString()} 字符</span>
          <Button variant="default" disabled={Boolean(busy)} onClick={cancel}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={Boolean(busy)}
            loading={busy === editor.action}
            onClick={() => void save()}
          >
            {editor.saveLabel || '保存'}
          </Button>
        </div>
      </div>
    )
  }

  // 整块正文本身就是「编辑」的入口：点一行字，比先找个按钮再点一次更直接。
  const startEditing = editor.readOnly ? undefined : () => setEditing(true)
  return (
    <div className="chat-plugin-editor">
      <div className="chat-plugin-editor-head">
        <span className="chat-plugin-editor-count">
          {editor.value.length.toLocaleString()} 字符
        </span>
        {editor.readOnly ? null : (
          <Button
            variant="default"
            size="compact"
            icon={<Pencil size={14} strokeWidth={1.75} aria-hidden="true" />}
            onClick={startEditing}
          >
            {editor.editLabel || '编辑'}
          </Button>
        )}
      </div>
      <pre className="chat-plugin-editor-text" onClick={startEditing}>
        {editor.value}
      </pre>
    </div>
  )
}

/**
 * 一张表格：列由插件声明，行是纯数据。
 *
 * 动作与条目共用一条路径 —— 行按钮发 `action + key`（`key` 是行 key），勾选框发
 * `action + key + values.check/column`。插件因此不需要知道「这次点的是第几列」。
 */
/**
 * 快捷按钮悬停时展开的那张表。
 *
 * 行本身是一个按钮（`role="menuitem"`）：悬停出来的一层里再放「评审」小按钮，既点不准，
 * 也让键盘走位变成两层。整行可点，列只负责排版。
 */
function QuickbarMenuTable({ table, onRun }) {
  const cellText = (row) =>
    table.columns
      .map((column) => row.cells?.[column.key]?.text || row.cells?.[column.key]?.link || '')
      .filter(Boolean)
      .join(' · ')
  // 复用插件面板那份表格（chat-plugin-table）：真正的 <table> 才会让每一行的列互相对齐，
  // 每行各算一套栅格时列宽只能各看各的内容。
  return (
    <div className="chat-plugin-table-wrap chat-plugin-quickbar-table">
      <table className="chat-plugin-table is-compact">
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr
              key={row.key}
              role="menuitem"
              tabIndex={0}
              title={cellText(row)}
              onClick={() => onRun(row)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onRun(row)
              }}
            >
              {table.columns.map((column) => {
                const cell = row.cells?.[column.key]
                return (
                  <td
                    key={column.key}
                    className={
                      [column.grow ? 'is-grow' : '', cell?.tone ? `tone-${cell.tone}` : '']
                        .filter(Boolean)
                        .join(' ') || undefined
                    }
                  >
                    {cell?.text || cell?.link || '—'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PluginPanelTable({ table, busy, runAction }) {
  const columns = table?.columns || []
  const rows = table?.rows || []
  const hasActions = rows.some((row) => (row.actions?.length || 0) > 0)
  const actionsColumn = columns.find((column) => column.actions)
  // 插件没指定按钮列时补在最右：只有编辑/删除、没有勾选框的表不必为此写一列。
  const trailingActions = hasActions && !actionsColumn
  // 勾选列窄且居中：它是「是/否」的一格状态，不该跟着表头文字一起把行撑开。
  const checkColumns = new Set()
  for (const row of rows) {
    for (const [key, cell] of Object.entries(row.cells || {})) {
      if (cell?.check) checkColumns.add(key)
    }
  }
  const columnClass = (column) =>
    [
      column.grow ? 'is-grow' : '',
      column.actions ? 'is-actions' : '',
      checkColumns.has(column.key) ? 'is-check' : ''
    ]
      .filter(Boolean)
      .join(' ')
  return (
    <div className="chat-plugin-table-wrap">
      <table className="chat-plugin-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={columnClass(column)} scope="col">
                {column.label}
              </th>
            ))}
            {trailingActions && <th className="is-actions" scope="col" aria-label="操作" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              {columns.map((column) => {
                if (column.actions) {
                  return (
                    <td key={column.key} className="is-actions">
                      <PluginPanelRowActions row={row} busy={busy} runAction={runAction} />
                    </td>
                  )
                }
                const cell = row.cells?.[column.key]
                return (
                  <td key={column.key} className={columnClass(column)}>
                    <PluginPanelTableCell
                      cell={cell}
                      rowKey={row.key}
                      columnKey={column.key}
                      label={column.label}
                      busy={busy}
                      runAction={runAction}
                    />
                  </td>
                )
              })}
              {trailingActions && (
                <td className="is-actions">
                  <PluginPanelRowActions row={row} busy={busy} runAction={runAction} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PluginPanelRowActions({ row, busy, runAction }) {
  return (row.actions || []).map((action) => (
    <PanelActionButton
      key={action.id}
      action={action}
      // 行内动作一律幽灵按钮（破坏性的挂红字）：每行都画带边框的方块，表格就成了一排按钮墙。
      variant={action.tone === 'danger' ? 'danger-ghost' : buttonVariant(action.tone)}
      size="compact"
      busy={busy}
      busyKey={`${action.id}:${row.key}`}
      run={(entry) => runAction(entry.id, row.key)}
    />
  ))
}

function PluginPanelTableCell({ cell, rowKey, columnKey, label, busy, runAction }) {
  if (!cell) return null
  if (cell.check) {
    return (
      <Checkbox
        checked={cell.check.checked}
        label={`${label}：${rowKey}`}
        size="compact"
        disabled={cell.check.disabled || Boolean(busy)}
        onChange={(next) =>
          void runAction(
            cell.check.action,
            rowKey,
            { column: columnKey, check: next ? 'true' : 'false' },
            { keepDrafts: true }
          )
        }
      />
    )
  }
  const body = cell.text || cell.link || '—'
  const primary =
    cell.link && isOpenableLink(cell.link) ? (
      <ArcoAction
        type="button"
        className={`chat-plugin-link${cell.tone ? ` tone-${cell.tone}` : ''}`}
        title={body}
        onClick={() => window.mica.terminal.openExternal(cell.link).catch(() => {})}
      >
        {body}
      </ArcoAction>
    ) : (
      <span
        className={`chat-plugin-cell${cell.tone ? ` tone-${cell.tone}` : ''}`}
        title={cell.text || undefined}
      >
        {cell.text || ''}
      </span>
    )
  if (!cell.sub) return primary
  return (
    <span className="chat-plugin-cell-stack">
      {primary}
      <span className="chat-plugin-cell-sub" title={cell.sub}>
        {cell.sub}
      </span>
    </span>
  )
}
