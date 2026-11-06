import { useLayoutEffect, useRef } from 'react'
import { attachComposerCursor } from './composer-cursor'

function ComposerCursor({ textareaRef, value }) {
  const cursorRef = useRef(null)
  const controllerRef = useRef(null)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return undefined
    const controller = attachComposerCursor(textarea, cursorRef.current)
    controllerRef.current = controller
    return () => {
      controller.dispose()
      controllerRef.current = null
    }
  }, [textareaRef])

  useLayoutEffect(() => {
    controllerRef.current?.sync()
  }, [value])

  return <span ref={cursorRef} className="chat-composer-cursor" aria-hidden="true" hidden />
}

export default function ChatComposer({
  value,
  placeholder,
  textareaRef,
  onChange,
  onKeyDown,
  onPaste,
  onFocus
}) {
  return (
    <div className="chat-composer-input">
      <textarea
        ref={textareaRef}
        value={value}
        placeholder={placeholder}
        rows={1}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        aria-label="对话输入"
        onChange={(event) => onChange?.(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          onKeyDown?.(event)
        }}
        onFocus={onFocus}
        onPaste={onPaste}
      />
      <ComposerCursor textareaRef={textareaRef} value={value} />
    </div>
  )
}
