import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconCheck, IconGitBranch, IconGitFork, IconPlus, IconTag } from '@tabler/icons-react'
import { formatTracking, relativeDateZh } from './git-refs'
import { useQuickPickAnchor } from './quick-pick-anchor'

const actions = [
  { id: 'create', label: '创建新分支…', icon: IconPlus },
  { id: 'createFrom', label: '从…创建新分支…', icon: IconGitFork }
]

const searchable = (item) =>
  [item.name, item.subject, item.author, item.hash, item.upstream].filter(Boolean).join(' ')

const detailOf = (item) =>
  [item.author, item.hash, item.subject].filter(Boolean).join(' · ') || item.ref

function RefRowBody({ item }) {
  return (
    <>
      <span className="quick-pick-row-main">
        <span className="quick-pick-row-title">{item.name}</span>
        {item.current && <IconCheck size={13} className="shrink-0 text-info-soft" />}
        {item.tracking && (
          <span className="quick-pick-row-meta">{formatTracking(item.tracking)}</span>
        )}
        {item.date && <span className="quick-pick-row-meta">{relativeDateZh(item.date)}</span>}
      </span>
      <span className="quick-pick-row-tail">
        {item.current ? '当前' : item.kind === 'tag' ? '标签' : '分支'}
      </span>
      <span className="quick-pick-row-detail">{detailOf(item)}</span>
    </>
  )
}

export function BranchPicker({ cwd, askText, canOperate, onChanged, onClose, anchorRef = null }) {
  const [refs, setRefs] = useState({ branches: [], tags: [] })
  const [mode, setMode] = useState('main')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 面板贴着底栏的分支按钮往上长：鼠标不用从按钮跑到屏幕顶部再跑回来。
  const anchorStyle = useQuickPickAnchor(anchorRef)
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
      setRefs({
        branches: (response?.refs?.branches || []).filter((item) => item.kind !== 'remote'),
        tags: response?.refs?.tags || []
      })
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
          setMode('from')
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
      if (item.current) onClose()
      else await operate(() => window.mica.git.checkout(cwd, item.ref))
    },
    [busy, create, cwd, loading, mode, onClose, operate]
  )

  const title = mode === 'from' ? '选择新分支的起点' : '选择要签出的分支或标记'
  const hint = mode === 'from' ? 'Esc 返回' : 'Esc 关闭'

  return (
    <div
      className={`quick-pick-overlay z-[10000]${anchorStyle ? ' is-anchored' : ''}`}
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="quick-pick-panel"
        style={anchorStyle || undefined}
      >
        <div className="quick-pick-head">
          <input
            ref={inputRef}
            value={query}
            disabled={busy}
            aria-label={title}
            placeholder={title}
            spellCheck={false}
            className="quick-pick-input"
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
        </div>

        {error && <div className="quick-pick-notice">{error}</div>}

        <div role="listbox" aria-label={title} className="quick-pick-list">
          {loading && <p className="quick-pick-empty">正在读取 Git 分支…</p>}
          {!loading && !items.length && <p className="quick-pick-empty">没有匹配的分支或标签</p>}
          {!loading &&
            items.map((item, index) => {
              const Icon = item.icon || (item.kind === 'tag' ? IconTag : IconGitBranch)
              const active = index === selected
              // 动作项与 ref 列表之间画一条分隔线（VS Code quick pick 的分组线）
              const separator =
                item.type === 'ref' && index > 0 && items[index - 1].type === 'action'
              if (item.type === 'action') {
                return (
                  <Fragment key={item.id}>
                    {separator && <div className="quick-pick-separator" />}
                    <button
                      ref={active ? selectedRef : null}
                      type="button"
                      tabIndex={-1}
                      role="option"
                      aria-selected={active}
                      disabled={busy}
                      className={`quick-pick-row${active ? ' is-selected' : ''}`}
                      onMouseEnter={() => setSelected(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(item)}
                    >
                      <Icon size={15} className="quick-pick-row-icon" />
                      <span className="quick-pick-row-title">{item.label}</span>
                    </button>
                  </Fragment>
                )
              }
              return (
                <Fragment key={item.ref}>
                  {separator && <div className="quick-pick-separator" />}
                  <button
                    ref={active ? selectedRef : null}
                    type="button"
                    tabIndex={-1}
                    role="option"
                    aria-selected={active}
                    disabled={busy}
                    className={`quick-pick-row is-multiline${active ? ' is-selected' : ''}`}
                    onMouseEnter={() => setSelected(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(item)}
                  >
                    <Icon size={15} className="quick-pick-row-icon" />
                    <RefRowBody item={item} />
                  </button>
                </Fragment>
              )
            })}
        </div>

        <footer className="quick-pick-status">
          <span title={refs.root || cwd}>{refs.root || cwd}</span>
          <span>{busy ? '正在执行 Git 操作…' : `↑↓ 选择 · Enter 确认 · ${hint}`}</span>
        </footer>
      </section>
    </div>
  )
}
