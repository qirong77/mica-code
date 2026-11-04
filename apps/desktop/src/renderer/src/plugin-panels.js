import { useEffect, useState } from 'react'
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

export function usePluginPanels(role) {
  const [panels, setPanels] = useState([])

  useEffect(() => {
    let alive = true
    let timer = 0
    let tries = 0
    const run = async () => {
      const next = await loadPluginPanels(role, { isAlive: () => alive })
      if (!alive) return
      setPanels(next)
      // 空结果有两种：这个会话没有面板，或者运行时还没起来 / 刚重启过。后者不该让这排按钮
      // 与状态行整页空着等到用户切角色，所以隔一会儿再读几次（有上限，不会一直轮询）。
      if (next.length === 0 && tries < 5) {
        tries += 1
        timer = setTimeout(run, 15_000)
      }
    }
    void run()
    // 启停之后立刻重算：停用插件的按钮与状态行跟着消失，不必等重挂载。
    const unsubscribe = subscribePluginsDetails(() => {
      tries = 0
      if (timer) clearTimeout(timer)
      timer = 0
      void run()
    })
    return () => {
      alive = false
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [role])

  return panels
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
      shortcuts: Array.isArray(plugin.desktopPanel.shortcuts) ? plugin.desktopPanel.shortcuts : []
    }))
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
export function panelDrafts(view) {
  const drafts = {}
  for (const section of Array.isArray(view?.sections) ? view.sections : []) {
    for (const field of section?.fields || []) drafts[field.key] = field.value ?? ''
  }
  return drafts
}

/** 换会话时丢掉上一个会话的菜单与视图：分支属于这个会话，串过去就是别人的分支。 */
export function prunePluginPanelCache(keepNodeId) {
  const prefix = `${keepNodeId || ''}\u0000`
  for (const key of [...menuCache.keys()]) {
    if (!key.startsWith(prefix)) menuCache.delete(key)
  }
  for (const key of [...viewCache.keys()]) {
    if (!key.startsWith(prefix)) viewCache.delete(key)
  }
}

/**
 * 一次面板视图请求里哪些菜单需要条目：清单声明了 `menu` 的那些。
 *
 * 面板挂在哪个按钮上由页面决定，这里只回答「为了这组按钮要问几次视图」。
 */
export function menuShortcutsOf(panels) {
  const wanted = []
  for (const panel of Array.isArray(panels) ? panels : []) {
    for (const shortcut of panel?.shortcuts || []) {
      if (shortcut?.menu) wanted.push({ panel, shortcut })
    }
  }
  return wanted
}

/**
 * 弹窗形态的页签：一块分区一个页签，标题就是页签名。
 *
 * 没有标题的分区（插件可以不给）也得有个能点的名字，按位置叫「第 N 项」；
 * `focusSection` 是快捷按钮点名要看的那一块，命中就切过去，没有（或那块已被插件删掉）
 * 就落回第一块——不能因为一个失效的名字把弹窗开成空白。
 */
export function pluginPanelTabs(sections, focusSection) {
  const tabs = (Array.isArray(sections) ? sections : []).map((section, index) => ({
    key: section?.title || `section-${index}`,
    label: section?.title || `第 ${index + 1} 项`
  }))
  const focused = tabs.findIndex((tab) => tab.key === focusSection)
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
