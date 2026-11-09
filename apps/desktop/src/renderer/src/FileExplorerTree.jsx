import { useEffect, useMemo, useRef } from 'react'
import { Input } from '@mica-config-ui/web'
import { IconChevronRight } from '@tabler/icons-react'
import Collapse from './Collapse'
import { FileSystemIcon } from './FileIcon'
import { longPressHandlers } from './hooks'
import { relativeToRoot, statusColor, statusLabel } from './git-decorations'
import { parentDirectory } from './files-tree'
import {
  nameSelection,
  orderEntries,
  TREE_INDENT,
  TREE_ROW_INSET,
  treeNavigation,
  visibleTreeEntries
} from './files-explorer'

export function FileNameInput({ edit, depth, onChange, onSubmit, onCancel }) {
  const inputRef = useRef(null)
  const rename = edit.action === 'rename'
  const label = rename ? '重命名' : edit.type === 'directory' ? '新建文件夹' : '新建文件'
  useEffect(() => {
    const input = inputRef.current
    input?.focus()
    if (input && rename) input.setSelectionRange(...nameSelection(input.value, edit.type))
    input?.scrollIntoView({ block: 'nearest' })
  }, [edit.id, edit.type, rename])
  useEffect(() => {
    if (edit.error && edit.focusError !== false) inputRef.current?.focus()
  }, [edit.error, edit.focusError])
  return (
    <div role="treeitem" aria-level={depth + 1} aria-label={label}>
      <div
        className="flex h-[22px] items-center pr-1.5 text-[13px]"
        style={{ paddingLeft: TREE_ROW_INSET + depth * TREE_INDENT }}
      >
        <span className="size-4 shrink-0" />
        <FileSystemIcon name={edit.value} type={edit.type} className="size-4 shrink-0" />
        <Input
          ref={(instance) => { inputRef.current = instance?.dom ?? null }}
          className="ml-[5px] min-w-0 flex-1 text-[16px] md:text-[13px]"
          height={22}
          style={{ paddingInline: 4 }}
          status={edit.error ? 'error' : undefined}
          aria-label={`${label}名称`}
          aria-invalid={!!edit.error}
          aria-describedby={edit.error ? 'file-entry-error' : undefined}
          value={edit.value}
          readOnly={edit.busy}
          placeholder={rename ? '' : '名称或相对路径'}
          autoComplete="off"
          spellCheck={false}
          onChange={onChange}
          onContextMenu={(event) => event.stopPropagation()}
          onBlur={() => onSubmit(true)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'Enter') {
              event.preventDefault()
              onSubmit(false)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onCancel()
            }
          }}
        />
      </div>
      {edit.error && (
        <div
          id="file-entry-error"
          role="alert"
          className="py-1 pr-2 text-[11px] text-danger"
          style={{ paddingLeft: TREE_ROW_INSET + 37 + depth * TREE_INDENT }}
        >
          {edit.error}
        </div>
      )}
    </div>
  )
}

function TreeRows(props) {
  const {
    nodes,
    directoryPath,
    depth = 0,
    selectedPath,
    focusPath,
    activePath,
    dragPath,
    dropPath,
    siblingDrop,
    orderMap,
    gitRoot,
    gitDecorations,
    edit,
    onEditChange,
    onEditSubmit,
    onEditCancel,
    onSelect,
    onToggle,
    onOpen,
    onContextMenu,
    onDragStart,
    onDragEnd,
    onDrop,
    onSiblingHover,
    onSiblingDrop
  } = props
  const createHere = edit && edit.action !== 'rename' && edit.directory === directoryPath
  return (
    <>
      {createHere && (
        <FileNameInput
          edit={edit}
          depth={depth}
          onChange={onEditChange}
          onSubmit={onEditSubmit}
          onCancel={onEditCancel}
        />
      )}
      {orderEntries(nodes, directoryPath, orderMap).map((node) => {
        const directory = node.type === 'directory'
        const relative = relativeToRoot(gitRoot, node.path)
        const fileStatus = !directory && relative ? gitDecorations.files.get(relative) : null
        const decoration =
          fileStatus || (directory && relative ? gitDecorations.folders.get(relative) : null)
        const siblingOver = siblingDrop?.path === node.path ? siblingDrop.position : null
        const selected = node.path === selectedPath
        const tone = selected
          ? 'bg-active text-fg-max'
          : node.ignored
            ? 'text-fg-dim hover:text-fg-muted'
            : 'text-fg-soft hover:text-fg-max'
        const editing = edit?.action === 'rename' && edit.path === node.path
        return (
          <div key={node.path}>
            {editing ? (
              <FileNameInput
                edit={edit}
                depth={depth}
                onChange={onEditChange}
                onSubmit={onEditSubmit}
                onCancel={onEditCancel}
              />
            ) : (
              <button
                type="button"
                role="treeitem"
                data-tree-path={node.path}
                tabIndex={node.path === focusPath ? 0 : -1}
                aria-level={depth + 1}
                aria-selected={selected}
                aria-current={node.path === activePath ? 'true' : undefined}
                aria-expanded={directory ? node.expanded : undefined}
                draggable={!edit}
                title={node.ignored ? `${node.path}（已被 .gitignore 忽略）` : node.path}
                className={`flex h-[22px] w-full items-center rounded pr-1.5 text-left text-[13px] outline-none hover:bg-list-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${tone} ${dragPath === node.path ? 'opacity-40' : ''} ${dropPath === node.path ? 'ring-1 ring-inset ring-info/70 bg-info/10' : ''}`}
                style={{ paddingLeft: TREE_ROW_INSET + depth * TREE_INDENT }}
                onFocus={() => onSelect(node.path)}
                onClick={() => {
                  onSelect(node.path)
                  if (directory) onToggle(node)
                  else onOpen(node.path)
                }}
                onContextMenu={(event) => onContextMenu(event, node)}
                {...longPressHandlers((event) => onContextMenu(event, node))}
                onDragStart={(event) => onDragStart(event, node)}
                onDragEnd={onDragEnd}
                onDragOver={(event) => {
                  if (!dragPath || dragPath === node.path) return
                  if (parentDirectory(dragPath) === parentDirectory(node.path)) {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    const rect = event.currentTarget.getBoundingClientRect()
                    onSiblingHover(
                      node.path,
                      event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                    )
                    return
                  }
                  if (!directory) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDragEnter={(event) => {
                  if (
                    !directory ||
                    (dragPath && parentDirectory(dragPath) === parentDirectory(node.path))
                  )
                    return
                  onDrop(event, node, false)
                }}
                onDrop={(event) => {
                  if (dragPath && parentDirectory(dragPath) === parentDirectory(node.path)) {
                    onSiblingDrop(node.path, siblingDrop?.position || 'after')
                    return
                  }
                  if (directory) onDrop(event, node, true)
                }}
              >
                <span
                  className={`grid size-4 shrink-0 place-items-center text-fg-muted transition-transform ${node.expanded ? 'rotate-90' : ''}`}
                >
                  {directory && <IconChevronRight size={14} />}
                </span>
                <FileSystemIcon
                  name={node.name}
                  type={node.type}
                  expanded={node.expanded}
                  className={`size-4 shrink-0 ${node.ignored ? 'opacity-45 grayscale' : ''}`}
                />
                <span
                  className="ml-[5px] min-w-0 flex-1 truncate"
                  style={decoration ? { color: statusColor(decoration) } : undefined}
                >
                  {node.name}
                </span>
                {node.loading && <span className="text-fg-dim">…</span>}
                {fileStatus && (
                  <span
                    className="ml-1.5 shrink-0 font-mono text-[11px] font-semibold"
                    style={{ color: statusColor(fileStatus) }}
                  >
                    {statusLabel(fileStatus)}
                  </span>
                )}
                {directory && decoration && (
                  <span
                    aria-hidden="true"
                    className="ml-1.5 size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: statusColor(decoration), opacity: 0.75 }}
                  />
                )}
              </button>
            )}
            {siblingOver && (
              <div className="pointer-events-none relative h-0">
                <div
                  className={`absolute inset-x-1 h-0.5 rounded-full bg-info ${siblingOver === 'before' ? 'bottom-[22px]' : 'top-0'}`}
                />
              </div>
            )}
            {directory && (
              <Collapse open={node.expanded}>
                <div role="group" className="relative">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 w-px bg-overlay-strong"
                    style={{ left: TREE_ROW_INSET + 8 + depth * TREE_INDENT }}
                  />
                  <TreeRows
                    {...props}
                    nodes={node.children}
                    directoryPath={node.path}
                    depth={depth + 1}
                  />
                  {node.error ? (
                    <div
                      className="py-1 pr-2 text-[11px] text-danger/85"
                      style={{ paddingLeft: 57 + (depth + 1) * TREE_INDENT }}
                    >
                      无法读取：{node.error}
                    </div>
                  ) : null}
                </div>
              </Collapse>
            )}
          </div>
        )
      })}
    </>
  )
}

export function FileExplorerTree({ tree, onAction, onBlankContextMenu, ...props }) {
  const ref = useRef(null)
  const typeAhead = useRef({ text: '', time: 0 })
  const entries = useMemo(
    () => visibleTreeEntries(tree.children, tree.root, props.orderMap),
    [tree.children, tree.root, props.orderMap]
  )
  const selectedPath = entries.some(({ node }) => node.path === props.selectedPath)
    ? props.selectedPath
    : entries[0]?.node.path
  const select = (path) => {
    props.onSelect(path)
    const element = [...(ref.current?.querySelectorAll('[data-tree-path]') || [])].find(
      (item) => item.dataset.treePath === path
    )
    element?.focus()
    element?.scrollIntoView({ block: 'nearest' })
  }
  return (
    <div
      ref={ref}
      className="h-full overflow-auto select-none outline-none"
      role="tree"
      aria-label="文件目录"
      aria-busy={tree.refreshing}
      tabIndex={entries.length ? -1 : 0}
      onContextMenu={onBlankContextMenu}
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onSelect(null)
      }}
      onKeyDown={(event) => {
        if (event.target.closest('input') || props.edit || event.nativeEvent.isComposing) return
        const node = entries.find(({ node }) => node.path === selectedPath)?.node
        if (event.key === 'F2' && node) {
          event.preventDefault()
          onAction('rename', node)
          return
        }
        const mac = window.mica.platform === 'darwin'
        if (
          node &&
          ((!mac &&
            event.key === 'Delete' &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey) ||
            (mac && event.key === 'Backspace' && event.metaKey && !event.altKey && !event.shiftKey))
        ) {
          event.preventDefault()
          onAction('delete', node)
          return
        }
        if (event.metaKey || event.ctrlKey || event.altKey) return
        if (node && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          if (node.type === 'directory') props.onToggle(node)
          else props.onOpen(node.path)
          return
        }
        const next = treeNavigation(entries, selectedPath, event.key, tree.root)
        if (next || event.key.startsWith('Arrow')) {
          event.preventDefault()
          if (next?.select) select(next.select)
          if (next?.toggle) props.onToggle(next.toggle)
        } else if (event.key.length === 1 && !event.shiftKey) {
          const now = Date.now()
          const previous = typeAhead.current
          const text =
            (now - previous.time < 700 ? previous.text : '') + event.key.toLocaleLowerCase()
          typeAhead.current = { text, time: now }
          const start = entries.findIndex(({ node }) => node.path === selectedPath) + 1
          const candidates = [...entries.slice(start), ...entries.slice(0, start)]
          const match = candidates.find(({ node }) =>
            node.name.toLocaleLowerCase().startsWith(text)
          )
          if (match) {
            event.preventDefault()
            select(match.node.path)
          }
        }
      }}
    >
      <TreeRows
        {...props}
        nodes={tree.children}
        directoryPath={tree.root}
        focusPath={selectedPath}
      />
    </div>
  )
}
