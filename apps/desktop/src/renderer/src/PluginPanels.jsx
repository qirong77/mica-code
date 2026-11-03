import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { createPortal } from 'react-dom'
// 控件全部来自设置页那同一套（见 packages/mica-config-ui）：插件面板里不另写按钮、
// 输入框、标签，否则同一个应用里会出现三种按钮高度和两套状态色。
import {
  Alert,
  Button,
  CollapsiblePanel,
  Empty,
  SecretInput,
  SettingRow,
  SplitView,
  Tag
} from '@mica-config-ui/web'
import { ModalShell } from './chat-modal'
import { FloatingMenu } from './FloatingMenu'
import {
  applyPanelResult,
  isOpenableLink,
  menuCacheKey,
  panelDrafts,
  pluginPanelTabs,
  quickbarMenuItems,
  readMenuCache,
  readPanelView,
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

const tagTone = (tone) => TAG_TONES[tone] || 'default'
const buttonVariant = (tone) => BUTTON_VARIANTS[tone] || 'ghost'

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
  openPlugin,
  focusSection,
  onTogglePanel,
  onCompose,
  onLaunchSession,
  onDialog,
  onOpenPath,
  onOpenReview
}) {
  const panels = usePluginPanels(role)
  const [pending, setPending] = useState('')
  // 动作可以回一句话（「先添加频道」这类）：显示在按钮旁边，几秒后自己消失。
  const [feedback, setFeedback] = useState('')
  const [openMenu, setOpenMenu] = useState('')
  // 子项菜单的落点按触发按钮的矩形现算（菜单本体是共享的 FloatingMenu，自己会收敛视口）。
  const [menuPos, setMenuPos] = useState(null)
  // 动态菜单要问插件要条目（分支是会话事实，清单里写不出来）。条目在页面层按会话缓存
  // （`plugin-panels.js` 的 menuCache），换页签、重挂载都直接命中。
  const [menuViews, setMenuViews] = useState({})
  const inflight = useRef(new Map())
  const [shortcutViews, setShortcutViews] = useState({})
  const context = JSON.stringify([nodeId, sessionId, cwd, role])
  const contextRef = useRef(context)
  contextRef.current = context
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
  const items = useMemo(() => {
    const list = []
    for (const panel of panels) {
      for (const [index, shortcut] of panel.shortcuts.entries()) {
        list.push({
          panel,
          shortcut,
          key: `${panel.id}:${shortcut.id || `legacy-${index}`}`,
          first: index === 0
        })
      }
    }
    return list
  }, [panels])

  const clearHover = useCallback(() => {
    if (!hoverTimer.current) return
    clearTimeout(hoverTimer.current)
    hoverTimer.current = 0
  }, [])
  useEffect(() => clearHover, [clearHover])

  // 同一插件的菜单和状态共用一次视图请求。上下文包含会话与目录，旧请求不能回填新会话。
  const loadView = useCallback(
    async (panel) => {
      const requestKey = `${context}\u0000${panel.id}`
      if (inflight.current.has(requestKey)) return inflight.current.get(requestKey)
      const request = (async () => {
        let result = null
        for (let attempt = 0; attempt < 2; attempt += 1) {
          result = await window.mica.chat.pluginPanels
            .view(nodeId, { pluginId: panel.id, sessionId, cwd })
            .catch(() => null)
          if (result && result.ok !== false) break
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350))
        }
        if (contextRef.current !== context) return null
        if (result?.ok !== false && result) {
          const view = result.view || result
          setShortcutViews((current) => ({ ...current, [requestKey]: view.shortcutStates || {} }))
          return { view }
        }
        return { error: result?.error || '读取失败，请重试' }
      })()
      inflight.current.set(requestKey, request)
      try {
        return await request
      } finally {
        inflight.current.delete(requestKey)
      }
    },
    [context, cwd, nodeId, sessionId]
  )

  const loadMenu = useCallback(
    async (panel, shortcut, key, { force = false } = {}) => {
      if (!shortcut?.menu) return
      const cacheKey = menuCacheKey(context, panel.id, shortcut.menu)
      if (!force) {
        const cached = readMenuCache(cacheKey)
        if (cached) {
          setMenuViews((current) => ({ ...current, [key]: cached.entry }))
          if (!cached.stale) return
        }
      }
      const result = await loadView(panel)
      if (!result || contextRef.current !== context) return
      const entry = result.error
        ? { items: [], ready: true, note: result.error, failed: true }
        : { items: quickbarMenuItems(shortcut, result.view), ready: true, note: '' }
      if (!result.error) writeMenuCache(cacheKey, entry)
      setMenuViews((current) => ({ ...current, [key]: entry }))
    },
    [context, loadView]
  )

  useEffect(() => {
    setMenuViews({})
    setOpenMenu('')
    setShortcutViews({})
  }, [context])

  useEffect(() => {
    const wanted = items.filter(({ shortcut }) => shortcut.menu || shortcut.id)
    if (!wanted.length) return undefined
    const refresh = () => {
      if (document.hidden) return
      const statusPanels = new Set()
      for (const { panel, shortcut, key } of wanted) {
        if (shortcut.menu) void loadMenu(panel, shortcut, key)
        if (shortcut.id && !statusPanels.has(panel.id)) {
          statusPanels.add(panel.id)
          void loadView(panel)
        }
      }
    }
    const timer = setTimeout(refresh, PREFETCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [items, loadMenu, loadView])

  useEffect(() => {
    const dynamicPanels = panels.filter((panel) => panel.shortcuts.some((shortcut) => shortcut.id))
    if (!dynamicPanels.length) return undefined
    const refresh = () => {
      if (!document.hidden) for (const panel of dynamicPanels) void loadView(panel)
    }
    const timer = setInterval(refresh, 30_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [panels, loadView])

  if (items.length === 0) return null

  const openSection = (panel, section) => {
    const active = openPlugin === panel.id && focusSection === section
    onTogglePanel(active ? '' : panel.id, active ? '' : section)
  }

  const runAction = async (panel, action, key, buttonKey) => {
    if (pending) return
    setPending(buttonKey || `${panel.id}:${action}`)
    try {
      const result = await window.mica.chat.pluginPanels
        .action(nodeId, { pluginId: panel.id, action, key, sessionId, cwd })
        .catch((cause) => ({ ok: false, error: String(cause?.message || cause) }))
      applyPanelResult(result, {
        onCompose,
        onLaunchSession,
        onDialog,
        onOpenPath,
        onOpenReview
      })
      setFeedback(result?.ok === false ? result.error || '动作失败' : result?.message || '')
      if (panel.shortcuts.some((shortcut) => shortcut.id)) void loadView(panel)
      for (const entry of items.filter(
        (item) => item.panel.id === panel.id && item.shortcut.menu
      )) {
        void loadMenu(panel, entry.shortcut, entry.key, { force: true })
      }
    } finally {
      setPending('')
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
    if (shortcut.items || shortcut.menu) {
      clearHover()
      if (openMenu === key) setOpenMenu('')
      else showMenu(event?.currentTarget?.getBoundingClientRect?.() || null, panel, shortcut, key)
      return
    }
    if (shortcut.section) openSection(panel, shortcut.section)
    else await runAction(panel, shortcut.action, undefined, key)
  }

  return (
    <div className="chat-plugin-quickbar" role="toolbar" aria-label="插件快捷操作" ref={barRef}>
      {items.map(({ panel, shortcut, key, first }) => {
        const state = shortcut.id
          ? shortcutViews[`${context}\u0000${panel.id}`]?.[shortcut.id]
          : null
        const disabled = state?.disabled === true
        const active =
          Boolean(shortcut.section) && openPlugin === panel.id && focusSection === shortcut.section
        const group = Boolean(shortcut.items || shortcut.menu)
        // 静态分组（清单直接给 items）不需要等面板视图；动态分组才读插件返回的那一块。
        const menuItems = shortcut.items
          ? quickbarMenuItems(shortcut)
          : group
            ? (menuViews[key]?.items ?? [])
            : []
        return (
          <div
            key={key}
            className={`chat-plugin-quickbar-group${first && panels.length > 1 ? ' is-plugin-start' : ''}`}
            onMouseEnter={
              group && !disabled ? (event) => hoverMenu(event, panel, shortcut, key) : undefined
            }
            onMouseLeave={group ? clearHover : undefined}
          >
            <button
              type="button"
              title={
                state?.disabledReason ||
                (shortcut.section
                  ? `${active ? '收起' : '打开'}「${shortcut.label}」`
                  : `${panel.label} · ${shortcut.label}`)
              }
              aria-pressed={shortcut.section ? active : undefined}
              aria-haspopup={group ? 'menu' : undefined}
              aria-expanded={group ? openMenu === key : undefined}
              disabled={Boolean(pending) || disabled}
              className={[
                'chat-plugin-quickbar-button',
                shortcut.action ? 'is-primary' : '',
                active ? 'is-active' : '',
                pending === key ? 'is-busy' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={(event) => void runShortcut(event, panel, shortcut, key)}
            >
              {shortcut.label}
              {pending === key && <span aria-label="执行中">…</span>}
              {state?.badge && <span className="chat-plugin-quickbar-badge">{state.badge}</span>}
              {group && (
                <span className="chat-plugin-quickbar-caret" aria-hidden="true">
                  ▾
                </span>
              )}
            </button>
            {group &&
              !disabled &&
              openMenu === key &&
              menuPos &&
              createPortal(
                <FloatingMenu
                  key={`${key}:${menuItems.length}:${menuViews[key]?.ready || false}`}
                  x={menuPos.x}
                  y={menuPos.y}
                  minWidth={Math.max(menuPos.width, 176)}
                  /* 这一排紧贴输入框，往下开会压住输入框：整组向上开。 */
                  placement="above"
                  /* 菜单本身也要豁免：否则 pointerdown 先关菜单，click 永远到不了菜单项。 */
                  ignoreSelector=".chat-plugin-quickbar-group, .chat-plugin-quickbar-menu"
                  onClose={() => setOpenMenu('')}
                >
                  <div className="chat-plugin-quickbar-menu">
                    {menuItems.length === 0 ? (
                      shortcut.menu && !menuViews[key]?.ready ? (
                        <span className="plugin-menu-skeleton" aria-hidden="true">
                          <span className="plugin-menu-skeleton-row" />
                          <span className="plugin-menu-skeleton-row is-short" />
                        </span>
                      ) : (
                        <span className="plugin-menu-loading">
                          {menuViews[key]?.note || '暂时没有可选项'}
                          {menuViews[key]?.failed && (
                            <button
                              type="button"
                              onClick={() => void loadMenu(panel, shortcut, key, { force: true })}
                            >
                              重试
                            </button>
                          )}
                        </span>
                      )
                    ) : (
                      menuItems.map((item) => (
                        <button
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
                          {item.detail && <span className="plugin-menu-hint">{item.detail}</span>}
                        </button>
                      ))
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
    </div>
  )
}

/** 抽屉本体：只画 `openPlugin` 指定的那一块。 */
export function PluginPanels({
  nodeId,
  sessionId,
  cwd,
  role,
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
      key={open.id}
      pluginId={open.id}
      label={open.label}
      display={open.display}
      nodeId={nodeId}
      sessionId={sessionId}
      cwd={cwd}
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
  label,
  display,
  nodeId,
  sessionId,
  cwd,
  focusSection,
  onClose,
  onCompose,
  onLaunchSession,
  onDialog,
  onOpenPath,
  onOpenReview
}) {
  // 菜单那边刚问过同一份视图时直接拿它开局：点开抽屉不该先看到一句「正在读取」。
  const seeded = useRef(readPanelView(nodeId, pluginId))
  const [view, setView] = useState(() => seeded.current?.view || null)
  const viewRef = useRef(seeded.current?.view || null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [drafts, setDrafts] = useState(() => panelDrafts(seeded.current?.view))
  // 弹窗形态下的当前页签（存 section 标题）。抽屉形态不用它。
  const [activeTab, setActiveTab] = useState('')
  const aliveRef = useRef(true)

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
    (result, { resetDrafts = false } = {}) => {
      if (!aliveRef.current) return
      if (result?.ok && result.view) {
        // 每 4 秒拉一次视图：没有变化就别换引用，否则整块面板连同滚动位置一起白重渲染。
        const same =
          viewRef.current && JSON.stringify(viewRef.current) === JSON.stringify(result.view)
        viewRef.current = result.view
        if (!same) setView(result.view)
        setError('')
        writePanelView(nodeId, pluginId, result.view)
        // 只在动作之后把草稿对齐到视图：定时刷新若也重置，用户正在输入的字会被清掉
        if (resetDrafts) setDrafts(panelDrafts(result.view))
      } else {
        setError(result?.error || '插件面板不可用')
      }
    },
    [nodeId, pluginId]
  )

  const load = useCallback(async () => {
    const result = await window.mica.chat.pluginPanels
      .view(nodeId, { pluginId, sessionId, cwd })
      .catch((cause) => ({ ok: false, error: String(cause?.message || cause) }))
    applyView(result)
  }, [applyView, cwd, nodeId, pluginId, sessionId])

  useEffect(() => {
    // 首次打开要带一次字段初值，之后的刷新只更新状态行/条目。已经有缓存视图时不清草稿
    // （用户可能已经在里面打字了），只把新结果换上去。
    const hadSeed = Boolean(seeded.current?.view)
    void window.mica.chat.pluginPanels
      .view(nodeId, { pluginId, sessionId, cwd })
      .catch((cause) => ({ ok: false, error: String(cause?.message || cause) }))
      .then((result) => applyView(result, { resetDrafts: !hadSeed }))
    const timer = setInterval(() => {
      // 抽屉开着才刷新：关掉之后没有任何人看它，不该每 4 秒叫醒一次会话 host
      if (typeof document !== 'undefined' && document.hidden) return
      void load()
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [applyView, cwd, load, nodeId, pluginId, sessionId])

  const runAction = useCallback(
    async (action, key) => {
      setBusy(key ? `${action}:${key}` : action)
      const result = await window.mica.chat.pluginPanels
        .action(nodeId, { pluginId, action, key, values: drafts, sessionId, cwd })
        .catch((cause) => ({ ok: false, error: String(cause?.message || cause) }))
      setBusy('')
      applyView(result, { resetDrafts: true })
      applyPanelResult(result, { onCompose, onLaunchSession, onDialog, onOpenPath, onOpenReview })
      setFeedback(result?.ok === false ? result.error || '动作失败' : result?.message || '')
    },
    [
      applyView,
      cwd,
      drafts,
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

  const sections = useMemo(() => view?.sections || [], [view])
  const statusTone = view?.status?.tone || 'muted'

  const { tabs, activeIndex: initialTabIndex } = useMemo(
    () => pluginPanelTabs(sections, focusSection),
    [sections, focusSection]
  )
  const sectionKeys = useMemo(() => tabs.map((tab) => tab.key), [tabs])

  // `focusSection` 只在它变化时生效一次：否则每 4 秒刷新都会把用户刚点开的其它块重新收起。
  const appliedFocusRef = useRef(null)

  useEffect(() => {
    if (sections.length === 0) return
    const focusKey = focusSection ? `${pluginId}:${focusSection}` : ''
    if (appliedFocusRef.current === focusKey) return
    appliedFocusRef.current = focusKey
    // 弹窗形态：快捷按钮点名的那一块直接切到它；没点名就停在当前页签，
    // 页签被删掉（插件改了分区）才回落到第一块。
    if (focusSection && sectionKeys.includes(focusSection)) setActiveTab(focusSection)
    else setActiveTab((previous) => (sectionKeys.includes(previous) ? previous : sectionKeys[0]))
  }, [focusSection, pluginId, sectionKeys, sections])

  const renderSection = (section, key, { tabbed = false } = {}) => (
    <PluginPanelSection
      key={key}
      section={section}
      tabbed={tabbed}
      // 抽屉里的折叠由 <details> 自己管（用户点开就是点开，4 秒刷新不会把它翻回去）；
      // 快捷按钮点名的那一块靠 key 变化重挂载来强制展开。
      focused={Boolean(focusSection) && key === focusSection}
      drafts={drafts}
      setDrafts={setDrafts}
      commit={section.commit ? () => runAction(section.commit) : null}
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
                    renderSection(activeSection, sectionKeys[tabIndex], { tabbed: true })}
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
      {sections.map((section, index) => renderSection(section, sectionKeys[index]))}
    </>
  )

  return (
    <aside className="chat-plugin-dock" aria-label={`${view?.title || label} 插件面板`}>
      <header className="chat-plugin-dock-head">
        <div className="chat-plugin-dock-title">
          <span>{view?.title || label}</span>
          {view?.status && <Tag tone={tagTone(statusTone)}>{view.status.label}</Tag>}
        </div>
        <button type="button" className="chat-plugin-close" title="收起" onClick={onClose}>
          <X size={13} />
        </button>
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
 * 声明了 `commit` 的 section（设置类）在输入停顿后自己提交，用户不用再点按钮；
 * 没声明的仍靠 section 底部的动作按钮带上 `values`。
 */
const COMMIT_DELAY_MS = 500

/** 一块折叠卡片：标题行可点，内容只在展开时渲染。 */
function PluginPanelSection({
  section,
  tabbed = false,
  focused,
  drafts,
  setDrafts,
  commit,
  busy,
  runAction
}) {
  const commitTimer = useRef(null)
  // 计时器要调「最新一次渲染」的提交回调：它闭包里带着最新的字段值，
  // 直接用 onChange 那一刻的回调会把改动前的 drafts 提交上去。
  const commitRef = useRef(commit)
  commitRef.current = commit

  useEffect(() => () => clearTimeout(commitTimer.current), [])

  const changeDraft = (key, value) => {
    setDrafts((previous) => ({ ...previous, [key]: value }))
    if (!commit) return
    clearTimeout(commitTimer.current)
    commitTimer.current = setTimeout(() => void commitRef.current?.(), COMMIT_DELAY_MS)
  }

  const body = (
    <PluginPanelRows
      section={section}
      drafts={drafts}
      changeDraft={changeDraft}
      busy={busy}
      runAction={runAction}
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
function PluginPanelRows({ section, drafts, changeDraft, busy, runAction }) {
  const hasBody = Boolean(section.text)
  const hasRows = (section.rows?.length || 0) + (section.items?.length || 0) > 0
  return (
    <div className="chat-plugin-rows">
      {/* 正文：一整段话（需求描述、结论）。行是「标签 — 一个值」，这里没有标签也不省略。 */}
      {hasBody && <p className="chat-plugin-text">{section.text}</p>}
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
              <button
                type="button"
                className="chat-plugin-link"
                title={row.value || row.link}
                onClick={() => window.mica.terminal.openExternal(row.link).catch(() => {})}
              >
                {row.value || row.link}
              </button>
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
                  <Button
                    key={action.id}
                    variant={buttonVariant(action.tone)}
                    disabled={action.disabled || Boolean(busy)}
                    loading={busy === `${action.id}:${item.key}`}
                    onClick={() => void runAction(action.id, item.key)}
                  >
                    {action.label}
                  </Button>
                ))}
              </span>
            )}
          </span>
        </SettingRow>
      ))}
      {/* 没有正文也没有行/条目时才画空态：只有输入框的 section（加频道）也该先说明
          「现在还没有」，表单本身不算内容。 */}
      {!hasBody && !hasRows && section.empty ? <Empty description={section.empty} /> : null}
      {section.fields?.map((field) => (
        <SettingRow
          key={field.key}
          label={field.label}
          hint={field.hint}
          htmlFor={`chat-plugin-field-${field.key}`}
        >
          {field.type === 'password' ? (
            <SecretInput
              id={`chat-plugin-field-${field.key}`}
              value={drafts[field.key] ?? ''}
              placeholder={field.placeholder || ''}
              ariaLabel={field.label}
              onChange={(next) => changeDraft(field.key, next)}
            />
          ) : (
            <input
              id={`chat-plugin-field-${field.key}`}
              className="text-input"
              type="text"
              inputMode={field.type === 'number' ? 'numeric' : undefined}
              value={drafts[field.key] ?? ''}
              placeholder={field.placeholder || ''}
              onChange={(event) => changeDraft(field.key, event.target.value)}
            />
          )}
        </SettingRow>
      ))}
      {section.actions?.length > 0 && (
        <div className="chat-plugin-section-actions">
          {section.actions.map((action) => (
            <Button
              key={action.id}
              variant={buttonVariant(action.tone)}
              title={action.hint || action.label}
              disabled={action.disabled || Boolean(busy)}
              loading={busy === action.id}
              onClick={() => void runAction(action.id)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
