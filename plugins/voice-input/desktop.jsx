import { useEffect, useRef, useState } from 'react'
import { Mic, Square, X } from 'lucide-react'
import { Button } from '@mica-config-ui/web'
import { createVoiceInput } from './recorder'

async function action(api, name, values) {
  const result = await api.panelAction(name, values)
  if (result?.ok === false) throw new Error(result.error || '语音输入暂时不可用，请稍后重试。')
  return result
}

/** The microphone is a bundled composer extension, available in the mobile layout. */
export function Composer({ api, isMobile, appendText, onOpenSettings }) {
  const [state, setState] = useState({ status: 'idle', elapsed: 0, error: '', retryable: false })
  const controller = useRef(null)
  const appendRef = useRef(appendText)
  appendRef.current = appendText

  useEffect(() => {
    if (!isMobile) return undefined
    const input = createVoiceInput({
      check: () => action(api, 'check'),
      upload: (file) => api.uploadAttachment(file),
      transcribe: async (path) => {
        const result = await action(api, 'transcribe', { path })
        if (!result?.compose) throw new Error(result?.message || '没有识别到文字，请重新录音。')
        return result.compose
      },
      discard: (path) => action(api, 'discard', { path }),
      appendText: (text) => appendRef.current?.(text),
      onChange: setState
    })
    controller.current = input
    const leavePage = () => {
      if (document.hidden) input.cancel()
    }
    const pageHide = () => input.cancel()
    document.addEventListener('visibilitychange', leavePage)
    window.addEventListener('pagehide', pageHide)
    return () => {
      document.removeEventListener('visibilitychange', leavePage)
      window.removeEventListener('pagehide', pageHide)
      input.dispose()
      controller.current = null
    }
  }, [api, isMobile])

  if (!isMobile) return null
  const recording = state.status === 'recording'
  const busy = state.status === 'processing' || state.status === 'requesting'
  const active = recording || busy
  const time = `${Math.floor(state.elapsed / 60)}:${String(state.elapsed % 60).padStart(2, '0')}`
  return (
    <div className="mica-config-ui flex min-w-0 items-center gap-1">
      <Button
        variant={recording ? 'danger-ghost' : 'ghost'}
        size="compact"
        icon={recording ? <Square size={16} /> : <Mic size={16} />}
        disabled={busy}
        title={recording ? '结束录音并转成文字' : '语音输入'}
        ariaLabel={recording ? '结束录音并转成文字' : '语音输入'}
        onClick={() => recording ? controller.current?.stop() : void controller.current?.start()}
      />
      {active || state.error ? (
        <div
          className={`flex min-w-0 items-center gap-1.5 ${state.error ? 'text-danger' : 'text-fg-soft'}`}
          role={state.error ? 'alert' : 'status'}
          aria-live="polite"
        >
          <span className="max-w-[40vw] truncate">
            {state.error || (recording ? `正在录音 ${time} / 2:00` : state.status === 'requesting' ? '正在准备麦克风…' : '正在转成文字…')}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {recording ? <Button size="compact" variant="accent" onClick={() => controller.current?.stop()}>结束录音</Button> : null}
            {state.retryable ? <Button size="compact" variant="ghost" onClick={() => controller.current?.retry()}>重试转写</Button> : null}
            {state.error ? <Button size="compact" variant="ghost" onClick={onOpenSettings}>语音设置</Button> : null}
            <Button size="compact" variant="ghost" icon={<X size={14} />} title={active ? '取消语音输入' : '关闭提示'} onClick={() => controller.current?.cancel()} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
