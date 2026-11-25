import { watchFile, unwatchFile } from 'node:fs'
import { createPluginSettingsStore } from '@packages/mica-plugin/PluginSettings.js'
import { resolveMicaHome } from '@packages/mica-config/index.js'
import { resolveEditorTarget } from './editor-window.js'
import { createLauncherFavicons, inlineIconDataUrl } from './launcher-favicon.js'

/**
 * Native lifecycle for manifest-declared launchers. No session process is needed.
 *
 * The global shortcut normally comes from the manifest. A launcher may instead point
 * at one of its settings (`shortcutSetting`), in which case the value is read from the
 * same `$MICA_HOME/plugin-settings/<id>.json` the config page writes and re-applied
 * whenever that file changes — no restart, and no silent fall back to the manifest
 * default when the user clears it.
 */
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
  home = process.env.MICA_HOME || resolveMicaHome(),
  readSettings,
  onError = console.warn
}) {
  const records = new Map()
  const settingsStores = new Map()
  let disposed = false

  function settingsStore(manifest) {
    let store = settingsStores.get(manifest.id)
    if (!store) {
      store = createPluginSettingsStore(
        manifest.id,
        Array.isArray(manifest.settings) ? manifest.settings : [],
        { configDir: home }
      )
      settingsStores.set(manifest.id, store)
    }
    return store
  }

  function settingsValues(manifest) {
    if (typeof readSettings === 'function') return readSettings(manifest) ?? {}
    return settingsStore(manifest).get()
  }

  /**
   * The accelerator a launcher should own right now. A declared setting always wins,
   * including when it is empty: an empty value is a visible error, because quietly
   * registering the manifest default makes the user's edit look applied while the key
   * they configured does nothing.
   */
  function resolveShortcut(manifest) {
    const spec = manifest.desktopLauncher
    const key = spec.shortcutSetting
    if (!key) return { shortcut: spec.shortcut, error: '' }
    let raw
    try {
      raw = settingsValues(manifest)[key]
    } catch (error) {
      return { shortcut: '', error: `无法读取快捷键设置 ${key}：${error?.message || error}` }
    }
    const shortcut = typeof raw === 'string' ? raw.trim() : ''
    if (!shortcut) return { shortcut: '', error: `快捷键设置 ${key} 为空，请填写一个全局快捷键` }
    return { shortcut, error: '' }
  }

  function toggle(id, record) {
    if (record.win?.isVisible() && (record.spec.webContent || record.win.isFocused())) {
      record.win.hide()
      return
    }
    void show(id).catch((error) => onError(error.message))
  }

  function register(id, record) {
    if (record.registered || !record.shortcut) return
    record.error = ''
    try {
      record.registered = globalShortcut.register(record.shortcut, () => toggle(id, record))
      if (!record.registered)
        record.error = `快捷键 ${record.shortcut} 已被其他应用占用，请释放后重试`
    } catch (error) {
      record.error = `无法注册快捷键 ${record.shortcut}：${error.message}`
    }
    if (record.error) onError(record.error)
  }

  /**
   * Make the registered shortcut match the current settings.
   *
   * Idempotent on purpose: it runs from `sync()`, from showing the window and from the
   * settings watcher. Only a changed accelerator or a cleared error retries the
   * registration, so an occupied key is not re-announced on every request.
   */
  function applyShortcut(id, record, { retry = false } = {}) {
    const next = resolveShortcut(record.manifest)
    // `settingError` is what the setting says; `error` may also hold a registration
    // failure. Keeping them apart means a status poll does not retry (and re-log) an
    // occupied key, while a new value from the settings file always does.
    const changed = next.shortcut !== record.shortcut || next.error !== record.settingError
    if (record.registered && (next.error || next.shortcut !== record.shortcut)) {
      globalShortcut.unregister(record.shortcut)
      record.registered = false
    }
    record.shortcut = next.shortcut
    record.settingError = next.error
    if (next.error) {
      record.error = next.error
      if (changed) onError(next.error)
      return
    }
    // The setting itself is fine; a registration failure from the previous attempt
    // stays visible until something actually retries it (`show` / `retry` / a change).
    if (record.registered) {
      record.error = ''
      return
    }
    if (!changed && !retry) return
    register(id, record)
  }

  function watchSettings(id, record) {
    if (typeof readSettings === 'function') return
    // Only a launcher whose shortcut comes from a setting has a file worth polling;
    // ordinary launchers must not add a watcher (or a settings store) for nothing.
    if (!record.spec.shortcutSetting) return
    const path = settingsStore(record.manifest).path
    if (!path) return
    record.settingsPath = path
    record.onSettings = () => {
      if (disposed || records.get(id) !== record) return
      sync()
    }
    watchFile(path, { interval: 400, persistent: false }, record.onSettings)
  }

  function createRecord(manifest) {
    const spec = manifest.desktopLauncher
    return {
      manifest,
      spec,
      win: null,
      view: null,
      webAttached: false,
      webHome: !!spec.webContent,
      loading: null,
      shortcut: '',
      settingError: '',
      registered: false,
      error: '',
      webError: '',
      webFavicon: '',
      webFaviconFor: '',
      webIcons: null,
      settingsPath: null,
      onSettings: null
    }
  }

  function sync() {
    if (disposed) return
    const disabled = readDisabled()
    for (const [id, record] of [...records]) {
      if (disabled.has(id)) remove(id, record)
    }
    for (const manifest of manifests) {
      if (!manifest.desktopLauncher) continue
      if (disabled.has(manifest.id)) continue
      let record = records.get(manifest.id)
      if (!record) {
        record = createRecord(manifest)
        records.set(manifest.id, record)
        watchSettings(manifest.id, record)
      }
      applyShortcut(manifest.id, record)
    }
    for (const id of [...settingsStores.keys()]) {
      if (!manifests.some((manifest) => manifest.id === id && manifest.desktopLauncher)) {
        settingsStores.delete(id)
      }
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
    const stateUrl = record.webHome || url === 'about:blank' ? '' : url
    return {
      url: stateUrl,
      home: record.webHome,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
      // An icon belongs to the page it was reported for. Keyed by URL instead of
      // cleared on every load, because a single-page app reports its icon once and
      // then navigates within itself: clearing on the next `did-start-loading` threw
      // the icon away for good, since Chromium only re-announces a *changed* icon.
      ...(record.webFavicon && record.webFaviconFor && record.webFaviconFor === stateUrl
        ? { faviconUrl: record.webFavicon }
        : {}),
      ...(record.webError ? { error: record.webError } : {})
    }
  }

  function pushWebState(id, record) {
    const win = record.win
    if (!win || win.isDestroyed() || !record.view || record.view.webContents.isDestroyed()) return
    if (!isLauncherPage(win.webContents.getURL(), id)) return
    const detail = JSON.stringify({ pluginId: id, state: webState(record) })
    void win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('mica:launcher-web-state', { detail: ${detail} }))`).catch(() => {})
  }

  /**
   * The launcher page is identified by its `pluginLauncher` parameter, not by the
   * exact URL string: the page normalizes its own query and may grow a fragment, and
   * a byte-for-byte comparison would then silently drop every state push — the view
   * keeps browsing while the plugin UI never hears about it, so nothing is
   * remembered and the welcome page keeps showing a list from its first mount.
   */
  function isLauncherPage(current, id) {
    try {
      const url = new URL(current)
      return url.origin === new URL(pageUrl).origin && url.searchParams.get('pluginLauncher') === id
    } catch {
      return false
    }
  }

  /** Icons are inlined here because the plugin page may only draw `data:` images. */
  function webIcons(record) {
    if (!record.webIcons) {
      record.webIcons = createLauncherFavicons({
        fetchImage: (url, options) => record.view.webContents.session.fetch(url, options)
      })
    }
    return record.webIcons
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
        if (event === 'did-start-loading') record.webError = ''
        pushWebState(id, record)
      })
    }
    wc.on('page-favicon-updated', (_event, favicons) => {
      if (record.webHome) return
      // Inline icons arrive as `data:image/…` and are already drawable by the page;
      // sites that declare one this way usually have no `/favicon.ico` to fall back to.
      const candidate = Array.isArray(favicons) ? favicons.find((value) => {
        return allowedWebUrl(value) || Boolean(inlineIconDataUrl(value))
      }) : ''
      record.webFavicon = candidate || ''
      record.webFaviconFor = candidate ? wc.getURL() : ''
      pushWebState(id, record)
    })
    wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) { record.webError = description; pushWebState(id, record) }
    })
    win.webContents.on('did-finish-load', () => pushWebState(id, record))
  }

  async function show(id) {
    const record = requireRecord(id)
    // A failed or occupied shortcut is retried when the user opens the launcher, and
    // a settings change made in the meantime is picked up here too.
    applyShortcut(id, record, { retry: true })
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
        record.webIcons?.clear()
        record.webIcons = null
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

  function remove(id, record = records.get(id)) {
    if (!record) return
    if (records.get(id) === record) records.delete(id)
    if (record.settingsPath && record.onSettings) unwatchFile(record.settingsPath, record.onSettings)
    record.settingsPath = null
    record.onSettings = null
    if (record.registered) globalShortcut.unregister(record.shortcut)
    record.registered = false
    if (record.view && !record.view.webContents.isDestroyed()) record.view.webContents.close()
    record.view = null
    record.webAttached = false
    record.webIcons?.clear()
    record.webIcons = null
    if (record.win && !record.win.isDestroyed()) record.win.destroy()
    settingsStores.delete(id)
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
        void wc.loadURL(url).catch(() => {})
      } else if (action === 'web.home') {
        record.webHome = true
        record.webError = ''
        record.webFavicon = ''
        record.webFaviconFor = ''
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
      else if (action === 'web.cover') {
        // 页面要在网页区域上画浮层（地址栏的最近访问列表）：临时把网页视图摘下来，
        // 关掉再挂回去。与 web.home 不同，`webHome` 不变——页面仍是「正在浏览」的那一页，
        // 只是暂时让位；摘下来的视图还活着，滚动位置与登录态都不受影响。
        if (path && typeof path === 'object' && path.cover === false) {
          if (!record.webHome) showWebContent(record)
        } else {
          hideWebContent(record)
        }
      }
      else if (action === 'web.favicon') {
        if (!allowedWebUrl(url) && !inlineIconDataUrl(url)) throw new Error('只允许有效的 HTTP(S) 图标地址')
        return { dataUrl: (await webIcons(record).load(url)) ?? '' }
      }
      else throw new Error('不支持的网页动作')
      return {}
    }
    if (action === 'status')
      return { shortcut: record.shortcut, registered: record.registered, error: record.error }
    if (action === 'show') {
      await show(pluginId)
      return {}
    }
    if (action === 'retry') {
      applyShortcut(pluginId, record, { retry: true })
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
    sync,
    close() {
      disposed = true
      unwatchFile(statePath, sync)
      for (const [id, record] of [...records]) remove(id, record)
    }
  }
}
