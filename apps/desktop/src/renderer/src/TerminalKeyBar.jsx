import { useCallback, useEffect, useRef, useState } from 'react'
import { TERMINAL_KEYS, readClipboardText } from './terminal-keys'

const HINT_MS = 2600
const PASTE_MISSING_HINT = '无法读取剪贴板，请用系统键盘的「粘贴」'

/**
 * 移动端终端功能键栏，贴在终端下方。
 *
 * 两条硬约束：
 * 1. 按下不能抢走终端的焦点——软键盘是挂在 xterm 的隐藏 textarea 上的，一旦失焦
 *    键盘就收起来，键栏本身也跟着被键盘挡住的位置一起消失。所以在 pointerdown
 *    （以及兼容鼠标事件 mousedown）上 preventDefault，动作留给 click：这样还能顺带
 *    避免「想横向滚动键栏，结果手指落点被当成一次按键」。
 * 2. 键栏会在键盘弹起时被顶到键盘上沿，靠的是根容器的可见高度跟随 visualViewport
 *    （见 hooks.js 的 useVisualViewportHeight），本身不需要再处理键盘高度。
 */
export default function TerminalKeyBar({ onSend }) {
  const [hint, setHint] = useState(null)
  const hintTimerRef = useRef(null)

  useEffect(
    () => () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    },
    []
  )

  const showHint = useCallback((text) => {
    setHint(text)
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    hintTimerRef.current = setTimeout(() => setHint(null), HINT_MS)
  }, [])

  const keepTerminalFocus = useCallback((event) => event.preventDefault(), [])

  const handlePaste = useCallback(() => {
    readClipboardText().then((text) => {
      if (text) onSend(text)
      else showHint(PASTE_MISSING_HINT)
    })
  }, [onSend, showHint])

  const buttonClass =
    'flex h-7 min-w-9 shrink-0 items-center justify-center rounded-md border border-line bg-panel-hi px-2 font-mono text-xs text-white/70 active:bg-active active:text-white'

  return (
    <div
      className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-t border-line bg-panel px-2"
      role="toolbar"
      aria-label="终端功能键"
    >
      {hint ? (
        <span className="truncate text-xs text-white/45">{hint}</span>
      ) : (
        <>
          {TERMINAL_KEYS.map((key) => (
            <button
              key={key.id}
              type="button"
              title={key.title}
              aria-label={key.title}
              className={buttonClass}
              onPointerDown={keepTerminalFocus}
              onMouseDown={keepTerminalFocus}
              onClick={() => onSend(key.data)}
            >
              {key.label}
            </button>
          ))}
          <button
            type="button"
            title="粘贴剪贴板内容"
            aria-label="粘贴剪贴板内容"
            className={buttonClass}
            onPointerDown={keepTerminalFocus}
            onMouseDown={keepTerminalFocus}
            onClick={handlePaste}
          >
            粘贴
          </button>
        </>
      )}
    </div>
  )
}
