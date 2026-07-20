import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const modes = {
  files: { label: '快速打开', placeholder: '搜索当前工作区中的文件', method: 'find', limit: 100 },
  text: { label: '全文搜索', placeholder: '在当前工作区中搜索文本', method: 'search', limit: 200 }
}

const isAbsolute = (value) => /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(value)
const resolvePath = (root, value) => {
  const path = String(value || '')
  if (!path || isAbsolute(path) || !root) return path
  const separator = String(root).includes('\\') ? '\\' : '/'
  return `${String(root).replace(/[\\/]+$/, '')}${separator}${path.replace(/^[\\/]+/, '')}`
}
const relativePath = (root, value) => {
  const path = String(value || '')
  const base = String(root || '').replace(/[\\/]+$/, '')
  if (!base) return path
  const lower = path.toLocaleLowerCase()
  const rootLower = base.toLocaleLowerCase()
  if (lower === rootLower) return path.split(/[\\/]/).at(-1) || path
  if (!lower.startsWith(`${rootLower}/`) && !lower.startsWith(`${rootLower}\\`)) return path
  return path.slice(base.length + 1)
}
const positiveInteger = (value) => {
  const number = Number.parseInt(value, 10)
  return Number.isFinite(number) && number > 0 ? number : 1
}
const responseItems = (response) => {
  if (Array.isArray(response)) return response
  for (const key of ['results', 'files', 'items', 'matches'])
    if (Array.isArray(response?.[key])) return response[key]
  return []
}
const flattenTextItems = (items) =>
  items.flatMap((item) =>
    item && typeof item === 'object' && Array.isArray(item.matches)
      ? item.matches.map((match) => ({ ...item, ...match, matches: undefined }))
      : [item]
  )

function matchIndexes(text, query, fuzzy) {
  const source = String(text).toLocaleLowerCase()
  const needle = String(query).trim().toLocaleLowerCase()
  if (!needle) return []
  if (fuzzy) {
    const output = []
    let from = 0
    for (const character of needle.replace(/\s+/g, '')) {
      const index = source.indexOf(character, from)
      if (index < 0) return []
      output.push(index)
      from = index + 1
    }
    return output
  }
  const output = []
  let from = 0
  while (from < source.length) {
    const index = source.indexOf(needle, from)
    if (index < 0) break
    for (let offset = 0; offset < needle.length; offset += 1) output.push(index + offset)
    from = index + needle.length
  }
  return output
}

function Highlight({ text, query, fuzzy = false }) {
  const value = String(text || '')
  const indexes = useMemo(() => new Set(matchIndexes(value, query, fuzzy)), [fuzzy, query, value])
  if (!indexes.size) return value
  const chunks = []
  let start = 0
  let marked = indexes.has(0)
  for (let index = 1; index <= value.length; index += 1) {
    const next = index < value.length && indexes.has(index)
    if (index < value.length && next === marked) continue
    const textChunk = value.slice(start, index)
    chunks.push(
      marked ? (
        <mark key={start} className="rounded-xs bg-[#c08532]/20 font-semibold text-[#dfbe84]">
          {textChunk}
        </mark>
      ) : (
        textChunk
      )
    )
    start = index
    marked = next
  }
  return chunks
}

function normalize(item, root, mode) {
  const source = typeof item === 'string' ? { path: item } : item
  if (!source || typeof source !== 'object') return null
  const candidate =
    source.path ||
    source.filePath ||
    source.absolutePath ||
    source.file ||
    source.relativePath ||
    source.relative
  const path = resolvePath(root, candidate)
  if (!path) return null
  const display = String(
    source.relativePath || source.relative || source.displayPath || relativePath(root, path)
  )
  return mode === 'files'
    ? { path, relativePath: display }
    : {
        path,
        relativePath: display,
        line: positiveInteger(source.line ?? source.lineNumber),
        column: positiveInteger(source.column ?? source.columnNumber),
        preview: String(source.preview ?? source.lineText ?? source.text ?? source.content ?? '')
      }
}

export function QuickSearch({ getRoot, openFile, closeActiveFile }) {
  const inputRef = useRef(null)
  const requestRef = useRef(0)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState('files')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [selected, setSelected] = useState(-1)
  const [message, setMessage] = useState('')
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const config = modes[mode]

  const hide = useCallback(() => {
    requestRef.current += 1
    setOpen(false)
    setResults([])
    setSelected(-1)
    setBusy(false)
  }, [])
  const show = useCallback((nextMode) => {
    requestRef.current += 1
    setMode(nextMode)
    setQuery('')
    setResults([])
    setSelected(-1)
    setMessage(nextMode === 'text' ? '输入文本以搜索当前工作区' : '正在加载文件…')
    setSummary('')
    setOpen(true)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [])

  useEffect(() => {
    const keydown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLocaleLowerCase()
      if (key === 'p' && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        show('files')
      } else if (key === 'f' && event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        show('text')
      } else if (key === 'w' && !event.shiftKey) {
        if (open) {
          event.preventDefault()
          event.stopPropagation()
          hide()
        } else if (closeActiveFile()) {
          event.preventDefault()
          event.stopPropagation()
        }
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [closeActiveFile, hide, open, show])

  useEffect(() => {
    if (!open) return undefined
    if (mode === 'text' && !query.trim()) {
      requestRef.current += 1
      setResults([])
      setSelected(-1)
      setMessage('输入文本以搜索当前工作区')
      setSummary('')
      setBusy(false)
      return undefined
    }
    const request = ++requestRef.current
    const timer = window.setTimeout(
      async () => {
        try {
          const root = await getRoot()
          if (request !== requestRef.current) return
          if (!root) {
            setResults([])
            setSelected(-1)
            setMessage('请先打开一个工作区文件夹')
            setSummary('')
            setBusy(false)
            return
          }
          const method = window.mica.files[config.method]
          if (typeof method !== 'function') {
            setMessage('当前版本不支持工作区搜索')
            setBusy(false)
            return
          }
          setBusy(true)
          setResults([])
          setSelected(-1)
          setMessage(mode === 'files' ? '正在搜索文件…' : '正在搜索工作区…')
          setSummary('')
          const response = await method(root, query.trim())
          if (request !== requestRef.current) return
          const raw = responseItems(response)
          const items = mode === 'text' ? flattenTextItems(raw) : raw
          const normalized = items.map((item) => normalize(item, root, mode)).filter(Boolean)
          const totalValue = Number(response?.total ?? response?.count)
          const total =
            Number.isFinite(totalValue) && totalValue >= normalized.length
              ? totalValue
              : normalized.length
          const visible = normalized.slice(0, config.limit)
          setResults(visible)
          setSelected(visible.length ? 0 : -1)
          setMessage(visible.length ? '' : '没有找到匹配结果')
          setSummary(
            total > visible.length || visible.length === config.limit
              ? `显示 ${visible.length} 项，共 ${total} 项`
              : `${visible.length} 个结果`
          )
        } catch (error) {
          if (request === requestRef.current) {
            setResults([])
            setSelected(-1)
            setMessage(error?.message ? `搜索失败：${error.message}` : '搜索失败，请稍后重试')
          }
        } finally {
          if (request === requestRef.current) setBusy(false)
        }
      },
      mode === 'files' && !query ? 0 : 160
    )
    return () => clearTimeout(timer)
  }, [config.limit, config.method, getRoot, mode, open, query])

  useEffect(() => {
    if (selected >= 0)
      document.getElementById(`quick-result-${selected}`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const openSelected = useCallback(() => {
    const result = results[selected]
    if (!result) return
    const opening =
      mode === 'text'
        ? openFile(result.path, { line: result.line, column: result.column })
        : openFile(result.path)
    Promise.resolve(opening).catch((error) => console.error('open search result failed', error))
    hide()
  }, [hide, mode, openFile, results, selected])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[12000] flex justify-center bg-black/20 px-4 pb-6 pt-[clamp(42px,10vh,100px)] no-drag"
      onClick={(event) => event.target === event.currentTarget && hide()}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-search-mode"
        aria-busy={busy}
        className="flex max-h-[min(620px,calc(90vh-42px))] w-[min(720px,calc(100vw-32px))] flex-col self-start overflow-hidden rounded-md border border-white/20 bg-[#151515] shadow-[0_16px_48px_rgb(0_0_0/.58)]"
      >
        <div className="flex min-h-12 shrink-0 items-center gap-2.5 border-b border-white/10 px-2.5 py-1.5">
          <span
            id="quick-search-mode"
            className="shrink-0 rounded-sm border border-white/10 bg-white/[.045] px-1.5 py-1 text-[10px] font-semibold tracking-wide text-white/45"
          >
            {config.label}
          </span>
          <input
            ref={inputRef}
            value={query}
            placeholder={config.placeholder}
            aria-label={config.placeholder}
            aria-controls="quick-search-results"
            aria-autocomplete="list"
            aria-activedescendant={selected >= 0 ? `quick-result-${selected}` : ''}
            autoComplete="off"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 text-sm text-white placeholder:text-white/25"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                hide()
              } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
                event.preventDefault()
                event.stopPropagation()
                if (results.length)
                  setSelected((value) =>
                    value < 0
                      ? 0
                      : (value + (event.key === 'ArrowDown' ? 1 : -1) + results.length) %
                        results.length
                  )
              } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.stopPropagation()
                openSelected()
              }
            }}
          />
        </div>
        <div className="relative min-h-13.5 overflow-hidden">
          {!!results.length && (
            <div
              id="quick-search-results"
              role="listbox"
              aria-label="搜索结果"
              className="thin-scrollbar max-h-[min(510px,calc(90vh-142px))] overflow-y-auto p-1.25"
            >
              {results.map((result, index) => (
                <button
                  id={`quick-result-${index}`}
                  key={`${result.path}-${result.line || ''}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={selected === index}
                  tabIndex={-1}
                  className={`grid min-h-9.25 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-sm px-2 py-1.25 text-left hover:bg-white/[.075] hover:text-white ${selected === index ? 'bg-white/[.075] text-white' : 'text-white/65'}`}
                  onMouseEnter={() => setSelected(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setSelected(index)
                    const item = results[index]
                    Promise.resolve(
                      mode === 'text'
                        ? openFile(item.path, { line: item.line, column: item.column })
                        : openFile(item.path)
                    ).catch(console.error)
                    hide()
                  }}
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-mono text-xs">
                      <Highlight
                        text={result.relativePath}
                        query={query}
                        fuzzy={mode === 'files'}
                      />
                    </span>
                    {mode === 'text' && (
                      <span className="truncate font-mono text-[11px] text-white/40">
                        <Highlight text={result.preview} query={query} />
                      </span>
                    )}
                  </span>
                  {mode === 'text' && (
                    <span className="font-mono text-[10px] text-white/30">
                      {result.line}:{result.column}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          {message && (
            <div
              role="status"
              className="grid min-h-13.5 place-items-center px-4 py-3 text-center text-xs text-white/35"
            >
              {message}
            </div>
          )}
        </div>
        <footer className="flex min-h-7.25 shrink-0 items-center justify-between gap-3 border-t border-white/[.07] px-2.5 py-1 text-[10px] text-white/30">
          <span className="truncate">{summary}</span>
          <span className="shrink-0">
            <kbd className="rounded-xs border border-white/10 bg-white/[.04] px-1">↑</kbd>{' '}
            <kbd className="rounded-xs border border-white/10 bg-white/[.04] px-1">↓</kbd> 选择{' '}
            <kbd className="rounded-xs border border-white/10 bg-white/[.04] px-1">Enter</kbd> 打开{' '}
            <kbd className="rounded-xs border border-white/10 bg-white/[.04] px-1">Esc</kbd> 关闭
          </span>
        </footer>
      </section>
    </div>
  )
}
