import { randomUUID } from 'node:crypto'
import { BrowserWindow, Menu, WebContentsView, clipboard, session } from 'electron'
import {
  BROWSER_PARTITION,
  BrowserRequestError,
  CHROME_HEIGHT,
  DEFAULT_BROWSER_SIZE,
  activeTab,
  browserSummary,
  createTabSwitcher,
  formatCookieHeader,
  keyDescriptors,
  normalizeCookieDomain,
  normalizeCookiePayload,
  normalizeLabel,
  normalizeUrl,
  normalizeWaitCondition,
  notFoundError,
  pickNetworkHeaders,
  publicCookie,
  serializeEvaluation,
  tabSummary,
  toElectronCookie,
  timeoutError,
  truncateOutput,
  visibilityEventName
} from './browser-core.js'
import { chromeDataUrl, chromePalette, parseChromeMessage } from './browser-chrome.js'
import {
  BROWSER_IDLE_REAP_MS,
  WINDOW_IDLE_SWEEP_MS,
  describeReap,
  resolveMs,
  selectIdleWindows,
  startIdleReaper
} from '../window-idle.js'

/**
 * 受控浏览器窗口的管理器：浏览器窗口、标签页（每个标签页一个 WebContentsView）、
 * 页面操作（点击/输入/截图/读 cookie/控制台/网络），以及它们到 HTTP 服务的映射。
 *
 * 几个刻意的设计：
 * - **窗口是隐藏式的**：用户点关闭只 `hide()`，页面与登录态原样留着；只有
 *   `POST /browser/browsers/:id/close` 才真的销毁。用户看到的关闭按钮不该等于丢掉现场。
 * - **默认全程不显示窗口**：截图、点击、输入、按键、滚动都在隐藏窗口里完成——实测
 *   `Page.captureScreenshot` 在隐藏窗口下拿到的就是当前帧，`Input.*` 原生输入也照常生效
 *   （前提是主进程挂了 `disable-backgrounding-occluded-windows`，否则 rAF 冻结）。
 *   `showBrowser` 是唯一的例外，只在明确要给用户演示时调用；用户自己则从顶栏图标唤出。
 * - **标签页视图按需挂载**：只有当前标签页挂在窗口上（坐标与原生输入都按挂载的视图算），
 *   其余保持存活但不渲染。截图一律走 CDP：`capturePage()` 在隐藏窗口上拿到的是旧帧。
 * - **浏览数据走独立分区**：普通窗口共享 `persist:mica-browser`，无痕窗口各用唯一内存分区，
 *   与应用自身、与用户日常浏览器互不干扰。
 */

const CLICK_SETTLE_MS = 120
const WAIT_POLL_MS = 150
const MAX_SCREENSHOT_HEIGHT = 16000
const MAX_CONSOLE_ENTRIES = 500
const MAX_NETWORK_ENTRIES = 400
const MAX_NETWORK_BODY = 4000
const SCREENSHOT_TIMEOUT_MS = 20000
/** `allCookies` 一次最多回多少条：分区里可能有上万条，整份 JSON 会把调用方和 IPC 一起拖住。 */
const MAX_COOKIE_LIST = 20000
const DEFAULT_COOKIE_LIST = 2000

export function createBrowserManager({
  onChange = () => {},
  onCookieChange = () => {},
  isQuitting = () => false,
  // 当前应用主题 id（ui-state 的 theme 解析后的结果）。外壳每次进来重新读一遍，顶栏
  // 配色和窗口底色都跟着它走，换主题后不需要重启窗口。
  theme = () => 'dark',
  // 隐藏多久之后真正销毁窗口（标签页随之重建）；0 关掉这条回收
  idleReapMs = resolveMs(process.env.MICA_BROWSER_IDLE_REAP_MS, BROWSER_IDLE_REAP_MS),
  idleSweepMs = WINDOW_IDLE_SWEEP_MS
} = {}) {
  const browsers = new Map()
  // 每个窗口在跑的页面操作数：导航、截图这类一次可能几十秒，期间不能被当成闲置
  const busyOps = new Map()
  let sequence = 0
  const permissionSessions = new WeakSet()

  const partition = () => session.fromPartition(BROWSER_PARTITION)
  const cookieStore = partition().cookies
  const cookieChanged = (_event, cookie, cause, removed) => {
    if (!cookie?.name || !cookie?.domain || cause === 'overwrite') return
    try {
      onCookieChange({
        cookie: { name: cookie.name, domain: cookie.domain, path: cookie.path || '/' },
        cause,
        removed: Boolean(removed)
      })
    } catch (error) {
      console.error('[mica-browser] 推送 cookie 变化失败:', error)
    }
  }
  cookieStore.on('changed', cookieChanged)

  /** 顶栏调色板 + 主题 id：外壳读盘失败时按默认深色处理，不影响窗口本身 */
  function chromeTheme() {
    let id = 'dark'
    try {
      id = String(typeof theme === 'function' ? theme() || 'dark' : theme)
    } catch {
      id = 'dark'
    }
    return { id, palette: chromePalette(id) }
  }

  function nextId(prefix) {
    sequence += 1
    return `${prefix}-${sequence}`
  }

  function emit(reason = 'change') {
    try {
      onChange({ reason })
    } catch (error) {
      console.error('[mica-browser] 广播浏览器状态失败:', error)
    }
  }

  /** 逻辑可见状态（顶栏图标看的就是它）：只在真的变化时广播，避免多余的界面刷新 */
  function applyVisibility(record, visible) {
    const event = visibilityEventName(record.visible, visible)
    record.visible = Boolean(visible)
    // 隐藏的那一刻开始计闲置：隐藏窗口的 renderer 与合成缓存都还在，收的是这个
    record.hiddenAt = record.visible ? null : Date.now()
    if (!event) return
    emit(event)
  }

  function browserList() {
    return [...browsers.values()].map((record) => browserSummary(record))
  }

  function requireBrowser(id) {
    const record = browsers.get(String(id || ''))
    if (!record) throw notFoundError(`浏览器窗口不存在：${id}`)
    record.lastUsedAt = Date.now()
    return record
  }

  function requireTab(tabId) {
    const id = String(tabId || '')
    for (const record of browsers.values()) {
      const tab = record.tabs.find((item) => item.id === id)
      if (tab) {
        record.lastUsedAt = Date.now()
        return { record, tab }
      }
    }
    throw notFoundError(`标签页不存在：${tabId}`)
  }

  /**
   * 浏览器 id 或标签页 id → 归属（没有归属返回 null，找不到也返回 null）。
   *
   * 服务层拿它在派发前挡「别的会话的操作」：归属是顶栏图标的依据，也是防串台的依据。
   */
  function ownerOf(id) {
    const key = String(id || '')
    if (!key) return null
    const record = browsers.get(key)
    if (record) return record.owner || null
    for (const item of browsers.values()) {
      if (item.tabs.some((tab) => tab.id === key)) return item.owner || null
    }
    return null
  }

  /** cookie 作用域 → 统一形状；页面不是 http(s) 时给空结果而不是报错（未登录也是合法状态） */
  async function readCookies(scope, format, browserSession = partition()) {
    if (!/^https?:/i.test(scope)) {
      return {
        url: scope,
        count: 0,
        cookieHeader: '',
        cookies: [],
        note: '当前页不是 http(s)，没有 cookie 作用域'
      }
    }
    const list = await browserSession.cookies.get({ url: scope })
    const mode = String(format || 'json').toLowerCase()
    if (mode === 'header') {
      return { url: scope, count: list.length, cookieHeader: formatCookieHeader(list) }
    }
    if (mode !== 'json') throw new BrowserRequestError(`不支持的 format：${format}`)
    return {
      url: scope,
      count: list.length,
      cookieHeader: formatCookieHeader(list),
      cookies: list.map(publicCookie)
    }
  }

  /* --------------------------------------------------------------- 窗口装配 */

  /** 一个分区只装一次权限策略：这些窗口是给 agent 用的，不该悄悄拿到摄像头/定位/通知 */
  function installPermissionPolicy(browserSession) {
    if (permissionSessions.has(browserSession)) return
    permissionSessions.add(browserSession)
    try {
      browserSession.setPermissionRequestHandler((_contents, permission, callback) => {
        callback(['clipboard-sanitized-write', 'fullscreen'].includes(permission))
      })
      browserSession.setPermissionCheckHandler(() => false)
    } catch (error) {
      console.error('[mica-browser] 设置权限策略失败:', error)
    }
  }

  function pushChrome(record) {
    if (!record.chromeReady || record.win.isDestroyed()) return
    const current = activeTab(record)
    const chrome = chromeTheme()
    // 窗口底色（页面加载中、内容透明处露出来的那一层）与顶栏一起换，避免浅色主题下
    // 先闪一片深色。只在主题真的变了时才调，setBackgroundColor 会重绘整窗。
    if (record.themeId !== chrome.id) {
      record.themeId = chrome.id
      try {
        record.win.setBackgroundColor(chrome.palette.canvas)
      } catch {
        // 窗口正在销毁：下一次创建会用新的底色
      }
    }
    const state = {
      label: record.label,
      incognito: record.incognito,
      owner: record.owner || '',
      windowCount: browsers.size,
      url: current?.url || '',
      title: current?.title || '',
      loading: Boolean(current?.loading),
      palette: chrome.palette,
      tabs: record.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title || tab.url || '新标签页',
        active: tab.id === record.activeTabId
      }))
    }
    record.chrome
      .executeJavaScript(`window.__micaChrome.update(${JSON.stringify(state)})`)
      .catch(() => {
        // chrome 还在加载或窗口已销毁：下一次状态变化会再推一遍
      })
  }

  function refreshWindowCounts() {
    for (const record of browsers.values()) pushChrome(record)
  }

  function syncWindowTitle(record) {
    if (record.win.isDestroyed()) return
    const current = activeTab(record)
    const kind = record.incognito ? '无痕受控浏览器' : '受控浏览器'
    // 页面还没有标题时不要拼成「受控浏览器 — 受控浏览器」：窗口种类只说一遍
    const title = current?.title || current?.url || ''
    record.win.setTitle(title ? `${title} — ${kind}` : kind)
  }

  function layout(record) {
    if (record.win.isDestroyed()) return
    const current = activeTab(record)
    if (!current?.view) return
    const [width, height] = record.win.getContentSize()
    current.view.setBounds({
      x: 0,
      y: CHROME_HEIGHT,
      width: Math.max(0, width),
      height: Math.max(0, height - CHROME_HEIGHT)
    })
  }

  function createBrowser({
    owner = null,
    url = '',
    label,
    show = false,
    focus = false,
    incognito = false
  } = {}) {
    const id = nextId('brw')
    // 不带 persist: 的唯一分区仅驻留内存；每个无痕窗口独立，普通窗口继续用原分区。
    const privateMode = incognito === true
    const partitionName = privateMode ? `mica-browser-private-${randomUUID()}` : BROWSER_PARTITION
    const browserSession = session.fromPartition(partitionName)
    installPermissionPolicy(browserSession)
    const chrome = chromeTheme()
    const win = new BrowserWindow({
      width: DEFAULT_BROWSER_SIZE.width,
      height: DEFAULT_BROWSER_SIZE.height,
      minWidth: 480,
      minHeight: 360,
      show: false,
      autoHideMenuBar: true,
      title: '受控浏览器',
      backgroundColor: chrome.palette.canvas,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    // 多个窗口时错开一点，别叠成一摞看不出有几个
    const offset = Math.min(browsers.size, 6) * 26
    if (offset) {
      const current = win.getBounds()
      win.setBounds({ ...current, x: current.x + offset, y: current.y + offset })
    }

    const record = {
      id,
      owner,
      incognito: privateMode,
      partitionName,
      browserSession,
      label: normalizeLabel(label),
      visible: false,
      // 新建的窗口默认隐藏，从这一刻起算闲置；`lastUsedAt` 跟着每次接口调用走
      hiddenAt: Date.now(),
      lastUsedAt: Date.now(),
      createdAt: new Date().toISOString(),
      themeId: chrome.id,
      win,
      chrome: win.webContents,
      chromeReady: false,
      tabs: [],
      activeTabId: null,
      destroyRequested: false
    }
    browsers.set(id, record)
    refreshWindowCounts()

    win.on('close', (event) => {
      // 用户点关闭 = 隐藏；应用退出或显式 close 才真的销毁（否则关一次就丢现场）
      if (isQuitting() || record.destroyRequested) return
      event.preventDefault()
      hideBrowser(id)
    })

    win.on('closed', () => {
      for (const tab of record.tabs) detachTab(tab)
      record.tabs = []
      browsers.delete(id)
      refreshWindowCounts()
      // 只清理本窗口的临时分区，绝不清理共享的普通浏览器数据。
      if (record.incognito) {
        void Promise.all([browserSession.clearStorageData(), browserSession.clearCache()]).catch(
          (error) => {
            console.error('[mica-browser] 清理无痕分区失败:', error)
          }
        )
      }
      emit('closed')
    })

    win.on('resize', () => layout(record))
    // 显示之前再推一次：窗口可能是在别的主题下建的，用户切主题时它正藏着
    win.on('show', () => pushChrome(record))
    // 逻辑可见状态只由 showBrowser / hideBrowser 改，不跟窗口的 show/hide 事件走：
    // 用户把窗口最小化、从 Dock 里唤回时，顶栏图标的状态也不需要跟着抖

    win.webContents.on('console-message', (details) => {
      const message = parseChromeMessage(details?.message)
      if (message) handleChromeMessage(record, message)
    })

    // 以 did-finish-load 为准：data: URL 的 loadURL 偶尔会以一个假的 ERR_FAILED 结束，
    // 而页面其实已经加载好了（此时再报错只会误导人）。
    win.webContents.on('did-finish-load', () => {
      record.chromeReady = true
      pushChrome(record)
    })
    win
      .loadURL(chromeDataUrl())
      .then(() => {
        record.chromeReady = true
        pushChrome(record)
      })
      .catch((error) => {
        if (!record.chromeReady && !record.win.isDestroyed()) {
          console.error('[mica-browser] chrome 加载失败', error?.code || error)
        }
      })

    addTab(record, url, { activate: true })
    if (show) showBrowser(id, { focus })
    emit('created')
    return record
  }

  function handleChromeMessage(record, message) {
    if (message.action === 'showWindows') {
      const entries = [...browsers.values()].filter((item) => !item.win.isDestroyed())
      if (entries.length < 2) return
      const menu = Menu.buildFromTemplate(
        entries.map((item, index) => {
          const current = activeTab(item)
          const title = current?.title || current?.url || item.label || '受控浏览器'
          return {
            label: `${index + 1}. ${item.incognito ? '无痕 · ' : ''}${title}${item.id === record.id ? '（当前窗口）' : !item.visible ? '（已隐藏）' : ''}`,
            click: () => {
              if (browsers.has(item.id)) showBrowser(item.id)
            }
          }
        })
      )
      menu.popup({ window: record.win })
      return
    }
    if (message.action === 'hide') {
      hideBrowser(record.id)
      return
    }
    if (message.action === 'activateTab') {
      try {
        activateTabIn(record, message.tabId)
      } catch {
        // 标签页可能在点击与处理之间被关掉
      }
      return
    }
    if (message.action === 'copy') {
      // 顶栏没有 preload，复制统一交给主进程：页面自己复制要过渲染进程的权限判定
      if (typeof message.text === 'string' && message.text) clipboard.writeText(message.text)
    }
  }

  /* ----------------------------------------------------------------- 标签页 */

  function attachTabEvents(record, tab) {
    const contents = tab.contents

    contents.setWindowOpenHandler(({ url }) => {
      // 受控窗口不弹出新窗口：target=_blank 一律在本窗口开新标签页，交给 agent 自己决定去留
      if (/^https?:/i.test(url)) {
        try {
          addTab(record, url, { activate: true })
        } catch (error) {
          console.error('[mica-browser] 打开新标签页失败:', error)
        }
      }
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, target) => {
      if (!isNavigableUrl(target)) event.preventDefault()
    })

    const refresh = () => {
      refreshTabState(tab)
      syncWindowTitle(record)
      pushChrome(record)
      emit('tab')
    }

    contents.on('did-start-loading', () => {
      tab.loading = true
      refresh()
    })
    contents.on('did-stop-loading', refresh)
    contents.on('did-navigate', refresh)
    contents.on('did-navigate-in-page', refresh)
    contents.on('page-title-updated', refresh)
    contents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      tab.loadError = `${code} ${description} (${validatedURL})`
      tab.loading = false
      refresh()
    })
    contents.on('render-process-gone', (_event, details) => {
      tab.loadError = `页面进程退出：${details?.reason || 'unknown'}`
      tab.loading = false
      refresh()
    })
    contents.on('console-message', (details) => pushConsoleEntry(tab, details))
  }

  function refreshTabState(tab) {
    const contents = tab.contents
    if (!contents || contents.isDestroyed()) return
    tab.url = contents.getURL()
    tab.title = contents.getTitle()
    tab.loading = contents.isLoading()
  }

  function addTab(record, url, { activate = true } = {}) {
    const target = normalizeUrl(url) || 'about:blank'
    const tab = {
      id: nextId('tab'),
      browserId: record.id,
      url: target,
      title: '',
      loading: true,
      loadError: '',
      view: null,
      contents: null,
      debuggerAttached: false,
      consoleEntries: [],
      network: new Map()
    }
    tab.view = new WebContentsView({
      webPreferences: {
        partition: record.partitionName,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    tab.contents = tab.view.webContents
    record.tabs.push(tab)
    attachTabEvents(record, tab)
    installDebugger(tab)

    if (activate || !record.activeTabId) activateTabIn(record, tab.id)

    if (target && target !== 'about:blank') void loadUrl(tab, target)
    else {
      tab.loading = false
      refreshTabState(tab)
      pushChrome(record)
    }
    return tab
  }

  function detachTab(tab) {
    try {
      if (tab.debuggerAttached && tab.contents && !tab.contents.isDestroyed())
        tab.contents.debugger.detach()
    } catch {
      // 已经断开
    }
    tab.debuggerAttached = false
    try {
      if (tab.contents && !tab.contents.isDestroyed()) tab.contents.close()
    } catch {
      // 已经销毁
    }
  }

  function activateTabIn(record, tabId) {
    const tab = record.tabs.find((item) => item.id === String(tabId || ''))
    if (!tab) throw notFoundError(`标签页不存在：${tabId}`)
    const previous = activeTab(record)
    if (previous && previous.id !== tab.id) {
      try {
        record.win.contentView.removeChildView(previous.view)
      } catch {
        // 视图可能已经不在窗口上
      }
    }
    record.activeTabId = tab.id
    for (const item of record.tabs) item.active = item.id === tab.id
    try {
      record.win.contentView.addChildView(tab.view)
    } catch (error) {
      console.error('[mica-browser] 挂载标签页视图失败:', error)
    }
    layout(record)
    refreshTabState(tab)
    syncWindowTitle(record)
    pushChrome(record)
    emit('tab-activated')
    return tab
  }

  async function loadUrl(tab, url) {
    try {
      await tab.contents.loadURL(url)
    } catch (error) {
      // 加载失败（DNS/证书/被中止）不改标签页归属：刷新时能读到真实 URL 与错误
      tab.loadError = error instanceof Error ? error.message : String(error)
      refreshTabState(tab)
    }
  }

  /* ------------------------------------------------- 调试协议（点击/截图/网络） */

  function ensureDebugger(tab) {
    if (tab.debuggerAttached && tab.contents.debugger.isAttached()) return true
    try {
      tab.contents.debugger.attach('1.3')
      tab.debuggerAttached = true
      tab.contents.debugger.on('message', (_event, method, params) => {
        if (method === 'Network.requestWillBeSent') {
          // 请求体（表单/JSON 参数）是排查「参数对不对」的第一手材料：缺了它 agent 只能往
          // 页面里插 fetch/XHR hook，而 hook 本身会干扰真实请求（实测有把请求打坏的案例）。
          const body = typeof params.request?.postData === 'string' ? params.request.postData : ''
          tab.network.set(params.requestId, {
            method: params.request?.method || 'GET',
            url: params.request?.url || '',
            resourceType: params.type || '',
            status: null,
            headers: pickNetworkHeaders(params.request?.headers),
            body: body.length > MAX_NETWORK_BODY ? `${body.slice(0, MAX_NETWORK_BODY)}…` : body,
            at: Date.now()
          })
          if (tab.network.size > MAX_NETWORK_ENTRIES)
            tab.network.delete(tab.network.keys().next().value)
        } else if (method === 'Network.responseReceived') {
          const entry = tab.network.get(params.requestId)
          if (entry) entry.status = params.response?.status ?? null
        }
      })
      return true
    } catch (error) {
      tab.debuggerAttached = false
      console.error('[mica-browser] 附加调试协议失败:', error)
      return false
    }
  }

  function installDebugger(tab) {
    if (!ensureDebugger(tab)) return
    tab.contents.debugger.sendCommand('Network.enable').catch(() => {})
    tab.contents.debugger.sendCommand('Page.enable').catch(() => {})
    // 隐藏窗口里 `document.hasFocus()` 是 false，有些站点据此关掉自动聚焦/快捷键/输入校验。
    // 焦点模拟让它以为自己在前台，而不会真的把用户正在打字的焦点抢过来。
    tab.contents.debugger
      .sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      .catch(() => {})
  }

  function sendCommand(tab, method, params = {}) {
    if (!ensureDebugger(tab)) throw new BrowserRequestError('无法附加页面调试协议')
    return tab.contents.debugger.sendCommand(method, params)
  }

  async function pressKeys(tab, descriptors) {
    for (const descriptor of descriptors) {
      const base = {
        key: descriptor.key,
        code: descriptor.code || undefined,
        windowsVirtualKeyCode: descriptor.keyCode ?? undefined
      }
      await sendCommand(tab, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        ...base,
        ...(descriptor.text ? { text: descriptor.text } : {})
      })
      await sendCommand(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    }
  }

  function evaluateInPage(tab, expression, timeoutMs = 15000) {
    const running = tab.contents.executeJavaScript(expression, true)
    if (!timeoutMs) return running
    let timer = null
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(timeoutError(`页面脚本执行超过 ${timeoutMs}ms`)), timeoutMs)
      timer.unref?.()
    })
    return Promise.race([running, timeout]).finally(() => clearTimeout(timer))
  }

  /**
   * 给一句 CDP 命令兜个超时。`Page.captureScreenshot` 在页面忙（长任务、合成器排队）时
   * 会长时间不返回，之前没有超时就表现为「截图端点直接卡住」，agent 只能干等或放弃截图。
   */
  function withTimeout(promise, timeoutMs, message) {
    if (!timeoutMs) return promise
    let timer = null
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(timeoutError(message || `命令超过 ${timeoutMs}ms 未返回`)),
        timeoutMs
      )
      timer.unref?.()
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
  }

  /**
   * 在**窗口始终隐藏**的前提下跑一次页面操作：只把目标标签页挂上窗口（坐标与原生输入都按
   * 挂载后的视图算），做完切回去。**不显示窗口**，也不需要「先显示再收起来」。
   *
   * 隐藏窗口能跑全流程靠两件事：主进程挂了 `disable-backgrounding-occluded-windows`（否则
   * rAF 冻结、截图只能是旧帧），以及截图走 CDP `Page.captureScreenshot`（`capturePage()`
   * 在隐藏窗口上拿到的是旧帧）。
   *
   * 「切过去 → run → 切回」这段在同一窗口上串行（见 createTabSwitcher）：并发交错会让
   * 后来者的坐标点击 / 截图落到别人切过去的标签页上。
   */
  const switchToTab = createTabSwitcher(activateTabIn)

  /** 页面操作进行中不算闲置：一次导航等加载、一张截图可能跑几十秒。 */
  async function withTargetTab(record, tab, run) {
    const key = String(record?.id || '')
    busyOps.set(key, (busyOps.get(key) || 0) + 1)
    try {
      return await switchToTab(record, tab, run)
    } finally {
      const left = (busyOps.get(key) || 1) - 1
      if (left > 0) busyOps.set(key, left)
      else busyOps.delete(key)
    }
  }

  async function elementCenter(tab, selector) {
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 120) };
    })()`
    const rect = await evaluateInPage(tab, script, 15000)
    if (!rect) throw new BrowserRequestError(`没有找到元素：${selector}`)
    return rect
  }

  async function dispatchMouse(tab, { x, y, type, clickCount = 1 }) {
    await sendCommand(tab, 'Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount,
      buttons: type === 'mousePressed' ? 1 : 0
    })
  }

  function pushConsoleEntry(tab, details) {
    tab.consoleEntries.push({
      level: typeof details?.level === 'string' ? details.level : 'log',
      message: String(details?.message ?? '').slice(0, 4000),
      source: details?.sourceId || '',
      line: details?.lineNumber ?? null,
      at: Date.now()
    })
    if (tab.consoleEntries.length > MAX_CONSOLE_ENTRIES) tab.consoleEntries.shift()
  }

  /* ------------------------------------------------------------------ 操作面 */

  /**
   * 把窗口显示到桌面上——**唯一**会这么做的路径。
   *
   * 除非明确要给用户演示，否则不要调用：截图、点击、输入、按键、滚动、读 cookie 全都在
   * 隐藏窗口里完成，不需要先显示，也不要用它「确保操作生效」（那只会让窗口在用户眼前闪）。
   * 用户自己想看时，会点顶栏那枚浏览器图标（页面 → IPC → 这里）。
   */
  function showBrowser(id, { focus = true } = {}) {
    const record = requireBrowser(id)
    if (record.win.isDestroyed()) throw new BrowserRequestError('窗口已销毁')
    if (record.win.isMinimized()) record.win.restore()
    if (focus) {
      record.win.show()
      record.win.focus()
    } else {
      // 演示但不抢焦点：别把用户正在打字的焦点抢走
      record.win.showInactive()
    }
    applyVisibility(record, true)
    return record
  }

  function hideBrowser(id) {
    const record = requireBrowser(id)
    if (!record.win.isDestroyed() && record.win.isVisible()) record.win.hide()
    applyVisibility(record, false)
    return record
  }

  function destroyBrowser(id) {
    const record = requireBrowser(id)
    record.destroyRequested = true
    for (const tab of record.tabs) detachTab(tab)
    record.tabs = []
    if (!record.win.isDestroyed()) record.win.destroy()
    emit('closed')
    return { ok: true }
  }

  function closeAll() {
    stopIdleReaper()
    cookieStore.removeListener('changed', cookieChanged)
    for (const record of [...browsers.values()]) {
      record.destroyRequested = true
      for (const tab of record.tabs) detachTab(tab)
      record.tabs = []
      if (!record.win.isDestroyed()) record.win.destroy()
    }
    browsers.clear()
  }

  /**
   * 收掉闲置太久的隐藏窗口：窗口、标签页和它们的 renderer 一起回收。
   *
   * 浏览器窗口按设计就是隐藏着用的（截图、点击都在隐藏窗口里完成），所以闲置要从
   * **最后一次接口调用**算起，不能只看隐藏时刻——否则代理一开着窗口就被算成闲置。
   */
  function reapIdleBrowsers(now = Date.now()) {
    if (isQuitting()) return []
    const entries = [...browsers.values()]
      .filter((record) => !record.win.isDestroyed())
      .map((record) => ({
        id: record.id,
        visible: record.visible || record.destroyRequested,
        idleSince:
          record.hiddenAt == null ? null : Math.max(record.hiddenAt, record.lastUsedAt || 0),
        busy: (busyOps.get(String(record.id)) || 0) > 0
      }))
    const ids = selectIdleWindows(entries, now, { idleMs: idleReapMs })
    for (const id of ids) {
      const idleSince = entries.find((entry) => entry.id === id)?.idleSince || now
      console.log(describeReap('browser', id, now - idleSince))
      try {
        destroyBrowser(id)
      } catch (error) {
        console.error('[mica-browser] 回收隐藏窗口失败:', error)
      }
    }
    return ids
  }

  const stopIdleReaper = startIdleReaper(reapIdleBrowsers, {
    sweepMs: idleSweepMs,
    label: 'browser'
  })

  /** 主题变了：把已经打开的窗口顶栏重画一遍（配色只在 pushChrome 里下发） */
  function refreshTheme() {
    for (const record of browsers.values()) pushChrome(record)
  }

  /**
   * 回收没有归属的窗口。归属是顶栏图标的唯一依据，留着就等于一个用户既看不见、
   * 也不会自己去关的浏览器进程（旧版本、或者绕开 x-mica-owner 直接打接口留下的）。
   */
  function pruneUnowned() {
    const removed = []
    for (const record of [...browsers.values()]) {
      if (record.owner) continue
      try {
        destroyBrowser(record.id)
        removed.push(record.id)
      } catch {
        // 单个窗口销毁失败不影响其他窗口
      }
    }
    return removed
  }

  function listTabs(owner) {
    const wanted = owner ? String(owner) : ''
    const tabs = []
    for (const record of browsers.values()) {
      if (wanted && record.owner !== wanted) continue
      for (const tab of record.tabs) tabs.push({ ...tabSummary(tab), owner: record.owner || null })
    }
    return tabs
  }

  function createTab({ browserId = '', url = '', owner = null, incognito } = {}) {
    if (!browserId) {
      const record = createBrowser({ owner, url, show: false, incognito })
      return { browser: record, tab: activeTab(record) }
    }
    const record = requireBrowser(browserId)
    if (incognito !== undefined && incognito !== record.incognito) {
      throw new BrowserRequestError('标签页必须沿用目标窗口的无痕模式，不能切换已有窗口的数据分区')
    }
    const tab = addTab(record, url, { activate: true })
    emit('tab')
    return { browser: record, tab }
  }

  function closeTab(tabId) {
    const { record, tab } = requireTab(tabId)
    const index = record.tabs.findIndex((item) => item.id === tab.id)
    record.tabs.splice(index, 1)
    try {
      record.win.contentView.removeChildView(tab.view)
    } catch {
      // 非当前标签页本来就没挂上
    }
    detachTab(tab)
    if (record.tabs.length === 0) {
      destroyBrowser(record.id)
      return { browser: null }
    }
    if (record.activeTabId === tab.id) {
      activateTabIn(record, record.tabs[Math.min(index, record.tabs.length - 1)].id)
    } else {
      pushChrome(record)
      emit('tab')
    }
    return { browser: record }
  }

  async function navigate(tabId, { url = '', action = '' } = {}) {
    const { record, tab } = requireTab(tabId)
    const verb = String(action || '')
      .trim()
      .toLowerCase()
    if (verb) {
      const history = tab.contents.navigationHistory
      const canGoBack = history?.canGoBack?.() ?? tab.contents.canGoBack()
      const canGoForward = history?.canGoForward?.() ?? tab.contents.canGoForward()
      if (verb === 'back') {
        if (!canGoBack) throw new BrowserRequestError('已经没有上一页')
        if (history?.goBack) history.goBack()
        else tab.contents.goBack()
      } else if (verb === 'forward') {
        if (!canGoForward) throw new BrowserRequestError('已经没有下一页')
        if (history?.goForward) history.goForward()
        else tab.contents.goForward()
      } else if (verb === 'reload') {
        tab.contents.reload()
      } else {
        throw new BrowserRequestError(`不支持的 action：${verb}`)
      }
    } else {
      const target = normalizeUrl(url)
      if (!target) throw new BrowserRequestError('navigate 需要 url 或 action')
      if (!isNavigableUrl(target)) throw new BrowserRequestError(`不支持的地址：${target}`)
      await loadUrl(tab, target)
    }
    refreshTabState(tab)
    syncWindowTitle(record)
    pushChrome(record)
    emit('navigated')
    return { record, tab }
  }

  function consoleEntries(tabId, { clear = false } = {}) {
    const { tab } = requireTab(tabId)
    const entries = tab.consoleEntries.map((entry) => ({ ...entry }))
    if (clear) tab.consoleEntries = []
    return entries
  }

  function networkEntries(tabId, { clear = false } = {}) {
    const { tab } = requireTab(tabId)
    const entries = [...tab.network.values()].map((entry) => ({ ...entry }))
    if (clear) tab.network.clear()
    return entries
  }

  return {
    listBrowsers: () => browserList(),
    getBrowser: (id) => browserSummary(requireBrowser(id)),
    /** 接口参数里的 id 可能是窗口 id，也可能是标签页 id：服务报「谁刚被调用」时用它定位 */
    locate(id) {
      const value = String(id || '')
      const record = browsers.get(value)
      if (record) return { browser: browserSummary(record), tab: null }
      for (const item of browsers.values()) {
        const tab = item.tabs.find((entry) => entry.id === value)
        if (tab) return { browser: browserSummary(item), tab: tabSummary(tab) }
      }
      return null
    },
    getSnapshot: () => ({ browsers: browserList() }),

    createBrowser,
    showBrowser,
    hideBrowser,
    destroyBrowser,
    pruneUnowned,
    reapIdleBrowsers,
    closeAll,
    refreshTheme,

    listTabs,
    createTab,
    closeTab,

    activateTab(tabId) {
      const { record, tab } = requireTab(tabId)
      activateTabIn(record, tab.id)
      return browserSummary(record)
    },

    navigate,

    async evaluate(tabId, { expression, timeoutMs } = {}) {
      const { tab } = requireTab(tabId)
      const code = String(expression ?? '').trim()
      if (!code) throw new BrowserRequestError('evaluate 需要 expression')
      return serializeEvaluation(await evaluateInPage(tab, code, timeoutMs || 15000))
    },

    async content(tabId, { format = 'text', maxChars = 200000 } = {}) {
      const { tab } = requireTab(tabId)
      const mode = String(format || 'text').toLowerCase()
      if (!['text', 'html'].includes(mode))
        throw new BrowserRequestError(`不支持的 format：${format}`)
      const expression =
        mode === 'html'
          ? 'document.documentElement ? document.documentElement.outerHTML : ""'
          : 'document.body ? document.body.innerText : ""'
      const raw = await evaluateInPage(tab, expression, 15000)
      const { content, truncated } = truncateOutput(
        typeof raw === 'string' ? raw : '',
        Number(maxChars) || 200000
      )
      return {
        url: tab.contents.getURL(),
        title: tab.contents.getTitle(),
        format: mode,
        content,
        truncated
      }
    },

    async click(tabId, { selector = '', x, y } = {}) {
      const { record, tab } = requireTab(tabId)
      let target = null
      let point = { x: Number(x), y: Number(y) }
      if (selector) {
        target = await elementCenter(tab, selector)
        point = { x: target.x, y: target.y }
      }
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new BrowserRequestError('click 需要 selector 或 x/y 坐标')
      }
      return withTargetTab(record, tab, async () => {
        await dispatchMouse(tab, { ...point, type: 'mouseMoved', clickCount: 0 })
        await dispatchMouse(tab, { ...point, type: 'mousePressed' })
        await dispatchMouse(tab, { ...point, type: 'mouseReleased' })
        await delay(CLICK_SETTLE_MS)
        refreshTabState(tab)
        emit('clicked')
        return {
          target: target || { x: point.x, y: point.y },
          url: tab.contents.getURL()
        }
      })
    },

    async type(tabId, { selector = '', text = '', clear = false, submit = false } = {}) {
      const { record, tab } = requireTab(tabId)
      return withTargetTab(record, tab, async () => {
        if (selector) {
          const script = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true })()`
          const found = await evaluateInPage(tab, script, 15000)
          if (!found) throw new BrowserRequestError(`没有找到元素：${selector}`)
        }
        if (clear) {
          await evaluateInPage(
            tab,
            `(() => {
              const el = document.activeElement;
              if (!el) return false;
              if (typeof el.select === 'function') el.select();
              else if (el.isContentEditable) document.execCommand('selectAll');
              return true;
            })()`,
            5000
          )
          await sendCommand(tab, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Backspace',
            code: 'Backspace',
            windowsVirtualKeyCode: 8
          })
          await sendCommand(tab, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Backspace',
            code: 'Backspace'
          })
        }
        if (text) await sendCommand(tab, 'Input.insertText', { text: String(text) })
        if (submit) await pressKeys(tab, [{ key: 'Enter', code: 'Enter', keyCode: 13 }])
        refreshTabState(tab)
        emit('typed')
        const value = await evaluateInPage(
          tab,
          `(() => {
            const el = document.activeElement
            if (!el) return ''
            return el.isContentEditable ? el.textContent || '' : el.value || ''
          })()`,
          5000
        )
        return { ok: true, value: String(value || ''), submitted: submit ? 'enter' : null }
      })
    },

    async keys(tabId, input) {
      const { record, tab } = requireTab(tabId)
      const descriptors = keyDescriptors(input)
      return withTargetTab(record, tab, async () => {
        await pressKeys(tab, descriptors)
        return { ok: true, fired: descriptors.map((descriptor) => descriptor.key) }
      })
    },

    async scroll(tabId, { deltaY = 0 } = {}) {
      const { record, tab } = requireTab(tabId)
      const amount = Number(deltaY)
      if (!Number.isFinite(amount) || amount === 0) {
        throw new BrowserRequestError('scroll 需要非零的 deltaY')
      }
      return withTargetTab(record, tab, async () => {
        // 不用 Input.dispatchMouseEvent 的 mouseWheel：隐藏窗口上它永远不返回，可见窗口上
        // 也不一定真的滚（实测视口不动）。改成页面内滚：先找视口中心下最近的可滚容器
        // （弹层、内部列表），没有就滚整个文档；两条路在隐藏窗口里都成立。
        const result = await evaluateInPage(
          tab,
          `(() => {
            const delta = ${amount}
            const el = document.elementFromPoint(
              Math.floor(window.innerWidth / 2),
              Math.floor(window.innerHeight / 2)
            )
            for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
              const style = getComputedStyle(node)
              const scrollable =
                /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1
              if (scrollable) {
                node.scrollTop += delta
                return { scrollY: window.scrollY, container: node.tagName, containerScrollTop: Math.round(node.scrollTop) }
              }
            }
            window.scrollBy(0, delta)
            return { scrollY: window.scrollY, container: null, containerScrollTop: null }
          })()`,
          5000
        )
        await delay(CLICK_SETTLE_MS)
        return {
          scrollY: Number(result?.scrollY) || 0,
          container: result?.container || null,
          containerScrollTop: result?.containerScrollTop ?? null
        }
      })
    },

    async screenshot(tabId, { fullPage = false, timeoutMs = 0 } = {}) {
      const { record, tab } = requireTab(tabId)
      return withTargetTab(record, tab, async () => {
        const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : SCREENSHOT_TIMEOUT_MS
        const params = { format: 'png' }
        if (fullPage) {
          const metrics = await withTimeout(
            sendCommand(tab, 'Page.getLayoutMetrics'),
            budget,
            `页面尺寸读取超过 ${budget}ms 未返回（页面可能在忙）`
          )
          const size = metrics?.cssContentSize || metrics?.contentSize || { width: 0, height: 0 }
          params.captureBeyondViewport = true
          params.clip = {
            x: 0,
            y: 0,
            width: Math.max(1, Math.ceil(size.width)),
            height: Math.min(Math.max(1, Math.ceil(size.height)), MAX_SCREENSHOT_HEIGHT),
            scale: 1
          }
        }
        const result = await withTimeout(
          sendCommand(tab, 'Page.captureScreenshot', params),
          budget,
          `页面截图超过 ${budget}ms 未返回（页面可能在忙）；可重试或改用 evaluate 读 DOM`
        )
        const data = result?.data || ''
        return {
          dataUrl: `data:image/png;base64,${data}`,
          bytes: Math.floor((data.length * 3) / 4),
          url: tab.contents.getURL()
        }
      })
    },

    async waitFor(tabId, input = {}) {
      const { tab } = requireTab(tabId)
      const condition = normalizeWaitCondition(input)
      const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : 10000
      const started = Date.now()
      const probe = condition.ready
        ? `document.readyState === 'complete'`
        : condition.selector
          ? `Boolean(document.querySelector(${JSON.stringify(condition.selector)}))`
          : condition.text
            ? `document.body ? document.body.innerText.includes(${JSON.stringify(condition.text)}) : false`
            : `location.href.includes(${JSON.stringify(condition.url)})`
      for (;;) {
        let matched = false
        try {
          matched = Boolean(await evaluateInPage(tab, probe, 5000))
        } catch {
          // 导航中执行上下文会被销毁，下一轮再试
        }
        if (matched) return { matched: true, elapsedMs: Date.now() - started }
        if (Date.now() - started >= timeoutMs)
          return { matched: false, elapsedMs: Date.now() - started }
        await delay(WAIT_POLL_MS)
      }
    },

    async cookies(tabId, { format = 'json', url = '' } = {}) {
      const { record, tab } = requireTab(tabId)
      const scope = normalizeUrl(url) || tab.contents.getURL() || ''
      return readCookies(scope, format, record.browserSession)
    },

    /**
     * 不需要标签页的 cookie 读取：按作用域直接从分区里取。给「别的进程想复用登录态」
     * 用 —— 不必为了读 cookie 先开一个停在目标站点的窗口。
     */
    async cookiesForScope({ url = '', format = 'json' } = {}) {
      return readCookies(normalizeUrl(url), format)
    },

    /**
     * 分区里的全部 cookie，可按域收窄。
     *
     * 与 `cookiesForScope` 的分工：那个按一个地址取「这个站点会发出去的」cookie（含父域），
     * 这个按域列举整份登录态——把浏览器里的会话搬到别处、或者反过来灌进来时用。
     */
    async allCookies({ domain = '', limit = DEFAULT_COOKIE_LIST } = {}) {
      const host = normalizeCookieDomain(domain)
      const max = Math.min(Math.max(Number(limit) || DEFAULT_COOKIE_LIST, 1), MAX_COOKIE_LIST)
      const filter = host ? { domain: host } : {}
      const list = await partition().cookies.get(filter)
      const sorted = [...list].sort(
        (left, right) =>
          String(left.domain).localeCompare(String(right.domain)) ||
          String(left.name).localeCompare(String(right.name)) ||
          String(right.path).localeCompare(String(left.path))
      )
      return {
        domain: host,
        total: sorted.length,
        count: Math.min(sorted.length, max),
        truncated: sorted.length > max,
        cookies: sorted.slice(0, max).map(publicCookie)
      }
    },

    /**
     * 批量写入 cookie。
     *
     * 单条失败不中断整批：一个域写不进去（Secure 与 http 冲突这类）不该让另外几百条白跑，
     * 失败原因原样回给调用方，由它决定要不要重试或提示用户。写完立刻 `flushStore()`：
     * 分区是磁盘上的库，应用被关掉时还没落盘的 cookie 就没了。
     */
    async setCookies(input = []) {
      const list = normalizeCookiePayload(input)
      const store = partition().cookies
      const failed = []
      let written = 0
      for (const entry of list) {
        try {
          await store.set(toElectronCookie(entry))
          written += 1
        } catch (error) {
          failed.push({
            name: String(entry?.name || ''),
            domain: String(entry?.domain || ''),
            reason: error instanceof Error ? error.message : String(error)
          })
        }
      }
      if (written > 0) await store.flushStore().catch(() => {})
      return { written, failed }
    },

    /** URL/name 删除会匹配父域与其它 path；用精确作用域的过期写入删除。 */
    async removeCookies(input = []) {
      const list = normalizeCookiePayload(input)
      const store = partition().cookies
      const failed = []
      let removed = 0
      for (const entry of list) {
        const name = String(entry?.name || '').trim()
        if (!name) {
          failed.push({ name: '', domain: String(entry?.domain || ''), reason: 'cookie 缺少 name' })
          continue
        }
        try {
          const domain = normalizeCookieDomain(entry.domain || entry.url)
          const hostOnly = entry.hostOnly ?? !String(entry.domain || domain).startsWith('.')
          const matches = (await store.get({ domain, name })).filter(
            (cookie) =>
              normalizeCookieDomain(cookie.domain) === domain &&
              cookie.path === (entry.path || '/') &&
              cookie.hostOnly === hostOnly
          )
          for (const cookie of matches) {
            await store.set({ ...toElectronCookie(cookie), expirationDate: 1 })
            removed += 1
          }
        } catch (error) {
          failed.push({
            name,
            domain: String(entry?.domain || ''),
            reason: error instanceof Error ? error.message : String(error)
          })
        }
      }
      if (removed > 0) await store.flushStore().catch(() => {})
      return { removed, failed }
    },

    ownerOf,
    consoleEntries,
    networkEntries
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** 只有这些协议交给页面自己走：其余（file/javascript/blob 之类）一律拦掉 */
function isNavigableUrl(url) {
  return /^(https?|about):/i.test(String(url || ''))
}
