import { useEffect, useRef, useState } from 'react'
import { editorOptions, monaco } from './monaco'

const NOTES_STORAGE_KEY = 'mica.notes.markdown'
const DEFAULT_NOTE = '# Notes\n\n'

function loadNote() {
  try {
    return localStorage.getItem(NOTES_STORAGE_KEY) ?? DEFAULT_NOTE
  } catch (error) {
    console.warn('load notes failed', error)
    return DEFAULT_NOTE
  }
}

export function NotesView({ visible }) {
  const hostRef = useRef(null)
  const editorRef = useRef(null)
  const saveTimerRef = useRef(null)
  const [saveState, setSaveState] = useState('已保存到本地')

  useEffect(() => {
    if (!hostRef.current) return undefined

    const model = monaco.editor.createModel(loadNote(), 'markdown')
    const editor = monaco.editor.create(hostRef.current, {
      ...editorOptions,
      model,
      ariaLabel: 'Notes Markdown 编辑器',
      wordWrap: 'on',
      wrappingIndent: 'same',
      quickSuggestions: false
    })
    editorRef.current = editor
    const changeListener = model.onDidChangeContent(() => {
      setSaveState('正在保存…')
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => {
        try {
          localStorage.setItem(NOTES_STORAGE_KEY, model.getValue())
          setSaveState('已保存到本地')
        } catch (error) {
          console.error('save notes failed', error)
          setSaveState('保存失败')
        }
      }, 200)
    })

    return () => {
      clearTimeout(saveTimerRef.current)
      try {
        localStorage.setItem(NOTES_STORAGE_KEY, model.getValue())
      } catch (error) {
        console.error('save notes failed', error)
      }
      changeListener.dispose()
      editor.dispose()
      model.dispose()
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!visible) return undefined
    const frame = requestAnimationFrame(() => {
      editorRef.current?.layout()
      editorRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])

  return (
    <section
      className={`min-h-0 flex-1 flex-col overflow-hidden ${visible ? 'flex' : 'hidden'}`}
      aria-hidden={!visible}
    >
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-white/10 bg-white/[.015] px-3 text-[11px] text-white/35">
        <span>Markdown</span>
        <span aria-live="polite">{saveState}</span>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1" />
    </section>
  )
}
