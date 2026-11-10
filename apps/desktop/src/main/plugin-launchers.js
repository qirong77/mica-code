import { watchFile, unwatchFile } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

/** Native lifecycle for manifest-declared launchers. No session process is needed. */
export function createPluginLaunchers({
  manifests,
  readDisabled,
  statePath,
  BrowserWindow,
  globalShortcut,
  screen,
  pageUrl,
  backgroundColor,
  deliver,
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
        if (record.win?.isVisible() && record.win.isFocused()) {
          record.win.hide()
          return
        }
        void show(id).catch((error) => onError(error.message))
      })
      if (!record.registered)
        record.error = `快捷键 ${record.spec.shortcut} 已被其他应用占用，请释放后重新打开搜索`
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
      const record = { spec, win: null, loading: null, registered: false, error: '' }
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
        resizable: false,
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
      // macOS panels accept keyboard focus without activating the app and already
      // join all Spaces, including fullscreen. setVisibleOnAllWorkspaces would
      // additionally transform the app's process type and disturb other windows.
      if (platform !== 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      win.on('blur', () => {
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
      try {
        record.loading = win.loadURL(launcherUrl(id))
        await record.loading
      } catch (error) {
        record.win = null
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
    if (record.win && !record.win.isDestroyed()) record.win.destroy()
  }

  async function control({ pluginId, action, path } = {}) {
    const record = requireRecord(pluginId)
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
      if (typeof path !== 'string' || !isAbsolute(path))
        throw new Error('需要文件或文件夹的绝对路径')
      const info = await stat(path)
      if (!info.isFile() && !info.isDirectory()) throw new Error('只能打开文件或文件夹')
      await deliver({ type: 'openPath', path })
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
