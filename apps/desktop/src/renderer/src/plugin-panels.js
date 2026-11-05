import { useMemo, useSyncExternalStore } from 'react'
import { readPluginsDetails, subscribePluginsDetails } from './plugins-details'

/**
 * 对话右侧能出现的插件面板（清单 `desktop.panel`）。
 *
 * 面板是「插件给数据、宿主画出来」的界面，所以页面这边只需要知道**有哪些**：清单里的
 * 标题与角色门槛。真正的视图与动作由会话的常驻 host 提供（插件就在那个进程里）。
 *
 * 复用配置页数据层（`readPluginsDetails`）而不是新开一条读取链路：它已经把官方插件与
 * `$MICA_HOME/plugins` 下的用户插件合流成一份，且带启用状态——停用的插件不该在对话区
 * 留一个点不开的按钮。
 *
 * 角色是会话事实：`roles` 为空表示任何角色都显示，否则只有当前会话角色命中时才出现。
 * 用户可能刚在输入条切了角色还没发消息（新角色要到下一轮才落盘），所以调用方把「待生效
 * 的角色」一并传进来。
 */
export const PANEL_RETRY_DELAYS = [1500, 4000, 9000]

/**
 * 读到空结果就退避重试几次。
 *
 * 页面在窗口启动那一刻挂载时，`/api/invoke` 可能还没就绪，这一次读到的空清单会让快捷条
 * 一直空着——ChatView 只在换角色时才会重新读，而用户不会为了一排按钮去切角色。重试是
 * 有上限的（清单本身能缓存，重试几乎不花请求）；角色本来就没有面板的会话多问几次也无妨。
 */
export async function loadPluginPanels(role, options = {}) {
  const {
    read = readPluginsDetails,
    delays = PANEL_RETRY_DELAYS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isAlive = () => true
  } = options
  let panels = []
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) {
      await sleep(delays[attempt - 1])
      if (!isAlive()) return panels
    }
    panels = selectPluginPanels(await read(), role)
    if (panels.length > 0 || !isAlive()) return panels
  }
  return panels
}

const EMPTY_PANELS = []

/** 角色是这份缓存的键：「没写」与 `default` 是同一件事（`selectPluginPanels` 也这么归一）。 */
const panelsRoleKey = (role) => String(role || 'default').trim() || 'default'

/**
 * 同一份清单在一棵树里有好几个消费方：输入框上方的快捷条、状态行、右侧抽屉的入口。
 * 各存一份 `useState`、各自挂订阅、各自跑退避重试，等于把「这份清单现在是什么」读两遍。
 *
 * 所以收成一份共享状态：按角色一只条目，**第一份订阅才开始读**，最后一份走了才停（退订 +
 * 清掉计时器）。停掉之后 panels 留着——重新挂载时先画这一份、再后台对齐（与菜单缓存同一个
 * 取舍：宁可先显示旧的一秒，也不要闪一下空白）。
 *
 * 读、退避、计时都能注入：测试里直接驱动这个 store，不必为了验证「只读一次」去搭一个 DOM。
 */
export function createPluginPanelsStore(options = {}) {
  const {
    read = readPluginsDetails,
    delays = PANEL_RETRY_DELAYS,
    idleDelayMs = 15_000,
    idleTries = 5,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    subscribeSource = subscribePluginsDetails,
    schedule = (callback, ms) => setTimeout(callback, ms),
    cancel = (timer) => clearTimeout(timer)
  } = options
  const entries = new Map()

  const entryOf = (role) => {
    const key = panelsRoleKey(role)
    let entry = entries.get(key)
    if (!entry) {
      entry = {
        role: key,
        panels: EMPTY_PANELS,
        listeners: new Set(),
        unsubscribeSource: null,
        // 每换一条链就加一：旧链回来时既不能写状态，也不能发通知。
        generation: 0,
        tries: 0,
        timer: 0
      }
      entries.set(key, entry)
    }
    return entry
  }

  const notify = (entry) => {
    for (const listener of [...entry.listeners]) {
      try {
        listener()
      } catch {
        // 消费方是页面组件：它出错只影响自己，不能连带让别的挂载点收不到更新。
      }
    }
  }

  const publish = (entry, panels) => {
    // 每次读取都是新数组：内容没变就别换引用，否则所有挂载点每分钟白重渲染一次。
    if (JSON.stringify(entry.panels) === JSON.stringify(panels)) return
    entry.panels = panels
    notify(entry)
  }

  /** 停掉在途的那条链：退避重试、空结果的续读、还没回来的读取结果都作废。 */
  const stopChain = (entry) => {
    entry.generation += 1
    entry.tries = 0
    if (entry.timer) {
      cancel(entry.timer)
      entry.timer = 0
    }
  }

  const run = async (entry, generation) => {
    const alive = () => generation === entry.generation && entry.listeners.size > 0
    const panels = await loadPluginPanels(entry.role, { read, delays, sleep, isAlive: alive })
    if (!alive()) return
    publish(entry, panels)
    // 空结果有两种：这个角色没有面板，或者运行时还没起来 / 刚重启过。后者不该让这排按钮
    // 与状态行整页空着等到用户切角色，所以隔一会儿再读几次（有上限，不会一直轮询）。
    if (panels.length > 0 || entry.tries >= idleTries) return
    entry.tries += 1
    entry.timer = schedule(() => {
      entry.timer = 0
      if (!alive()) return
      void run(entry, generation)
    }, idleDelayMs)
  }

  const restart = (entry) => {
    stopChain(entry)
    void run(entry, entry.generation)
  }

  const release = (entry, listener) => {
    // 同一个 listener 只收尾一次：重复取消不该再动别人的订阅。
    if (!entry.listeners.delete(listener)) return
    if (entry.listeners.size > 0) return
    // 最后一份走了：停链、退订清单变化。panels 留着，下一次挂载先画它。
    stopChain(entry)
    const unsubscribe = entry.unsubscribeSource
    entry.unsubscribeSource = null
    unsubscribe?.()
  }

  return {
    /** 挂上一份消费方：第一份才开始读，此后共用同一条重试链与同一个清单订阅。 */
    subscribe(role, listener) {
      const entry = entryOf(role)
      entry.listeners.add(listener)
      if (!entry.unsubscribeSource) {
        entry.unsubscribeSource = subscribeSource(() => restart(entry))
        restart(entry)
      }
      return () => release(entry, listener)
    },
    /** 当前快照：引用只在内容变化时才换（`useSyncExternalStore` 要求它稳定）。 */
    get(role) {
      return entries.get(panelsRoleKey(role))?.panels ?? EMPTY_PANELS
    }
  }
}

/** 模块级一份：快捷条、状态行与抽屉入口共用它。 */
const sharedPanels = createPluginPanelsStore()

export function usePluginPanels(role) {
  // 订阅与快照按 role 各绑一次：换角色时 useSyncExternalStore 会先退订旧的再订新的，
  // 没人看的那个角色自然停下。
  const subscribe = useMemo(
    () => (onStoreChange) => sharedPanels.subscribe(role, onStoreChange),
    [role]
  )
  const getSnapshot = useMemo(() => () => sharedPanels.get(role), [role])
  // 服务端渲染没有订阅：给一份稳定的空清单即可（store 里没有条目时也是它）。
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * 从配置页那几份插件数据里挑出「当前会话该显示的面板」。
 *
 * 三条都是硬条件：插件启用（停用的不该留一个点不开的按钮）、清单声明了面板、角色命中
 * （`roles` 为空表示任何角色）。角色用**待生效**的那个：用户可能刚在输入条切了角色还没
 * 发消息，那时落盘的还是旧角色。
 */
export function selectPluginPanels(plugins, role) {
  const active = String(role || 'default').trim() || 'default'
  return (Array.isArray(plugins) ? plugins : [])
    .filter((plugin) => plugin?.state === 'enabled' && plugin?.desktopPanel)
    .filter((plugin) => {
      const roles = Array.isArray(plugin.desktopPanel.roles) ? plugin.desktopPanel.roles : []
      return roles.length === 0 || roles.includes(active)
    })
    .map((plugin) => ({
      id: plugin.id,
      label: plugin.desktopPanel.label || plugin.name || plugin.id,
      icon: plugin.icon || '',
      // 清单 `open`：点入口时执行那个动作，而不是打开抽屉（见 PluginPanels 的入口动作）。
      ...(typeof plugin.desktopPanel.open === 'string' && plugin.desktopPanel.open.trim()
        ? { openAction: plugin.desktopPanel.open.trim() }
        : {}),
      display: plugin.desktopPanel.display === 'modal' ? 'modal' : 'drawer',
      // 声明了 `status` 的面板即使没有任何快捷按钮也要问一次视图：输入框上方那行状态
      // （「这个能力现在生效没有」）就来自它，丢了这一位状态行永远不会出现。
      status: plugin.desktopPanel.status === true,
      // 声明了 `dynamicShortcuts` 的面板，按钮本身在视图里（模型刚建的那一排）。没有这一位
      // 页面就不知道该去问，按钮永远不出现。
      dynamicShortcuts: plugin.desktopPanel.dynamicShortcuts === true,
      shortcuts: Array.isArray(plugin.desktopPanel.shortcuts) ? plugin.desktopPanel.shortcuts : []
    }))
}

/**
 * 输入框上方那排按钮的最终清单：清单里声明的 + 视图在运行期给的。
 *
 * 清单里的按钮在前（插件写死的常用入口），视图现给的在后（这一轮才有的那几个）——位置
 * 稳定的入口不该被一次会话的内容挤到后面去。运行期的 key 带 `view:` 前缀，免得和清单里
 * 同 id 的按钮撞成同一个 React key。
 */
export function pluginQuickbarItems(panels, runtimeShortcuts) {
  const list = []
  for (const panel of Array.isArray(panels) ? panels : []) {
    const statics = Array.isArray(panel?.shortcuts) ? panel.shortcuts : []
    const dynamic = runtimeShortcuts?.[panel?.id]
    const shortcuts = [
      ...statics.map((shortcut, index) => ({
        shortcut,
        key: `${panel.id}:${shortcut.id || `legacy-${index}`}`
      })),
      ...(Array.isArray(dynamic) ? dynamic : []).map((shortcut) => ({
        shortcut,
        key: `${panel.id}:view:${shortcut.id}`
      }))
    ]
    shortcuts.forEach(({ shortcut, key }, index) => {
      list.push({ panel, shortcut, key, first: index === 0 })
    })
  }
  return list
}

/**
 * 一颗快捷按钮「怎么画」：插件只声明意图（图标 / 颜色 / 形状 / 纯图标），
 * 这里翻成宿主那套类名与无障碍属性。
 *
 * 抽成纯函数是因为这几条规则必须两端一致：清单里的按钮与视图在运行期给的按钮走同一个
 * 判定，颜色与形状的取值也来自同一份（`PLUGIN_SHORTCUT_COLORS` / `PLUGIN_SHORTCUT_SHAPES`
 * 那边的校验已经过滤过，这里只管画）。
 */
export function quickbarButtonLook(shortcut, { active = false, busy = false, hasMenu = false, panelLabel = '' } = {}) {
  const style = shortcut?.style || {}
  const icon = typeof style.icon === 'string' ? style.icon.trim() : ''
  // 没有图标时「只画图标」只会得到一颗空按钮：退回带文字的那一种。
  const iconOnly = style.iconOnly === true && Boolean(icon)
  const className = [
    'chat-plugin-quickbar-button',
    shortcut?.action ? 'is-primary' : '',
    style.color ? `color-${style.color}` : '',
    style.shape && style.shape !== 'pill' ? `shape-${style.shape}` : '',
    iconOnly ? 'is-icon-only' : '',
    active ? 'is-active' : '',
    busy ? 'is-busy' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return {
    icon,
    iconOnly,
    className,
    hasMenu: Boolean(hasMenu),
    label: shortcut?.label || '',
    // 只画图标时文字退回无障碍名与悬停提示
    ariaLabel: iconOnly ? shortcut?.label || '' : undefined,
    title:
      shortcut?.section
        ? `${active ? '收起' : '打开'}「${shortcut?.label || ''}」`
        : `${panelLabel} · ${shortcut?.label || ''}`
  }
}

/**
 * 动作回包里「跨出面板一步」的几种效果。
 *
 * 插件只声明意图（`compose` 放一段文本进输入框、`newSession` 开个会话跑提示词），
 * 真正动页面的是宿主：输入框、页签、角色、发送时机都属于页面，插件碰不到也不该碰。
 * `dialog` 也一样：表格内容由插件给，弹窗、排版、把链接交给系统浏览器是页面的事。
 * `openReview` 是「看这条分支相对主分支改了什么」——宿主把主窗口切到编辑器上的这份对比，
 * 只读提交、不切工作区，所以评审别人的分支不会改动当前会话的目录。
 */
export function applyPanelResult(
  result,
  { onCompose, onLaunchSession, onDialog, onOpenPath, onOpenReview } = {}
) {
  if (!result || result.ok === false) return
  if (typeof result.compose === 'string' && result.compose.trim()) onCompose?.(result.compose)
  if (result.newSession && typeof result.newSession.prompt === 'string') {
    onLaunchSession?.(result.newSession)
  }
  // 弹窗可以只有一张二维码、一段话，甚至只有一个「去配置」按钮：表格不是它的前提。
  if (
    result.dialog &&
    (Array.isArray(result.dialog.rows) || result.dialog.qr || result.dialog.text)
  )
    onDialog?.(result.dialog)
  // 面板只有 340px：超过一屏的正文（插件自己的规则文件、随包分发的 skill）在抽屉里既看
  // 不清也改不动。插件只声明「打开哪个文件」，落到宿主的编辑器由页面负责。
  if (result.openPath && typeof result.openPath.path === 'string' && result.openPath.path.trim()) {
    onOpenPath?.(result.openPath.path, result.openPath.line, {
      focus: result.openPath.focus === true
    })
  }
  if (result.openReview && typeof result.openReview.cwd === 'string' && result.openReview.cwd) {
    onOpenReview?.(result.openReview)
  }
  // 打开地址交给系统浏览器：页面自己不做导航，也不接管用户已经开着的标签页。
  if (typeof result.openExternal === 'string' && result.openExternal) {
    window.mica?.terminal?.openExternal?.(result.openExternal)?.catch?.(() => {})
  }
}

/**
 * 快捷按钮的静态子项（清单里的 `items`）：一组动作，点了就执行或打开分区。
 *
 * 没有动作的条目点了什么也不会发生，一律丢掉。
 */
export function quickbarMenuItems(shortcut) {
  const raw = shortcut?.items
  return (Array.isArray(raw) ? raw : []).filter(
    (item) => typeof item?.label === 'string' && item.label.trim() && (item.action || item.section)
  )
}

/**
 * 动态菜单的那一份数据：清单声明 `menu` 时，面板视图用同名表格回答「现在有哪些行」。
 *
 * 与 `quickbarMenuItems` 分工：清单里的 `items` 是一组**动作**（同步频道 / 频道设置），
 * 这里是一份**数据**（这个需求涉及哪些项目、各在哪条分支）。行必须带 action，否则点不动，
 * 直接丢掉。
 */
export function quickbarMenuTable(view, menu) {
  const raw = menu ? view?.menus?.[menu] : null
  const columns = (Array.isArray(raw?.columns) ? raw.columns : []).filter(
    (column) =>
      typeof column?.key === 'string' &&
      column.key &&
      typeof column?.label === 'string' &&
      column.label
  )
  const rows = (Array.isArray(raw?.rows) ? raw.rows : []).filter(
    (row) =>
      typeof row?.action === 'string' && row.action && row?.cells && typeof row.cells === 'object'
  )
  if (columns.length === 0 || rows.length === 0) return { columns: [], rows: [] }
  return { columns, rows }
}

/**
 * 面板行里的值能不能当链接点。
 *
 * 只认能交给系统浏览器的地址：`javascript:` / `file:` 这类既不该成为链接，也不该被页面
 * 拿去导航。点击由页面转给 `window.mica.terminal.openExternal`，页面自己不做跳转。
 */
export function isOpenableLink(href) {
  return /^(https?:|mailto:)/i.test(String(href ?? '').trim())
}

/**
 * 动态菜单的条目在**页面**这一层缓存。
 *
 * 这些条目是本地事实（这个会话涉及哪些分支），不是网络数据；每换一次页签、每重挂载一次
 * 就回去问一遍，用户看到的就是一句「正在读取」。缓存跨挂载共用，并且是
 * **先给旧的、再后台刷新**：超过 TTL 也不清空，界面立刻有内容，新结果回来再替换。
 */
const MENU_CACHE_MS = 60_000
const menuCache = new Map()

export function menuCacheKey(nodeId, pluginId, menu) {
  return `${nodeId || ''}\u0000${pluginId || ''}\u0000${menu || ''}`
}

/** 命中的缓存条目；`stale` 表示过了 TTL，可以先画出来再问一次。 */
export function readMenuCache(key, now = Date.now(), ttl = MENU_CACHE_MS) {
  const hit = menuCache.get(key)
  if (!hit) return null
  return { entry: hit.entry, stale: now - hit.at >= ttl }
}

export function writeMenuCache(key, entry, now = Date.now()) {
  menuCache.set(key, { at: now, entry })
  if (menuCache.size > 24) {
    const [oldest] = menuCache.keys()
    menuCache.delete(oldest)
  }
  return entry
}

export function clearMenuCache() {
  menuCache.clear()
}

/**
 * 整块视图也缓存一份：菜单只为了两行分支去问视图，问回来的东西正是抽屉里要画的内容。
 * 抽屉打开时先用这一份画出来（否则点开就是一句「正在读取」），再后台刷新。
 */
const VIEW_CACHE_MS = 30_000
const viewCache = new Map()

const viewKey = (nodeId, pluginId) => `${nodeId || ''}\u0000${pluginId || ''}`

export function readPanelView(nodeId, pluginId, now = Date.now(), ttl = VIEW_CACHE_MS) {
  const hit = viewCache.get(viewKey(nodeId, pluginId))
  if (!hit) return null
  return { view: hit.view, stale: now - hit.at >= ttl }
}

export function writePanelView(nodeId, pluginId, view, now = Date.now()) {
  if (!view) return null
  viewCache.set(viewKey(nodeId, pluginId), { at: now, view })
  if (viewCache.size > 16) {
    const [oldest] = viewCache.keys()
    viewCache.delete(oldest)
  }
  return view
}

/** 视图里每个输入框的初值：首次打开与动作之后对齐草稿用（定时刷新不能碰，会清掉正在输的字）。 */
/**
 * 草稿的键带上分区位置：插件可以有两块分区都叫「地址」「端口」（一个连生产、一个连测试），
 * 扁平按 `field.key` 存会让两处的字互相串。位置是这块分区在视图里的下标——与页签 key 用的是
 * 同一个序号，视图结构不变时不会跳。
 */
export function panelDraftKey(sectionIndex, fieldKey) {
  return `${sectionIndex}:${fieldKey}`
}

export function panelDrafts(view) {
  const drafts = {}
  const sections = Array.isArray(view?.sections) ? view.sections : []
  for (const [index, section] of sections.entries()) {
    for (const field of section?.fields || []) drafts[panelDraftKey(index, field.key)] = field.value ?? ''
  }
  return drafts
}

/** 某一块分区的草稿还原成插件看到的那份扁平 `values`（动作只属于发起它的那块分区）。 */
export function sectionDrafts(drafts, sectionIndex) {
  const prefix = `${sectionIndex}:`
  const values = {}
  for (const [key, value] of Object.entries(drafts || {})) {
    if (key.startsWith(prefix)) values[key.slice(prefix.length)] = value
  }
  return values
}

/**
 * 弹窗形态的页签：一块分区一个页签，标题就是页签名。
 *
 * 没有标题的分区（插件可以不给）也得有个能点的名字，按位置叫「第 N 项」；
 * `focusSection` 是快捷按钮点名要看的那一块，命中就切过去，没有（或那块已被插件删掉）
 * 就落回第一块——不能因为一个失效的名字把弹窗开成空白。
 */
export function pluginPanelTabs(sections, focusSection) {
  const tabs = (Array.isArray(sections) ? sections : []).map((section, index) => {
    const title = typeof section?.title === 'string' ? section.title.trim() : ''
    return {
      // 页签名可以重复（两块都叫「设置」），key 不行：共用 key 时 React 复用节点，
      // 按 key 找块也只能找到第一块，第二块永远打不开。
      key: title ? `${title}#${index}` : `section-${index}`,
      title,
      label: title || `第 ${index + 1} 项`
    }
  })
  // 清单里的 `section` 是分区标题，同名时取第一块。
  const focused = focusSection ? tabs.findIndex((tab) => tab.title === focusSection) : -1
  return { tabs, activeIndex: focused >= 0 ? focused : 0 }
}

/**
 * 「某个插件的面板状态变了」的广播。
 *
 * 抽屉里的动作（开关、连接、删机器）会改变输入框上方那排按钮的状态行，但两者是两个组件、
 * 各存一份视图：抽屉自己刷新看不到对方，对方要等 30 秒轮询才更新。开关这种「点完就要看到
 * 结果」的东西不能等，所以动作成功后广播一次，快捷栏那一侧立刻重取视图。
 */
const panelStatusListeners = new Set()

export function isCompletedToolEvent(payload, nodeId) {
  return Boolean(
    nodeId &&
    payload?.id === nodeId &&
    payload.event?.type === 'tool_use' &&
    payload.event.part?.state?.status === 'completed'
  )
}

export function notifyPluginPanelStatusChanged() {
  for (const listener of [...panelStatusListeners]) {
    try {
      listener()
    } catch {
      // 监听方是页面组件，出错只影响它自己，不能连带把动作结果吞掉。
    }
  }
}

export function subscribePluginPanelStatus(listener) {
  panelStatusListeners.add(listener)
  return () => {
    panelStatusListeners.delete(listener)
  }
}
