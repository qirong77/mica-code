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

function fixture({ occupied = false, load, platform = 'darwin' } = {}) {
  let shortcutOccupied = occupied
  const home = mkdtempSync(join(tmpdir(), 'mica-launcher-test-'))
  const disabled = new Set()
  const bindings = new Map()
  const windows = []
  const delivered = []
  class Window extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.calls = []
      this.webContents = new EventEmitter()
      this.webContents.setWindowOpenHandler = () => {}
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
    setPosition(x, y) {
      this.position = [x, y]
    }
  }
  const controller = createPluginLaunchers({
    manifests: [
      {
        id: 'sample',
        desktopLauncher: { title: 'Sample', shortcut: 'Alt+Space', width: 720, height: 480 }
      }
    ],
    statePath: join(home, 'state.json'),
    readDisabled: () => disabled,
    BrowserWindow: Window,
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
    pageUrl: 'http://127.0.0.1:8787/?existing=1',
    backgroundColor: () => '#ffffff',
    platform,
    deliver: async (intent) => {
      delivered.push(intent)
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
    disabled,
    delivered,
    home,
    releaseShortcut: () => {
      shortcutOccupied = false
    }
  }
}

describe('manifest desktop launchers', () => {
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

  test('delivers an existing file to the editor before hiding; rejects missing or relative targets', async () => {
    const f = fixture()
    const path = join(f.home, '中文 file.txt')
    writeFileSync(path, 'hello')
    await f.control('show')
    await f.control('openPath', { path })
    expect(f.delivered).toEqual([{ type: 'openPath', path }])
    expect(f.windows[0].visible).toBe(false)
    await expect(f.control('openPath', { path: 'relative.txt' })).rejects.toThrow('绝对路径')
    await expect(f.control('openPath', { path: join(f.home, 'missing') })).rejects.toThrow()
    await f.control('openPath', { path: f.home })
    expect(f.delivered.at(-1).path).toBe(f.home)
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
