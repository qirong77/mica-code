import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPluginLaunchers } from './plugin-launchers.js'

const cleanups = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

function fixture({ occupied = false, load, platform = 'darwin', webContent, pageUrl = 'http://127.0.0.1:8787/?existing=1' } = {}) {
  let shortcutOccupied = occupied
  const home = mkdtempSync(join(tmpdir(), 'mica-launcher-test-'))
  const disabled = new Set()
  const bindings = new Map()
  const windows = []
  const views = []
  const delivered = []
  const opened = []
  class Window extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.calls = []
      this.webContents = new EventEmitter()
      this.webContents.setWindowOpenHandler = () => {}
      this.webContents.getURL = () => this.url
      this.webContents.executeJavaScript = async (script) => { this.script = script }
      this.contentView = {
        addChildView: (view) => { this.view = view },
        removeChildView: (view) => { if (this.view === view) this.view = null }
      }
      windows.push(this)
    }
    setVisibleOnAllWorkspaces(...args) {
      this.calls.push(['setVisibleOnAllWorkspaces', ...args])
    }
    async loadURL(url) {
      this.url = url
      await load?.()
    }
    isDestroyed() {
      return this.destroyed === true
    }
    isVisible() {
      return this.visible === true
    }
    isFocused() {
      return this.visible === true
    }
    destroy() {
      this.destroyed = true
    }
    hide() {
      this.calls.push(['hide'])
      this.visible = false
    }
    show() {
      this.calls.push(['show'])
      this.visible = true
    }
    focus() {
      this.calls.push(['focus'])
    }
    getSize() {
      return [720, 480]
    }
    getContentSize() { return this.contentSize || [720, 480] }
    setPosition(x, y) {
      this.position = [x, y]
    }
  }
  class View {
    constructor(options) {
      this.options = options
      const wc = this.webContents = new EventEmitter()
      wc.session = {
        setPermissionRequestHandler: (fn) => { this.permissionRequest = fn },
        setPermissionCheckHandler: (fn) => { this.permissionCheck = fn },
        webRequest: { onBeforeRequest: (fn) => { this.request = fn } }
      }
      wc.navigationHistory = {
        canGoBack: () => !!this.backAvailable, canGoForward: () => !!this.forwardAvailable,
        goBack: () => { this.wentBack = true }, goForward: () => { this.wentForward = true }
      }
      wc.isDestroyed = () => !!this.destroyed
      wc.close = () => { this.destroyed = true }
      wc.isLoading = () => !!this.loading
      wc.getURL = () => this.url || ''
      wc.loadURL = async (url) => { this.url = url; wc.emit('did-navigate') }
      wc.reload = () => { this.reloaded = true }
      wc.setWindowOpenHandler = (fn) => { this.open = fn }
      views.push(this)
    }
    setBounds(bounds) { this.bounds = bounds }
  }
  const controller = createPluginLaunchers({
    manifests: [
      {
        id: 'sample',
        desktopLauncher: { title: 'Sample', shortcut: 'Alt+Space', width: 720, height: 480, ...(webContent ? { webContent } : {}) }
      }
    ],
    statePath: join(home, 'state.json'),
    readDisabled: () => disabled,
    BrowserWindow: Window,
    WebContentsView: View,
    globalShortcut: {
      register(key, callback) {
        if (shortcutOccupied) return false
        bindings.set(key, callback)
        return true
      },
      unregister(key) {
        bindings.delete(key)
      }
    },
    screen: {
      getCursorScreenPoint: () => ({ x: -500, y: 500 }),
      getDisplayNearestPoint: () => ({ workArea: { x: -1920, y: 100, width: 1920, height: 1080 } })
    },
    pageUrl,
    backgroundColor: () => '#ffffff',
    platform,
    deliver: async (intent) => {
      delivered.push(intent)
    },
    openEditorWindow: async (target) => {
      opened.push(target)
    },
    onError: () => {}
  })
  cleanups.push(() => {
    controller.close()
    rmSync(home, { recursive: true, force: true })
  })
  const control = (action, values = {}) =>
    controller.control({ pluginId: 'sample', action, ...values })
  return {
    controller,
    control,
    bindings,
    windows,
    views,
    disabled,
    delivered,
    opened,
    home,
    releaseShortcut: () => {
      shortcutOccupied = false
    }
  }
}

describe('manifest desktop launchers', () => {
  test('opens the local Mica runtime like any other HTTP(S) address', async () => {
    const f = fixture({ webContent: { top: 64 }, pageUrl: 'http://localhost:5173/' })
    await f.control('show')
    await f.control('web.navigate', { url: 'http://127.0.0.1:8787/plugins/pages/notebook?note=1' })
    expect(await f.control('web.state')).toMatchObject({ url: 'http://127.0.0.1:8787/plugins/pages/notebook?note=1', home: false })
  })

  test('embeds a sandboxed isolated view, handles navigation and destroys it on disable', async () => {
    const f = fixture({ webContent: { top: 64 } })
    await expect(f.control('web.state')).rejects.toThrow('尚未打开')
    await f.control('show')
    const win = f.windows[0]
    const view = f.views[0]
    expect(win.options.resizable).toBe(true)
    expect(view.options.webPreferences).toEqual({ partition: 'persist:mica-launcher-sample', sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(view.bounds).toEqual({ x: 0, y: 64, width: 720, height: 416 })
    expect(win.view).toBeUndefined()
    expect(await f.control('web.state')).toMatchObject({ url: '', home: true })
    expect(view.permissionCheck()).toBe(false)
    let permission
    view.permissionRequest(null, 'media', (value) => { permission = value })
    expect(permission).toBe(false)
    win.contentSize = [850, 700]
    win.emit('resize')
    expect(view.bounds).toEqual({ x: 0, y: 64, width: 850, height: 636 })
    win.emit('blur')
    expect(win.visible).toBe(true)
    await f.control('web.navigate', { url: 'https://example.com/' })
    expect(await f.control('web.state')).toEqual({ url: 'https://example.com/', home: false, canGoBack: false, canGoForward: false, loading: false })
    expect(win.view).toBe(view)
    expect(win.script).toContain('mica:launcher-web-state')
    view.webContents.emit('page-favicon-updated', {}, ['javascript:alert(1)', 'https://cdn.example/icon.svg?cache=1'])
    expect(await f.control('web.state')).toMatchObject({ faviconUrl: 'https://cdn.example/icon.svg?cache=1' })
    view.webContents.emit('did-start-loading')
    expect((await f.control('web.state')).faviconUrl).toBeUndefined()
    for (const url of ['javascript:alert(1)', 'file:///tmp/a', ' http://example.com', 'http://x:bad', 'http://u:p@example.com']) {
      await expect(f.control('web.navigate', { url })).rejects.toThrow()
    }
    let prevented = false
    view.webContents.emit('will-redirect', { preventDefault: () => { prevented = true } }, 'file:///etc/passwd')
    expect(prevented).toBe(true)
    prevented = false
    view.webContents.emit('will-frame-navigate', { url: 'https://example.com/', preventDefault: () => { prevented = true } })
    expect(prevented).toBe(false)
    view.webContents.emit('will-frame-navigate', { url: 'file:///etc/passwd', preventDefault: () => { prevented = true } })
    expect(prevented).toBe(true)
    expect(view.open({ url: 'https://example.org/' })).toEqual({ action: 'deny' })
    expect(view.url).toBe('https://example.org/')
    view.loading = true
    view.webContents.emit('did-start-loading')
    expect((await f.control('web.state')).loading).toBe(true)
    view.webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://example.org/', true)
    expect((await f.control('web.state')).error).toBe('NAME_NOT_RESOLVED')
    view.loading = false
    view.webContents.emit('did-stop-loading')
    view.backAvailable = view.forwardAvailable = true
    await f.control('web.back'); await f.control('web.forward'); await f.control('web.reload')
    expect([view.wentBack, view.wentForward, view.reloaded]).toEqual([true, true, true])
    await f.control('web.home')
    expect(win.view).toBeNull()
    expect(await f.control('web.state')).toMatchObject({ url: '', home: true })
    f.bindings.get('Alt+Space')()
    expect(win.visible).toBe(false)
    await f.control('show')
    expect(f.views).toHaveLength(1)
    expect(view.url).toBe('https://example.org/')
    f.disabled.add('sample')
    await expect(f.control('web.state')).rejects.toThrow('停用')
    expect(view.destroyed).toBe(true)
  })

  test('rejects web actions on ordinary launchers', async () => {
    const f = fixture()
    await f.control('show')
    await expect(f.control('web.state')).rejects.toThrow('未声明')
  })

  test('registers globally, reuses a sandboxed window and positions on the cursor display', async () => {
    const f = fixture()
    expect(f.bindings.has('Alt+Space')).toBe(true)
    await f.control('show')
    await f.control('show')
    expect(f.windows).toHaveLength(1)
    expect(f.windows[0].url).toContain('pluginLauncher=sample')
    expect(f.windows[0].options.webPreferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
    expect(f.windows[0].position[0]).toBeLessThan(0)
    f.windows[0].emit('blur')
    expect(f.windows[0].visible).toBe(false)
  })

  test('reports shortcut conflicts and still permits opening from settings', async () => {
    const f = fixture({ occupied: true })
    expect(await f.control('status')).toMatchObject({ registered: false })
    expect((await f.control('status')).error).toContain('占用')
    await f.control('show')
    expect(f.windows[0].visible).toBe(true)
    f.releaseShortcut()
    expect(await f.control('retry')).toMatchObject({ registered: true, error: '' })
    expect(f.windows[0].destroyed).not.toBe(true)
  })

  test('macOS uses a nonactivating panel without changing the app process type', async () => {
    const f = fixture()
    await f.control('show')
    const win = f.windows[0]
    expect(win.options.type).toBe('panel')
    expect(win.options.focusable).not.toBe(false)
    expect(win.options.parent).toBeUndefined()
    expect(win.calls).toEqual([['show'], ['focus']])
    await f.control('close')
    f.bindings.get('Alt+Space')()
    await Promise.resolve()
    expect(f.windows).toHaveLength(1)
    expect(win.calls).toEqual([['show'], ['focus'], ['hide'], ['show'], ['focus']])
    win.emit('blur')
    expect(win.isVisible()).toBe(false)
    expect(f.delivered).toEqual([])
  })

  for (const platform of ['win32', 'linux']) {
    test(`${platform} retains the ordinary focusable launcher window`, async () => {
      const f = fixture({ platform })
      await f.control('show')
      const win = f.windows[0]
      expect(win.options.type).toBeUndefined()
      expect(win.calls).toEqual([
        ['setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true }],
        ['show'],
        ['focus']
      ])
    })
  }

  test('does not reshow a pending window after disabling and toggles the visible palette off', async () => {
    let finishLoad
    const f = fixture({
      load: () =>
        new Promise((resolve) => {
          finishLoad = resolve
        })
    })
    const showing = f.control('show')
    f.disabled.add('sample')
    await expect(f.control('status')).rejects.toThrow('停用')
    finishLoad()
    await showing
    expect(f.windows[0].visible).not.toBe(true)
    const ready = fixture()
    await ready.control('show')
    ready.bindings.get('Alt+Space')()
    expect(ready.windows[0].visible).toBe(false)
  })

  test('opens an editor window for an existing file before hiding; rejects missing or relative targets', async () => {
    const f = fixture()
    const path = join(f.home, '中文 file.txt')
    writeFileSync(path, 'hello')
    await f.control('show')
    await f.control('openPath', { path })
    expect(f.opened).toEqual([path])
    expect(f.delivered).toEqual([])
    expect(f.windows[0].visible).toBe(false)
    await expect(f.control('openPath', { path: 'relative.txt' })).rejects.toThrow('绝对路径')
    await expect(f.control('openPath', { path: join(f.home, 'missing') })).rejects.toThrow()
    await f.control('openPath', { path: f.home })
    expect(f.opened.at(-1)).toBe(f.home)
  })

  test('Escape only hides the panel; settings explicitly delivers to the main window', async () => {
    const f = fixture()
    await f.control('show')
    let prevented = false
    f.windows[0].webContents.emit(
      'before-input-event',
      {
        preventDefault: () => {
          prevented = true
        }
      },
      { type: 'keyDown', key: 'Escape' }
    )
    expect(prevented).toBe(true)
    expect(f.windows[0].isVisible()).toBe(false)
    expect(f.delivered).toEqual([])
    await f.control('show')
    await f.control('configure')
    expect(f.delivered).toEqual([{ type: 'configurePlugin', pluginId: 'sample' }])
    expect(f.windows[0].isVisible()).toBe(false)
  })

  test('disabling releases only the owned shortcut and destroys its palette', async () => {
    const f = fixture()
    await f.control('show')
    f.disabled.add('sample')
    await expect(f.control('show')).rejects.toThrow('停用')
    expect(f.bindings.size).toBe(0)
    expect(f.windows[0].destroyed).toBe(true)
    f.disabled.clear()
    await f.control('show')
    expect(f.windows).toHaveLength(2)
    f.controller.close()
    expect(f.bindings.size).toBe(0)
  })
})
