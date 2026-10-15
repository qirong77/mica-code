import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheck,
  IconGitBranch,
  IconGitCompare,
  IconSearch,
  IconTag,
  IconX
} from '@tabler/icons-react'
import { comparePickerItems } from './git-compare-model'

/** A read-only quick pick. The panel owns comparison mode; choosing a ref preserves it. */
export function GitComparePicker({ cwd, current, onPick, onClose }) {
  const [refs, setRefs] = useState(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [resolving, setResolving] = useState(false)
  const [retry, setRetry] = useState(0)
  const dialogRef = useRef(null)
  const inputRef = useRef(null)
  const requestRef = useRef(0)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const id = useId()
  const items = useMemo(() => comparePickerItems(refs, current, query), [refs, current, query])
  const commitQuery = query.trim()
  const optionCount = items.length + Number(Boolean(commitQuery))
  const activeIndex = Math.min(active, Math.max(0, optionCount - 1))

  useEffect(() => {
    const previous = document.activeElement
    inputRef.current?.focus()
    return () => {
      requestRef.current += 1
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setRefs(null)
    Promise.resolve()
      .then(() => window.mica.git.refs(cwd))
      .then((response) => {
        if (cancelled) return
        if (response?.error) throw new Error(response.error)
        setRefs(response?.refs || response || { branches: [], tags: [] })
      })
      .catch((failure) => {
        if (!cancelled) setError(failure?.message || String(failure))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cwd, retry])

  useEffect(() => {
    dialogRef.current
      ?.querySelector(`[data-option-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, query, refs])

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', closeOnEscape, true)
    return () => document.removeEventListener('keydown', closeOnEscape, true)
  }, [])

  async function choose(index) {
    if (resolving) return
    if (items[index]) {
      const { kind, ref, name } = items[index]
      onPick({ kind, ref, name, direct: Boolean(current?.direct) })
      return
    }
    if (!commitQuery) return
    const request = ++requestRef.current
    setResolving(true)
    setError('')
    try {
      const result = await window.mica.git.resolveRef(cwd, commitQuery)
      if (request !== requestRef.current) return
      if (result?.error || !result?.ref?.hash)
        throw new Error(result?.error || '无法解析这个 Git 引用')
      onPick({
        kind: 'commit',
        ref: result.ref.hash,
        name: result.ref.name || commitQuery,
        direct: Boolean(current?.direct)
      })
    } catch (failure) {
      if (request === requestRef.current) setError(failure?.message || String(failure))
    } finally {
      if (request === requestRef.current) setResolving(false)
    }
  }

  function handleKey(event) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Tab') {
      const controls = [
        ...dialogRef.current.querySelectorAll('input:not(:disabled), button:not(:disabled)')
      ]
      const first = controls[0]
      const last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
      return
    }
    if (event.target !== inputRef.current) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(
        (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + optionCount) %
          Math.max(1, optionCount)
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void choose(activeIndex)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[11000] bg-black/25"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="absolute left-1/2 top-[max(48px,8vh)] flex max-h-[min(560px,80vh)] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-md border border-white/15 bg-panel text-white/85 shadow-2xl"
        onKeyDown={handleKey}
      >
        <div className="flex h-9 shrink-0 items-center gap-2 px-3">
          <IconGitCompare size={16} className="text-white/55" />
          <span id={`${id}-title`} className="flex-1 text-[12px] font-semibold">
            选择比较基线
          </span>
          <button
            type="button"
            title="关闭"
            aria-label="关闭基线选择器"
            onClick={onClose}
            className="grid size-6 place-items-center rounded-sm text-white/50 hover:bg-white/10 hover:text-white"
          >
            <IconX size={15} />
          </button>
        </div>
        <div className="mx-2 mb-2 flex h-8 shrink-0 items-center gap-2 rounded-sm border border-accent/70 bg-white/[.03] px-2">
          <IconSearch size={15} className="shrink-0 text-white/45" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="搜索分支、标签或输入提交"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-options`}
            aria-activedescendant={optionCount ? `${id}-option-${activeIndex}` : undefined}
            placeholder="搜索分支、标签，或输入提交 / Git 引用…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            disabled={resolving}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-white/35"
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
              setError('')
            }}
          />
          {resolving && (
            <span role="status" className="shrink-0 text-[11px] text-white/50">
              验证中…
            </span>
          )}
        </div>
        {error && (
          <div role="alert" className="mx-3 mb-2 text-[12px] text-danger-soft">
            {error}
            {!refs && !loading && (
              <button
                type="button"
                onClick={() => setRetry((value) => value + 1)}
                className="ml-2 text-info-soft underline"
              >
                重新读取
              </button>
            )}
          </div>
        )}
        {loading && (
          <div role="status" className="px-3 pb-2 text-[12px] text-white/45">
            正在读取分支与标签…
          </div>
        )}
        <div
          id={`${id}-options`}
          role="listbox"
          aria-label="比较基线"
          className="min-h-0 overflow-y-auto px-1 pb-1"
        >
          {items.map((item, index) => {
            const Icon =
              item.kind === 'tag' ? IconTag : item.kind === 'auto' ? IconGitCompare : IconGitBranch
            return (
              <div key={item.id} role="presentation">
                {item.group !== items[index - 1]?.group && (
                  <div className="px-2 pb-1 pt-2 text-[11px] text-white/40">{item.group}</div>
                )}
                <div
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={activeIndex === index}
                  aria-disabled={resolving}
                  data-option-index={index}
                  className={`flex h-9 cursor-default items-center gap-2 rounded-sm px-2 ${activeIndex === index ? 'bg-accent/20 text-white' : 'hover:bg-list-hover'}`}
                  onPointerMove={() => setActive(index)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => void choose(index)}
                >
                  <Icon size={16} className="shrink-0 text-white/55" />
                  <span
                    className="min-w-0 flex-1 truncate text-[13px]"
                    title={item.ref || item.hint}
                  >
                    {item.name}
                  </span>
                  <span className="max-w-[45%] truncate text-[11px] text-white/40">
                    {item.hint}
                  </span>
                  {item.current && <IconCheck size={15} className="shrink-0 text-info-soft" />}
                </div>
              </div>
            )
          })}
          {commitQuery && (
            <div
              id={`${id}-option-${items.length}`}
              role="option"
              aria-selected={activeIndex === items.length}
              aria-disabled={resolving}
              data-option-index={items.length}
              className={`mt-1 flex min-h-9 cursor-default items-center gap-2 rounded-sm border-t border-white/[.06] px-2 text-[13px] ${activeIndex === items.length ? 'bg-accent/20 text-white' : 'hover:bg-list-hover'}`}
              onPointerMove={() => setActive(items.length)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => void choose(items.length)}
            >
              <IconGitCompare size={16} className="shrink-0 text-white/55" />
              <span className="min-w-0 flex-1 truncate">使用引用「{commitQuery}」</span>
              <span className="shrink-0 text-[11px] text-white/40">验证提交</span>
            </div>
          )}
        </div>
        <div className="shrink-0 border-t border-white/[.08] px-3 py-2 text-[11px] text-white/40">
          ↑ ↓ 选择 · Enter 确认 · Esc 关闭
        </div>
      </div>
    </div>,
    document.body
  )
}
