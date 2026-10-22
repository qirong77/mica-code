import { useEffect, useRef, useState } from 'react'

/**
 * 单行文本输入弹窗（新建文件、重命名、新建分组…）。
 *
 * 主应用与独立文件窗口共用这一份：`onClose` 收的是去掉首尾空白的输入，取消/关闭/Esc 收
 * `null`，调用方据此决定要不要真的动手。Esc 与 Cmd/Ctrl+W 都当取消——后者在 macOS 上是
 * 「关窗」，别让它落到窗口自己身上把整个窗口关掉。
 */
export function TextPrompt({ prompt, onClose }) {
  const [value, setValue] = useState(prompt.initial)
  const inputRef = useRef(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const submit = () => onClose(value.trim())
  return (
    <div
      className="fixed inset-0 z-[11000] grid place-items-center bg-black/45 backdrop-blur-[4px] no-drag"
      onClick={(event) => event.target === event.currentTarget && onClose(null)}
    >
      <section
        role="dialog"
        aria-modal="true"
        className="w-[min(420px,calc(100vw-32px))] rounded-md border border-line bg-panel/98 p-3.5 shadow-2xl"
      >
        <h2 className="mb-1.5 text-sm font-semibold text-white/95">{prompt.title}</h2>
        {prompt.hint && <p className="mb-3 text-xs leading-5 text-white/45">{prompt.hint}</p>}
        <input
          ref={inputRef}
          value={value}
          spellCheck={false}
          className="mb-3 h-8 w-full rounded-sm border border-white/15 bg-white/[.04] px-2.5 text-[13px] text-white focus:border-white/30"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'w') {
              event.preventDefault()
              onClose(null)
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose(null)
            }
          }}
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="h-7 min-w-16 rounded-sm px-3 text-xs text-white/65 hover:bg-white/[.06] hover:text-white"
            onClick={() => onClose(null)}
          >
            取消
          </button>
          <button
            type="button"
            className="h-7 min-w-16 rounded-sm border border-line bg-white/[.06] px-3 text-xs text-white hover:bg-white/10"
            onClick={submit}
          >
            确定
          </button>
        </div>
      </section>
    </div>
  )
}
