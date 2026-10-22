import { describe, expect, it } from 'bun:test'
import { createRevealController } from './browser-reveal.js'

function fakeWindow({ visible = false, minimized = false } = {}) {
  const state = { visible, minimized, destroyed: false, opacity: 1, mouseForwarding: true }
  const calls = []
  const win = {
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    showInactive: () => {
      calls.push('showInactive')
      state.visible = true
    },
    hide: () => {
      calls.push('hide')
      state.visible = false
    },
    restore: () => {
      calls.push('restore')
      state.minimized = false
      state.visible = true
    },
    minimize: () => {
      calls.push('minimize')
      state.minimized = true
    },
    setOpacity: (value) => {
      calls.push(`opacity:${value}`)
      state.opacity = value
    },
    setIgnoreMouseEvents: (value) => {
      calls.push(`ignoreMouse:${value}`)
      state.mouseForwarding = !value
    }
  }
  return { win, state, calls }
}

function fakeTimers() {
  const pending = new Map()
  let seq = 0
  return {
    timers: {
      set: (fn) => {
        seq += 1
        pending.set(seq, fn)
        return seq
      },
      clear: (id) => pending.delete(id)
    },
    pending,
    runAll: () => {
      for (const [id, fn] of [...pending]) {
        pending.delete(id)
        fn()
      }
    }
  }
}

describe('createRevealController', () => {
  it('压透明度在显示之前，收起之后再还原，避免闪帧', () => {
    const { win, state, calls } = fakeWindow({ visible: false })
    const controller = createRevealController({ env: {} })
    expect(controller.begin(win)).toEqual({ visible: false, minimized: false })
    expect(calls).toEqual(['opacity:0', 'ignoreMouse:true', 'showInactive'])
    expect(state.opacity).toBe(0)
    controller.flush(win)
    expect(calls).toEqual([
      'opacity:0',
      'ignoreMouse:true',
      'showInactive',
      'hide',
      'ignoreMouse:false',
      'opacity:1'
    ])
    expect(state.visible).toBe(false)
    expect(state.opacity).toBe(1)
  })

  it('一串操作共用同一次露出，只有空闲后才真正收起', () => {
    const { win, calls } = fakeWindow({ visible: false })
    const { timers, pending, runAll } = fakeTimers()
    const controller = createRevealController({ idleMs: 1500, timers })
    controller.begin(win)
    controller.end(win)
    // 空窗期内的第二次操作复用已有露出，不会再来一次 show
    expect(controller.begin(win)).toEqual({ visible: false, minimized: false })
    controller.end(win)
    expect(calls).toEqual(['opacity:0', 'ignoreMouse:true', 'showInactive'])
    expect(pending.size).toBe(1)
    runAll()
    expect(calls.slice(-1)).toEqual(['opacity:1'])
    expect(controller.isRevealed(win)).toBe(false)
  })

  it('嵌套未结束时不会提前收起', () => {
    const { win, calls } = fakeWindow({ visible: false })
    const { timers, pending } = fakeTimers()
    const controller = createRevealController({ timers })
    controller.begin(win)
    controller.begin(win)
    controller.end(win)
    expect(pending.size).toBe(0)
    controller.end(win)
    expect(pending.size).toBe(1)
    expect(calls).not.toContain('hide')
  })

  it('本来就在显示面上时什么都不做', () => {
    const { win, calls } = fakeWindow({ visible: true })
    const controller = createRevealController({ env: {} })
    expect(controller.begin(win)).toBeNull()
    controller.end(win)
    controller.flush(win)
    expect(calls).toEqual([])
  })

  it('最小化窗口还原后再最小化回去', () => {
    const { win, state, calls } = fakeWindow({ visible: true, minimized: true })
    const controller = createRevealController({ env: {} })
    expect(controller.begin(win)).toEqual({ visible: true, minimized: true })
    expect(calls).toEqual(['opacity:0', 'ignoreMouse:true', 'restore'])
    controller.flush(win)
    expect(state.minimized).toBe(true)
    expect(state.opacity).toBe(1)
  })

  it('关掉透明露出时退回可见地显示一下', () => {
    const { win, calls } = fakeWindow({ visible: false })
    const controller = createRevealController({ env: { MICA_BROWSER_REVEAL_OPACITY: '0' } })
    controller.begin(win)
    controller.flush(win)
    expect(calls).toEqual(['showInactive', 'hide'])
  })

  it('窗口已销毁时直接放弃，不抛错', () => {
    const { win } = fakeWindow()
    win.isDestroyed = () => true
    const controller = createRevealController({ env: {} })
    expect(controller.begin(win)).toBeNull()
    expect(() => controller.flush(win)).not.toThrow()
  })
})
