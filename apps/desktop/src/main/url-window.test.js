import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { createUrlWindows } from './url-window.js'

class FakeWindow extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.destroyed = false
    this.visible = false
    this.focused = false
    this.urls = []
    this.webContents = {
      setWindowOpenHandler: (handler) => {
        this.windowOpenHandler = handler
      }
    }
  }

  async loadURL(url) {
    this.urls.push(url)
  }

  isDestroyed() {
    return this.destroyed
  }

  show() {
    this.visible = true
  }

  focus() {
    this.focused = true
  }

  destroy() {
    this.destroyed = true
    this.emit('closed')
  }

  close() {
    let prevented = false
    this.emit('close', { preventDefault: () => { prevented = true } })
    if (!prevented) this.destroy()
  }

  emitReady() {
    this.emit('ready-to-show')
  }
}

function fixture() {
  const created = []
  class Window extends FakeWindow {
    constructor(options) {
      super(options)
      created.push(this)
    }
  }
  const external = []
  const controller = createUrlWindows({
    BrowserWindow: Window,
    backgroundColor: () => '#101010',
    openExternal: (url) => external.push(url),
    onError: () => {}
  })
  return { controller, created, external }
}

test('opens an ordinary HTTP(S) window without a preload and shows it when ready', () => {
  const { controller, created } = fixture()
  const win = controller.open('https://example.com/path?q=1')

  assert.equal(created.length, 1)
  assert.equal(win.options.webPreferences.preload, undefined)
  assert.equal(win.options.titleBarStyle, undefined)
  assert.deepEqual(win.urls, ['https://example.com/path?q=1'])
  assert.equal(win.visible, false)
  win.emitReady()
  assert.equal(win.visible, true)
  assert.equal(win.focused, true)
  assert.equal(controller.size, 1)
})

test('does not reuse windows and forgets a window after it is closed', () => {
  const { controller, created } = fixture()
  const first = controller.open('https://example.com/')
  const second = controller.open('https://example.com/')

  assert.equal(created.length, 2)
  assert.notEqual(first, second)
  first.close()
  assert.equal(first.destroyed, true)
  assert.equal(controller.size, 1)
  second.close()
  assert.equal(controller.size, 0)
})

test('does not intercept close, and destroys all outstanding windows on shutdown', () => {
  const { controller, created, external } = fixture()
  const first = controller.open('https://example.com/')
  const second = controller.open('http://example.org/')

  assert.equal(first.listenerCount('close'), 0)
  assert.deepEqual(first.windowOpenHandler({ url: 'https://other.example/' }), { action: 'deny' })
  assert.deepEqual(first.windowOpenHandler({ url: 'mailto:user@example.com' }), { action: 'deny' })
  assert.deepEqual(external, ['https://other.example/', 'mailto:user@example.com'])
  controller.close()
  assert.equal(first.destroyed, true)
  assert.equal(second.destroyed, true)
  assert.equal(controller.size, 0)
})

test('only accepts HTTP(S) addresses', () => {
  const { controller } = fixture()
  for (const value of ['file:///tmp/a', 'javascript:alert(1)', '', 'not a url']) {
    assert.throws(() => controller.open(value), /Only HTTP and HTTPS/)
  }
})
