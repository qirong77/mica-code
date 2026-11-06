import { describe, expect, it } from 'bun:test'
import { attachComposerCursor, showComposerCursor } from './composer-cursor'

const visible = { focused: true, windowFocused: true, composing: false, start: 2, end: 2 }

describe('composer cursor', () => {
  it('only shows for a focused collapsed selection outside composition', () => {
    expect(showComposerCursor(visible)).toBe(true)
    for (const changed of [
      { focused: false },
      { windowFocused: false },
      { composing: true },
      { end: 3 }
    ]) {
      expect(showComposerCursor({ ...visible, ...changed })).toBe(false)
    }
  })

  it('measures the complete native text, follows scrolling and restores native caret on cleanup', () => {
    const document = new EventTarget()
    const window = new EventTarget()
    const textarea = new EventTarget()
    let pending
    let disconnected = false
    let removed = false
    let rangePosition
    const text = { data: '' }
    const mirror = {
      style: {},
      setAttribute() {},
      appendChild() {},
      getBoundingClientRect: () => ({ left: 10, top: 10 }),
      remove() {
        removed = true
      }
    }
    Object.assign(window, {
      requestAnimationFrame: (callback) => {
        pending = callback
        return 1
      },
      cancelAnimationFrame: () => {
        pending = null
      },
      getComputedStyle: () => ({ font: '13px monospace', lineHeight: '20px' }),
      ResizeObserver: class {
        observe() {}
        disconnect() {
          disconnected = true
        }
      }
    })
    Object.assign(document, {
      defaultView: window,
      hasFocus: () => true,
      activeElement: textarea,
      createElement: () => mirror,
      createTextNode: () => text,
      createRange: () => ({
        setStart: (node, position) => {
          rangePosition = position
        },
        collapse() {},
        getBoundingClientRect: () => ({ left: 50, top: 50, height: 16 })
      })
    })
    Object.assign(textarea, {
      ownerDocument: document,
      style: { caretColor: '' },
      value: 'before\n你好 👩‍💻 after',
      selectionStart: 9,
      selectionEnd: 9,
      clientWidth: 200,
      scrollLeft: 4,
      scrollTop: 20
    })
    const animation = { currentTime: 500 }
    const cursor = {
      style: {},
      hidden: true,
      parentNode: { appendChild() {} },
      getAnimations: () => [animation]
    }
    const controller = attachComposerCursor(textarea, cursor)
    pending()
    expect(text.data).toBe(`${textarea.value}\u200b`)
    expect(rangePosition).toBe(9)
    expect(cursor.style).toMatchObject({ transform: 'translate(36px, 18px)', height: '20px' })
    expect(cursor.hidden).toBe(false)
    expect(animation.currentTime).toBe(0)
    expect(textarea.style.caretColor).toBe('transparent')

    textarea.dispatchEvent(new Event('compositionstart'))
    expect(cursor.hidden).toBe(true)
    expect(textarea.style.caretColor).toBe('')
    textarea.dispatchEvent(new Event('compositionend'))
    pending()
    expect(cursor.hidden).toBe(false)

    textarea.selectionEnd = 12
    document.dispatchEvent(new Event('selectionchange'))
    pending()
    expect(cursor.hidden).toBe(true)
    textarea.selectionEnd = 9
    controller.sync()
    pending()
    window.dispatchEvent(new Event('blur'))
    expect(cursor.hidden).toBe(true)

    controller.sync()
    controller.dispose()
    expect(removed).toBe(true)
    expect(disconnected).toBe(true)
    expect(pending).toBe(null)
    expect(textarea.style.caretColor).toBe('')
    textarea.dispatchEvent(new Event('input'))
    expect(pending).toBe(null)
  })
})
