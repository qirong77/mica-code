import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, GitBranch, GitBranchPlus, Plus, Tag, Unplug } from 'lucide-react'

const actions = [
  { id: 'create', label: '创建新分支…', icon: Plus },
  { id: 'createFrom', label: '从…创建新分支…', icon: GitBranchPlus },
  { id: 'detached', label: '签出已分离…', icon: Unplug }
]

const searchable = (item) =>
  [item.name, item.subject, item.author, item.hash, item.upstream].filter(Boolean).join(' ')

function RefRow({ item }) {
  const Icon = item.kind === 'tag' ? Tag : GitBranch
  return (
    <>
      <Icon size={15} className="mt-0.5 shrink-0 text-white/55" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <strong className="truncate text-[13px] font-medium text-white/90">{item.name}</strong>
          {item.current && <Check size={13} className="shrink-0 text-[#4fa7ff]" />}
          {item.tracking && (
            <span className="shrink-0 text-[11px] text-white/40">{item.tracking}</span>
          )}
          {item.date && <span className="shrink-0 text-[11px] text-white/35">{item.date}</span>}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-white/38">
          {[item.author, item.hash, item.subject].filter(Boolean).join(' · ') || item.ref}
        </span>
      </span>
      <span className="shrink-0 text-[11px] text-white/30">
        {item.current ? '当前' : item.kind === 'tag' ? '标签' : '分支'}
      </span>
    </>
  )
}

export function BranchPicker({ cwd, askText, canOperate, onChanged, onClose }) {
  const [refs, setRefs] = useState({ branches: [], tags: [] })
  const [mode, setMode] = useState('main')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)
  const selectedRef = useRef(null)
  const requestRef = useRef(0)

  const load = useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true)
    setError('')
    setRefs({ branches: [], tags: [] })
    setSelected(0)
    try {
      const response = await window.mica.git.refs(cwd)
      if (request !== requestRef.current) return
      if (response?.error) throw new Error(response.error)
      setRefs(response?.refs || { branches: [], tags: [] })
    } catch (loadError) {
      if (request === requestRef.current) setError(loadError?.message || String(loadError))
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    setMode('main')
    setQuery('')
    setSelected(0)
    load()
    inputRef.current?.focus()
    return () => {
      requestRef.current += 1
    }
  }, [load])

  const items = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const matches = (item) => !needle || searchable(item).toLocaleLowerCase().includes(needle)
    if (mode === 'main') {
      const actionItems = actions
        .filter((item) => !needle || item.label.toLocaleLowerCase().includes(needle))
        .map((item) => ({ ...item, type: 'action' }))
      return [
        ...actionItems,
        ...refs.branches.filter(matches).map((item) => ({ ...item, type: 'ref' }))
      ]
    }
    return [...refs.branches, ...refs.tags]
      .filter(matches)
      .map((item) => ({ ...item, type: 'ref' }))
  }, [mode, query, refs])

  useEffect(() => setSelected(0), [mode, query, refs])
  useEffect(() => selectedRef.current?.scrollIntoView({ block: 'nearest' }), [selected])

  const restoreFocus = () => requestAnimationFrame(() => inputRef.current?.focus())
  const operate = useCallback(
    async (operation) => {
      const blocked = canOperate?.()
      if (blocked) {
        setError(blocked)
        return
      }
      setBusy(true)
      setError('')
      try {
        const response = await operation()
        if (response?.error) throw new Error(response.error)
        await onChanged(response?.status)
        onClose()
      } catch (operationError) {
        setError(operationError?.message || String(operationError))
      } finally {
        setBusy(false)
        restoreFocus()
      }
    },
    [canOperate, onChanged, onClose]
  )

  const create = useCallback(
    async (startRef = null) => {
      const blocked = canOperate?.()
      if (blocked) {
        setError(blocked)
        return
      }
      const name = await askText(
        '创建新分支',
        '',
        startRef ? `新分支将基于 ${startRef.name} 创建并立即签出。` : '创建后将立即签出新分支。'
      )
      if (name === null) {
        restoreFocus()
        return
      }
      await operate(() => window.mica.git.createBranch(cwd, name, startRef?.ref || null))
    },
    [askText, canOperate, cwd, operate]
  )

  const choose = useCallback(
    async (item) => {
      if (!item || busy || loading) return
      if (item.type === 'action') {
        if (item.id === 'create') await create()
        else {
          setMode(item.id === 'createFrom' ? 'from' : 'detached')
          setQuery('')
          setError('')
          restoreFocus()
        }
        return
      }
      if (mode === 'from') {
        await create(item)
        return
      }
      if (mode === 'detached') {
        await operate(() => window.mica.git.checkout(cwd, item.ref, true))
        return
      }
      if (item.current) onClose()
      else await operate(() => window.mica.git.checkout(cwd, item.ref))
    },
    [busy, create, cwd, loading, mode, onClose, operate]
  )

  const title =
    mode === 'from'
      ? '选择新分支的起点'
      : mode === 'detached'
        ? '选择要签出的分支或标签'
        : '选择要签出的分支'

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center bg-black/35 px-4 pt-[76px] backdrop-blur-[2px] no-drag"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-[min(760px,calc(100vw-32px))] overflow-hidden rounded-md border border-white/15 bg-[#202021]/98 shadow-[0_18px_70px_rgba(0,0,0,.55)]"
      >
        <div className="border-b border-white/10 p-2.5">
          <input
            ref={inputRef}
            value={query}
            disabled={busy}
            aria-label={title}
            placeholder={title}
            spellCheck={false}
            className="h-9 w-full rounded-sm border border-[#1684d8] bg-white/[.06] px-3 text-[13px] text-white outline-none placeholder:text-white/35 focus:border-[#2899eb] focus:ring-1 focus:ring-[#2899eb]/30"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'w') {
                event.preventDefault()
                if (!busy) onClose()
                return
              }
              if (event.key === 'Tab') {
                event.preventDefault()
                return
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const direction = event.key === 'ArrowDown' ? 1 : -1
                setSelected(
                  (value) => (value + direction + items.length) % Math.max(items.length, 1)
                )
              } else if (event.key === 'Enter') {
                event.preventDefault()
                choose(items[selected])
              } else if (event.key === 'Escape') {
                event.preventDefault()
                if (mode === 'main') onClose()
                else {
                  setMode('main')
                  setQuery('')
                  setError('')
                }
              }
            }}
          />
          <div className="mt-2 flex items-center justify-between gap-3 px-1 text-[11px] text-white/35">
            <span className="truncate">{refs.root || cwd}</span>
            <span className="shrink-0">↑↓ 选择 · Enter 确认 · Esc 返回</span>
          </div>
        </div>

        {error && (
          <div className="border-b border-[#d46a6a]/25 bg-[#d46a6a]/10 px-3 py-2 text-xs leading-5 text-[#ffaaaa]">
            {error}
          </div>
        )}

        <div role="listbox" className="max-h-[62vh] overflow-y-auto p-1.5">
          {loading && (
            <p className="px-2.5 py-5 text-center text-xs text-white/35">正在读取 Git 分支…</p>
          )}
          {!loading && !items.length && (
            <p className="px-2.5 py-5 text-center text-xs text-white/35">没有匹配的分支或标签</p>
          )}
          {!loading &&
            items.map((item, index) => {
              const Icon = item.icon
              return (
                <button
                  ref={index === selected ? selectedRef : null}
                  key={item.type === 'action' ? item.id : item.ref}
                  type="button"
                  tabIndex={-1}
                  role="option"
                  aria-selected={index === selected}
                  disabled={busy}
                  className={`flex w-full items-start gap-2.5 rounded-sm px-2.5 text-left transition-colors ${
                    item.type === 'action' ? 'min-h-9 items-center' : 'min-h-12 py-1.5'
                  } ${index === selected ? 'bg-[#075b91] text-white' : 'text-white/75 hover:bg-white/[.06]'}`}
                  onMouseEnter={() => setSelected(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(item)}
                >
                  {item.type === 'action' ? (
                    <>
                      <Icon size={16} className="shrink-0" />
                      <span className="text-[13px] font-medium">{item.label}</span>
                    </>
                  ) : (
                    <RefRow item={item} />
                  )}
                </button>
              )
            })}
        </div>
        {busy && (
          <div className="border-t border-white/10 px-3 py-2 text-xs text-white/45">
            正在执行 Git 操作…
          </div>
        )}
      </section>
    </div>
  )
}
