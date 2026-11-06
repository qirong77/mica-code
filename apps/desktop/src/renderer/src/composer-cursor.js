const MIRROR_PROPERTIES = [
  'font',
  'letterSpacing',
  'lineHeight',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'textAlign',
  'textIndent',
  'textTransform',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
  'tabSize',
  'direction'
]

export function showComposerCursor({ focused, windowFocused, composing, start, end }) {
  return focused && windowFocused && !composing && start === end
}

export function attachComposerCursor(textarea, cursor) {
  const document = textarea.ownerDocument
  const window = document.defaultView
  const mirror = document.createElement('div')
  mirror.className = 'chat-composer-cursor-measure'
  mirror.setAttribute('aria-hidden', 'true')
  const text = document.createTextNode('')
  mirror.appendChild(text)
  cursor.parentNode.appendChild(mirror)
  const range = document.createRange()
  let composing = false
  let frame = null
  let disposed = false
  const nativeCaretColor = textarea.style.caretColor

  const hide = () => {
    cursor.hidden = true
    textarea.style.caretColor = nativeCaretColor
  }

  const sync = () => {
    frame = null
    if (disposed) return
    if (
      !showComposerCursor({
        focused: document.activeElement === textarea,
        windowFocused: document.hasFocus(),
        composing,
        start: textarea.selectionStart,
        end: textarea.selectionEnd
      })
    ) {
      hide()
      return
    }

    const styles = window.getComputedStyle(textarea)
    for (const property of MIRROR_PROPERTIES) mirror.style[property] = styles[property]
    mirror.style.width = `${textarea.clientWidth}px`
    // Keep the suffix for identical wrapping; the sentinel gives empty/final lines a caret rect.
    text.data = `${textarea.value}\u200b`
    range.setStart(text, textarea.selectionStart)
    range.collapse(true)
    const rect = range.getBoundingClientRect()
    if (!rect.height) {
      hide()
      return
    }
    const origin = mirror.getBoundingClientRect()
    const height = Number.parseFloat(styles.lineHeight) || rect.height
    const left = Math.max(
      0,
      Math.min(textarea.clientWidth - 1.8, rect.left - origin.left - textarea.scrollLeft)
    )
    const top = rect.top - origin.top - textarea.scrollTop - (height - rect.height) / 2
    cursor.style.transform = `translate(${left}px, ${top}px)`
    cursor.style.height = `${height}px`
    cursor.hidden = false
    for (const animation of cursor.getAnimations()) animation.currentTime = 0
    textarea.style.caretColor = 'transparent'
  }

  const schedule = () => {
    if (!disposed && frame === null) frame = window.requestAnimationFrame(sync)
  }
  const onCompositionStart = () => {
    composing = true
    hide()
  }
  const onCompositionEnd = () => {
    composing = false
    schedule()
  }
  const onBlur = () => {
    composing = false
    hide()
  }
  const listeners = [
    ...['input', 'select', 'keyup', 'pointerup', 'scroll', 'focus'].map((event) => [
      textarea,
      event,
      schedule
    ]),
    [textarea, 'blur', onBlur],
    [textarea, 'compositionstart', onCompositionStart],
    [textarea, 'compositionend', onCompositionEnd],
    [document, 'selectionchange', schedule],
    [window, 'focus', schedule],
    [window, 'blur', hide],
    [window, 'resize', schedule]
  ]
  for (const [target, event, handler] of listeners) target.addEventListener(event, handler)
  const observer = new window.ResizeObserver(schedule)
  observer.observe(textarea)
  document.fonts?.addEventListener('loadingdone', schedule)
  schedule()

  return {
    sync: schedule,
    dispose() {
      disposed = true
      if (frame !== null) window.cancelAnimationFrame(frame)
      for (const [target, event, handler] of listeners) target.removeEventListener(event, handler)
      observer.disconnect()
      document.fonts?.removeEventListener('loadingdone', schedule)
      hide()
      mirror.remove()
    }
  }
}
