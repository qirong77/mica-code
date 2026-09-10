import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconChevronRight, IconGitBranch, IconSearch } from '@tabler/icons-react'
import { FileSystemIcon } from './FileIcon'
import { statusColor, statusLabel } from './git-decorations'
import { editorOptions, languageFor, monaco } from './monaco'

const MAX_RESULTS = 200

function Highlight({ text, query }) {
  const value = String(text || '')
  const needle = String(query || '').toLowerCase()
  if (!needle) return value
  const index = value.toLowerCase().indexOf(needle)
  if (index < 0) return value
  return (
    <>
      {value.slice(0, index)}
      <mark className="rounded-xs bg-warn/20 font-semibold text-warn-soft">
        {value.slice(index, index + needle.length)}
      </mark>
      {value.slice(index + needle.length)}
    </>
  )
}

export function SearchPanel({ root, onOpenFile, activePath }) {
  const inputRef = useRef(null)
  const requestRef = useRef(0)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [message, setMessage] = useState('搜索当前工作区中的文件内容')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!query.trim()) {
      requestRef.current += 1
      setResults([])
      setMessage('搜索当前工作区中的文件内容')
      setBusy(false)
      return undefined
    }
    const request = ++requestRef.current
    const timer = window.setTimeout(async () => {
      try {
        setBusy(true)
        const items = await window.mica.files.search(root, query)
        if (request !== requestRef.current) return
        setResults(items?.slice(0, MAX_RESULTS) || [])
        setMessage(items?.length ? `${items.length} 个结果` : '没有匹配的结果')
      } catch (error) {
        if (request !== requestRef.current) return
        setResults([])
        setMessage(`搜索失败：${error?.message || error}`)
      } finally {
        if (request === requestRef.current) setBusy(false)
      }
    }, 180)
    return () => {
      clearTimeout(timer)
      requestRef.current += 1
    }
  }, [query, root])

  useEffect(() => {
    if (!root) {
      setQuery('')
      setResults([])
      setMessage('选择一个终端会话以搜索文件')
    }
  }, [root])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <div className="flex h-6 flex-1 items-center gap-1.5 rounded-sm border border-white/[.07] bg-white/[.03] px-2">
          <IconSearch size={12} className="shrink-0 text-white/40" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="搜索文件内容"
            aria-label="搜索文件内容"
            className="h-full min-w-0 flex-1 bg-transparent text-[11px] text-white/85 placeholder:text-white/30 focus:outline-none"
            onChange={(event) => setQuery(event.target.value)}
          />
          {busy && (
            <span
              className="size-2.5 shrink-0 animate-spin rounded-full border border-white/25 border-t-white/75"
              aria-hidden="true"
            />
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-between border-b border-white/[.06] px-3 pb-1.5 text-[10px] text-white/35">
        <span className="truncate" title={root || ''}>
          {root}
        </span>
        <span className="ml-2 shrink-0 tabular-nums">{message}</span>
      </div>
      <div className="thin-scrollbar min-h-0 flex-1 overflow-auto py-1">
        {results.map((result, index) => (
          <button
            key={`${result.path}-${result.line}-${index}`}
            type="button"
            title={result.path}
            className={`block w-full px-3 py-1 text-left transition-colors hover:bg-white/[.045] ${activePath === result.path ? 'bg-white/[.075]' : ''}`}
            onClick={() => onOpenFile(result.path, result.line)}
          >
            <div className="flex items-center gap-1 font-mono text-[10px] text-white/45">
              <span className="min-w-0 flex-1 truncate">{result.relativePath || result.path}</span>
              <span className="shrink-0 tabular-nums text-white/30">:{result.line}</span>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-white/65">
              <Highlight text={result.preview} query={query} />
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function makeGitTree(files) {
  const root = { folders: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] })
      node = node.folders.get(part)
    }
    node.files.push({ ...file, name: parts.at(-1) })
  }
  return root
}

function GitRows({ node, path = '', depth = 0, collapsed, onToggle, selectedPath, onSelect }) {
  return (
    <>
      {[...node.folders].map(([name, folder]) => {
        const key = path ? `${path}/${name}` : name
        const closed = collapsed.has(key)
        return (
          <div key={key}>
            <button
              type="button"
              className="grid h-6.5 w-full grid-cols-[14px_16px_minmax(0,1fr)] items-center gap-1 rounded-sm pr-1.5 text-left text-xs text-white/65 hover:bg-white/[.045] hover:text-white"
              style={{ paddingLeft: 5 + depth * 13 }}
              onClick={() => onToggle(key)}
            >
              <IconChevronRight
                size={13}
                className={`text-white/35 ${closed ? '' : 'rotate-90'}`}
              />
              <FileSystemIcon name={name} type="directory" expanded={!closed} className="size-4" />
              <span className="truncate">{name}</span>
            </button>
            {!closed && (
              <GitRows
                node={folder}
                path={key}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            )}
          </div>
        )
      })}
      {node.files.map((file) => (
        <button
          key={file.path}
          type="button"
          title={file.path}
          className={`grid h-6.5 w-full grid-cols-[14px_16px_minmax(0,1fr)_18px] items-center gap-1 rounded-sm pr-1.5 text-left text-xs hover:bg-white/[.045] hover:text-white ${selectedPath === file.path ? 'bg-white/[.075] text-white' : 'text-white/65'}`}
          style={{ paddingLeft: 5 + depth * 13 }}
          onClick={() => onSelect(file)}
        >
          <span />
          <FileSystemIcon name={file.name} className="size-4" />
          <span className="truncate">{file.name}</span>
          <span
            className="justify-self-end font-mono text-[10px] font-semibold"
            style={{ color: statusColor(file.status) }}
          >
            {statusLabel(file.status)}
          </span>
        </button>
      ))}
    </>
  )
}

export function GitPanel({
  cwd,
  repository,
  loading,
  onSelectFile,
  selectedPath,
  rootLabel = null,
  heading = 'CHANGES'
}) {
  const [collapsed, setCollapsed] = useState(new Set())
  const tree = useMemo(() => makeGitTree(repository?.files || []), [repository])

  const root = repository?.root || cwd
  const rootClosed = collapsed.has('__root__')

  const toggle = useCallback((key) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center px-3 pt-2">
        <span className="text-[10px] font-semibold tracking-[.08em] text-white/45">{heading}</span>
        {loading && (
          <span
            className="ml-2 size-2.5 animate-spin rounded-full border border-white/25 border-t-white/75"
            aria-hidden="true"
          />
        )}
      </div>
      <div className="truncate px-3 py-1 font-mono text-[10px] text-white/30" title={root || ''}>
        {root}
      </div>
      <div className="thin-scrollbar min-h-0 flex-1 overflow-auto px-1.5 pb-3">
        {!cwd && (
          <div className="px-3 py-6 text-center text-[11px] text-white/35">
            选择一个终端会话以查看 Git 变化
          </div>
        )}
        {cwd && loading && !repository && (
          <div className="px-3 py-6 text-center text-[11px] text-white/35">
            正在读取 Git 工作区…
          </div>
        )}
        {cwd && !loading && !repository && (
          <div className="px-3 py-6 text-center text-[11px] text-white/35">
            当前目录不在 Git 仓库中
          </div>
        )}
        {repository && !repository.files.length && (
          <div className="px-3 py-6 text-center text-[11px] text-white/35">工作区没有文件变化</div>
        )}
        {repository && repository.files.length > 0 && (
          <>
            {rootLabel && (
              <button
                type="button"
                title={rootLabel}
                className="grid h-6.5 w-full grid-cols-[14px_16px_minmax(0,1fr)] items-center gap-1 rounded-sm pr-1.5 text-left text-xs text-info hover:bg-white/[.045]"
                style={{ paddingLeft: 5 }}
                onClick={() => toggle('__root__')}
              >
                <IconChevronRight
                  size={13}
                  className={`text-white/35 ${rootClosed ? '' : 'rotate-90'}`}
                />
                <IconGitBranch size={14} className="shrink-0" />
                <span className="truncate">{rootLabel}</span>
              </button>
            )}
            {!rootClosed && (
              <GitRows
                node={tree}
                depth={rootLabel ? 1 : 0}
                collapsed={collapsed}
                selectedPath={selectedPath}
                onToggle={toggle}
                onSelect={onSelectFile}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

export { languageFor }

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
              renderSideBySide: true,
              useInlineViewWhenSpaceIsLimited: false
            })
            modeRef.current = 'diff'
          }
          const original = monaco.editor.createModel(content.original, language)
          const modified = monaco.editor.createModel(content.modified, language)
          modelsRef.current = [original, modified]
          editorRef.current?.setModel({ original, modified })
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
