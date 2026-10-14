import {
  Suspense,
  forwardRef,
  lazy,
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
import { GitPanel, SearchPanel } from './FileSidePanels'
import { buildGitDecorations, relativeToRoot, statusColor, statusLabel } from './git-decorations'
import { longPressHandlers, useIsMobile, useLatest, usePaneWidth } from './hooks'
import { editorOptions, fileName, languageFor, loadMonaco } from './monaco'
// 品牌标志全仓库只有一份（apps/desktop/resources/icon.svg），空编辑器水印直接引用它。
import brandMark from '../../../resources/icon.svg?url&no-inline'

// diff 视图静态依赖 monaco 本体，拆成独立模块后只在挑选 diff 时才下载。
const GitDiffEditor = lazy(() =>
  import('./GitDiffEditor').then((module) => ({ default: module.GitDiffEditor }))
)

// 资源管理器的横向栅格，取自 VS Code 实测值：每层只缩进 8px，行内是
// 「16px 箭头格 + 16px 图标格 + 5px 间隙」——所以文件名的左边距就是 57 + 8 * depth，
// 缩进参考线落在父级箭头中心（28 + 8 * depth）。行高同样是 VS Code 的 22px。
const TREE_INDENT = 8
const TREE_LABEL_INSET = 57
const TREE_LABEL_OFFSET = 37

const makeNode = (entry) => ({
  name: entry.name,
  path: entry.path,
  type: entry.type,
  ignored: !!entry.ignored,
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

// 空编辑器水印：对齐 VS Code 的 editor placeholder（品牌标记 + 常用快捷键）。
// 没有打开文件时用它填住编辑器分栏，而不是让目录树撑满整个文件视图——这样目录树的
// 宽度与「有没有打开文件」无关，和 VS Code 一样。
function EmptyEditorWatermark() {
  const mac = window.mica.platform === 'darwin'
  const shortcuts = [
    ['快速打开文件', mac ? '⌘ P' : 'Ctrl P'],
    ['在文件中搜索', mac ? '⇧ ⌘ F' : 'Ctrl ⇧ F'],
    ['关闭当前编辑器', mac ? '⌘ W' : 'Ctrl W'],
    // 终端开关两端都只认 Ctrl+`（macOS 的 ⌘` 是系统保留键），不要写成 ⌘。
    ['显示/隐藏终端', 'Ctrl `']
  ]
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      <div className="flex w-60 -translate-y-10 flex-col items-center">
        <img src={brandMark} alt="" aria-hidden="true" className="w-28 opacity-[.13] grayscale" />
        <dl className="mt-10 w-full space-y-0.5 text-[12px]">
          {shortcuts.map(([label, keys]) => (
            <div key={label} className="flex items-baseline justify-between gap-4">
              <dt className="truncate text-white/40">{label}</dt>
              <dd className="shrink-0 font-mono text-[11px] text-white/30">{keys}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
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
    const ignored = !!node.ignored
    // 被 .gitignore 忽略的条目整体置灰（图标一并脱色），但仍然可以打开/展开
    const tone =
      node.path === activePath
        ? 'bg-white/[.075] text-white'
        : ignored
          ? 'text-white/30 hover:text-white/50'
          : 'text-white/70 hover:text-white'
    return (
      <div key={node.path}>
        <button
          type="button"
          role="treeitem"
          aria-expanded={directory ? node.expanded : undefined}
          draggable
          title={ignored ? `${node.path}（已被 .gitignore 忽略）` : node.path}
          className={`flex h-[22px] w-full items-center rounded pr-1.5 text-left text-[13px] hover:bg-list-hover ${tone} ${
            dragPath === node.path ? 'opacity-40' : ''
          } ${dropPath === node.path ? 'ring-1 ring-inset ring-info/70 bg-info/10' : ''}`}
          style={{
            // 与 VS Code 的资源管理器一致：16px 箭头格 + 16px 图标格 + 5px 间隙，
            // 每层只缩进 8px（不是 13px），所以深层级不会早早把标题挤出面板。
            paddingLeft: TREE_LABEL_INSET - TREE_LABEL_OFFSET + depth * TREE_INDENT,
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
            className={`grid size-4 shrink-0 place-items-center text-white/40 ${node.expanded ? 'rotate-90' : ''}`}
          >
            {directory && <IconChevronRight size={14} />}
          </span>
          <span className="grid size-4 shrink-0 place-items-center text-white/50">
            <FileSystemIcon
              name={node.name}
              type={node.type}
              expanded={node.expanded}
              className={`size-4 ${ignored ? 'opacity-45 grayscale' : ''}`}
            />
          </span>
          <span
            className="ml-[5px] min-w-0 flex-1 truncate"
            style={decoration ? { color: statusColor(decoration) } : undefined}
          >
            {node.name}
          </span>
          {node.loading && <span className="text-white/35">…</span>}
          {fileStatus && (
            <span
              className="ml-1.5 shrink-0 font-mono text-[11px] font-semibold"
              style={{ color: statusColor(fileStatus) }}
            >
              {statusLabel(fileStatus)}
            </span>
          )}
          {folderStatus && (
            <span
              aria-hidden="true"
              className="ml-1.5 size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: statusColor(folderStatus), opacity: 0.75 }}
            />
          )}
        </button>
        {directory &&
          node.expanded &&
          (node.error ? (
            <div
              className="py-1 pr-2 text-[11px] text-danger/85"
              style={{ paddingLeft: TREE_LABEL_INSET + (depth + 1) * TREE_INDENT }}
            >
              无法读取：{node.error}
            </div>
          ) : node.loaded && !node.children.length ? (
            <div
              className="py-1 pr-2 text-[11px] text-white/30"
              style={{ paddingLeft: TREE_LABEL_INSET + (depth + 1) * TREE_INDENT }}
            >
              空文件夹
            </div>
          ) : (
            <div className="relative">
              {/* 缩进参考线：与 VS Code 一样落在父级箭头的中心线上（只有展开的分支才画）。 */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 w-px bg-white/[.09]"
                style={{ left: TREE_LABEL_INSET - TREE_LABEL_OFFSET + 8 + depth * TREE_INDENT }}
              />
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
            </div>
          ))}
      </div>
    )
  })
}

/** 标签条底部的 1px 分隔线：VS Code 只在非活动标签下画线，活动标签与编辑器连成一片，
    所以线画成内阴影而不是容器边框（边框没法被活动标签盖掉）。 */
const TAB_UNDERLINE = 'shadow-[inset_0_-1px_0_0_var(--color-line)]'

export const FilesView = forwardRef(function FilesView(
  {
    root,
    visible,
    askText,
    onCornerResizeStart,
    gitCwd,
    gitRepository,
    gitBranchChanges,
    gitLoading,
    gitBranch,
    onRefreshGit
  },
  ref
) {
  const viewRef = useRef(null)
  const editorHostRef = useRef(null)
  const editorRef = useRef(null)
  /** ensureEditor() 的单调 promise：monaco 装载 + 编辑器创建只做一次 */
  const editorReadyRef = useRef(null)
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
  // GIT TREE 面板比的是「当前分支相对基线分支（origin/HEAD → master/main）」的变更，
  // 提交前后都看得见；没有基线（例如就停在主分支上）时退回工作区语义，
  // 于是它和 CHANGES 一样只列还没提交的改动。
  const branchChanges = useMemo(
    () => (gitBranchChanges?.base ? gitBranchChanges : null),
    [gitBranchChanges]
  )

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

  // 选中的文件要记住自己是从哪个面板点开的：GIT TREE 里的文件跟 merge-base 比，
  // CHANGES 里的跟 HEAD 比（见 GitDiffEditor 的 `base`）。
  const selectGitFile = useCallback((file, base = 'head') => {
    if (file && file.path) setGitSelectedFile({ ...file, base })
  }, [])

  const closeGitDiff = useCallback(() => setGitSelectedFile(null), [])

  /**
   * 源代码管理行内悬浮出来的三个操作（对应 VS Code 的同名按钮）。放弃更改不可逆
   * ——未跟踪文件会被删掉、已跟踪文件会被恢复——所以先确认。做完统一刷新 Git 数据，
   * 让「暂存的更改 / 更改」两段立刻跟着变。
   */
  const gitFileAction = useCallback(
    async (kind, file) => {
      if (!gitCwd || !file?.path) return
      if (kind === 'discard') {
        const undo = file.status === 'added' ? '这个文件会被删除' : '这个文件会恢复成已保存的版本'
        const ok = window.confirm(`确定放弃“${file.path}”的更改吗？\n${undo}，且无法撤销。`)
        if (!ok) return
      }
      const result = await window.mica.git[kind](gitCwd, file.path)
      if (result?.error) {
        // 走短暂提示（跟其它操作失败一致）：非 transient 的消息会整块盖住编辑器分栏
        // 且一直留着，看起来像「文件页面不能用了」。
        showMessage(`Git 操作失败：${result.error}`, true, true)
        return
      }
      if (kind === 'discard' && gitSelectedFile?.path === file.path) setGitSelectedFile(null)
      await onRefreshGit?.()
    },
    [gitCwd, gitSelectedFile, onRefreshGit, showMessage]
  )

  const switchPanel = useCallback((panel) => {
    setActivePanel((current) => (current === panel ? 'explorer' : panel))
  }, [])

  useEffect(() => {
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
      editorRef.current?.dispose()
      editorRef.current = null
      editorReadyRef.current = null
    }
  }, [])

  /**
   * 首次真正需要编辑器时才加载 monaco 并建实例（启动路径完全不碰它）。
   * 返回 monaco 本体，供 createModel / Uri 使用；已建好时立即 resolve。
   */
  const ensureEditor = useCallback(() => {
    if (!editorReadyRef.current) {
      const generation = lifecycleRef.current
      editorReadyRef.current = (async () => {
        const monaco = await loadMonaco()
        // 等待期间卸载/重挂过就不要往旧 host 上建
        if (generation !== lifecycleRef.current || !editorHostRef.current) return monaco
        const editor = monaco.editor.create(editorHostRef.current, {
          ...editorOptions,
          model: null
        })
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
          saveActionRef.current?.()
        )
        editorRef.current = editor
        return monaco
      })()
    }
    return editorReadyRef.current
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
        // 首次打开文件时这里才真正装载 monaco；装载期间用户可能切走/关掉页签。
        const monaco = await ensureEditor()
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
    [activateFile, ensureEditor, revealPosition, setActivePath, setTabs, showMessage]
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
  const isGitTree = activePanel === 'git-tree'
  // 徽标与资源管理器装饰始终是「工作区还没提交的改动」（与 VS Code 一致），
  // GIT TREE 面板则额外能看到分支上已经提交的改动。
  const changeCount = gitRepository?.files?.length || 0
  // 没有打开文件（也没有 Git 差异预览）时，编辑器分栏里显示空编辑器水印；
  // 目录树的宽度因此与「有没有打开文件」无关（与 VS Code 一致）。
  const hasEditorContent =
    tabs.length > 0 || (isGitPanel && !!gitSelectedFile) || (!!message && !message.transient)
  // 手机上目录树与编辑器互相占满：打开文件后显示编辑器，点「返回文件列表」切回目录树
  const isMobile = useIsMobile()
  const [mobileTreeVisible, setMobileTreeVisible] = useState(false)
  const editorOpen = isMobile ? hasEditorContent && !mobileTreeVisible : true
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
        className={`w-12 shrink-0 flex-col items-center border-r border-line bg-panel py-1 ${
          isMobile && editorOpen ? 'hidden' : 'flex'
        }`}
        aria-label="活动栏"
      >
        {[
          ['explorer', IconFiles, '资源管理器'],
          ['search', IconSearch, '搜索'],
          ['git', IconGitBranch, '源代码管理'],
          // 与 VS Code 的活动栏一致：变更树用一棵松树（圣诞树）标记，
          // 和上面的「源代码管理」分支图标区分开。
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
              className="group relative grid size-12 shrink-0 place-items-center"
              onClick={() => switchPanel(id)}
            >
              {/* VS Code 的活动栏是 48px 的项目里放 32px 的圆角高亮块 + 24px 图标 */}
              <span
                className={`grid size-8 place-items-center rounded-md transition-colors ${
                  active
                    ? 'bg-white/[.09] text-white'
                    : 'text-white/45 group-hover:bg-white/[.06] group-hover:text-white'
                }`}
              >
                <Icon size={24} className="shrink-0" />
              </span>
              {badges[id] && (
                <span
                  aria-hidden="true"
                  className="absolute right-1 bottom-2 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[9px] font-semibold leading-none text-white"
                >
                  {badges[id]}
                </span>
              )}
            </button>
          )
        })}
      </nav>
      <aside
        className={`min-h-0 flex-col bg-panel ${
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
            repository={isGitTree ? branchChanges || gitRepository : gitRepository}
            loading={gitLoading}
            onRefresh={onRefreshGit}
            selectedPath={gitSelectedFile?.path}
            onSelectFile={(file) =>
              selectGitFile(file, isGitTree && branchChanges ? 'branch' : 'head')
            }
            variant={isGitTree ? 'tree' : 'list'}
            title={isGitTree ? 'Git 变更树' : '源代码管理'}
            sectionLabel={isGitTree ? gitBranch || '更改' : '更改'}
            /* 面板名本身看不出在跟谁比：把基线写进 tooltip（提交过的改动也在这里出现）。 */
            compareLabel={isGitTree ? branchChanges?.baseLabel || null : null}
            emptyText={
              isGitTree && branchChanges
                ? `当前分支相对 ${branchChanges.baseLabel} 没有变更`
                : '工作区没有文件变化'
            }
            /* 行内悬浮操作只在「工作区改动」列表里有意义：GIT TREE 里的文件是相对
               基线的差异（含已提交的部分），暂存/放弃都无从谈起。 */
            onOpenFile={
              isGitTree
                ? undefined
                : (file) =>
                    openFile(
                      `${String(gitRepository?.root || '').replace(/\/+$/, '')}/${file.path}`
                    )
            }
            onStage={isGitTree ? undefined : (file) => gitFileAction('stage', file)}
            onUnstage={isGitTree ? undefined : (file) => gitFileAction('unstage', file)}
            onDiscard={isGitTree ? undefined : (file) => gitFileAction('discard', file)}
          />
        ) : (
          <>
            <header className="flex h-[35px] shrink-0 items-center gap-0.5 pl-4 pr-2">
              <div
                className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white/80"
                title={tree.root || ''}
              >
                {tree.root ? fileName(tree.root) : '资源管理器'}
              </div>
              <button
                type="button"
                disabled={!tree.root}
                title="新建文件"
                aria-label="新建文件"
                className="grid size-6 shrink-0 place-items-center rounded-sm text-white/45 hover:bg-white/[.06] hover:text-white disabled:opacity-30"
                onClick={() =>
                  runFileAction('new-file', {
                    path: tree.root,
                    type: 'directory',
                    name: fileName(tree.root)
                  })
                }
              >
                <IconFilePlus size={16} />
              </button>
              <button
                type="button"
                disabled={!tree.root}
                title="新建文件夹"
                aria-label="新建文件夹"
                className="grid size-6 shrink-0 place-items-center rounded-sm text-white/45 hover:bg-white/[.06] hover:text-white disabled:opacity-30"
                onClick={() =>
                  runFileAction('new-directory', {
                    path: tree.root,
                    type: 'directory',
                    name: fileName(tree.root)
                  })
                }
              >
                <IconFolderPlus size={16} />
              </button>
              <button
                type="button"
                disabled={!tree.root}
                title="刷新"
                aria-label="刷新"
                className="grid size-6 shrink-0 place-items-center rounded-sm text-white/45 hover:bg-white/[.06] hover:text-white disabled:opacity-30"
                onClick={refresh}
              >
                <IconRefresh size={16} />
              </button>
              <button
                type="button"
                disabled={!tree.root}
                title="折叠所有文件夹"
                aria-label="折叠所有文件夹"
                className="grid size-6 shrink-0 place-items-center rounded-sm text-white/45 hover:bg-white/[.06] hover:text-white disabled:opacity-30"
                onClick={collapseAll}
              >
                <IconSquareMinus size={16} />
              </button>
              <button
                type="button"
                title="更多操作"
                aria-label="更多操作"
                aria-haspopup="menu"
                data-menu-anchor="explorer"
                aria-expanded={explorerMenu ? 'true' : 'false'}
                className={`grid size-6 shrink-0 place-items-center rounded-sm hover:bg-white/[.06] hover:text-white ${
                  explorerMenu ? 'bg-white/[.06] text-white' : 'text-white/45'
                }`}
                onClick={openExplorerMenu}
              >
                <IconDots size={16} />
              </button>
            </header>
            <div className="relative min-h-0 flex-1">
              <div className="h-full overflow-auto select-none" role="tree" aria-label="文件目录">
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
                  className="absolute inset-0 grid place-items-center bg-panel px-4 text-center text-[11px] text-white/35"
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
          <Suspense fallback={null}>
            <GitDiffEditor cwd={gitCwd || null} file={gitSelectedFile} onClose={closeGitDiff} />
          </Suspense>
        ) : (
          <>
            <div
              ref={tabListRef}
              // 标签条底色比编辑器还暗（VS Code 的 editorGroupHeader.tabsBackground），
              // 活动标签用 canvas 才显得「亮出来」；Darcula 没有顶部高亮线，不加。
              className={`h-8 shrink-0 overflow-x-auto overflow-y-hidden bg-tabstrip ${tabs.length ? 'flex' : 'hidden'}`}
              role="tablist"
              aria-label="打开的文件"
            >
              {isMobile && (
                <button
                  type="button"
                  title="返回文件列表"
                  aria-label="返回文件列表"
                  className={`sticky left-0 z-10 grid h-8 w-9 shrink-0 place-items-center border-r border-line bg-tabstrip text-white/60 ${TAB_UNDERLINE}`}
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
                  className={`group relative flex h-8 min-w-32 max-w-64 flex-[0_1_184px] items-center gap-2 border-r border-line px-2.5 text-[13px] ${
                    tab.path === activePath
                      ? 'bg-canvas text-white'
                      : `text-white/50 hover:bg-white/[.035] hover:text-white/75 ${TAB_UNDERLINE}`
                  }`}
                  onAuxClick={(event) => event.button === 1 && closeFile(tab.path)}
                >
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
              {/* 铺满剩余宽度的填充块，只为把底部那条线延伸到标签右侧的空白区 */}
              <div aria-hidden="true" className={`min-w-px flex-1 ${TAB_UNDERLINE}`} />
            </div>
            {activeTab && (
              <div className="flex h-[22px] shrink-0 items-center gap-1 overflow-hidden border-b border-line px-3 text-[11px] text-white/40">
                {breadcrumbs.map((part, index) => (
                  <span key={`${part}-${index}`} className="contents">
                    {index > 0 && <span className="shrink-0 text-xs text-white/25">›</span>}
                    {/* 与 VS Code 一样，文件名前面带一个文件图标；中间的目录只有文字 */}
                    {index === breadcrumbs.length - 1 && (
                      <FileIcon name={activeTab.name} className="mr-0.5 size-3.5 shrink-0" />
                    )}
                    <span
                      className={`truncate ${index === breadcrumbs.length - 1 ? 'text-white/70' : ''}`}
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
              {!tabs.length && !(message && !message.transient) && <EmptyEditorWatermark />}
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
          className={`absolute bottom-3.5 right-4 z-20 max-w-[calc(100%-32px)] rounded-sm border bg-panel/96 px-2.5 py-1.5 text-xs shadow-xl ${message.error ? 'border-danger/40 text-danger-soft' : 'border-white/15 text-white/70'}`}
        >
          {message.text}
        </div>
      )}
    </section>
  )
})
