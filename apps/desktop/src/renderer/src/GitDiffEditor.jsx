import { useEffect, useRef } from 'react'
import { IconChevronRight } from '@tabler/icons-react'
import { editorOptions, languageFor } from './monaco'
import { monaco } from './monaco-runtime'

/**
 * Git diff 视图。从 FileSidePanels 拆出来单独成模块，由 FilesView 经 React.lazy
 * 按需加载：它静态 import 了 monaco 本体，留在 FileSidePanels 里会让 monaco
 * 跟着文件面板一起进启动路径（挑选 diff 是低频操作，不值得付这个代价）。
 */
export function GitDiffEditor({ cwd, file, onClose }) {
  const hostRef = useRef(null)
  const editorRef = useRef(null)
  const modelsRef = useRef([])
  const requestRef = useRef(0)
  const modeRef = useRef(null)

  useEffect(() => {
    if (!hostRef.current) return undefined
    const editor = monaco.editor.create(hostRef.current, editorOptions)
    editorRef.current = editor
    return () => {
      requestRef.current += 1
      for (const model of modelsRef.current) model?.dispose()
      modelsRef.current = []
      editor.dispose()
      editorRef.current = null
      modeRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!file || !cwd) return
    const request = ++requestRef.current
    ;(async () => {
      try {
        const content = await window.mica.git.file(cwd, file.path)
        if (request !== requestRef.current || !editorRef.current) return
        for (const model of modelsRef.current) model?.dispose()
        modelsRef.current = []
        if (content.binary || file.binary) {
          editorRef.current?.setModel(null)
          return
        }
        const language = languageFor(file.path)
        if (file.status === 'added' || file.status === 'deleted') {
          modeRef.current = 'single'
          const model = monaco.editor.createModel(
            file.status === 'added' ? content.modified : content.original,
            language
          )
          modelsRef.current = [model]
          editorRef.current?.setModel(model)
        } else {
          if (modeRef.current !== 'diff') {
            editorRef.current?.dispose()
            editorRef.current = monaco.editor.createDiffEditor(hostRef.current, {
              ...editorOptions,
              originalEditable: false,
              // 不锁死双列：面板宽度不够时 monaco 自己退回内联 diff
              // （默认断点 renderSideBySideInlineBreakpoint = 900）。
              renderSideBySide: true,
              useInlineViewWhenSpaceIsLimited: true
            })
            modeRef.current = 'diff'
          }
          const original = monaco.editor.createModel(content.original, language)
          const modified = monaco.editor.createModel(content.modified, language)
          modelsRef.current = [original, modified]
          editorRef.current?.setModel({ original, modified })
          // 直接落到第一处变更（内部会等 diff 计算完成），否则只会打开文件停在首行。
          editorRef.current?.revealFirstDiff()
        }
        requestAnimationFrame(() => editorRef.current?.layout())
      } catch {
        if (request !== requestRef.current) return
        editorRef.current?.setModel(null)
      }
    })()
  }, [cwd, file])

  useEffect(() => {
    if (file) requestAnimationFrame(() => editorRef.current?.layout())
  }, [file])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {file && (
        <header className="flex h-8 shrink-0 items-center gap-3 border-b border-white/[.07] px-3 text-[11px] text-white/65">
          <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
            {file.path}
          </span>
          {onClose && (
            <button
              type="button"
              title="关闭 diff"
              aria-label="关闭 diff"
              className="shrink-0 rounded-sm px-1 text-white/45 hover:bg-white/10 hover:text-white"
              onClick={onClose}
            >
              <IconChevronRight size={13} className="rotate-90" />
            </button>
          )}
        </header>
      )}
      <div ref={hostRef} className="min-h-0 flex-1" />
    </div>
  )
}
