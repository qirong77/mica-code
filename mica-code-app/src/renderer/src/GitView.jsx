import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, File, Folder, RefreshCw } from 'lucide-react'
import { useLatest, usePaneWidth } from './hooks'
import { editorOptions, languageFor, monaco } from './monaco'

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
              className="grid h-7 w-full grid-cols-[14px_16px_minmax(0,1fr)_18px] items-center gap-1 rounded-sm pr-1.5 text-left text-xs text-white/65 hover:bg-white/[.045] hover:text-white"
              style={{ paddingLeft: 5 + depth * 13 }}
              onClick={() => onToggle(key)}
            >
              <ChevronRight size={13} className={`text-white/35 ${closed ? '' : 'rotate-90'}`} />
              <Folder size={14} className="text-white/45" />
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
          className={`grid h-7 w-full grid-cols-[14px_16px_minmax(0,1fr)_18px] items-center gap-1 rounded-sm pr-1.5 text-left text-xs hover:bg-white/[.045] hover:text-white ${selectedPath === file.path ? 'bg-white/[.075] text-white' : 'text-white/65'}`}
          style={{ paddingLeft: 5 + depth * 13 }}
          onClick={() => onSelect(file)}
        >
          <span />
          <File size={14} className="text-white/45" />
          <span className="truncate">{file.name}</span>
          <span
            className={`justify-self-end font-mono text-[10px] font-semibold ${file.status === 'added' ? 'text-[#55b982]' : file.status === 'deleted' ? 'text-[#e06c75]' : 'text-[#d7ae5d]'}`}
          >
            {file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}
          </span>
        </button>
      ))}
    </>
  )
}

export function GitView({ cwd, repository, loading, visible, onRefresh }) {
  const viewRef = useRef(null)
  const editorHostRef = useRef(null)
  const editorRef = useRef(null)
  const modelsRef = useRef([])
  const modeRef = useRef(null)
  const requestRef = useRef(0)
  const signatureRef = useRef(null)
  const repositoryRef = useLatest(repository)
  const cwdRef = useLatest(cwd)
  const [selectedPath, setSelectedPath] = useState(null)
  const selectedPathRef = useLatest(selectedPath)
  const [selectedFile, setSelectedFile] = useState(null)
  const [collapsed, setCollapsed] = useState(new Set())
  const [message, setMessage] = useState('选择变化的文件以查看对比')
  const tree = useMemo(() => makeGitTree(repository?.files || []), [repository])

  const clearEditor = useCallback((disposeEditor = false) => {
    editorRef.current?.setModel(null)
    for (const model of modelsRef.current) model?.dispose()
    modelsRef.current = []
    if (disposeEditor) {
      editorRef.current?.dispose()
      editorRef.current = null
      modeRef.current = null
    }
  }, [])

  const ensureEditor = useCallback(
    (mode) => {
      if (editorRef.current && modeRef.current === mode) return editorRef.current
      clearEditor(true)
      modeRef.current = mode
      const options = { ...editorOptions, readOnly: true }
      editorRef.current =
        mode === 'diff'
          ? monaco.editor.createDiffEditor(editorHostRef.current, {
              ...options,
              originalEditable: false,
              renderSideBySide: true,
              useInlineViewWhenSpaceIsLimited: false
            })
          : monaco.editor.create(editorHostRef.current, options)
      return editorRef.current
    },
    [clearEditor]
  )

  const selectFile = useCallback(
    async (file) => {
      if (!file || !repositoryRef.current || !cwdRef.current) return
      const requestCwd = cwdRef.current
      const requestRoot = repositoryRef.current.root
      const request = ++requestRef.current
      setSelectedPath(file.path)
      setSelectedFile(file)
      clearEditor()
      setMessage('正在加载对比…')
      try {
        const content = await window.mica.git.file(requestCwd, file.path)
        if (
          request !== requestRef.current ||
          cwdRef.current !== requestCwd ||
          repositoryRef.current?.root !== requestRoot
        )
          return
        if (content.binary || file.binary) {
          clearEditor()
          setMessage('二进制文件无法进行文本对比')
          return
        }
        clearEditor()
        const language = languageFor(file.path)
        if (file.status === 'added' || file.status === 'deleted') {
          const editor = ensureEditor('single')
          const model = monaco.editor.createModel(
            file.status === 'added' ? content.modified : content.original,
            language
          )
          modelsRef.current = [model]
          editor.setModel(model)
        } else {
          const editor = ensureEditor('diff')
          const original = monaco.editor.createModel(content.original, language)
          const modified = monaco.editor.createModel(content.modified, language)
          modelsRef.current = [original, modified]
          editor.setModel({ original, modified })
        }
        setMessage('')
        requestAnimationFrame(() => editorRef.current?.layout())
      } catch (error) {
        if (request !== requestRef.current) return
        clearEditor()
        setMessage(`无法加载文件对比：${error?.message || error}`)
      }
    },
    [clearEditor, cwdRef, ensureEditor, repositoryRef]
  )

  useEffect(() => {
    if (!visible) {
      requestRef.current += 1
      return
    }
    if (!cwd) {
      requestRef.current += 1
      signatureRef.current = null
      setSelectedPath(null)
      setSelectedFile(null)
      clearEditor()
      setMessage('选择一个终端会话以查看 Git 变化')
      return
    }
    if (loading && !repository) {
      setMessage('正在读取 Git 工作区…')
      return
    }
    if (!repository) {
      requestRef.current += 1
      signatureRef.current = null
      setSelectedPath(null)
      setSelectedFile(null)
      clearEditor()
      setMessage('当前目录不在 Git 仓库中')
      return
    }
    const signature = JSON.stringify({ root: repository.root, files: repository.files })
    if (signature === signatureRef.current) {
      requestAnimationFrame(() => editorRef.current?.layout())
      return
    }
    signatureRef.current = signature
    if (!repository.files.length) {
      requestRef.current += 1
      setSelectedPath(null)
      setSelectedFile(null)
      clearEditor()
      setMessage('工作区没有文件变化')
      return
    }
    const selected =
      repository.files.find((file) => file.path === selectedPathRef.current) || repository.files[0]
    selectFile(selected)
  }, [clearEditor, cwd, loading, repository, selectFile, selectedPathRef, visible])

  useEffect(
    () => () => {
      requestRef.current += 1
      clearEditor(true)
    },
    [clearEditor]
  )

  const layout = useCallback(() => editorRef.current?.layout(), [])
  const { width, separatorProps } = usePaneWidth({
    storageKey: 'mica.gitTreeWidth',
    initial: 260,
    min: 160,
    minRight: 300,
    containerRef: viewRef,
    onLayout: layout
  })
  useEffect(() => {
    if (visible) requestAnimationFrame(layout)
  }, [layout, visible, width])

  return (
    <section
      ref={viewRef}
      className={`min-h-0 flex-1 bg-[#0e0e0e] no-drag ${visible ? 'flex' : 'hidden'}`}
    >
      <aside className="flex min-h-0 shrink-0 flex-col bg-[#111]" style={{ width }}>
        <header className="flex h-9 shrink-0 items-center justify-between px-2 pl-3">
          <span className="text-[10px] font-semibold tracking-[.08em] text-white/45">CHANGES</span>
          <button
            type="button"
            title="刷新 Git 变化"
            aria-label="刷新 Git 变化"
            className="grid size-6.5 place-items-center rounded-sm text-white/45 hover:bg-white/[.06] hover:text-white"
            onClick={() => {
              signatureRef.current = null
              onRefresh()
            }}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </header>
        <div
          className="truncate px-3 pb-2 font-mono text-[10px] text-white/30"
          title={repository?.root || ''}
        >
          {repository?.root}
        </div>
        <div className="thin-scrollbar min-h-0 flex-1 overflow-auto px-1.5 pb-3">
          <GitRows
            node={tree}
            collapsed={collapsed}
            selectedPath={selectedPath}
            onToggle={(key) =>
              setCollapsed((current) => {
                const next = new Set(current)
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return next
              })
            }
            onSelect={selectFile}
          />
        </div>
      </aside>
      <div
        {...separatorProps}
        className="pane-resizer z-10 w-1.25 shrink-0 cursor-col-resize"
        role="separator"
        aria-label="调整 Git 变化列表宽度"
        aria-orientation="vertical"
        aria-valuemin="160"
        aria-valuenow={width}
        tabIndex={0}
      />
      <section className="relative flex min-w-0 min-h-0 flex-1 flex-col">
        {selectedFile && (
          <header className="flex h-9 shrink-0 items-center gap-3 border-b border-white/[.07] px-3 text-[11px] text-white/65">
            <span className="min-w-0 flex-1 truncate font-mono" title={selectedFile.path}>
              {selectedFile.path}
            </span>
            <span className="flex shrink-0 gap-2 font-mono text-[10px]">
              <span className="text-[#55b982]">+{selectedFile.additions}</span>
              <span className="text-[#e06c75]">−{selectedFile.deletions}</span>
            </span>
          </header>
        )}
        <div ref={editorHostRef} className="min-h-0 flex-1" />
        {message && (
          <div
            className={`absolute inset-x-0 bottom-0 grid place-items-center p-6 text-center text-xs text-white/35 ${selectedFile ? 'top-9' : 'top-0'}`}
          >
            {message}
          </div>
        )}
      </section>
    </section>
  )
}
