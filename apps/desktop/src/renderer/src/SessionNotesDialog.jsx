import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconNotebook } from '@tabler/icons-react'
import { editorOptions, loadMonaco } from './monaco'
import { ModalShell } from './chat-modal'

/**
 * 与 `mica-common/sessionNotes.ts` 的上限一致。
 * 超限在这里就拒绝保存，不交给宿主裁：那会把用户刚写的尾巴砍掉还不说一声。
 * 宿主侧的归一化只作为兜底（损坏文件的截断）。
 */
const MAX_CHARS = 20000
/** 打字停顿这么久才落盘：一次请求就够，不必每敲一个字发一条。 */
const SAVE_DELAY_MS = 700

const STATUS_LABEL = {
  loading: '载入中…',
  idle: '',
  dirty: '未保存',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败'
}

/**
 * 会话笔记弹窗：用户与模型共同维护的一段 markdown。
 *
 * 笔记存在会话快照里、不在对话历史里，所以压缩不会把它改掉 —— 这也是它值得单独
 * 存在的理由。编辑器复用应用里的 monaco（`loadMonaco()` 按需装载），但**另建一个
 * model**（`inmemory://` + 会话 id）：FilesView 的页签 model 由文件视图独占它的 URI
 * 与只读状态，共用会互相踩。
 */
export function SessionNotesDialog({ nodeId, sessionId, cwd, running, onClose }) {
  const hostRef = useRef(null)
  const editorRef = useRef(null)
  const modelRef = useRef(null)
  /** 程序性写入（首次载入、外部更新）期间不触发自动保存。 */
  const applyingRef = useRef(false)
  const saveTimerRef = useRef(null)
  const dirtyRef = useRef(false)
  const contentRef = useRef('')
  const saveRef = useRef(async () => {})

  const [state, setState] = useState('loading')
  const [chars, setChars] = useState(0)
  const [error, setError] = useState('')

  const target = useMemo(
    () => ({ sessionId: sessionId || null, cwd: cwd || null }),
    [sessionId, cwd]
  )

  const readNotes = useCallback(async () => {
    const result = await window.mica.chat.notes(nodeId, target)
    return typeof result?.content === 'string' ? result.content : ''
  }, [nodeId, target])

  const save = useCallback(async () => {
    const value = modelRef.current?.getValue() ?? ''
    // 超限不保存：留在编辑器里让用户自己删，比悄悄截断一半更可预期。
    if (value.length > MAX_CHARS) {
      setState('error')
      setError(`超过 ${MAX_CHARS} 字符上限，未保存`)
      return
    }
    setState('saving')
    setError('')
    try {
      const result = await window.mica.chat.setNotes(nodeId, value, target)
      if (result?.ok === false) {
        setState('error')
        setError(result.error || result.message || '保存失败')
        return
      }
      dirtyRef.current = false
      contentRef.current = value
      setState('saved')
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [nodeId, target])
  saveRef.current = save

  /** 外部内容（其他窗口保存、模型更新）落到编辑器里，并清掉「未保存」。 */
  const applyExternal = useCallback((next) => {
    const model = modelRef.current
    if (!model || model.getValue() === next) return
    applyingRef.current = true
    model.setValue(next)
    applyingRef.current = false
    contentRef.current = next
    dirtyRef.current = false
    setChars(next.length)
    setError('')
    setState('idle')
  }, [])

  // 编辑器只建一次：nodeId 变化（切换会话）时重建，避免把上一条会话的 model 留在图上。
  useEffect(() => {
    let disposed = false
    let disposeChange = null
    let unsubscribeNotes = null
    let editor = null
    let model = null

    void (async () => {
      const [monaco, initial] = await Promise.all([loadMonaco(), readNotes().catch(() => '')])
      if (disposed || !hostRef.current) return

      model = monaco.editor.createModel(
        initial,
        'markdown',
        monaco.Uri.parse(`inmemory://mica-session-notes/${encodeURIComponent(nodeId)}`)
      )
      editor = monaco.editor.create(hostRef.current, {
        ...editorOptions,
        // 弹窗里没有文件路径语义，行号列不需要为长路径留宽
        lineNumbersMinChars: 3,
        model
      })
      modelRef.current = model
      editorRef.current = editor
      contentRef.current = initial
      setChars(initial.length)
      setState('idle')

      disposeChange = editor.onDidChangeModelContent(() => {
        if (applyingRef.current) return
        const value = modelRef.current?.getValue() ?? ''
        const over = value.length > MAX_CHARS
        dirtyRef.current = true
        contentRef.current = value
        setChars(value.length)
        setState(over ? 'error' : 'dirty')
        setError(over ? `超过 ${MAX_CHARS} 字符上限，未保存；删到上限以内会自动继续保存` : '')
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        // 超限期间不发请求：否则每敲一个字都失败一次。
        if (over) {
          saveTimerRef.current = null
          return
        }
        saveTimerRef.current = setTimeout(() => {
          saveTimerRef.current = null
          if (dirtyRef.current) void saveRef.current()
        }, SAVE_DELAY_MS)
      })

      // 同一会话的其他窗口保存了笔记：没在编辑就跟上，正在编辑则以本地为准。
      unsubscribeNotes = window.mica.chat.onNotesUpdated?.((payload) => {
        if (payload?.id !== nodeId) return
        if (typeof payload.content !== 'string') return
        if (dirtyRef.current || editorRef.current?.hasTextFocus()) return
        applyExternal(payload.content)
      })
    })().catch((err) => {
      if (disposed) return
      setState('error')
      setError(err instanceof Error ? err.message : String(err))
    })

    return () => {
      disposed = true
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      disposeChange?.dispose()
      unsubscribeNotes?.()
      // 关窗即落盘：用户可能敲完就按 Esc，不等防抖那一拍。
      if (dirtyRef.current && contentRef.current.length <= MAX_CHARS) {
        dirtyRef.current = false
        window.mica.chat.setNotes(nodeId, contentRef.current, target).catch(() => {})
      }
      editorRef.current = null
      modelRef.current = null
      editor?.dispose()
      model?.dispose()
    }
    // readNotes / target 都是 nodeId 的派生值，跟着 nodeId 重建即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  // 一轮对话结束后重读：模型可能刚用 SessionNotes 工具写过笔记。
  const previousRunningRef = useRef(running)
  useEffect(() => {
    const was = previousRunningRef.current
    previousRunningRef.current = running
    if (!was || running) return
    if (dirtyRef.current || editorRef.current?.hasTextFocus()) return
    readNotes()
      .then(applyExternal)
      .catch(() => {})
  }, [running, readNotes, applyExternal])

  const footer = (
    <div className="chat-notes-footer">
      <span className="chat-notes-hint">
        存在会话里，不会被上下文压缩掉；模型用 SessionNotes 工具读写同一份内容。
      </span>
      <span
        className={`chat-notes-status${state === 'error' ? ' is-error' : ''}`}
        title={state === 'error' ? error : undefined}
      >
        {state === 'error' && error ? error : STATUS_LABEL[state] || ''}
      </span>
      <span className={`chat-notes-count${chars > MAX_CHARS ? ' is-over' : ''}`}>
        {chars} / {MAX_CHARS}
      </span>
    </div>
  )

  return (
    <ModalShell
      title="会话笔记"
      icon={<IconNotebook size={14} />}
      subtitle="Markdown · 用户与模型共同维护"
      onClose={onClose}
      className="session-notes-modal"
      footer={footer}
    >
      <div className="chat-notes-editor" ref={hostRef} />
    </ModalShell>
  )
}
