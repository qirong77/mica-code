import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  EDITOR_PARAM,
  createEditorWindows,
  editorWindowUrl,
  resolveEditorTarget
} from './editor-window.js'

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mica-editor-window-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

class FakeWindow extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.destroyed = false
    this.visible = false
    this.urls = []
    this.calls = []
    this.webContents = new EventEmitter()
    this.webContents.setWindowOpenHandler = (handler) => {
      this.windowOpenHandler = handler
    }
  }
  async loadURL(url) {
    this.urls.push(url)
  }
  isDestroyed() {
    return this.destroyed
  }
  isMinimized() {
    return false
  }
  show() {
    this.visible = true
    this.calls.push('show')
  }
  focus() {
    this.calls.push('focus')
  }
  destroy() {
    this.destroyed = true
    this.emit('closed')
  }
  emitReady() {
    this.emit('ready-to-show')
  }
}

function fixture({ pageUrl = 'http://127.0.0.1:8787/?layout=desktop' } = {}) {
  const created = []
  class Window extends FakeWindow {
    constructor(options) {
      super(options)
      created.push(this)
    }
  }
  const controller = createEditorWindows({
    BrowserWindow: Window,
    pageUrl: () => pageUrl,
    webPreferences: { preload: '/tmp/preload.js', sandbox: true },
    backgroundColor: () => '#101010',
    platform: 'darwin',
    openExternal: () => {},
    onError: () => {}
  })
  return { controller, created }
}

describe('editor window url', () => {
  test('keeps the page query and carries the target', () => {
    const url = new URL(editorWindowUrl('http://h:1/?layout=desktop', '/tmp/中文 file.md'))
    expect(url.origin).toBe('http://h:1')
    expect(url.searchParams.get('layout')).toBe('desktop')
    expect(url.searchParams.get(EDITOR_PARAM)).toBe('/tmp/中文 file.md')
  })
})

describe('resolveEditorTarget', () => {
  test('accepts an existing file or directory', async () => {
    const file = join(home, 'a.md')
    writeFileSync(file, 'x')
    expect(await resolveEditorTarget(file)).toBe(file)
    expect(await resolveEditorTarget(home)).toBe(home)
  })

  test('rejects relative and missing targets', async () => {
    await expect(resolveEditorTarget('a.md')).rejects.toThrow('绝对路径')
    await expect(resolveEditorTarget('')).rejects.toThrow('绝对路径')
    await expect(resolveEditorTarget(join(home, 'missing.md'))).rejects.toThrow()
  })
})

describe('createEditorWindows', () => {
  test('loads the page with ?editor= and shows the window on first paint', () => {
    const { controller, created } = fixture()
    const target = join(home, 'notes')
    const win = controller.open(target)
    expect(created).toHaveLength(1)
    expect(win.options.webPreferences.sandbox).toBe(true)
    expect(win.options.titleBarStyle).toBe('hidden')
    expect(win.options.title).toBe(`notes — Mica`)
    expect(new URL(win.urls[0]).searchParams.get(EDITOR_PARAM)).toBe(target)
    expect(win.visible).toBe(false)
    win.emitReady()
    expect(win.visible).toBe(true)
    expect(controller.size).toBe(1)
  })

  test('reuses the window of the same path and opens another for a different one', () => {
    const { controller, created } = fixture()
    const first = controller.open(join(home, 'a'))
    controller.open(join(home, 'a'))
    expect(created).toHaveLength(1)
    expect(first.calls).toEqual(['show', 'focus'])
    const second = controller.open(join(home, 'b'))
    expect(created).toHaveLength(2)
    expect(second).not.toBe(first)
  })

  test('closing a window forgets it so the path can be opened again', () => {
    const { controller, created } = fixture()
    const target = join(home, 'a')
    const win = controller.open(target)
    win.destroy()
    expect(controller.size).toBe(0)
    expect(controller.hasContents(win.webContents)).toBe(false)
    controller.open(target)
    expect(created).toHaveLength(2)
  })

  test('tracks its own contents and refuses to open before the page exists', () => {
    const { controller } = fixture()
    const win = controller.open(join(home, 'a'))
    expect(controller.hasContents(win.webContents)).toBe(true)
    expect(controller.hasContents(new EventEmitter())).toBe(false)
    const late = fixture({ pageUrl: '' }).controller
    expect(() => late.open(join(home, 'a'))).toThrow('本机页面还没准备好')
  })

  test('keeps external links out of the window and destroys everything on close', () => {
    const { controller, created } = fixture()
    const win = controller.open(join(home, 'a'))
    controller.open(join(home, 'b'))
    const blocked = win.windowOpenHandler({ url: 'https://example.com' })
    expect(blocked).toEqual({ action: 'deny' })
    controller.close()
    expect(created.every((item) => item.destroyed)).toBe(true)
    expect(controller.size).toBe(0)
  })
})
