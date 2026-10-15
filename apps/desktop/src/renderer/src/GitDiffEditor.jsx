import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconExternalLink,
  IconLayoutColumns,
  IconLayoutList,
  IconRefresh,
  IconX
} from '@tabler/icons-react'
import { FileSystemIcon } from './FileIcon'
import { statusColor, statusLabel } from './git-decorations'
import { editorOptions, fileName, languageFor } from './monaco'
import { monaco } from './monaco-runtime'
import { useSharedState } from './ui-state'

const ACTION =
  'inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-sm px-1.5 text-fg-muted hover:bg-panel-hi hover:text-fg-strong disabled:pointer-events-none disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent'

function Action({ title, children, ...props }) {
  return (
    <button type="button" title={title} aria-label={title} className={ACTION} {...props}>
      {children}
    </button>
  )
}

// Monaco must release its model listeners before the models themselves are disposed.
function detachModels(editor, modelsRef) {
  editor?.setModel(null)
  for (const model of modelsRef.current) model.dispose()
  modelsRef.current = []
}

/** Loaded only through FilesView's lazy boundary, including the Monaco runtime. */
export function GitDiffEditor({
  cwd,
  file,
  onClose,
  onPreviousFile,
  onNextFile,
  hasPreviousFile,
  hasNextFile,
  onOpenFile,
  onToggleReviewed,
  reviewed = false,
  comparisonLabel = ''
}) {
  const hostRef = useRef(null)
  const editorRef = useRef(null)
  const modelsRef = useRef([])
  const requestRef = useRef(0)
  const activeKeyRef = useRef(null)
  const viewStatesRef = useRef(new Map())
  const [layout, setLayout] = useSharedState('gitDiffLayout', 'side')
  const [narrow, setNarrow] = useState(false)
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState(null)
  const [diffCount, setDiffCount] = useState(null)
  const sideBySide = layout !== 'inline' && !narrow
  const current = result?.file === file && result?.cwd === cwd && result?.retry === retry
  const phase = !file || !cwd ? 'empty' : current ? result.phase : 'loading'
  const ready = phase === 'ready'
  const base = file?.base
  const options = base && typeof base === 'object' ? base : {}
  const originalLabel =
    (current && result.originalLabel) ||
    options.originalLabel ||
    options.label ||
    options.ref ||
    comparisonLabel ||
    'HEAD'
  const modifiedLabel =
    (current && result.modifiedLabel) ||
    options.modifiedLabel ||
    ((options.mode || base) === 'staged' ? '暂存区（Index）' : '工作区（Working Tree）')

  useLayoutEffect(() => {
    const host = hostRef.current
    const viewStates = viewStatesRef.current
    const editor = monaco.editor.createDiffEditor(host, {
      ...editorOptions,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      // The observer controls both the layout and its labels at the same breakpoint.
      useInlineViewWhenSpaceIsLimited: false,
      renderSideBySideInlineBreakpoint: 600,
      ignoreTrimWhitespace: false,
      renderMarginRevertIcon: false,
      renderGutterMenu: false
    })
    editorRef.current = editor
    const subscription = editor.onDidUpdateDiff(() => {
      if (editor.getModel()) setDiffCount(editor.getLineChanges()?.length ?? null)
    })
    const resize = () => {
      const width = host.getBoundingClientRect().width
      setNarrow(width > 0 && width < 600)
      editor.layout()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()
    return () => {
      requestRef.current += 1
      if (activeKeyRef.current && editor.getModel()) {
        viewStates.set(activeKeyRef.current, editor.saveViewState())
      }
      observer.disconnect()
      subscription.dispose()
      detachModels(editor, modelsRef)
      editor.dispose()
      editorRef.current = null
      activeKeyRef.current = null
    }
  }, [])

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: sideBySide })
    editorRef.current?.layout()
  }, [sideBySide])

  useLayoutEffect(() => {
    const editor = editorRef.current
    const viewStates = viewStatesRef.current
    const request = ++requestRef.current
    detachModels(editor, modelsRef)
    activeKeyRef.current = null
    setDiffCount(null)
    setResult({ file, cwd, retry, phase: 'loading' })
    if (!file || !cwd) return undefined

    // Fingerprint changes reload content but retain the user's place in this comparison.
    const key = JSON.stringify([cwd, file.path, file.base ?? null])
    const savedView = viewStates.get(key)
    activeKeyRef.current = key
    let initialDiffSubscription = null
    ;(async () => {
      try {
        // Preserve the exact resolved ref and staged mode supplied by the comparison tree.
        const content = await window.mica.git.file(cwd, file.path, file.base ?? null)
        if (request !== requestRef.current || editorRef.current !== editor) return
        if (!content || content.error) throw new Error(content?.error || '未收到文件内容')
        if (content.binary || file.binary) {
          setResult({ file, cwd, retry, ...content, phase: 'binary' })
          return
        }
        const language = languageFor(file.path)
        const original = monaco.editor.createModel(content.original ?? '', language)
        modelsRef.current.push(original)
        const modified = monaco.editor.createModel(content.modified ?? '', language)
        modelsRef.current.push(modified)
        // Added/deleted files keep an empty side so the whole change is green/red.
        initialDiffSubscription = editor.onDidUpdateDiff(() => {
          initialDiffSubscription?.dispose()
          initialDiffSubscription = null
          if (request !== requestRef.current) return
          if (savedView) editor.restoreViewState(savedView)
          else editor.revealFirstDiff()
        })
        editor.setModel({ original, modified })
        if (savedView) editor.restoreViewState(savedView)
        setResult({
          file,
          cwd,
          retry,
          phase: 'ready',
          originalLabel: content.originalLabel,
          modifiedLabel: content.modifiedLabel
        })
        editor.layout()
      } catch (error) {
        if (request !== requestRef.current) return
        initialDiffSubscription?.dispose()
        initialDiffSubscription = null
        detachModels(editor, modelsRef)
        setResult({
          file,
          cwd,
          retry,
          phase: 'error',
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })()
    return () => {
      requestRef.current += 1
      initialDiffSubscription?.dispose()
      if (editorRef.current === editor && editor.getModel()) {
        viewStates.set(key, editor.saveViewState())
      }
    }
  }, [cwd, file, retry])

  const openFile = () => onOpenFile?.(file)
  const navigateDiff = (direction) => {
    editorRef.current?.goToDiff(direction)
    editorRef.current?.focus()
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-canvas text-fg">
      {file && (
        <>
          <header className="flex h-[35px] shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]">
            <FileSystemIcon name={file.path} className="size-4" />
            <span
              className="min-w-0 max-w-[45%] truncate font-medium text-fg-strong"
              title={file.path}
            >
              {fileName(file.path)}
            </span>
            <span
              className="shrink-0 font-mono text-[11px]"
              style={{ color: statusColor(file.status) }}
            >
              {statusLabel(file.status)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted" title={file.path}>
              {file.path}
            </span>
            {onClose && (
              <Action title="关闭比较" onClick={onClose}>
                <IconX size={14} />
              </Action>
            )}
          </header>
          <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-0.5 border-b border-line px-2 text-[11px]">
            <Action
              title="上一个文件"
              disabled={!hasPreviousFile || !onPreviousFile}
              onClick={onPreviousFile}
            >
              <IconChevronLeft size={14} />
            </Action>
            <Action title="下一个文件" disabled={!hasNextFile || !onNextFile} onClick={onNextFile}>
              <IconChevronRight size={14} />
            </Action>
            <span className="mx-1 h-3.5 border-l border-line" aria-hidden="true" />
            <Action
              title="上一处差异"
              disabled={!ready || !diffCount}
              onClick={() => navigateDiff('previous')}
            >
              <IconArrowUp size={14} />
            </Action>
            <Action
              title="下一处差异"
              disabled={!ready || !diffCount}
              onClick={() => navigateDiff('next')}
            >
              <IconArrowDown size={14} />
            </Action>
            <span className="px-1 tabular-nums text-fg-muted" role="status" aria-live="polite">
              {ready
                ? diffCount === null
                  ? '计算差异…'
                  : diffCount
                    ? `${diffCount} 处差异`
                    : '无文本差异'
                : ''}
            </span>
            <span className="min-w-0 flex-1 truncate px-1 text-fg-muted" title={comparisonLabel}>
              {comparisonLabel}
            </span>
            {onToggleReviewed && (
              <Action
                title={reviewed ? '标为未阅' : '标为已阅'}
                aria-pressed={reviewed}
                onClick={() => onToggleReviewed(file)}
              >
                <IconCheck size={14} className={reviewed ? 'text-git-added' : ''} />
                <span>{reviewed ? '已阅' : '标为已阅'}</span>
              </Action>
            )}
            {onOpenFile && (
              <Action
                title="打开工作区文件"
                onClick={openFile}
                disabled={file.status === 'deleted'}
              >
                <IconExternalLink size={14} />
              </Action>
            )}
            <Action
              title={layout === 'inline' ? '切换为双列比较' : '切换为内联比较'}
              aria-pressed={layout === 'inline'}
              onClick={() => setLayout(layout === 'inline' ? 'side' : 'inline')}
            >
              {layout === 'inline' ? <IconLayoutColumns size={14} /> : <IconLayoutList size={14} />}
            </Action>
          </div>
          <div className="flex shrink-0 border-b border-line bg-panel text-[11px] text-fg-muted">
            {sideBySide ? (
              <>
                <div
                  className="min-w-0 flex-1 truncate border-r border-line px-3 py-1"
                  title={`原始版本：${originalLabel}`}
                >
                  原始版本 · {originalLabel}
                </div>
                <div
                  className="min-w-0 flex-1 truncate px-3 py-1"
                  title={`修改版本：${modifiedLabel}`}
                >
                  修改版本 · {modifiedLabel}
                </div>
              </>
            ) : (
              <div
                className="min-w-0 truncate px-3 py-1"
                title={`${originalLabel} → ${modifiedLabel}`}
              >
                {originalLabel} → {modifiedLabel} · 内联比较
              </div>
            )}
          </div>
        </>
      )}
      <div className="relative min-h-0 flex-1" aria-busy={phase === 'loading'}>
        <div ref={hostRef} className={`absolute inset-0 ${ready ? '' : 'invisible'}`} />
        {phase !== 'ready' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-auto bg-canvas p-6 text-center text-[12px] text-fg-muted">
            {phase === 'empty' && <p>选择一个文件以查看差异</p>}
            {phase === 'loading' && (
              <div className="flex items-center gap-2" role="status">
                <IconRefresh size={16} className="animate-spin" />
                正在加载差异…
              </div>
            )}
            {phase === 'binary' && (
              <>
                <FileSystemIcon name={file.path} className="size-8" />
                <p className="max-w-full break-all text-fg-strong">{file.path}</p>
                <p>这是二进制文件，无法显示文本差异。</p>
                {onOpenFile && file.status !== 'deleted' && (
                  <Action title="打开工作区文件" onClick={openFile}>
                    <IconExternalLink size={14} /> 打开文件
                  </Action>
                )}
              </>
            )}
            {phase === 'error' && (
              <>
                <p className="text-fg-strong">无法加载 {fileName(file.path)} 的差异</p>
                <p className="max-w-full select-text break-words text-danger" role="alert">
                  {result.error}
                </p>
                <Action title="重新加载差异" onClick={() => setRetry((value) => value + 1)}>
                  <IconRefresh size={14} /> 重试
                </Action>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
