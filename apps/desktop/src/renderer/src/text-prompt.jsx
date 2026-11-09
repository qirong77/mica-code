import { useCallback, useState } from 'react'
import { Button, Input } from '@mica-config-ui/web'
import { ModalShell } from './chat-modal'

/**
 * 单行文本输入弹窗（新建文件、重命名、新建分组…）。
 *
 * `onClose` 收的是去掉首尾空白的输入，取消/关闭/Esc 收 `null`，调用方据此决定要不要真的
 * 动手。Esc 与 Cmd/Ctrl+W 都当取消——后者在 macOS 上是「关窗」，别让它落到窗口自己身上
 * 把整个窗口关掉。
 *
 * 外壳与详情弹窗同一个 `ModalShell`：以前这里是 Tailwind 手写的一套遮罩与卡片，
 * 遮罩比例、圆角、关闭方式都和别处对不上。表单动作放底部（见 `chat-modal-footer`）。
 */
export function TextPrompt({ prompt, onClose }) {
  const [value, setValue] = useState(prompt.initial)
  const focusInput = useCallback((instance) => {
    instance?.focus()
    instance?.dom?.select()
  }, [])
  const submit = () => onClose(value.trim())
  return (
    <ModalShell
      title={prompt.title}
      subtitle={prompt.hint || null}
      onClose={() => onClose(null)}
      className="chat-modal-prompt"
      footer={
        <>
          <Button onClick={() => onClose(null)}>取消</Button>
          <Button variant="accent" onClick={submit}>
            确定
          </Button>
        </>
      }
    >
      <div className="mica-config-ui is-embed">
        <Input
          ref={focusInput}
          autoFocus
          value={value}
          spellCheck={false}
          className="chat-modal-input"
          onChange={setValue}
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
          }}
        />
      </div>
    </ModalShell>
  )
}
