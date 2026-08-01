import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronRight,
  Folder,
  FolderOpen,
  ListTree,
  MoreHorizontal,
  Search,
  SquareTerminal,
  X
} from 'lucide-react'
import { childMap } from './workspace'

const rowClass =
  'group relative flex min-h-6.5 cursor-pointer items-center gap-1.5 rounded-sm pr-2 text-[13px] hover:bg-white/[.045] hover:text-white active:bg-white/[.07]'

function RenameInput({ node, onCommit, onCancel }) {
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      defaultValue={node.text}
      spellCheck={false}
      className="h-5 min-w-0 flex-1 rounded-sm border border-white/20 bg-white/[.06] px-1.5 text-[13px] text-white"
      onClick={(event) => event.stopPropagation()}
      onBlur={(event) => onCommit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
    />
  )
}

function ContextMenu({ menu, node, onClose, onAction }) {
  useEffect(() => {
    const close = (event) => {
      if (!event.target.closest?.('[data-session-menu]')) onClose()
    }
    const escape = (event) => event.key === 'Escape' && onClose()
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [onClose])

  const items = [
    ['rename', '重命名'],
    ...(node.type === 'folder'
      ? [
          ['createFolder', '新建文件夹'],
          ['createTerminal', 'NEW SESSION'],
          ['setDefaultPath', '设置默认路径…']
        ]
      : []),
    ['remove', '删除']
  ]
  return createPortal(
    <div
      data-session-menu
      className="fixed z-[10000] min-w-37 rounded-md border border-white/15 bg-[#181818]/98 p-1.5 shadow-2xl backdrop-blur"
      style={{ top: menu.y, left: menu.x }}
    >
      {items.map(([action, label]) => (
        <button
          key={action}
          type="button"
          className={`block w-full rounded-sm px-2.5 py-1.5 text-left text-xs hover:bg-white/[.07] ${action === 'remove' ? 'text-[#e75e78]' : 'text-white/90'}`}
          onClick={() => {
            onClose()
            onAction(action, node)
          }}
        >
          {label}
        </button>
      ))}
    </div>,
    document.body
  )
}

export function SessionTree({
  nodes,
  selectedId,
  editingId,
  unread,
  sessions,
  titles,
  onSelect,
  onSelectRecent,
  onToggle,
  onRename,
  onCancelEdit,
  onStartEdit,
  onMove,
  onAction
}) {
  const children = useMemo(() => childMap(nodes), [nodes])
  const [menu, setMenu] = useState(null)
  const [drag, setDrag] = useState(null)
  const [query, setQuery] = useState('')
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false)
  const [recentCollapsed, setRecentCollapsed] = useState(false)
  const closeMenu = () => setMenu(null)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const displayText = (node) =>
    node.type === 'terminal' && node.sessionId && titles?.[node.sessionId]?.title
      ? titles[node.sessionId].title
      : node.text
  const recentSessions = useMemo(() => {
    const source = sessions || []
    if (!normalizedQuery) return source.slice(0, 8)
    return source
      .filter((session) =>
        (session.title || session.id || '').toLocaleLowerCase().includes(normalizedQuery)
      )
      .slice(0, 8)
  }, [sessions, normalizedQuery])

  const matchesQuery = (node) => {
    if (!normalizedQuery) return true
    if (displayText(node).toLocaleLowerCase().includes(normalizedQuery)) return true
    return (children.get(node.id) || []).some(matchesQuery)
  }

  const openMenu = (event, node) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      id: node.id,
      x: Math.max(4, Math.min(event.clientX, window.innerWidth - 160)),
      y: Math.max(4, Math.min(event.clientY, window.innerHeight - 190))
    })
  }

  const renderChildren = (parent = '#', depth = 0) =>
    (children.get(parent) || []).filter(matchesQuery).map((node) => {
      const folder = node.type === 'folder'
      const opened = folder && (normalizedQuery || node.state.opened)
      const state = unread[node.id]
      const running = !folder && state?.running
      const hasUnread = !folder && !running && state?.unread
      const selected = node.id === selectedId
      const target = drag?.targetId === node.id ? drag.position : null
      return (
        <li key={node.id} role="treeitem" aria-expanded={folder ? opened : undefined}>
          <div
            data-node-id={node.id}
            draggable={editingId !== node.id}
            className={`${rowClass} ${selected ? 'bg-white/[.075] text-white' : 'text-white/70'} ${drag?.id === node.id ? 'opacity-45' : ''} ${target === 'inside' ? 'ring-1 ring-inset ring-white/30' : ''}`}
            style={{ paddingLeft: 7 + depth * 14 }}
            title={node.cwd ? `${displayText(node)} — ${node.cwd}` : displayText(node)}
            onClick={() => {
              onSelect(node)
              if (folder) onToggle(node.id)
            }}
            onDoubleClick={() => !folder && onStartEdit(node.id)}
            onContextMenu={(event) => openMenu(event, node)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', node.id)
              setDrag({ id: node.id, targetId: null, position: null })
            }}
            onDragOver={(event) => {
              if (!drag || drag.id === node.id) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              const ratio =
                (event.clientY - event.currentTarget.getBoundingClientRect().top) /
                event.currentTarget.offsetHeight
              const position =
                folder && ratio > 0.25 && ratio < 0.75 ? 'inside' : ratio < 0.5 ? 'before' : 'after'
              setDrag((value) => ({ ...value, targetId: node.id, position }))
            }}
            onDrop={(event) => {
              event.preventDefault()
              if (drag?.targetId) onMove(drag.id, drag.targetId, drag.position)
              setDrag(null)
            }}
            onDragEnd={() => setDrag(null)}
          >
            {target === 'before' && <span className="absolute inset-x-2 top-0 h-px bg-white/70" />}
            {target === 'after' && (
              <span className="absolute inset-x-2 bottom-0 h-px bg-white/70" />
            )}
            {folder ? (
              <button
                type="button"
                aria-label={opened ? '折叠' : '展开'}
                className="grid size-3.5 shrink-0 place-items-center text-white/35"
                onClick={(event) => {
                  event.stopPropagation()
                  onToggle(node.id)
                }}
              >
                <ChevronRight size={13} className={opened ? 'rotate-90' : ''} />
              </button>
            ) : (
              <span className="size-3.5 shrink-0" />
            )}
            <span className="grid size-3.5 shrink-0 place-items-center text-white/50">
              {folder ? (
                opened ? (
                  <FolderOpen size={14} />
                ) : (
                  <Folder size={14} />
                )
              ) : (
                <SquareTerminal size={14} />
              )}
            </span>
            {editingId === node.id ? (
              <RenameInput
                node={node}
                onCommit={(value) => onRename(node.id, value)}
                onCancel={onCancelEdit}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{displayText(node)}</span>
            )}
            {running && (
              <span className="size-1.75 shrink-0 animate-pulse rounded-full bg-[#46c57a] ring-2 ring-[#46c57a]/15" />
            )}
            {hasUnread && (
              <span className="size-1.75 shrink-0 rounded-full bg-[#5aa9ff] ring-2 ring-[#5aa9ff]/20" />
            )}
            <button
              type="button"
              title="更多操作"
              aria-label="更多操作"
              className="grid size-5 shrink-0 place-items-center rounded text-white/40 opacity-0 hover:bg-white/[.1] hover:text-white group-hover:opacity-100 focus:opacity-100"
              onClick={(event) => openMenu(event, node)}
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
          {opened && <ul role="group">{renderChildren(node.id, depth + 1)}</ul>}
        </li>
      )
    })

  const menuNode = menu && nodes.find((node) => node.id === menu.id)
  return (
    <>
      <div className="thin-scrollbar min-h-0 flex-1 overflow-auto px-2 pb-4 pt-1 no-drag">
        <div className="mb-1 flex items-center gap-1.5 border-b border-transparent px-2 pt-1 focus-within:border-white/20">
          <Search size={14} className="shrink-0 text-white/40" />
          <input
            type="search"
            value={query}
            placeholder="搜索会话..."
            aria-label="搜索会话"
            className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-white placeholder:text-white/35 focus:outline-none"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              title="清除搜索"
              aria-label="清除搜索"
              className="grid size-5 place-items-center rounded text-white/40 hover:bg-white/[.08] hover:text-white"
              onClick={() => setQuery('')}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <section className="pb-3">
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2 px-2 pt-1 text-left text-[11px] font-semibold uppercase tracking-[.18em] text-white/75 hover:text-white"
            aria-expanded={!sessionsCollapsed}
            onClick={() => setSessionsCollapsed((value) => !value)}
          >
            <ChevronRight
              size={14}
              className={`text-white/55 transition-transform ${sessionsCollapsed ? '' : 'rotate-90'}`}
            />
            <span className="flex items-center gap-2">
              <ListTree size={14} className="text-white/55" />
              Sessions
            </span>
          </button>
          {!sessionsCollapsed && (
            <ul role="tree" className="flex flex-col gap-px">
              {renderChildren()}
            </ul>
          )}
        </section>
        <section>
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2 px-2 pt-1 text-left text-[11px] font-semibold uppercase tracking-[.18em] text-white/75 hover:text-white"
            aria-expanded={!recentCollapsed}
            onClick={() => setRecentCollapsed((value) => !value)}
          >
            <ChevronRight
              size={14}
              className={`text-white/55 transition-transform ${recentCollapsed ? '' : 'rotate-90'}`}
            />
            <ListTree size={14} className="text-white/55" />
            Recent
          </button>
          {!recentCollapsed &&
            (recentSessions.length ? (
              <ul className="flex flex-col gap-px" aria-label="最近会话">
                {recentSessions.map((session) => {
                  const running = session.turnState === 'running'
                  const isSelected = nodes.some(
                    (node) => node.id === selectedId && node.sessionId === session.id
                  )
                  return (
                    <li key={session.id}>
                      <button
                        type="button"
                        title={
                          session.cwd
                            ? `${session.title || session.id} — ${session.cwd}`
                            : session.title || session.id
                        }
                        className={`${rowClass} ml-5 w-[calc(100%-1.25rem)] px-2 text-left ${isSelected ? 'bg-white/[.075] text-white' : 'text-white/70'}`}
                        onClick={() => onSelectRecent(session)}
                      >
                        <SquareTerminal size={14} className="shrink-0 text-white/50" />
                        <span className="min-w-0 flex-1 truncate">
                          {session.title || session.id}
                        </span>
                        {running && (
                          <span className="size-1.75 shrink-0 animate-pulse rounded-full bg-[#46c57a]" />
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="py-1 pl-7 pr-2 text-xs text-white/35">暂无最近会话。</p>
            ))}
        </section>
      </div>
      {menuNode && (
        <ContextMenu menu={menu} node={menuNode} onClose={closeMenu} onAction={onAction} />
      )}
    </>
  )
}
