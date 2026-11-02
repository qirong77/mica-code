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
import { createGitDiffSession, gitDiffKey } from './git-diff-session'
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
  const sessionRef = useRef(null)
  const retryRef = useRef(0)
  const [layout, setLayout] = useSharedState('gitDiffLayout', 'side')
  const [narrow, setNarrow] = useState(false)
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState(null)
  const [diffCount, setDiffCount] = useState(null)
  const [loadingHint, setLoadingHint] = useState(false)
  const sideBySide = layout !== 'inline' && !narrow
  const key = gitDiffKey(cwd, file)
  const current = result?.key === key
  const phase = !file || !cwd ? 'empty' : current ? result.phase : 'loading'
  const busy = phase === 'loading' || (current && result.refreshing)
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
    const session = createGitDiffSession({
      editor,
      readFile: (directory, path, base) => window.mica.git.file(directory, path, base),
      createModel: (content, path) => monaco.editor.createModel(content, languageFor(path)),
      onChange: (next) => {
        setResult(next)
        setDiffCount(next.phase === 'ready' ? (editor.getLineChanges()?.length ?? null) : null)
      }
    })
    sessionRef.current = session
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
      observer.disconnect()
      subscription.dispose()
      session.dispose()
      editor.dispose()
      editorRef.current = null
      sessionRef.current = null
    }
  }, [])

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: sideBySide })
    editorRef.current?.layout()
  }, [sideBySide])

  useLayoutEffect(() => {
    const force = retry !== retryRef.current
    retryRef.current = retry
    void sessionRef.current?.select(cwd, file, { force })
  }, [cwd, file, retry])

  useEffect(() => {
    if (!busy) return undefined
    const timer = window.setTimeout(() => setLoadingHint(true), 150)
    return () => window.clearTimeout(timer)
  }, [busy, key, retry])

  useLayoutEffect(() => setLoadingHint(false), [busy, key, retry])

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
            <Action title="刷新差异" disabled={busy} onClick={() => setRetry((value) => value + 1)}>
              <IconRefresh size={14} />
            </Action>
            {onToggleReviewed && (
              <Action
                title={reviewed ? '标为未阅' : '标为已阅'}
                aria-pressed={reviewed}
                disabled={!ready || busy}
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
      <div className="relative min-h-0 flex-1" aria-busy={busy}>
        <div
          ref={hostRef}
          className={`absolute inset-0 ${
            ready || (phase === 'loading' && result?.hasModel) ? '' : 'invisible'
          } ${phase === 'loading' ? 'pointer-events-none' : ''}`}
          aria-hidden={!ready}
        />
        {busy && loadingHint && (
          <div
            className="absolute right-3 top-2 z-10 flex max-w-[calc(100%-24px)] items-center gap-2 rounded bg-panel px-2 py-1 text-[11px] text-fg-muted shadow"
            role="status"
          >
            <IconRefresh size={14} className="shrink-0 animate-spin" />
            <span className="truncate">正在加载 {fileName(file.path)} 的差异…</span>
          </div>
        )}
        {!['ready', 'loading'].includes(phase) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-auto bg-canvas p-6 text-center text-[12px] text-fg-muted">
            {phase === 'empty' && <p>选择一个文件以查看差异</p>}
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
