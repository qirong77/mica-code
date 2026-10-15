import { BrowserWindow, WebContentsView, session } from 'electron'
import {
  BROWSER_PARTITION,
  BrowserRequestError,
  CHROME_HEIGHT,
  DEFAULT_BROWSER_SIZE,
  activeTab,
  browserSummary,
  formatCookieHeader,
  keyDescriptors,
  normalizeLabel,
  normalizeUrl,
  normalizeWaitCondition,
  notFoundError,
  publicCookie,
  serializeEvaluation,
  tabSummary,
  timeoutError,
  truncateOutput
} from './browser-core.js'
import { chromeDataUrl, parseChromeMessage } from './browser-chrome.js'

/**
 * 受控浏览器窗口的管理器：浏览器窗口、标签页（每个标签页一个 WebContentsView）、
 * 页面操作（点击/输入/截图/读 cookie/控制台/网络），以及它们到 HTTP 服务的映射。
 *
 * 几个刻意的设计：
 * - **窗口是隐藏式的**：用户点关闭只 `hide()`，页面与登录态原样留着；只有
 *   `POST /browser/browsers/:id/close` 才真的销毁。用户看到的关闭按钮不该等于丢掉现场。
 * - **标签页视图按需挂载**：只有当前标签页挂在窗口上，其余保持存活但不渲染；截图走 CDP
 *   而不是 `capturePage`——后者要求窗口有可见的显示面（隐藏窗口直接报错），而 agent 大多数
 *   时候面对的正是隐藏窗口。
 * - **浏览数据走独立分区**（`persist:mica-browser`）：与应用自身、与用户日常浏览器互不干扰。
 */

const CLICK_SETTLE_MS = 120
const WAIT_POLL_MS = 150
const MAX_SCREENSHOT_HEIGHT = 16000
const MAX_CONSOLE_ENTRIES = 500
const MAX_NETWORK_ENTRIES = 400

/**
 * 隐藏窗口里的原生输入会被丢掉：Chromium 的鼠标/键盘事件挂在有显示面的 widget 上，
 * 窗口 `hide()` 之后 `Input.dispatchMouseEvent` / `dispatchKeyEvent` 发出去没有任何效果
 * （实测 press/release 全丢，`Input.insertText` 倒是能写进已聚焦的元素）。而 agent 大多数
 * 时候面对的正是隐藏窗口（用户不想被弹窗打断），所以隐藏时改走这一份**页面内合成事件**：
 * 命中判定照 `elementFromPoint`（被弹层盖住就报错，而不是硬点），点击补上 mousedown/mouseup，
 * 输入用原生 value setter + input/change 事件（React 受控组件也认）。
 * 窗口可见时一律走原生输入（更高保真），两条路都在返回值里用 `via` 标出来。
 */
const SYNTHETIC_INPUT = `(command) => {
  const read = (el) => (el.isContentEditable ? el.textContent : el.value) || ''
  const write = (el, value) => {
    if (el.isContentEditable) {
      el.textContent = value
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
      if (descriptor && descriptor.set) descriptor.set.call(el, value)
      else el.value = value
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const fireKey = (el, key, code, keyCode) => {
    const init = { key: key, code: code || '', keyCode: keyCode || 0, which: keyCode || 0, bubbles: true, cancelable: true }
    el.dispatchEvent(new KeyboardEvent('keydown', init))
    el.dispatchEvent(new KeyboardEvent('keyup', init))
  }

  if (command.action === 'click') {
    const el = command.selector
      ? document.querySelector(command.selector)
      : document.elementFromPoint(command.x, command.y)
    if (!el) return { ok: false, reason: command.selector ? 'not-found' : 'no-element-at-point' }
    const rect = el.getBoundingClientRect()
    const x = rect.x + rect.width / 2
    const y = rect.y + rect.height / 2
    const top = document.elementFromPoint(x, y)
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      return { ok: false, reason: 'covered', by: top.tagName }
    }
    const options = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }
    el.dispatchEvent(new MouseEvent('mousedown', options))
    el.dispatchEvent(new MouseEvent('mouseup', options))
    el.click()
    return { ok: true, via: 'in-page', tag: el.tagName, text: String(el.innerText || el.value || '').slice(0, 120) }
  }

  if (command.action === 'type') {
    const el = command.selector ? document.querySelector(command.selector) : document.activeElement
    if (!el) return { ok: false, reason: 'not-found' }
    if (typeof el.focus === 'function') el.focus()
    write(el, (command.clear ? '' : read(el)) + command.text)
    let submitted = null
    if (command.submit) {
      if (el.form && typeof el.form.requestSubmit === 'function') {
        el.form.requestSubmit()
        submitted = 'form'
      } else {
        fireKey(el, 'Enter', 'Enter', 13)
        submitted = 'keydown'
      }
    }
    return { ok: true, via: 'in-page', value: read(el), submitted }
  }

  if (command.action === 'keys') {
    const el = document.activeElement || document.body
    const fired = []
    for (const descriptor of command.descriptors) {
      if (descriptor.text && el && ('value' in el || el.isContentEditable)) {
        write(el, read(el) + descriptor.text)
      }
      fireKey(el, descriptor.key, descriptor.code, descriptor.keyCode)
      fired.push(descriptor.key)
    }
    return { ok: true, via: 'in-page', fired }
  }

  if (command.action === 'scroll') {
    window.scrollBy(0, command.deltaY)
    return { ok: true, via: 'in-page', scrollY: window.scrollY }
  }

  return { ok: false, reason: 'unknown-action' }
}`

export function createBrowserManager({ onChange = () => {}, isQuitting = () => false } = {}) {
  const browsers = new Map()
  let sequence = 0
  let permissionsInstalled = false

  const partition = () => session.fromPartition(BROWSER_PARTITION)

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

  function browserList() {
    return [...browsers.values()].map((record) => browserSummary(record))
  }

  function requireBrowser(id) {
    const record = browsers.get(String(id || ''))
    if (!record) throw notFoundError(`浏览器窗口不存在：${id}`)
    return record
  }

  function requireTab(tabId) {
    const id = String(tabId || '')
    for (const record of browsers.values()) {
      const tab = record.tabs.find((item) => item.id === id)
      if (tab) return { record, tab }
    }
    throw notFoundError(`标签页不存在：${tabId}`)
  }

  /* --------------------------------------------------------------- 窗口装配 */

  /** 一个分区只装一次权限策略：这些窗口是给 agent 用的，不该悄悄拿到摄像头/定位/通知 */
  function installPermissionPolicy() {
    if (permissionsInstalled) return
    permissionsInstalled = true
    try {
      partition().setPermissionRequestHandler((_contents, permission, callback) => {
        callback(['clipboard-sanitized-write', 'fullscreen'].includes(permission))
      })
      partition().setPermissionCheckHandler(() => false)
    } catch (error) {
      console.error('[mica-browser] 设置权限策略失败:', error)
    }
  }

  function pushChrome(record) {
    if (!record.chromeReady || record.win.isDestroyed()) return
    const current = activeTab(record)
    const state = {
      label: record.label,
      owner: record.owner || '',
      url: current?.url || '',
      title: current?.title || '',
      loading: Boolean(current?.loading),
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

  function syncWindowTitle(record) {
    if (record.win.isDestroyed()) return
    const current = activeTab(record)
    const title = current?.title || current?.url || '受控浏览器'
    record.win.setTitle(`${title} — 受控浏览器`)
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

  function createBrowser({ owner = null, url = '', label, show = false, focus = false } = {}) {
    const id = nextId('brw')
    const win = new BrowserWindow({
      width: DEFAULT_BROWSER_SIZE.width,
      height: DEFAULT_BROWSER_SIZE.height,
      minWidth: 480,
      minHeight: 360,
      show: false,
      autoHideMenuBar: true,
      title: '受控浏览器',
      backgroundColor: '#2b2b2b',
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
      label: normalizeLabel(label),
      visible: false,
      createdAt: new Date().toISOString(),
      win,
      chrome: win.webContents,
      chromeReady: false,
      tabs: [],
      activeTabId: null,
      destroyRequested: false
    }
    browsers.set(id, record)
    installPermissionPolicy()

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
      emit('closed')
    })

    win.on('resize', () => layout(record))
    win.on('show', () => {
      record.visible = true
      emit('shown')
    })
    win.on('hide', () => {
      record.visible = false
      emit('hidden')
    })

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
        partition: BROWSER_PARTITION,
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
          tab.network.set(params.requestId, {
            method: params.request?.method || 'GET',
            url: params.request?.url || '',
            resourceType: params.type || '',
            status: null,
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

  /** 可见窗口走原生输入，隐藏窗口走页面内合成事件（原因见 SYNTHETIC_INPUT 的说明） */
  function inputMode(record) {
    return record.visible && !record.win.isDestroyed() ? 'native' : 'in-page'
  }

  async function synthetic(tab, command) {
    const result = await evaluateInPage(
      tab,
      `(${SYNTHETIC_INPUT})(${JSON.stringify(command)})`,
      15000
    )
    if (!result?.ok) {
      if (result?.reason === 'covered') {
        throw new BrowserRequestError(
          `目标被 ${result.by} 盖住，点击没有下发（改用 evaluate 强制触发？）`
        )
      }
      throw new BrowserRequestError(`页面内操作失败：${result?.reason || 'unknown'}`)
    }
    return result
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

  function showBrowser(id, { focus = true } = {}) {
    const record = requireBrowser(id)
    if (record.win.isDestroyed()) throw new BrowserRequestError('窗口已销毁')
    if (record.win.isMinimized()) record.win.restore()
    if (focus) {
      record.win.show()
      record.win.focus()
    } else {
      // agent 让它「可见」不该抢走用户正在打字的焦点
      record.win.showInactive()
    }
    record.visible = true
    emit('shown')
    return record
  }

  function hideBrowser(id) {
    const record = requireBrowser(id)
    if (!record.win.isDestroyed() && record.win.isVisible()) record.win.hide()
    record.visible = false
    emit('hidden')
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
    for (const record of [...browsers.values()]) {
      record.destroyRequested = true
      for (const tab of record.tabs) detachTab(tab)
      record.tabs = []
      if (!record.win.isDestroyed()) record.win.destroy()
    }
    browsers.clear()
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

  function createTab({ browserId = '', url = '', owner = null } = {}) {
    if (!browserId) {
      const record = createBrowser({ owner, url, show: false })
      return { browser: record, tab: activeTab(record) }
    }
    const record = requireBrowser(browserId)
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
    getSnapshot: () => ({ browsers: browserList() }),

    createBrowser,
    showBrowser,
    hideBrowser,
    destroyBrowser,
    closeAll,

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
      if (inputMode(record) === 'in-page') {
        const result = await synthetic(tab, { action: 'click', selector, x: point.x, y: point.y })
        await delay(CLICK_SETTLE_MS)
        refreshTabState(tab)
        emit('clicked')
        return {
          target: target || { x: result.x ?? point.x, y: result.y ?? point.y },
          via: result.via,
          url: tab.contents.getURL()
        }
      }
      await dispatchMouse(tab, { ...point, type: 'mouseMoved', clickCount: 0 })
      await dispatchMouse(tab, { ...point, type: 'mousePressed' })
      await dispatchMouse(tab, { ...point, type: 'mouseReleased' })
      await delay(CLICK_SETTLE_MS)
      refreshTabState(tab)
      emit('clicked')
      return {
        target: target || { x: point.x, y: point.y },
        via: 'native',
        url: tab.contents.getURL()
      }
    },

    async type(tabId, { selector = '', text = '', clear = false, submit = false } = {}) {
      const { record, tab } = requireTab(tabId)
      if (inputMode(record) === 'in-page') {
        if (selector) {
          const found = await evaluateInPage(
            tab,
            `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
            5000
          )
          if (!found) throw new BrowserRequestError(`没有找到元素：${selector}`)
        }
        if (!selector) {
          // 合成路径要往「当前聚焦的元素」里写，没聚焦就明确报错（原生路径这里是隐式的）
          const focused = await evaluateInPage(
            tab,
            'Boolean(document.activeElement && document.activeElement !== document.body)',
            5000
          )
          if (!focused) throw new BrowserRequestError('没有聚焦任何元素，type 需要 selector')
        }
        const result = await synthetic(tab, {
          action: 'type',
          selector,
          text: String(text || ''),
          clear,
          submit
        })
        refreshTabState(tab)
        emit('typed')
        return { ok: true, via: result.via, value: result.value, submitted: result.submitted }
      }
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
      return { ok: true, via: 'native' }
    },

    async keys(tabId, input) {
      const { record, tab } = requireTab(tabId)
      const descriptors = keyDescriptors(input)
      if (inputMode(record) === 'in-page') {
        const result = await synthetic(tab, { action: 'keys', descriptors })
        refreshTabState(tab)
        return { ok: true, via: result.via, fired: result.fired }
      }
      await pressKeys(tab, descriptors)
      return { ok: true, via: 'native' }
    },

    async scroll(tabId, { deltaY = 0 } = {}) {
      const { record, tab } = requireTab(tabId)
      const amount = Number(deltaY)
      if (!Number.isFinite(amount) || amount === 0) {
        throw new BrowserRequestError('scroll 需要非零的 deltaY')
      }
      if (inputMode(record) === 'in-page') {
        const result = await synthetic(tab, { action: 'scroll', deltaY: amount })
        await delay(CLICK_SETTLE_MS)
        return { scrollY: result.scrollY }
      }
      const size = await evaluateInPage(
        tab,
        '({ x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2) })',
        5000
      )
      await sendCommand(tab, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: size.x,
        y: size.y,
        deltaX: 0,
        deltaY: amount
      })
      await delay(CLICK_SETTLE_MS)
      const scrollY = await evaluateInPage(tab, 'window.scrollY', 5000)
      return { scrollY }
    },

    async screenshot(tabId, { fullPage = false } = {}) {
      const { record, tab } = requireTab(tabId)
      // 非当前标签页的视图不在窗口上（没有显示面），截图前临时挂上再切回去
      const previous = activeTab(record)
      const switched = !previous || previous.id !== tab.id
      if (switched) activateTabIn(record, tab.id)
      try {
        const params = { format: 'png' }
        if (fullPage) {
          const metrics = await sendCommand(tab, 'Page.getLayoutMetrics')
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
        const result = await sendCommand(tab, 'Page.captureScreenshot', params)
        const data = result?.data || ''
        return {
          dataUrl: `data:image/png;base64,${data}`,
          bytes: Math.floor((data.length * 3) / 4),
          url: tab.contents.getURL()
        }
      } finally {
        if (switched && previous && record.tabs.includes(previous))
          activateTabIn(record, previous.id)
      }
    },

    async waitFor(tabId, input = {}) {
      const { tab } = requireTab(tabId)
      const condition = normalizeWaitCondition(input)
      const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : 10000
      const started = Date.now()
      const probe = condition.selector
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
      const { tab } = requireTab(tabId)
      const scope = normalizeUrl(url) || tab.contents.getURL() || ''
      if (!/^https?:/i.test(scope)) {
        return {
          url: scope,
          count: 0,
          cookieHeader: '',
          cookies: [],
          note: '当前页不是 http(s)，没有 cookie 作用域'
        }
      }
      const list = await partition().cookies.get({ url: scope })
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
    },

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
