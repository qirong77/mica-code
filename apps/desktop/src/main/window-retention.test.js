import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { REMOTE_WINDOW_RETENTION_MS, retainHiddenWindow } from './window-retention.js'

function fixture() {
  let now = 0
  let sequence = 0
  const timers = new Map()
  const win = Object.assign(new EventEmitter(), {
    visible: true,
    destroyed: false,
    destroys: 0,
    isVisible() {
      return this.visible
    },
    isDestroyed() {
      return this.destroyed
    },
    hide() {
      this.visible = false
      this.emit('hide')
    },
    show() {
      this.visible = true
      this.emit('show')
    },
    destroy() {
      this.destroyed = true
      this.destroys++
      this.emit('closed')
    }
  })
  const dispose = retainHiddenWindow(win, {
    schedule: (callback, ms) => {
      const id = ++sequence
      timers.set(id, { at: now + ms, callback })
      return id
    },
    cancel: (id) => timers.delete(id)
  })
  const advance = (ms) => {
    now += ms
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now && timers.delete(id)) timer.callback()
    }
  }
  return { win, timers, advance, dispose }
}

describe('remote runtime window retention', () => {
  test('visible windows have no expiry, hidden windows survive until exactly two hours', () => {
    const { win, timers, advance } = fixture()
    expect(REMOTE_WINDOW_RETENTION_MS).toBe(7_200_000)
    advance(REMOTE_WINDOW_RETENTION_MS * 3)
    expect(win.destroys).toBe(0)
    expect(timers.size).toBe(0)
    win.hide()
    advance(REMOTE_WINDOW_RETENTION_MS - 1)
    expect(win.destroys).toBe(0)
    advance(1)
    expect(win.destroys).toBe(1)
    expect(timers.size).toBe(0)
  })

  test('showing cancels expiry and the next hide gets a fresh two hours', () => {
    const { win, timers, advance } = fixture()
    win.hide()
    advance(REMOTE_WINDOW_RETENTION_MS - 1)
    win.show()
    expect(timers.size).toBe(0)
    advance(REMOTE_WINDOW_RETENTION_MS)
    expect(win.destroys).toBe(0)
    win.hide()
    advance(REMOTE_WINDOW_RETENTION_MS - 1)
    expect(win.destroys).toBe(0)
    advance(1)
    expect(win.destroys).toBe(1)
  })

  test('repeated hide or close does not extend the hidden period', () => {
    const { win, advance } = fixture()
    win.hide()
    advance(REMOTE_WINDOW_RETENTION_MS - 1)
    win.hide()
    advance(1)
    expect(win.destroys).toBe(1)
  })

  test('closing or disposing clears timers and event subscriptions', () => {
    for (const action of ['closed', 'dispose']) {
      const { win, timers, advance, dispose } = fixture()
      win.hide()
      if (action === 'closed') win.destroy()
      else dispose()
      expect(timers.size).toBe(0)
      expect(win.listenerCount('show')).toBe(0)
      expect(win.listenerCount('hide')).toBe(0)
      advance(REMOTE_WINDOW_RETENTION_MS)
      expect(win.destroys).toBe(action === 'closed' ? 1 : 0)
    }
  })

  test('expiry checks actual visibility before destroying a window', () => {
    const { win, advance } = fixture()
    win.hide()
    // A queued show event must not let an old timer destroy a visible window.
    win.visible = true
    advance(REMOTE_WINDOW_RETENTION_MS)
    expect(win.destroys).toBe(0)
  })
})
