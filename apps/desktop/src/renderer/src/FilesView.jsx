import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  IconArrowLeft,
  IconArrowUp,
  IconChevronRight,
  IconChristmasTree,
  IconClipboard,
  IconCopy,
  IconDots,
  IconFilePlus,
  IconFiles,
  IconFolderOpen,
  IconFolderPlus,
  IconGitBranch,
  IconPencil,
  IconRefresh,
  IconSearch,
  IconSquareMinus,
  IconTrash,
  IconX
} from '@tabler/icons-react'
import { FileIcon, FileSystemIcon } from './FileIcon'
import { GitDiffEditor, GitPanel, SearchPanel } from './FileSidePanels'
import { buildGitDecorations, relativeToRoot, statusColor, statusLabel } from './git-decorations'
import { longPressHandlers, useIsMobile, useLatest, usePaneWidth } from './hooks'
import { editorOptions, fileName, languageFor, monaco } from './monaco'

const makeNode = (entry) => ({
  name: entry.name,
  path: entry.path,
  type: entry.type,
  expanded: false,
  loaded: false,
  loading: false,
  error: '',
  children: []
})

function updateTree(nodes, path, update) {
  return nodes.map((node) =>
    node.path === path
      ? update(node)
      : node.children?.length
        ? { ...node, children: updateTree(node.children, path, update) }
        : node
  )
}

function expandedPaths(nodes, output = new Set()) {
  for (const node of nodes) {
    if (node.expanded) output.add(node.path)
    expandedPaths(node.children || [], output)
  }
  return output
}

// 折叠全部：丢掉已加载的子树，下次展开时重新读取，避免展开后看到过期内容
function collapseNodes(nodes) {
  return nodes.map((node) =>
    node.expanded || node.loaded
      ? { ...node, expanded: false, loaded: false, loading: false, error: '', children: [] }
      : node
  )
}

function relativeParts(rootPath, filePath) {
  const root = String(rootPath || '')
    .replaceAll('\\', '/')
    .replace(/\/$/, '')
  const target = String(filePath || '').replaceAll('\\', '/')
  const caseRoot = window.mica.platform === 'win32' ? root.toLowerCase() : root
  const caseTarget = window.mica.platform === 'win32' ? target.toLowerCase() : target
  const relative = caseTarget.startsWith(`${caseRoot}/`) ? target.slice(root.length + 1) : target
  return relative.split('/').filter(Boolean)
}

function parentName(path) {
  const parts = String(path || '')
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
  return parts.at(-2) || ''
}

const isSameOrChildPath = (candidate, parent) => {
  const normalize = (value) =>
    String(value || '')
      .replaceAll('\\', '/')
      .replace(/\/$/, '')
  const left = normalize(candidate)
  const right = normalize(parent)
  const caseLeft = window.mica.platform === 'win32' ? left.toLowerCase() : left
  const caseRight = window.mica.platform === 'win32' ? right.toLowerCase() : right
  return caseLeft === caseRight || caseLeft.startsWith(`${caseRight}/`)
}

/** 目录部分：/a/b/c -> /a/b */
function dirOf(path) {
  const normalized = String(path || '')
    .replaceAll('\\', '/')
    .replace(/\/$/, '')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : normalized || '/'
}

const isSibling = (a, b) => dirOf(a) === dirOf(b)

function findDirChildren(nodes, dirPath) {
  for (const node of nodes) {
    if (node.path === dirPath) return node.children
    if (node.children?.length) {
      const found = findDirChildren(node.children, dirPath)
      if (found) return found
    }
  }
  return null
}

function updateDirChildren(nodes, dirPath, update) {
  return nodes.map((node) =>
    node.path === dirPath
      ? { ...node, children: update(node.children) }
      : node.children?.length
        ? { ...node, children: updateDirChildren(node.children, dirPath, update) }
        : node
  )
}

function applyOrder(children, directory, orderMap) {
  const order = orderMap?.[directory]
  if (!order?.length) return children
  const byName = new Map(children.map((node) => [node.name, node]))
  const known = order.map((name) => byName.get(name)).filter(Boolean)
  const seen = new Set(known.map((node) => node.name))
  const rest = children.filter((node) => !seen.has(node.name))
  return [...known, ...rest]
}

function FloatingMenu({ x, y, minWidth, onClose, ignoreSelector, children }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ x, y })
  useEffect(() => {
    // 常驻按钮自己负责开合：按压事件不关菜单，否则按下即关、点开又被重新打开，无法收起
    const close = (event) => {
      if (ignoreSelector && event.target?.closest?.(ignoreSelector)) return
      onClose()
    }
    const keydown = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', keydown)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', keydown)
    }
  }, [ignoreSelector, onClose])
  useLayoutEffect(() => {
    if (!ref.current) return
    const w = ref.current.offsetWidth
    const h = ref.current.offsetHeight
    let px = x
    let py = y
    if (px + w > window.innerWidth - 4) px = Math.max(4, window.innerWidth - w - 4)
    if (py + h > window.innerHeight - 4) py = Math.max(4, window.innerHeight - h - 4)
    setPos({ x: px, y: py })
  }, [x, y])
  return (
    <div
      ref={ref}
      className="fixed z-[10000] rounded-md border border-white/12 bg-panel/98 p-1 shadow-2xl backdrop-blur"
      style={{ left: pos.x, top: pos.y, minWidth }}
      role="menu"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  )
}

function MenuSeparator() {
  return <div className="mx-1 my-1 h-px bg-white/10" />
}

function MenuItem({ icon: Icon, label, danger, disabled, onClick }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={`flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[13px] hover:bg-white/[.08] disabled:opacity-40 disabled:hover:bg-transparent ${
        danger ? 'text-danger-soft' : 'text-white/90 hover:text-white'
      }`}
      onClick={onClick}
    >
      <span className="grid w-4 shrink-0 place-items-center">
        <Icon size={14} className="shrink-0 opacity-75" />
      </span>
      <span className="flex-1">{label}</span>
    </button>
  )
}

function FileContextMenu({ menu, onAction, onClose }) {
  const directory = menu.node.type === 'directory'
  const items = [
    ...(directory
      ? [
          { id: 'new-file', label: '新建文件', icon: IconFilePlus },
          { id: 'new-directory', label: '新建文件夹', icon: IconFolderPlus },
          { separator: true }
        ]
      : []),
    { id: 'rename', label: '重命名', icon: IconPencil },
    { id: 'duplicate', label: '创建副本', icon: IconCopy },
    { separator: true },
    { id: 'copy-path', label: '复制路径', icon: IconClipboard },
    { id: 'copy-relative-path', label: '复制相对路径', icon: IconClipboard },
    { id: 'reveal', label: '在文件管理器中显示', icon: IconFolderOpen },
    { separator: true },
    { id: 'delete', label: '删除', icon: IconTrash, danger: true }
  ]
  return (
    <FloatingMenu x={menu.x} y={menu.y} minWidth={220} onClose={onClose}>
      {items.map((item, index) =>
        item.separator ? (
          <MenuSeparator key={`separator-${index}`} />
        ) : (
          <MenuItem
            key={item.id}
            icon={item.icon}
            label={item.label}
            danger={item.danger}
            onClick={() => onAction(item.id, menu.node)}
          />
        )
      )}
    </FloatingMenu>
  )
}

// 资源管理器标题栏的「更多操作」：VS Code 把刷新、折叠、返回上级都收在这里
function ExplorerMenu({ menu, onAction, onClose }) {
  const items = [
    { id: 'new-file', label: '新建文件', icon: IconFilePlus, disabled: !menu.root },
    { id: 'new-directory', label: '新建文件夹', icon: IconFolderPlus, disabled: !menu.root },
    { id: 'refresh', label: '刷新', icon: IconRefresh, disabled: !menu.root },
    { id: 'collapse-all', label: '折叠所有文件夹', icon: IconSquareMinus, disabled: !menu.root },
    { separator: true },
    { id: 'open-parent', label: '返回上级目录', icon: IconArrowUp, disabled: !menu.parent },
    { id: 'reveal', label: '在文件管理器中显示', icon: IconFolderOpen, disabled: !menu.root },
    { id: 'copy-path', label: '复制路径', icon: IconClipboard, disabled: !menu.root }
  ]
  return (
    <FloatingMenu
      x={menu.x}
      y={menu.y}
      minWidth={200}
      onClose={onClose}
      ignoreSelector='[data-menu-anchor="explorer"]'
    >
      {items.map((item, index) =>
        item.separator ? (
          <MenuSeparator key={`separator-${index}`} />
        ) : (
          <MenuItem
            key={item.id}
            icon={item.icon}
            label={item.label}
            disabled={item.disabled}
            onClick={() => onAction(item.id, menu)}
          />
        )
      )}
    </FloatingMenu>
  )
}

function FileTreeRows({
  nodes,
  depth = 0,
  activePath,
  dragPath,
  dropPath,
  siblingDrop,
  orderMap,
  gitRoot,
  gitDecorations,
  onToggle,
  onOpen,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDrop,
  onSiblingHover,
  onSiblingDrop
}) {
  return nodes.map((node) => {
    const directory = node.type === 'directory'
    const relative = relativeToRoot(gitRoot, node.path)
    const fileStatus = !directory && relative ? gitDecorations.files.get(relative) : null
    const folderStatus = directory && relative ? gitDecorations.folders.get(relative) : null
    const decoration = fileStatus || folderStatus
    const siblingOver =
      siblingDrop?.path === node.path
        ? siblingDrop.position === 'before'
          ? 'before'
          : 'after'
        : null
    return (
      <div key={node.path}>
        <button
          type="button"
          role="treeitem"
          aria-expanded={directory ? node.expanded : undefined}
          draggable
          title={node.path}
          className={`flex h-7 w-full items-center gap-1 rounded-sm pr-2 text-left text-xs hover:bg-white/[.045] hover:text-white ${
            node.path === activePath ? 'bg-white/[.075] text-white' : 'text-white/70'
          } ${dragPath === node.path ? 'opacity-40' : ''} ${dropPath === node.path ? 'ring-1 ring-inset ring-info/70 bg-info/10' : ''}`}
          style={{
            paddingLeft: 5 + depth * 13,
            boxShadow:
              siblingOver === 'before'
                ? 'inset 0 2px 0 rgba(90,167,232,.9)'
                : siblingOver === 'after'
                  ? 'inset 0 -2px 0 rgba(90,167,232,.9)'
                  : undefined
          }}
          onClick={() => (directory ? onToggle(node) : onOpen(node.path))}
          onContextMenu={(event) => onContextMenu(event, node)}
          {...longPressHandlers((event) => onContextMenu(event, node))}
          onDragStart={(event) => onDragStart(event, node)}
          onDragEnd={onDragEnd}
          onDragOver={(event) => {
            if (!dragPath || dragPath === node.path) return
            if (isSibling(dragPath, node.path)) {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              const rect = event.currentTarget.getBoundingClientRect()
              const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
              onSiblingHover(node.path, position)
              return
            }
            if (!directory) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
          }}
          onDragEnter={(event) => {
            if (!directory || (dragPath && isSibling(dragPath, node.path))) return
            onDrop(event, node, false)
          }}
          onDrop={(event) => {
            if (dragPath && isSibling(dragPath, node.path)) {
              onSiblingDrop(node.path, siblingDrop?.position || 'after')
              return
            }
            if (directory) onDrop(event, node, true)
          }}
        >
          <span
            className={`grid size-3.5 shrink-0 place-items-center text-white/35 ${node.expanded ? 'rotate-90' : ''}`}
          >
            {directory && <IconChevronRight size={13} />}
          </span>
          <span className="grid size-4 shrink-0 place-items-center text-white/50">
            <FileSystemIcon
              name={node.name}
              type={node.type}
              expanded={node.expanded}
              className="size-4"
            />
          </span>
          <span
            className="min-w-0 flex-1 truncate"
            style={decoration ? { color: statusColor(decoration) } : undefined}
          >
            {node.name}
          </span>
          {node.loading && <span className="text-white/35">…</span>}
          {fileStatus && (
            <span
              className="shrink-0 font-mono text-[10px] font-semibold"
              style={{ color: statusColor(fileStatus) }}
            >
              {statusLabel(fileStatus)}
            </span>
          )}
          {folderStatus && (
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: statusColor(folderStatus), opacity: 0.75 }}
            />
          )}
        </button>
        {directory &&
          node.expanded &&
          (node.error ? (
            <div
              className="py-1 pr-2 text-[11px] text-danger/85"
              style={{ paddingLeft: 35 + (depth + 1) * 13 }}
            >
              无法读取：{node.error}
            </div>
          ) : node.loaded && !node.children.length ? (
            <div
              className="py-1 pr-2 text-[11px] text-white/30"
              style={{ paddingLeft: 35 + (depth + 1) * 13 }}
            >
              空文件夹
            </div>
          ) : (
            <FileTreeRows
              nodes={applyOrder(node.children, node.path, orderMap)}
              depth={depth + 1}
              activePath={activePath}
              dragPath={dragPath}
              dropPath={dropPath}
              siblingDrop={siblingDrop}
              orderMap={orderMap}
              gitRoot={gitRoot}
              gitDecorations={gitDecorations}
              onToggle={onToggle}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDrop={onDrop}
              onSiblingHover={onSiblingHover}
              onSiblingDrop={onSiblingDrop}
            />
          ))}
      </div>
    )
  })
}

export const FilesView = forwardRef(function FilesView(
  { root, visible, askText, onCornerResizeStart, gitCwd, gitRepository, gitLoading, gitBranch },
  ref
) {
  const viewRef = useRef(null)
  const editorHostRef = useRef(null)
  const editorRef = useRef(null)
  const tabListRef = useRef(null)
  const requestRef = useRef(0)
  const reloadRef = useRef(0)
  const lifecycleRef = useRef(0)
  const messageTimer = useRef(null)
  const saveActionRef = useRef(null)
  const [tree, setTree] = useState({
    root: null,
    parent: null,
    children: [],
    status: '选择一个终端会话以查看文件'
  })
  const treeRef = useLatest(tree)
  const [tabs, setTabsState] = useState([])
  const tabsRef = useRef([])
  const [activePath, setActivePathState] = useState(null)
  const activeRef = useRef(null)
  const [contextMenu, setContextMenu] = useState(null)
  const [explorerMenu, setExplorerMenu] = useState(null)
  const [dragPath, setDragPath] = useState(null)
  const [dropPath, setDropPath] = useState(null)
  const [siblingDrop, setSiblingDrop] = useState(null) // { path, position: 'before'|'after' }
  const [orderMap, setOrderMap] = useState({})
  const orderMapRef = useRef({})
  const [message, setMessage] = useState(null)
  const [activePanel, setActivePanel] = useState('explorer')
  const [gitSelectedFile, setGitSelectedFile] = useState(null)

  // 目录树上的 Git 装饰：改动文件染成对应状态色并带状态字母，其所有上级文件夹继承最主要的状态
  const gitDecorations = useMemo(() => buildGitDecorations(gitRepository), [gitRepository])
  const gitRoot = gitRepository?.root || null

  const setTabs = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(tabsRef.current) : updater
    tabsRef.current = next
    setTabsState(next)
  }, [])
  const setActivePath = useCallback((path) => {
    activeRef.current = path
    setActivePathState(path)
  }, [])
  const showMessage = useCallback((text, transient = false, error = false) => {
    clearTimeout(messageTimer.current)
    setMessage(text ? { text, transient, error } : null)
    if (transient) {
      messageTimer.current = window.setTimeout(() => setMessage(null), error ? 4000 : 1800)
    }
  }, [])

  const selectGitFile = useCallback((file) => {
    if (file && file.path) setGitSelectedFile(file)
  }, [])

  const closeGitDiff = useCallback(() => setGitSelectedFile(null), [])

  const switchPanel = useCallback((panel) => {
    setActivePanel((current) => (current === panel ? 'explorer' : panel))
  }, [])

  useEffect(() => {
    const editor = monaco.editor.create(editorHostRef.current, { ...editorOptions, model: null })
    editorRef.current = editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActionRef.current?.())
    return () => {
      lifecycleRef.current += 1
      reloadRef.current += 1
      clearTimeout(messageTimer.current)
      const currentTabs = tabsRef.current
      tabsRef.current = []
      activeRef.current = null
      for (const tab of currentTabs) {
        tab.subscription?.dispose()
        tab.model?.dispose()
      }
      editor.dispose()
      editorRef.current = null
    }
  }, [])

  const activateFile = useCallback(
    (path, focus = true) => {
      const tab = tabsRef.current.find((item) => item.path === path)
      if (!tab) return
      if (activeRef.current === path && editorRef.current?.getModel() === tab.model) {
        if (tab.model) showMessage('')
        if (focus) editorRef.current?.focus()
        return
      }
      const previous = tabsRef.current.find((item) => item.path === activeRef.current)
      if (previous?.model && previous.path !== path)
        previous.viewState = editorRef.current?.saveViewState()
      setActivePath(path)
      if (!tab.model) {
        editorRef.current?.setModel(null)
        showMessage(`正在打开 ${tab.name}…`)
        return
      }
      editorRef.current?.setModel(tab.model)
      if (tab.viewState) editorRef.current?.restoreViewState(tab.viewState)
      showMessage('')
      requestAnimationFrame(() => {
        if (activeRef.current !== path || editorRef.current?.getModel() !== tab.model) return
        editorRef.current?.layout()
        if (focus) editorRef.current?.focus()
      })
    },
    [setActivePath, showMessage]
  )

  const revealPosition = useCallback((position) => {
    if (!position || !editorRef.current?.getModel()) return
    const lineNumber = Math.max(1, Number(position.line) || 1)
    const column = Math.max(1, Number(position.column) || 1)
    editorRef.current.setPosition({ lineNumber, column })
    editorRef.current.revealPositionInCenter({ lineNumber, column })
    editorRef.current.focus()
  }, [])

  const openFile = useCallback(
    async (path, position = null) => {
      if (!path) return
      const existing = tabsRef.current.find((tab) => tab.path === path)
      if (existing) {
        activateFile(path)
        requestAnimationFrame(() => {
          if (activeRef.current === path && editorRef.current?.getModel() === existing.model) {
            revealPosition(position)
          }
        })
        return
      }
      const previous = tabsRef.current.find((tab) => tab.path === activeRef.current)
      if (previous?.model) previous.viewState = editorRef.current?.saveViewState()
      const tab = {
        path,
        name: fileName(path),
        model: null,
        subscription: null,
        viewState: null,
        savedVersion: null,
        diskVersion: null,
        dirty: false,
        loading: true,
        saving: false
      }
      setTabs((items) => [...items, tab])
      setActivePath(path)
      editorRef.current?.setModel(null)
      showMessage(`正在打开 ${tab.name}…`)
      const generation = lifecycleRef.current
      try {
        const result = await window.mica.files.read(path)
        if (generation !== lifecycleRef.current || !tabsRef.current.includes(tab)) return
        const model = monaco.editor.createModel(
          result.content,
          languageFor(path),
          monaco.Uri.file(path)
        )
        tab.model = model
        tab.diskVersion = result.version
        tab.loading = false
        tab.savedVersion = model.getAlternativeVersionId()
        tab.subscription = model.onDidChangeContent(() => {
          const current = tabsRef.current.find((item) => item.path === path)
          if (!current?.model) return
          const dirty = current.model.getAlternativeVersionId() !== current.savedVersion
          if (dirty !== current.dirty)
            setTabs((items) => items.map((item) => (item === current ? { ...item, dirty } : item)))
        })
        setTabs((items) => items.map((item) => (item === tab ? { ...tab } : item)))
        if (activeRef.current === path) {
          editorRef.current?.setModel(model)
          showMessage('')
          requestAnimationFrame(() => {
            if (activeRef.current !== path || editorRef.current?.getModel() !== model) return
            editorRef.current?.layout()
            editorRef.current?.focus()
            revealPosition(position)
          })
        }
      } catch (error) {
        if (!tabsRef.current.includes(tab)) return
        const text = `无法打开文件：${error?.message || error}`
        setTabs((items) => items.filter((item) => item !== tab))
        if (activeRef.current === path) {
          const fallback = tabsRef.current.at(-1)
          if (fallback) {
            activateFile(fallback.path, false)
            showMessage(text, true, true)
          } else {
            setActivePath(null)
            editorRef.current?.setModel(null)
            showMessage(text)
          }
        } else {
          const activeTab = tabsRef.current.find((item) => item.path === activeRef.current)
          if (activeTab?.model) showMessage(text, true, true)
          else if (activeTab?.loading) showMessage(`正在打开 ${activeTab.name}…`)
        }
      }
    },
    [activateFile, revealPosition, setActivePath, setTabs, showMessage]
  )

  const saveActive = useCallback(async () => {
    const tab = tabsRef.current.find((item) => item.path === activeRef.current)
    if (!tab?.model || !tab.dirty || tab.loading || tab.saving) return
    const content = tab.model.getValue()
    const savedVersion = tab.model.getAlternativeVersionId()
    tab.saving = true
    setTabs((items) => items.map((item) => (item === tab ? { ...tab } : item)))
    try {
      const result = await window.mica.files.write(tab.path, content, tab.diskVersion)
      if (!tabsRef.current.some((item) => item.path === tab.path)) return
      tab.savedVersion = savedVersion
      tab.diskVersion = result.version
      tab.dirty = tab.model.getAlternativeVersionId() !== savedVersion
      setTabs((items) => items.map((item) => (item.path === tab.path ? { ...tab } : item)))
      showMessage(tab.dirty ? '已保存，文件仍有新的更改' : '已保存', true)
    } catch (error) {
      showMessage(`保存失败：${error?.message || error}`, true, true)
      throw error
    } finally {
      tab.saving = false
      setTabs((items) => items.map((item) => (item.path === tab.path ? { ...tab } : item)))
    }
  }, [setTabs, showMessage])
  saveActionRef.current = () =>
    saveActive().catch((error) => console.error('save file failed', error))

  const closeFile = useCallback(
    (path) => {
      const tab = tabsRef.current.find((item) => item.path === path)
      if (!tab) return false
      if (tab.saving) {
        showMessage('文件正在保存，请稍后再关闭', true, true)
        return false
      }
      if (tab.dirty && !window.confirm(`“${tab.name}” 的更改尚未保存。是否放弃更改并关闭？`))
        return false
      const paths = tabsRef.current.map((item) => item.path)
      const index = paths.indexOf(path)
      const wasActive = activeRef.current === path
      tab.subscription?.dispose()
      if (editorRef.current?.getModel() === tab.model) editorRef.current.setModel(null)
      tab.model?.dispose()
      const remaining = tabsRef.current.filter((item) => item !== tab)
      setTabs(remaining)
      if (wasActive) {
        const next = remaining[Math.min(index, remaining.length - 1)]
        if (next) activateFile(next.path, false)
        else {
          setActivePath(null)
          showMessage('')
        }
      }
      return true
    },
    [activateFile, setActivePath, setTabs, showMessage]
  )

  useEffect(() => {
    const keydown = (event) => {
      if (
        !visible ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.key.toLowerCase() !== 's'
      )
        return
      event.preventDefault()
      saveActionRef.current?.()
    }
    const unload = (event) => {
      if (!tabsRef.current.some((tab) => tab.dirty || tab.saving)) return
      event.preventDefault()
      event.returnValue = ''
    }
    document.addEventListener('keydown', keydown)
    window.addEventListener('beforeunload', unload)
    return () => {
      document.removeEventListener('keydown', keydown)
      window.removeEventListener('beforeunload', unload)
    }
  }, [visible])

  const loadRoot = useCallback(async (path) => {
    const target = typeof path === 'string' && path.trim() ? path : ''
    const request = ++requestRef.current
    setTree({
      root: target || null,
      parent: null,
      children: [],
      status: target ? '正在读取…' : '选择一个终端会话以查看文件'
    })
    if (!target) return
    try {
      const result = await window.mica.files.list(target)
      if (request !== requestRef.current) return
      setTree({
        root: result.path,
        parent: result.parentPath,
        children: result.entries.map(makeNode),
        status: result.entries.length ? '' : '这个文件夹是空的'
      })
    } catch (error) {
      if (request === requestRef.current)
        setTree((value) => ({
          ...value,
          children: [],
          status: `无法读取文件夹：${error?.message || error}`
        }))
    }
  }, [])

  useEffect(() => {
    if (visible) loadRoot(root)
  }, [loadRoot, root, visible])

  useEffect(() => {
    if (!visible) return undefined
    let cancelled = false
    window.mica.files
      .orderGet()
      .then((order) => {
        if (cancelled) return
        orderMapRef.current = order || {}
        setOrderMap(orderMapRef.current)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [visible])

  const restoreExpanded = useCallback(async (nodes, paths, request) => {
    const restored = []
    for (const node of nodes) {
      if (request !== requestRef.current || node.type !== 'directory' || !paths.has(node.path)) {
        restored.push(node)
        continue
      }
      try {
        const result = await window.mica.files.list(node.path)
        const children = result.entries.map(makeNode)
        restored.push({
          ...node,
          expanded: true,
          loaded: true,
          children: await restoreExpanded(children, paths, request)
        })
      } catch (error) {
        restored.push({ ...node, expanded: true, error: error?.message || String(error) })
      }
    }
    return restored
  }, [])

  const refresh = useCallback(async () => {
    const current = treeRef.current
    if (!current.root) return
    const paths = expandedPaths(current.children)
    const request = ++requestRef.current
    setTree((value) => ({ ...value, status: '正在刷新…' }))
    try {
      const result = await window.mica.files.list(current.root)
      let children = result.entries.map(makeNode)
      children = await restoreExpanded(children, paths, request)
      if (request !== requestRef.current) return
      setTree({
        root: result.path,
        parent: result.parentPath,
        children,
        status: children.length ? '' : '这个文件夹是空的'
      })
    } catch (error) {
      if (request === requestRef.current)
        setTree((value) => ({ ...value, status: `无法刷新文件夹：${error?.message || error}` }))
    }
  }, [restoreExpanded, treeRef])

  const collapseAll = useCallback(() => {
    setTree((value) => ({ ...value, children: collapseNodes(value.children) }))
  }, [])

  const closeTabsUnder = useCallback(
    (path) => {
      const affected = tabsRef.current.filter((tab) => isSameOrChildPath(tab.path, path))
      if (affected.some((tab) => tab.dirty || tab.saving)) {
        showMessage('请先保存或关闭此项目中已修改的文件', true, true)
        return false
      }
      for (const tab of affected) closeFile(tab.path)
      return true
    },
    [closeFile, showMessage]
  )

  const runFileAction = useCallback(
    async (action, node) => {
      setContextMenu(null)
      try {
        if (action === 'copy-path') {
          await window.mica.files.copyPath(node.path)
          showMessage('路径已复制', true)
          return
        }
        if (action === 'copy-relative-path') {
          await window.mica.files.copyRelativePath(treeRef.current.root, node.path)
          showMessage('相对路径已复制', true)
          return
        }
        if (action === 'reveal') {
          await window.mica.files.reveal(node.path)
          return
        }
        if (action === 'new-file' || action === 'new-directory') {
          const kind = action === 'new-file' ? '文件' : '文件夹'
          const name = await askText(`新建${kind}`, '', `请输入${kind}名称`)
          if (!name?.trim()) return
          const result = await window.mica.files.create(
            node.path,
            name,
            action === 'new-file' ? 'file' : 'directory'
          )
          await refresh()
          if (action === 'new-file') openFile(result.path)
          showMessage(`${kind}已创建`, true)
          return
        }
        if (action === 'rename') {
          const name = await askText('重命名', node.name, '请输入新名称')
          if (!name?.trim() || name.trim() === node.name) return
          if (!closeTabsUnder(node.path)) return
          await window.mica.files.rename(node.path, name)
          await refresh()
          showMessage('已重命名', true)
          return
        }
        if (action === 'duplicate') {
          await window.mica.files.duplicate(node.path)
          await refresh()
          showMessage('副本已创建', true)
          return
        }
        if (action === 'delete') {
          if (!window.confirm(`确定要将“${node.name}”移到回收站吗？`)) return
          if (!closeTabsUnder(node.path)) return
          await window.mica.files.delete(node.path)
          await refresh()
          showMessage('已删除', true)
        }
      } catch (error) {
        showMessage(`操作失败：${error?.message || error}`, true, true)
      }
    },
    [askText, closeTabsUnder, openFile, refresh, showMessage, treeRef]
  )

  const openContextMenu = useCallback((event, node) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      node,
      x: event.clientX,
      y: event.clientY
    })
  }, [])

  const openExplorerMenu = useCallback(
    (event) => {
      if (explorerMenu) {
        setExplorerMenu(null)
        return
      }
      const rect = event.currentTarget.getBoundingClientRect()
      setExplorerMenu({
        x: Math.max(4, rect.right - 200),
        y: rect.bottom + 4,
        root: treeRef.current.root,
        parent: treeRef.current.parent
      })
    },
    [explorerMenu, treeRef]
  )

  const runExplorerAction = useCallback(
    (action, menu) => {
      setExplorerMenu(null)
      if (action === 'refresh') return refresh()
      if (action === 'collapse-all') return collapseAll()
      if (action === 'open-parent') return loadRoot(menu.parent)
      // 根目录当普通目录节点复用文件操作（新建、显示、复制路径）
      return runFileAction(action, {
        path: menu.root,
        type: 'directory',
        name: fileName(menu.root)
      })
    },
    [collapseAll, loadRoot, refresh, runFileAction]
  )

  const startFileDrag = useCallback((event, node) => {
    setContextMenu(null)
    setDragPath(node.path)
    setDropPath(null)
    setSiblingDrop(null)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', node.path)
  }, [])

  const finishFileDrag = useCallback(() => {
    setDragPath(null)
    setDropPath(null)
    setSiblingDrop(null)
  }, [])

  const handleSiblingHover = useCallback((path, position) => {
    setDropPath(null)
    setSiblingDrop({ path, position })
  }, [])

  const handleSiblingDrop = useCallback(
    async (targetPath, position) => {
      if (!dragPath || dragPath === targetPath) return
      const directory = dirOf(targetPath)
      const current = treeRef.current
      const children =
        directory === current.root ? current.children : findDirChildren(current.children, directory)
      if (!children?.length) return
      const names = children.map((node) => node.name)
      const dragName = children.find((node) => node.path === dragPath)?.name
      const targetName = children.find((node) => node.path === targetPath)?.name
      const from = names.indexOf(dragName)
      const to = names.indexOf(targetName)
      if (from < 0 || to < 0) {
        setDragPath(null)
        setSiblingDrop(null)
        return
      }
      names.splice(from, 1)
      const at = names.indexOf(targetName)
      names.splice(position === 'before' ? at : at + 1, 0, dragName)
      const reorder = (list) =>
        names.map((name) => list.find((node) => node.name === name)).filter(Boolean)
      setTree((value) => ({
        ...value,
        children:
          directory === value.root
            ? reorder(value.children)
            : updateDirChildren(value.children, directory, reorder)
      }))
      setDragPath(null)
      setDropPath(null)
      setSiblingDrop(null)
      try {
        const next = { ...orderMapRef.current, [directory]: names }
        orderMapRef.current = next
        setOrderMap(next)
        await window.mica.files.orderSet(directory, names)
      } catch (error) {
        showMessage(`排序保存失败：${error?.message || error}`, true, true)
      }
    },
    [dragPath, showMessage, treeRef]
  )

  const handleFileDrop = useCallback(
    async (event, directory, commit) => {
      event.preventDefault()
      event.stopPropagation()
      if (!dragPath || dragPath === directory.path || isSameOrChildPath(directory.path, dragPath))
        return
      if (!commit) {
        setDropPath(directory.path)
        return
      }
      setDropPath(null)
      setDragPath(null)
      if (!closeTabsUnder(dragPath)) return
      try {
        await window.mica.files.move(dragPath, directory.path)
        await refresh()
        showMessage(`已移动到 ${directory.name}`, true)
      } catch (error) {
        showMessage(`移动失败：${error?.message || error}`, true, true)
      }
    },
    [closeTabsUnder, dragPath, refresh, showMessage]
  )

  const reloadAfterGitChange = useCallback(
    async (nextRoot) => {
      if (tabsRef.current.some((tab) => tab.dirty || tab.saving || tab.loading)) return false
      const generation = lifecycleRef.current
      const request = ++reloadRef.current
      const snapshot = [...tabsRef.current]
      const active = activeRef.current
      const activeTab = snapshot.find((tab) => tab.path === active)
      if (activeTab?.model && editorRef.current?.getModel() === activeTab.model)
        activeTab.viewState = editorRef.current.saveViewState()

      const treeTask = loadRoot(nextRoot)
      const results = await Promise.all(
        snapshot.map(async (tab) => {
          try {
            return { path: tab.path, value: await window.mica.files.read(tab.path) }
          } catch (error) {
            return { path: tab.path, error }
          }
        })
      )
      if (generation !== lifecycleRef.current || request !== reloadRef.current) return false

      const responses = new Map(results.map((result) => [result.path, result]))
      const removed = []
      const nextTabs = []
      for (const tab of tabsRef.current) {
        const response = responses.get(tab.path)
        if (!response || tab.dirty || tab.saving) {
          nextTabs.push(tab)
          continue
        }
        if (response.error) {
          removed.push(tab)
          tab.subscription?.dispose()
          if (editorRef.current?.getModel() === tab.model) editorRef.current.setModel(null)
          tab.model?.dispose()
          continue
        }
        if (tab.model.getValue() !== response.value.content)
          tab.model.setValue(response.value.content)
        nextTabs.push({
          ...tab,
          diskVersion: response.value.version,
          savedVersion: tab.model.getAlternativeVersionId(),
          dirty: false,
          loading: false
        })
      }
      setTabs(nextTabs)

      const nextActive = nextTabs.find((tab) => tab.path === active) || nextTabs.at(-1)
      if (nextActive) {
        setActivePath(nextActive.path)
        editorRef.current?.setModel(nextActive.model)
        if (nextActive.viewState) editorRef.current?.restoreViewState(nextActive.viewState)
      } else {
        setActivePath(null)
        editorRef.current?.setModel(null)
      }
      await treeTask
      if (generation !== lifecycleRef.current || request !== reloadRef.current) return false
      showMessage(
        removed.length
          ? `已重新加载分支内容，${removed.length} 个不存在的文件已关闭`
          : '已重新加载分支内容',
        true,
        removed.length > 0
      )
      return true
    },
    [loadRoot, setActivePath, setTabs, showMessage]
  )

  useImperativeHandle(
    ref,
    () => ({
      openFile,
      closeActive() {
        if (!activeRef.current) return false
        closeFile(activeRef.current)
        return true
      },
      hasDirty() {
        return tabsRef.current.some((tab) => tab.dirty || tab.saving || tab.loading)
      },
      reloadAfterGitChange,
      layout() {
        editorRef.current?.layout()
      }
    }),
    [closeFile, openFile, reloadAfterGitChange]
  )

  const toggleDirectory = useCallback(async (node) => {
    if (node.loading) return
    if (node.expanded || node.loaded) {
      setTree((value) => ({
        ...value,
        children: updateTree(value.children, node.path, (item) => ({
          ...item,
          expanded: !item.expanded
        }))
      }))
      return
    }
    const request = requestRef.current
    setTree((value) => ({
      ...value,
      children: updateTree(value.children, node.path, (item) => ({
        ...item,
        expanded: true,
        loading: true,
        error: ''
      }))
    }))
    try {
      const result = await window.mica.files.list(node.path)
      if (request !== requestRef.current) return
      setTree((value) => ({
        ...value,
        children: updateTree(value.children, node.path, (item) => ({
          ...item,
          loaded: true,
          loading: false,
          children: result.entries.map(makeNode)
        }))
      }))
    } catch (error) {
      if (request === requestRef.current)
        setTree((value) => ({
          ...value,
          children: updateTree(value.children, node.path, (item) => ({
            ...item,
            loaded: false,
            loading: false,
            error: error?.message || String(error)
          }))
        }))
    }
  }, [])

  const layout = useCallback(() => editorRef.current?.layout(), [])
  const { width, separatorProps } = usePaneWidth({
    storageKey: 'mica.filesTreeWidth',
    initial: 260,
    min: 180,
    minRight: 305,
    containerRef: viewRef,
    onLayout: layout
  })
  useEffect(() => {
    if (visible) requestAnimationFrame(layout)
  }, [layout, visible, width, tabs.length])

  useEffect(() => {
    if (!activePath) return
    requestAnimationFrame(() => {
      const activeTabElement = [...(tabListRef.current?.children || [])].find(
        (element) => element.dataset.path === activePath
      )
      activeTabElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }, [activePath, tabs.length])

  const handleTabKeyDown = useCallback(
    (event, path) => {
      if (['Enter', ' '].includes(event.key)) {
        event.preventDefault()
        activateFile(path)
        return
      }
      const items = tabsRef.current
      const currentIndex = items.findIndex((tab) => tab.path === path)
      if (currentIndex < 0) return
      let nextIndex
      if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + items.length) % items.length
      else if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % items.length
      else if (event.key === 'Home') nextIndex = 0
      else if (event.key === 'End') nextIndex = items.length - 1
      else return
      event.preventDefault()
      activateFile(items[nextIndex].path, false)
      requestAnimationFrame(() => {
        tabListRef.current?.children[nextIndex]?.querySelector('[role="tab"]')?.focus()
      })
    },
    [activateFile]
  )

  const activeTab = tabs.find((tab) => tab.path === activePath)
  const breadcrumbs = activeTab ? relativeParts(tree.root, activeTab.path) : []
  const isGitPanel = activePanel === 'git' || activePanel === 'git-tree'
  const changeCount = gitRepository?.files?.length || 0
  // 没有打开文件（也没有 Git 差异预览）时不显示编辑器面板，目录树占满整个右侧面板
  const hasEditorContent =
    tabs.length > 0 || (isGitPanel && !!gitSelectedFile) || (!!message && !message.transient)
  // 手机上目录树与编辑器互相占满：打开文件后显示编辑器，点「返回文件列表」切回目录树
  const isMobile = useIsMobile()
  const [mobileTreeVisible, setMobileTreeVisible] = useState(false)
  const editorOpen = hasEditorContent && !(isMobile && mobileTreeVisible)
  const tabNameCounts = tabs.reduce((counts, tab) => {
    counts.set(tab.name, (counts.get(tab.name) || 0) + 1)
    return counts
  }, new Map())
  // 活动栏徽标：有 Git 改动时在图标右下角显示改动条数（与 VS Code 源代码管理一致）
  const badges = changeCount ? { git: changeCount > 99 ? '99+' : String(changeCount) } : {}

  return (
    <section
      ref={viewRef}
      className={`relative min-h-0 flex-1 bg-canvas no-drag ${visible ? 'flex' : 'hidden'}`}
    >
      <nav
        className={`w-11 shrink-0 flex-col items-center gap-1 border-r border-white/[.07] bg-raised py-1.5 ${
          isMobile && editorOpen ? 'hidden' : 'flex'
        }`}
        aria-label="活动栏"
      >
        {[
          ['explorer', IconFiles, '资源管理器'],
          ['search', IconSearch, '搜索'],
          ['git', IconGitBranch, '源代码管理'],
          ['git-tree', IconChristmasTree, 'Git 变更树']
        ].map(([id, Icon, label]) => {
          const active = activePanel === id
          return (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={badges?.[id] ? `${label}，${changeCount} 处改动` : label}
              aria-pressed={active}
              className={`relative grid size-9 place-items-center rounded-md transition-colors ${active ? 'bg-white/[.09] text-white' : 'text-white/45 hover:bg-white/[.05] hover:text-white'}`}
              onClick={() => switchPanel(id)}
            >
              <Icon size={17} className="shrink-0" />
              {badges[id] && (
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -bottom-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[9px] font-semibold leading-none text-white"
                >
                  {badges[id]}
                </span>
              )}
            </button>
          )
        })}
      </nav>
      <aside
        className={`min-h-0 flex-col bg-raised ${
          isMobile && editorOpen ? 'hidden' : `flex ${editorOpen ? 'shrink-0' : 'min-w-0 flex-1'}`
        }`}
        style={editorOpen && !isMobile ? { width } : undefined}
        aria-label="侧边面板"
      >
        {activePanel === 'search' ? (
          <SearchPanel root={root} onOpenFile={openFile} activePath={activePath} />
        ) : isGitPanel ? (
          <GitPanel
            cwd={gitCwd || null}
            repository={gitRepository}
            loading={gitLoading}
            selectedPath={gitSelectedFile?.path}
            onSelectFile={selectGitFile}
            heading={activePanel === 'git-tree' ? 'GIT TREE' : 'CHANGES'}
            rootLabel={activePanel === 'git-tree' ? gitBranch || null : null}
          />
        ) : (
          <>
            <header className="flex h-9 shrink-0 items-center gap-0.5 px-2">
              <div
                className="min-w-0 flex-1 truncate text-[11px] font-semibold text-white/70"
                title={tree.root || ''}
              >
                {tree.root ? fileName(tree.root) : '资源管理器'}
              </div>
              <button
                type="button"
                disabled={!tree.root}
                title="新建文件"
                aria-label="新建文件"
                className="grid size-6.5 shrink-0 place-items-center rounded-sm text-white/45 hover:bg-white/[.06] hover:text-white disabled:opacity-30"
                onClick={() =>
                  runFileAction('new-file', {
                    path: tree.root,
                    type: 'directory',
                    name: fileName(tree.root)
                  })
                }
              >
                <IconFilePlus size={15} />
              </button>
              <button
                type="button"
                disabled={!tree.root}
                title="新建文件夹"
                aria-label="新建文件夹"
                className="grid size-6.5 shrink-0 place-items-center rounded-sm text-white/45 hover:bg-white/[.06] hover:text-white disabled:opacity-30"
                onClick={() =>
                  runFileAction('new-directory', {
                    path: tree.root,
                    type: 'directory',
                    name: fileName(tree.root)
                  })
                }
              >
                <IconFolderPlus size={15} />
              </button>
              <button
                type="button"
                disabled={!tree.root}
                title="折叠所有文件夹"
                aria-label="折叠所有文件夹"
                className="grid size-6.5 shrink-0 place-items-center rounded-sm text-white/45 hover:bg-white/[.06] hover:text-white disabled:opacity-30"
                onClick={collapseAll}
              >
                <IconSquareMinus size={15} />
              </button>
              <button
                type="button"
                title="更多操作"
                aria-label="更多操作"
                aria-haspopup="menu"
                data-menu-anchor="explorer"
                aria-expanded={explorerMenu ? 'true' : 'false'}
                className={`grid size-6.5 shrink-0 place-items-center rounded-sm hover:bg-white/[.06] hover:text-white ${
                  explorerMenu ? 'bg-white/[.06] text-white' : 'text-white/45'
                }`}
                onClick={openExplorerMenu}
              >
                <IconDots size={15} />
              </button>
            </header>
            <div className="relative min-h-0 flex-1">
              <div
                className="thin-scrollbar h-full overflow-auto px-1.5 py-1 select-none"
                role="tree"
                aria-label="文件目录"
              >
                <FileTreeRows
                  nodes={applyOrder(tree.children, tree.root, orderMap)}
                  activePath={activePath}
                  dragPath={dragPath}
                  dropPath={dropPath}
                  siblingDrop={siblingDrop}
                  orderMap={orderMap}
                  gitRoot={gitRoot}
                  gitDecorations={gitDecorations}
                  onToggle={toggleDirectory}
                  onOpen={(path) => {
                    setMobileTreeVisible(false)
                    openFile(path)
                  }}
                  onContextMenu={openContextMenu}
                  onDragStart={startFileDrag}
                  onDragEnd={finishFileDrag}
                  onDrop={handleFileDrop}
                  onSiblingHover={handleSiblingHover}
                  onSiblingDrop={handleSiblingDrop}
                />
              </div>
              {tree.status && (
                <div
                  role="status"
                  className="absolute inset-0 grid place-items-center bg-raised px-4 text-center text-[11px] text-white/35"
                >
                  {tree.status}
                </div>
              )}
            </div>
          </>
        )}
      </aside>
      {contextMenu && (
        <FileContextMenu
          menu={contextMenu}
          onAction={runFileAction}
          onClose={() => setContextMenu(null)}
        />
      )}
      {explorerMenu && (
        <ExplorerMenu
          menu={explorerMenu}
          onAction={runExplorerAction}
          onClose={() => setExplorerMenu(null)}
        />
      )}
      <div
        {...separatorProps}
        className={`pane-resizer z-10 w-1.25 shrink-0 ${editorOpen && !isMobile ? '' : 'hidden'}`}
        role="separator"
        aria-label="调整文件目录宽度"
        aria-orientation="vertical"
        aria-valuemin="180"
        aria-valuenow={width}
        tabIndex={0}
      />
      {onCornerResizeStart && (
        <div
          className="pane-corner-resizer absolute z-30"
          style={{ left: width + 2.5, top: '100%' }}
          title="同时调整文件目录宽度和终端高度"
          aria-hidden="true"
          data-resizing={separatorProps['data-resizing']}
          onPointerDown={(event) => {
            separatorProps.onPointerDown(event)
            onCornerResizeStart(event)
          }}
          onPointerMove={separatorProps.onPointerMove}
          onPointerUp={separatorProps.onPointerUp}
          onPointerCancel={separatorProps.onPointerCancel}
        />
      )}
      <section
        id="file-editor-panel"
        role="tabpanel"
        className={`min-w-0 min-h-0 flex-1 flex-col ${editorOpen ? 'flex' : 'hidden'}`}
        aria-label={activeTab ? `${activeTab.name} 编辑器` : '文件编辑器'}
      >
        {isGitPanel && gitSelectedFile ? (
          <GitDiffEditor cwd={gitCwd || null} file={gitSelectedFile} onClose={closeGitDiff} />
        ) : (
          <>
            <div
              ref={tabListRef}
              className={`thin-scrollbar h-9 shrink-0 overflow-x-auto overflow-y-hidden border-b border-white/[.07] bg-raised ${tabs.length ? 'flex' : 'hidden'}`}
              role="tablist"
              aria-label="打开的文件"
            >
              {isMobile && (
                <button
                  type="button"
                  title="返回文件列表"
                  aria-label="返回文件列表"
                  className="sticky left-0 z-10 grid h-[35px] w-9 shrink-0 place-items-center border-r border-white/[.07] bg-raised text-white/60"
                  onClick={() => setMobileTreeVisible(true)}
                >
                  <IconArrowLeft size={15} />
                </button>
              )}
              {tabs.map((tab) => (
                <div
                  key={tab.path}
                  data-path={tab.path}
                  title={tab.path}
                  className={`group relative flex h-[35px] min-w-32 max-w-64 flex-[0_1_184px] items-center gap-2 border-r border-white/[.07] px-2.5 text-[11px] ${tab.path === activePath ? 'bg-canvas text-white' : 'text-white/50 hover:bg-white/[.035] hover:text-white/75'}`}
                  onAuxClick={(event) => event.button === 1 && closeFile(tab.path)}
                >
                  {tab.path === activePath && (
                    <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-info" />
                  )}
                  <button
                    type="button"
                    role="tab"
                    tabIndex={tab.path === activePath ? 0 : -1}
                    aria-selected={tab.path === activePath}
                    aria-controls="file-editor-panel"
                    aria-label={`${tab.name}${tabNameCounts.get(tab.name) > 1 ? `，${parentName(tab.path)} 文件夹` : ''}${tab.dirty ? '，未保存' : ''}${tab.loading ? '，正在打开' : ''}${tab.saving ? '，正在保存' : ''}`}
                    className="flex min-w-0 flex-1 items-center gap-2 self-stretch overflow-hidden text-left"
                    onClick={() => activateFile(tab.path)}
                    onKeyDown={(event) => handleTabKeyDown(event, tab.path)}
                  >
                    <FileIcon name={tab.name} className="size-4" />
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
                      <span className="min-w-0 truncate">{tab.name}</span>
                      {tabNameCounts.get(tab.name) > 1 && (
                        <span className="shrink truncate text-[9px] text-white/30">
                          {parentName(tab.path)}
                        </span>
                      )}
                    </span>
                  </button>
                  <span className="relative grid size-5 shrink-0 place-items-center">
                    {(tab.loading || tab.saving) && (
                      <span
                        className="size-2.5 animate-spin rounded-full border border-white/25 border-t-white/75"
                        aria-hidden="true"
                      />
                    )}
                    {tab.dirty && !tab.loading && !tab.saving && (
                      <span
                        className="size-1.75 rounded-full bg-white/65 group-hover:hidden group-focus-within:hidden"
                        aria-hidden="true"
                      />
                    )}
                    {!tab.loading && !tab.saving && (
                      <button
                        type="button"
                        tabIndex={tab.path === activePath ? 0 : -1}
                        title={`关闭 ${tab.name}`}
                        aria-label={`关闭 ${tab.name}`}
                        className={`${
                          tab.dirty || tab.path !== activePath
                            ? isMobile
                              ? 'opacity-70'
                              : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
                            : ''
                        } absolute inset-0 grid place-items-center rounded-sm text-white/45 hover:bg-white/10 hover:text-white`}
                        onClick={(event) => {
                          event.stopPropagation()
                          closeFile(tab.path)
                        }}
                      >
                        <IconX size={12} />
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {activeTab && (
              <div className="flex h-7.5 shrink-0 items-center gap-1 overflow-hidden border-b border-white/[.07] px-3 text-[10px] text-white/40">
                {breadcrumbs.map((part, index) => (
                  <span key={`${part}-${index}`} className="contents">
                    {index > 0 && <span className="shrink-0 text-sm text-white/25">›</span>}
                    <span
                      className={`truncate ${index === breadcrumbs.length - 1 ? 'text-white/60' : ''}`}
                    >
                      {part}
                    </span>
                  </span>
                ))}
                <span className="ml-auto shrink-0">
                  {activeTab.saving ? '正在保存…' : activeTab.dirty ? '未保存' : ''}
                </span>
              </div>
            )}
            <div className="relative min-h-0 flex-1">
              <div ref={editorHostRef} className="size-full" />
              {message && !message.transient && (
                <div
                  role="status"
                  className="absolute inset-0 grid place-items-center bg-canvas p-6 text-center text-xs text-white/35"
                >
                  {message.text}
                </div>
              )}
            </div>
          </>
        )}
      </section>
      {message?.transient && (
        <div
          role="status"
          className={`absolute bottom-3.5 right-4 z-20 max-w-[calc(100%-32px)] rounded-sm border bg-raised/96 px-2.5 py-1.5 text-xs shadow-xl ${message.error ? 'border-danger/40 text-danger-soft' : 'border-white/15 text-white/70'}`}
        >
          {message.text}
        </div>
      )}
    </section>
  )
})
