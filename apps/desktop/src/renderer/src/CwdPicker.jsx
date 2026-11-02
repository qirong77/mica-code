import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconArrowUp, IconFolder, IconFolderOpen } from '@tabler/icons-react'
import { normalizeCwd, rankCwdMatches, splitCwd } from './cwd-recents'
import { useQuickPickAnchor } from './quick-pick-anchor'

export function CwdPicker({
  cwd, invalid, recent = [], onClose, onApply, anchorRef = null,
  error = '', busy = false, ariaLabel = '切换项目目录'
}) {
  const [value, setValue] = useState(cwd || '')
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const inputRef = useRef(null)
  // 面板贴在底栏的目录按钮上方展开（右下角），与左下角的分支切换一致。
  const anchorStyle = useQuickPickAnchor(anchorRef, { align: 'end' })
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  // 没有任何会话记录时至少把当前目录列出来，面板不至于空着
  const entries = useMemo(() => {
    if (recent.length > 0) return recent
    const current = normalizeCwd(cwd)
    return current ? [{ path: current, usedAtMs: 0, sessionCount: 0 }] : []
  }, [recent, cwd])
  const matches = useMemo(() => rankCwdMatches(entries, query), [entries, query])
  useEffect(() => setHighlight(0), [query])
  const activeIndex = Math.min(highlight, Math.max(0, matches.length - 1))
  const activeDir = matches[activeIndex]?.path || ''
  const currentDir = normalizeCwd(cwd)
  const apply = (path) => { if (!busy) onApply(path) }
  const submit = () => {
    const next = value.trim()
    if (next) apply(next)
  }
  const moveHighlight = (step) => {
    if (matches.length === 0) return
    setHighlight((index) => Math.min(Math.max(index + step, 0), matches.length - 1))
  }
  const chooseFolder = () => {
    if (busy) return
    // 浏览器里没有原生目录选择器，改用应用内浏览（浏览的是服务端目录）
    if (window.mica?.isWeb) {
      setPickerOpen(true)
      return
    }
    void window.mica.workspace
      .selectDirectory({ title: '选择工作目录', defaultPath: cwd })
      .then((result) => {
        if (result && !result.canceled && result.path) apply(result.path)
      })
  }
  return (
    <div
      className={`quick-pick-overlay z-[11000]${anchorStyle ? ' is-anchored' : ''}`}
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-busy={busy}
        className="quick-pick-panel"
        style={anchorStyle || undefined}
      >
        <div className="quick-pick-head">
          <input
            ref={inputRef}
            value={query}
            spellCheck={false}
            aria-label="搜索项目目录"
            placeholder="选择项目目录（输入以筛选）"
            className="quick-pick-input"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                moveHighlight(1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                moveHighlight(-1)
              } else if (event.key === 'Enter' && activeDir) {
                event.preventDefault()
                apply(activeDir)
              }
            }}
          />
        </div>
        {invalid && (
          <div className="quick-pick-notice">当前目录不存在或已被移动，请选择正确的项目目录。</div>
        )}
        {error && <div role="alert" className="quick-pick-notice text-danger">{error}</div>}
        <div role="listbox" aria-label="最近目录" className="quick-pick-list">
          <button type="button" className="quick-pick-row" disabled={busy} onClick={chooseFolder}>
            <IconFolderOpen size={15} className="quick-pick-row-icon" />
            <span className="quick-pick-row-title">选择文件夹…</span>
          </button>
          {entries.length > 0 && <div className="quick-pick-separator" />}
          {matches.map((entry, index) => {
            // 末段（项目名）永远完整显示，只把前面那截截断。
            const { head, tail } = splitCwd(entry.path)
            const name = tail || head || '/'
            const active = index === activeIndex
            const isCurrent = normalizeCwd(entry.path) === currentDir
            return (
              <button
                key={entry.path}
                type="button"
                title={entry.path}
                disabled={busy}
                className={`quick-pick-row${active ? ' is-selected' : ''}`}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => apply(entry.path)}
              >
                <IconFolder size={15} className="quick-pick-row-icon" />
                <span className="quick-pick-row-main">
                  <span className="quick-pick-row-title">{name}</span>
                  <span className="quick-pick-row-path">{tail ? head : ''}</span>
                </span>
                <span className="quick-pick-row-tail">
                  {isCurrent ? '当前' : entry.sessionCount ? `${entry.sessionCount} 个会话` : ''}
                </span>
              </button>
            )
          })}
          {matches.length === 0 && <p className="quick-pick-empty">没有匹配的目录</p>}
        </div>
        <footer className="quick-pick-foot">
          <input
            value={value}
            spellCheck={false}
            aria-label="工作目录完整路径"
            placeholder="输入完整路径，如 /Users/name/project"
            className="quick-pick-input"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <button
            type="button"
            disabled={busy || !value.trim()}
            className="shrink-0 rounded-sm px-2 py-0.5 text-[11px] text-fg-strong hover:bg-overlay-strong hover:text-fg-max disabled:text-fg-faint"
            onClick={submit}
          >
            {busy ? '验证中…' : '应用'}
          </button>
        </footer>
      </section>
      {pickerOpen && (
        <DirectoryPicker
          initialPath={value.trim() || cwd}
          onClose={() => setPickerOpen(false)}
          onPick={(dir) => {
            setPickerOpen(false)
            apply(dir)
          }}
        />
      )}
    </div>
  )
}

/** 浏览器端的工作目录选择器：在服务端目录树里逐级浏览，替代 Electron 的原生选择器 */
function DirectoryPicker({ initialPath, onClose, onPick }) {
  const [current, setCurrent] = useState('')
  const [parent, setParent] = useState(null)
  const [entries, setEntries] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (target) => {
    setLoading(true)
    setError('')
    try {
      const result = await window.mica.files.list(target || window.mica.homeDir)
      setCurrent(result?.path || target)
      setParent(result?.parentPath || null)
      setEntries((result?.entries || []).filter((entry) => entry.type === 'directory'))
    } catch (err) {
      setError(err?.message || String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(initialPath) }, [initialPath, load])
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[12000] grid place-items-center bg-black/55 no-drag"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        className="flex h-[min(520px,80vh)] w-[min(520px,calc(100vw-24px))] flex-col overflow-hidden rounded-md border border-line bg-panel/98 shadow-2xl"
      >
        <h2 className="shrink-0 border-b border-line px-3.5 py-2.5 text-sm font-semibold text-fg-max">选择文件夹</h2>
        <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-line px-3.5 py-2">
          <button
            type="button" title="上级目录" aria-label="上级目录" disabled={!parent}
            className="grid size-6 shrink-0 place-items-center rounded-md text-fg-soft hover:bg-overlay-strong hover:text-fg-max disabled:opacity-30"
            onClick={() => void load(parent)}
          >
            <IconArrowUp size={14} />
          </button>
          <span className="min-w-0 flex-1 truncate text-xs text-fg-soft" title={current}>{current || '…'}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
          {error ? (
            <p className="px-2 py-1.5 text-xs leading-5 text-danger">{error}</p>
          ) : loading ? (
            <p className="px-2 py-1.5 text-xs text-fg-muted">读取中…</p>
          ) : entries.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-fg-dim">没有子目录</p>
          ) : entries.map((entry) => (
            <button
              key={entry.path} type="button" title={entry.path}
              className="flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-fg-soft hover:bg-overlay hover:text-fg-max"
              onClick={() => void load(entry.path)}
            >
              <IconFolder size={14} className="shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-3.5 py-2.5">
          <button
            type="button" disabled={!current}
            className="h-9 flex-1 rounded-sm bg-overlay-strong px-3.5 text-xs text-fg-strong hover:bg-overlay-heavy disabled:text-fg-faint"
            onClick={() => current && onPick(current)}
          >选择此文件夹</button>
          <button
            type="button"
            className="h-9 rounded-sm border border-line px-3.5 text-xs text-fg-soft hover:bg-overlay hover:text-fg-max"
            onClick={onClose}
          >取消</button>
        </div>
      </section>
    </div>
  )
}
