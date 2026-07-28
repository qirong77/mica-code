import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, Folder, FolderOpen, SquareTerminal } from 'lucide-react'
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
          ['createTerminal', '新建终端'],
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
  onSelect,
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
  const closeMenu = () => setMenu(null)

  const renderChildren = (parent = '#', depth = 0) =>
    (children.get(parent) || []).map((node) => {
      const folder = node.type === 'folder'
      const opened = folder && node.state.opened
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
            title={node.cwd ? `${node.text} — ${node.cwd}` : node.text}
            onClick={() => {
              onSelect(node)
              if (folder) onToggle(node.id)
            }}
            onDoubleClick={() => !folder && onStartEdit(node.id)}
            onContextMenu={(event) => {
              event.preventDefault()
              const x = Math.min(event.clientX, window.innerWidth - 160)
              const y = Math.min(event.clientY, window.innerHeight - (folder ? 190 : 80))
              setMenu({ id: node.id, x: Math.max(4, x), y: Math.max(4, y) })
            }}
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
              <span className="min-w-0 flex-1 truncate">{node.text}</span>
            )}
            {running && (
              <span className="size-1.75 shrink-0 animate-pulse rounded-full bg-[#46c57a] ring-2 ring-[#46c57a]/15" />
            )}
            {hasUnread && (
              <span
                className={`size-1.75 shrink-0 rounded-full ring-2 ${
                  state.lastType === 'turn.completed'
                    ? 'bg-[#5aa9ff] ring-[#5aa9ff]/20'
                    : state.lastType === 'turn.aborted'
                      ? 'bg-[#c08532] ring-[#c08532]/15'
                      : 'bg-[#e75e78] ring-[#e75e78]/15'
                }`}
              />
            )}
          </div>
          {opened && <ul role="group">{renderChildren(node.id, depth + 1)}</ul>}
        </li>
      )
    })

  const menuNode = menu && nodes.find((node) => node.id === menu.id)
  return (
    <>
      <div className="thin-scrollbar min-h-0 flex-1 overflow-auto px-2 pb-4 pt-1 no-drag">
        <ul role="tree" className="flex flex-col gap-px">
          {renderChildren()}
        </ul>
      </div>
      {menuNode && (
        <ContextMenu menu={menu} node={menuNode} onClose={closeMenu} onAction={onAction} />
      )}
    </>
  )
}
