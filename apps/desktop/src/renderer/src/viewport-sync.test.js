import { describe, expect, it } from 'bun:test'
import { syncVisualViewport } from './viewport-sync'

function browser() {
  const properties = new Map()
  const frames = new Map()
  let nextFrame = 0
  let now = 0
  let writes = 0
  let scrolls = 0
  const scrollEvents = []
  const viewport = Object.assign(new EventTarget(), { height: 852, scale: 1, offsetTop: 0 })
  const win = Object.assign(new EventTarget(), {
    visualViewport: viewport,
    innerHeight: 852,
    scrollX: 0,
    scrollY: 0,
    matchMedia: () => ({ matches: true }),
    performance: { now: () => now },
    requestAnimationFrame: (callback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    scrollTo: ({ left, top }) => {
      scrolls++
      win.scrollX = left
      win.scrollY = top
      scrollEvents.push(() => {
        win.dispatchEvent(new Event('scroll'))
        viewport.dispatchEvent(new Event('scroll'))
      })
    }
  })
  const doc = Object.assign(new EventTarget(), {
    activeElement: { matches: () => false },
    documentElement: {
      clientHeight: 852,
      style: {
        setProperty: (name, value) => {
          writes++
          properties.set(name, value)
        },
        removeProperty: (name) => properties.delete(name)
      }
    }
  })
  return {
    win,
    doc,
    viewport,
    properties,
    frames,
    get writes() {
      return writes
    },
    get scrolls() {
      return scrolls
    },
    focus() {
      doc.activeElement = { tagName: 'TEXTAREA' }
      doc.dispatchEvent(new Event('focusin'))
    },
    flushScrollEvents() {
      scrollEvents.splice(0).forEach((event) => event())
    },
    advance(ms) {
      now += ms
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach((callback) => callback(now))
    }
  }
}

describe('syncVisualViewport', () => {
  it('starts keyboard synchronization when tapping an already focused editor without a new focus event', () => {
    const b = browser()
    const dispose = syncVisualViewport(b.win, b.doc)
    b.focus()
    b.advance(1000)
    expect(b.frames.size).toBe(0)

    // 会话自动聚焦时未弹键盘；之后点击不会再有 focusin 或及时的 viewport 事件。
    b.doc.dispatchEvent(new Event('pointerdown'))
    b.viewport.height = 420
    b.viewport.offsetTop = 100
    b.win.scrollY = 432
    b.advance(16)
    expect(b.properties.get('--vvh')).toBe('420px')
    expect(b.properties.get('--vvh-top')).toBe('100px')
    expect(b.win.scrollY).toBe(0)
    dispose()
  })

  it('resynchronizes when the same focused input reopens the keyboard after dismissal', () => {
    const b = browser()
    const dispose = syncVisualViewport(b.win, b.doc)
    b.focus()
    b.viewport.height = 420
    b.advance(16)
    b.viewport.height = 852
    b.viewport.dispatchEvent(new Event('resize'))
    b.advance(1000)
    expect(b.properties.get('--vvh')).toBe('852px')
    expect(b.frames.size).toBe(0)

    b.doc.dispatchEvent(new Event('pointerdown'))
    b.viewport.height = 420
    b.advance(16)
    expect(b.properties.get('--vvh')).toBe('420px')
    dispose()
  })

  it('continues checking when a long press opens the keyboard on release', () => {
    const b = browser()
    const dispose = syncVisualViewport(b.win, b.doc)
    b.focus()
    b.doc.dispatchEvent(new Event('pointerdown'))
    b.advance(1500)
    expect(b.frames.size).toBe(0)
    b.doc.dispatchEvent(new Event('pointerup'))
    b.viewport.height = 420
    b.advance(16)
    expect(b.properties.get('--vvh')).toBe('420px')
    dispose()
  })

  it('ignores pointer gestures without an editor and on desktop', () => {
    for (const mode of ['no-editor', 'desktop']) {
      const b = browser()
      const dispose = syncVisualViewport(b.win, b.doc)
      if (mode === 'desktop') {
        b.focus()
        b.advance(1000)
        b.win.matchMedia = () => ({ matches: false })
      }
      b.doc.dispatchEvent(new Event('pointerdown'))
      b.doc.dispatchEvent(new Event('pointerup'))
      expect(b.frames.size).toBe(0)
      dispose()
    }
  })

  it('corrects document scrolling after focus even without a visual viewport event', () => {
    const b = browser()
    const dispose = syncVisualViewport(b.win, b.doc)
    b.focus()
    b.viewport.height = 420
    b.win.scrollY = 432
    b.win.dispatchEvent(new Event('scroll'))
    expect(b.win.scrollY).toBe(0)
    expect(b.scrolls).toBe(1)
    dispose()
  })

  it('follows delayed keyboard geometry and page scrolling without another user gesture', () => {
    const b = browser()
    const dispose = syncVisualViewport(b.win, b.doc)
    b.focus()
    b.advance(100)
    b.viewport.height = 420
    b.viewport.offsetTop = 100
    b.win.scrollY = 432
    b.advance(16)
    expect(b.properties.get('--vvh')).toBe('420px')
    expect(b.properties.get('--vvh-top')).toBe('100px')
    expect(b.win.scrollY).toBe(0)
    // 键盘完全收起前，focusout 时读到的值仍可能是旧的。
    b.doc.activeElement = { matches: () => false }
    b.doc.dispatchEvent(new Event('focusout'))
    b.viewport.height = 852
    b.viewport.offsetTop = 0
    b.advance(300)
    expect(b.properties.get('--vvh')).toBe('852px')
    expect(b.properties.has('--vvh-top')).toBe(false)
    dispose()
  })

  it('uses layout height changes when visualViewport stays stale', () => {
    const b = browser()
    const dispose = syncVisualViewport(b.win, b.doc)
    b.focus()
    b.win.innerHeight = 420
    b.advance(16)
    expect(b.properties.get('--vvh')).toBe('420px')
    dispose()
  })

  it('keeps native focus scrolling until the keyboard is included in the app height', () => {
    const b = browser()
    const dispose = syncVisualViewport(b.win, b.doc)
    b.focus()
    b.win.scrollY = 432
    b.win.dispatchEvent(new Event('scroll'))
    expect(b.win.scrollY).toBe(432)
    expect(b.scrolls).toBe(0)
    b.viewport.height = 420
    b.advance(16)
    expect(b.win.scrollY).toBe(0)
    dispose()
  })

  it('remembers the unfocused height when both layout height signals shrink', () => {
    const b = browser()
    const dispose = syncVisualViewport(b.win, b.doc)
    b.focus()
    b.win.innerHeight = 420
    b.doc.documentElement.clientHeight = 420
    b.viewport.offsetTop = 352
    b.win.scrollY = 432
    b.advance(16)
    expect(b.properties.get('--vvh')).toBe('420px')
    expect(b.properties.get('--vvh-top')).toBe('352px')
    expect(b.win.scrollY).toBe(0)
    b.doc.activeElement = null
    b.doc.dispatchEvent(new Event('focusout'))
    b.advance(100)
    expect(b.properties.get('--vvh-top')).toBe('352px')
    dispose()
  })

  it('preserves pinch zoom panning, desktop scrolling, and scrolling without an editor', () => {
    for (const mode of ['zoom', 'desktop', 'no-editor']) {
      const b = browser()
      const dispose = syncVisualViewport(b.win, b.doc)
      if (mode !== 'no-editor') b.focus()
      b.viewport.height = 420
      if (mode === 'zoom') {
        b.viewport.scale = 2
        b.viewport.height = 210
      }
      if (mode === 'desktop') b.win.matchMedia = () => ({ matches: false })
      b.win.scrollY = 100
      b.win.dispatchEvent(new Event('scroll'))
      expect(b.win.scrollY).toBe(100)
      expect(b.scrolls).toBe(0)
      dispose()
    }
  })

  it('corrects late dismissal scrolling only during the bounded keyboard restoration', () => {
    const b = browser()
    const dispose = syncVisualViewport(b.win, b.doc)
    b.focus()
    b.viewport.height = 420
    b.win.scrollY = 432
    b.advance(16)
    b.doc.activeElement = null
    b.doc.dispatchEvent(new Event('focusout'))
    b.viewport.height = 852
    b.win.scrollY = 100
    b.advance(300)
    expect(b.win.scrollY).toBe(0)
    b.advance(1000)
    b.win.scrollY = 50
    b.win.dispatchEvent(new Event('scroll'))
    expect(b.win.scrollY).toBe(50)
    dispose()
  })

  it('does not treat readonly inputs and non-text controls as keyboard editors', () => {
    for (const element of [
      { tagName: 'INPUT', type: 'checkbox' },
      { tagName: 'INPUT', type: 'range' },
      { tagName: 'INPUT', type: 'text', readOnly: true },
      { tagName: 'TEXTAREA', disabled: true }
    ]) {
      const b = browser()
      const dispose = syncVisualViewport(b.win, b.doc)
      b.doc.activeElement = element
      b.viewport.height = 420
      b.win.scrollY = 100
      b.doc.dispatchEvent(new Event('focusin'))
      expect(b.win.scrollY).toBe(100)
      dispose()
    }
  })

  it('settles after asynchronous scroll events caused by correction and repeated browser scrolling', () => {
    const b = browser()
    const dispose = syncVisualViewport(b.win, b.doc)
    b.focus()
    b.viewport.height = 420
    for (let i = 0; i < 3; i++) {
      b.win.scrollY = 432
      b.advance(16)
      b.flushScrollEvents()
      expect(b.win.scrollY).toBe(0)
      expect(b.frames.size).toBe(1)
    }
    expect(b.scrolls).toBe(3)
    b.advance(1000)
    expect(b.frames.size).toBe(0)
    dispose()
  })

  it('coalesces animation frames, avoids redundant writes, and stops after settling', () => {
    const b = browser()
    const dispose = syncVisualViewport(b.win, b.doc)
    b.focus()
    b.viewport.dispatchEvent(new Event('resize'))
    b.win.dispatchEvent(new Event('resize'))
    expect(b.frames.size).toBe(1)
    const writes = b.writes
    b.advance(500)
    expect(b.frames.size).toBe(1)
    b.advance(500)
    expect(b.frames.size).toBe(0)
    expect(b.writes).toBe(writes)
    dispose()
  })

  it('cleans up animation frames, listeners, and viewport overrides on unmount', () => {
    const b = browser()
    const dispose = syncVisualViewport(b.win, b.doc)
    b.focus()
    dispose()
    expect(b.frames.size).toBe(0)
    expect(b.properties.size).toBe(0)
    for (const [target, events] of [
      [b.win, ['resize', 'scroll', 'orientationchange']],
      [b.viewport, ['resize', 'scroll']],
      [b.doc, ['focusin', 'focusout', 'pointerdown', 'pointerup']]
    ]) {
      events.forEach((event) => target.dispatchEvent(new Event(event)))
    }
    expect(b.frames.size).toBe(0)
    expect(b.properties.size).toBe(0)
  })

  it('leaves browsers without visualViewport on the CSS fallback', () => {
    const b = browser()
    b.win.visualViewport = null
    expect(syncVisualViewport(b.win, b.doc)).toBeUndefined()
    expect(b.properties.size).toBe(0)
    expect(b.frames.size).toBe(0)
  })
})
