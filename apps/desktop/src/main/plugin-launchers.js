import { watchFile, unwatchFile } from 'node:fs'
import { resolveEditorTarget } from './editor-window.js'

/** Native lifecycle for manifest-declared launchers. No session process is needed. */
export function createPluginLaunchers({
  manifests,
  readDisabled,
  statePath,
  BrowserWindow,
  WebContentsView,
  globalShortcut,
  screen,
  pageUrl,
  backgroundColor,
  deliver,
  openEditorWindow,
  platform = process.platform,
  onError = console.warn
}) {
  const records = new Map()
  let disposed = false

  function register(id, record) {
    if (record.registered) return
    record.error = ''
    try {
      record.registered = globalShortcut.register(record.spec.shortcut, () => {
        if (record.win?.isVisible() && (record.spec.webContent || record.win.isFocused())) {
          record.win.hide()
          return
        }
        void show(id).catch((error) => onError(error.message))
      })
      if (!record.registered)
        record.error = `快捷键 ${record.spec.shortcut} 已被其他应用占用，请释放后重试`
    } catch (error) {
      record.error = `无法注册快捷键 ${record.spec.shortcut}：${error.message}`
    }
    if (record.error) onError(record.error)
  }

  function sync() {
    const disabled = readDisabled()
    for (const manifest of manifests) {
      if (!manifest.desktopLauncher) continue
      const id = manifest.id
      if (disabled.has(id)) {
        remove(id)
        continue
      }
      if (records.has(id)) continue
      const spec = manifest.desktopLauncher
      const record = {
        spec,
        win: null,
        view: null,
        webAttached: false,
        webHome: !!spec.webContent,
        loading: null,
        registered: false,
        error: '',
        webError: '',
        webFavicon: ''
      }
      records.set(id, record)
      register(id, record)
    }
  }

  function requireRecord(id) {
    sync()
    const record = records.get(id)
    if (!record || disposed) throw new Error('插件已停用或没有桌面启动器')
    return record
  }

  function allowedWebUrl(value) {
    if (typeof value !== 'string' || /[\s\x00-\x1f\x7f]/.test(value) || value.length > 8192) return false
    if (value === 'about:blank') return true
    if (!/^https?:\/\//i.test(value)) return false
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password
    } catch { return false }
  }

  function webState(record) {
    const wc = record.view.webContents
    const url = wc.getURL()
    return {
      url: record.webHome || url === 'about:blank' ? '' : url,
      home: record.webHome,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
      ...(record.webFavicon ? { faviconUrl: record.webFavicon } : {}),
      ...(record.webError ? { error: record.webError } : {})
    }
  }

  function pushWebState(id, record) {
    const win = record.win
    if (!win || win.isDestroyed() || !record.view || record.view.webContents.isDestroyed()) return
    if (win.webContents.getURL() !== launcherUrl(id)) return
    const detail = JSON.stringify({ pluginId: id, state: webState(record) })
    void win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('mica:launcher-web-state', { detail: ${detail} }))`).catch(() => {})
  }

  function showWebContent(record) {
    if (!record.view || record.webAttached) return
    record.win.contentView.addChildView(record.view)
    record.webAttached = true
  }

  function hideWebContent(record) {
    if (!record.view || !record.webAttached) return
    record.win.contentView.removeChildView(record.view)
    record.webAttached = false
  }

  function attachWebContent(id, record, win) {
    const view = new WebContentsView({ webPreferences: {
      partition: `persist:mica-launcher-${id}`,
      sandbox: true, contextIsolation: true, nodeIntegration: false
    } })
    record.view = view
    const wc = view.webContents
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    wc.session.setPermissionCheckHandler(() => false)
    const resize = () => {
      if (win.isDestroyed() || wc.isDestroyed()) return
      const [width, height] = win.getContentSize()
      const top = Math.min(record.spec.webContent.top, height)
      view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) })
    }
    resize()
    win.on('resize', resize)
    const guard = (event, url) => { if (!allowedWebUrl(event.url ?? url)) event.preventDefault() }
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)
    wc.on('will-frame-navigate', guard)
    wc.setWindowOpenHandler(({ url }) => {
      if (allowedWebUrl(url)) void wc.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })
    for (const event of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']) {
      wc.on(event, () => {
        if (event === 'did-start-loading') {
          record.webError = ''
          record.webFavicon = ''
        }
        pushWebState(id, record)
      })
    }
    wc.on('page-favicon-updated', (_event, favicons) => {
      if (record.webHome) return
      const candidate = Array.isArray(favicons) ? favicons.find((value) => {
        return allowedWebUrl(value)
      }) : ''
      record.webFavicon = candidate || ''
      pushWebState(id, record)
    })
    wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) { record.webError = description; pushWebState(id, record) }
    })
    win.webContents.on('did-finish-load', () => pushWebState(id, record))
  }

  async function show(id) {
    const record = requireRecord(id)
    register(id, record)
    if (!record.win || record.win.isDestroyed()) {
      const spec = record.spec
      const win = new BrowserWindow({
        width: spec.width,
        height: spec.height,
        show: false,
        frame: false,
        resizable: !!spec.webContent,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        ...(platform === 'darwin' ? { type: 'panel' } : {}),
        title: spec.title,
        backgroundColor: backgroundColor(),
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
      })
      record.win = win
      win.on('closed', () => {
        if (record.win !== win) return
        if (record.view && !record.view.webContents.isDestroyed()) record.view.webContents.close()
        record.view = null
        record.webAttached = false
        record.win = null
      })
      // macOS panels accept keyboard focus without activating the app and already
      // join all Spaces, including fullscreen. setVisibleOnAllWorkspaces would
      // additionally transform the app's process type and disturb other windows.
      if (platform !== 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      if (!spec.webContent) win.on('blur', () => {
        if (!win.isDestroyed()) win.hide()
      })
      win.on('close', (event) => {
        if (!disposed && records.has(id)) {
          event.preventDefault()
          win.hide()
        }
      })
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('will-navigate', (event, target) => {
        if (target !== launcherUrl(id)) event.preventDefault()
      })
      win.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') {
          event.preventDefault()
          win.hide()
        }
      })
      if (spec.webContent) attachWebContent(id, record, win)
      try {
        record.loading = win.loadURL(launcherUrl(id))
        await record.loading
      } catch (error) {
        record.win = null
        if (record.view && !record.view.webContents.isDestroyed()) record.view.webContents.close()
        record.view = null
        record.webAttached = false
        if (!win.isDestroyed()) win.destroy()
        throw error
      } finally {
        record.loading = null
      }
    } else if (record.loading) await record.loading
    // Loading can finish after the plugin was disabled or the application quit.
    if (disposed || records.get(id) !== record || !record.win || record.win.isDestroyed()) return
    const win = record.win
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const [width, height] = win.getSize()
    win.setPosition(
      Math.round(area.x + (area.width - width) / 2),
      Math.round(area.y + Math.max(0, (area.height - height) / 3))
    )
    win.show()
    win.focus()
  }

  function launcherUrl(id) {
    const url = new URL(pageUrl)
    url.searchParams.set('pluginLauncher', id)
    return url.href
  }

  function remove(id) {
    const record = records.get(id)
    if (!record) return
    records.delete(id)
    if (record.registered) globalShortcut.unregister(record.spec.shortcut)
    if (record.view && !record.view.webContents.isDestroyed()) record.view.webContents.close()
    record.view = null
    record.webAttached = false
    if (record.win && !record.win.isDestroyed()) record.win.destroy()
  }

  async function control({ pluginId, action, path, url } = {}) {
    const record = requireRecord(pluginId)
    if (typeof action === 'string' && action.startsWith('web.')) {
      if (!record.spec.webContent) throw new Error('此启动器未声明网页内容')
      if (!record.view || record.view.webContents.isDestroyed()) throw new Error('网页浮窗尚未打开')
      const wc = record.view.webContents
      if (action === 'web.state') return webState(record)
      if (action === 'web.navigate') {
        if (!allowedWebUrl(url)) throw new Error('只允许有效的 HTTP(S) 地址或 about:blank')
        showWebContent(record)
        record.webHome = false
        record.webError = ''
        record.webFavicon = ''
        void wc.loadURL(url).catch(() => {})
      } else if (action === 'web.home') {
        record.webHome = true
        record.webError = ''
        record.webFavicon = ''
        hideWebContent(record)
        pushWebState(pluginId, record)
      } else if (action === 'web.back') {
        if (wc.navigationHistory.canGoBack()) {
          showWebContent(record)
          record.webHome = false
          wc.navigationHistory.goBack()
        }
      } else if (action === 'web.forward') {
        if (wc.navigationHistory.canGoForward()) {
          showWebContent(record)
          record.webHome = false
          wc.navigationHistory.goForward()
        }
      } else if (action === 'web.reload') {
        if (!record.webHome) wc.reload()
      }
      else throw new Error('不支持的网页动作')
      return {}
    }
    if (action === 'status')
      return { shortcut: record.spec.shortcut, registered: record.registered, error: record.error }
    if (action === 'show') {
      await show(pluginId)
      return {}
    }
    if (action === 'retry') {
      register(pluginId, record)
      return control({ pluginId, action: 'status' })
    }
    if (action === 'close') {
      record.win?.hide()
      return {}
    }
    if (action === 'openPath') {
      // 搜索结果默认落在**新开的编辑器窗口**上：当前窗口（可能在对话里、可能连着别的
      // 机器）保持不动，看文件是一件并行的事。
      await openEditorWindow(await resolveEditorTarget(path))
    } else if (action === 'configure') {
      await deliver({ type: 'configurePlugin', pluginId })
    } else throw new Error('不支持的启动器动作')
    record.win?.hide()
    return {}
  }

  sync()
  watchFile(statePath, { interval: 400, persistent: false }, sync)
  return {
    control,
    close() {
      disposed = true
      unwatchFile(statePath, sync)
      for (const id of [...records.keys()]) remove(id)
    }
  }
}
