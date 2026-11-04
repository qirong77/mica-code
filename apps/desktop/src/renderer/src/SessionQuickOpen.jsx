import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { IconSearch, IconX } from '@tabler/icons-react'
import { Highlighted } from './SessionTree'
import { relativeTimeShort } from './relative-time'
import { liveSessionRowState } from './session-state'
import { groupById } from './session-projects'
import { buildSessionQuickOpenItems } from './session-quick-open-rows'

/**
 * 会话运行状态位：与侧栏同一套颜色（绿=运行中、红=上一轮失败、蓝=有未读）。
 * 没有状态时也占位，否则各行的标题列会随状态多少左右跳。
 */
function StateDot({ state }) {
  if (state === 'running') {
    return (
      <span
        className="size-2 shrink-0 rounded-full bg-success chat-dot-running"
        title="对话正在运行"
      />
    )
  }
  if (state === 'error') {
    return (
      <span className="size-2 shrink-0 rounded-full bg-danger" title="上一轮没有正常运行完成" />
    )
  }
  if (state === 'unread') {
    return <span className="size-2 shrink-0 rounded-full bg-info" title="有未读结果" />
  }
  return <span aria-hidden="true" className="size-2 shrink-0" />
}

/**
 * ⌘P 快速打开会话：主区顶部居中的一层（VS Code quick pick 的位置与交互）。
 *
 * 它盖在对话区上方而不是全窗口：红框就是它该出现的地方，左侧会话列表与顶栏仍然
 * 可读。点浮层外面或按 Esc 关闭，↑↓ 选择，Enter 打开；打开之后由调用方收起
 * （调用方还要负责切视图、复用页签）。
 *
 * 只按标题、目录与所在分组匹配，不搜对话正文——那要读会话文件，快速打开必须打字
 * 就有结果。正文搜索在侧栏（⌘K）。
 */
export function SessionQuickOpen({
  sessions,
  projects,
  openBySession,
  unread,
  onClose,
  onOpenSession
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const id = useId()

  const groups = useMemo(() => groupById(projects), [projects])
  const { items, total } = useMemo(() => {
    const assignments = projects?.assignments || {}
    return buildSessionQuickOpenItems({
      sessions,
      query,
      groupNameOf: (sessionId) => groups.get(assignments[sessionId])?.name || ''
    })
  }, [sessions, query, groups, projects])
  const activeIndex = items.length ? Math.min(active, items.length - 1) : -1

  useEffect(() => {
    const focus = () => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.select()
    }
    focus()
    // 挂载这一帧别处（终端、编辑器）可能刚把焦点拿回去：下一帧确认一次，
    // 否则浮层开着、字却打在对话输入框里。
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== inputRef.current) focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  // 结果变了之后选中项可能已经不在列表里，收敛回最后一条。
  useEffect(() => {
    setActive((index) => (items.length ? Math.min(index, items.length - 1) : 0))
  }, [items])

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-quick-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, items])

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

  // 浮层只盖住对话区，点侧栏或顶栏时窗口里别处仍然可点；那种点击先把它收起来，
  // 与 VS Code 的 quick open 一致（否则「点了会话、浮层还挂在那里」）。
  useEffect(() => {
    const closeOutside = (event) => {
      if (event.target instanceof Element && event.target.closest('[data-session-quick-open]'))
        return
      onCloseRef.current()
    }
    window.addEventListener('pointerdown', closeOutside, true)
    return () => window.removeEventListener('pointerdown', closeOutside, true)
  }, [])

  const choose = (item) => {
    if (item) onOpenSession(item.session)
  }

  const handleKey = (event) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!items.length) return
      event.preventDefault()
      setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      if (!items.length) return
      event.preventDefault()
      setActive((index) =>
        Math.min(items.length - 1, Math.max(0, index + (event.key === 'PageDown' ? 10 : -10)))
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(items[activeIndex])
    }
  }

  return (
    <div
      data-session-quick-open=""
      className="absolute inset-0 z-[60]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="快速打开会话"
        className="absolute left-1/2 top-2 flex max-h-[min(520px,calc(100%-16px))] w-[min(680px,calc(100%-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-md border border-line-strong bg-panel/98 text-fg-strong shadow-2xl backdrop-blur"
        onKeyDown={handleKey}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-soft px-3">
          <IconSearch size={15} className="shrink-0 text-fg-muted" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="按标题、路径或分组搜索会话"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-options`}
            aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
            placeholder="按标题、路径或分组搜索会话…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg-max outline-none placeholder:text-fg-dim"
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
          />
          {query && (
            <button
              type="button"
              title="清除搜索"
              aria-label="清除搜索"
              className="grid size-5 shrink-0 place-items-center rounded text-fg-muted hover:bg-overlay-strong hover:text-fg-max"
              onClick={() => {
                setQuery('')
                setActive(0)
                inputRef.current?.focus()
              }}
            >
              <IconX size={14} />
            </button>
          )}
        </div>

        <div
          ref={listRef}
          id={`${id}-options`}
          role="listbox"
          aria-label="会话"
          className="min-h-0 overflow-y-auto px-1 py-1"
        >
          {items.map((item, index) => {
            const state = liveSessionRowState({
              notificationState: unread?.[openBySession?.[item.session.id]],
              interrupted: item.session.interrupted,
              remoteRunning: item.session.remoteRunning,
              awaiting: item.session.awaiting
            })
            // 目录命中时右列直接展示完整路径（能看到命中的那一段），否则只给「分组 · 目录名」。
            const pathLine = item.cwdRanges.length
              ? item.cwd
              : [item.groupName, item.cwdLabel].filter(Boolean).join(' · ')
            return (
              <div
                key={item.id}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={activeIndex === index}
                data-quick-index={index}
                className={`flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-[13px] ${
                  activeIndex === index
                    ? 'bg-active text-fg-max'
                    : 'text-fg-strong hover:bg-list-hover'
                }`}
                onPointerMove={() => setActive(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(item)}
              >
                <StateDot state={state} />
                <span className="min-w-0 flex-1 truncate" title={item.title}>
                  <Highlighted text={item.title} ranges={item.titleRanges} />
                </span>
                <span
                  className="max-w-[45%] min-w-0 truncate text-[11px] text-fg-muted"
                  title={item.cwd || item.groupName}
                >
                  {item.cwdRanges.length ? (
                    <Highlighted text={pathLine} ranges={item.cwdRanges} />
                  ) : (
                    pathLine
                  )}
                </span>
                <span className="shrink-0 text-[11px] text-fg-dim tabular-nums">
                  {relativeTimeShort(item.updatedAtMs)}
                </span>
              </div>
            )
          })}
          {!items.length && (
            <div role="presentation" className="px-3 py-3 text-[12px] text-fg-muted">
              {sessions?.length ? '没有匹配的会话。' : '还没有可打开的会话。'}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line-soft px-3 py-1.5 text-[11px] text-fg-muted">
          <span>↑ ↓ 选择 · Enter 打开 · Esc 关闭</span>
          <span className="ml-auto tabular-nums" title={`${total} 个匹配的会话`}>
            {items.length === total ? `${total} 个会话` : `${items.length} / ${total}`}
          </span>
        </div>
      </div>
    </div>
  )
}
