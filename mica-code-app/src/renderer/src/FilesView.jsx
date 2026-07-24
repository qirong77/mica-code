import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  ArrowUp,
  ChevronRight,
  Clipboard,
  Copy,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react'
import { FileIcon, FileSystemIcon } from './FileIcon'
import { useLatest, usePaneWidth } from './hooks'
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

function FileContextMenu({ menu, onAction, onClose }) {
  useEffect(() => {
    const close = () => onClose()
    const keydown = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', keydown)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', keydown)
    }
  }, [onClose])
  const directory = menu.node.type === 'directory'
  const items = [
    ...(directory
      ? [
          { id: 'new-file', label: '新建文件', icon: FilePlus },
          { id: 'new-directory', label: '新建文件夹', icon: FolderPlus },
          { separator: true }
        ]
      : []),
    { id: 'rename', label: '重命名', icon: Pencil },
    { id: 'duplicate', label: '创建副本', icon: Copy },
    { separator: true },
    { id: 'copy-path', label: '复制路径', icon: Clipboard },
    { id: 'copy-relative-path', label: '复制相对路径', icon: Clipboard },
    { id: 'reveal', label: '在文件管理器中显示', icon: FolderOpen },
    { separator: true },
    { id: 'delete', label: '删除', icon: Trash2, danger: true }
  ]
  return (
    <div
      className="fixed z-[10000] min-w-48 rounded-md border border-white/15 bg-[#181818]/98 p-1.5 text-xs shadow-2xl backdrop-blur"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={`separator-${index}`} className="my-1 border-t border-white/10" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`flex h-7 w-full items-center gap-2 rounded px-2 text-left hover:bg-white/[.08] ${item.danger ? 'text-[#ef7288]' : 'text-white/75 hover:text-white'}`}
            onClick={() => onAction(item.id, menu.node)}
          >
            <item.icon size={14} className="shrink-0 opacity-75" />
            {item.label}
          </button>
        )
      )}
    </div>
  )
}

function FileTreeRows({
  nodes,
  depth = 0,
  activePath,
  dragPath,
  dropPath,
  onToggle,
  onOpen,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDrop
}) {
  return nodes.map((node) => {
    const directory = node.type === 'directory'
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
          } ${dragPath === node.path ? 'opacity-40' : ''} ${dropPath === node.path ? 'ring-1 ring-inset ring-[#5aa7e8]/70 bg-[#5aa7e8]/10' : ''}`}
          style={{ paddingLeft: 5 + depth * 13 }}
          onClick={() => (directory ? onToggle(node) : onOpen(node.path))}
          onContextMenu={(event) => onContextMenu(event, node)}
          onDragStart={(event) => onDragStart(event, node)}
          onDragEnd={onDragEnd}
          onDragOver={(event) => {
            if (!directory || dragPath === node.path) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
          }}
          onDragEnter={(event) => directory && onDrop(event, node, false)}
          onDrop={(event) => directory && onDrop(event, node, true)}
        >
          <span
            className={`grid size-3.5 shrink-0 place-items-center text-white/35 ${node.expanded ? 'rotate-90' : ''}`}
          >
            {directory && <ChevronRight size={13} />}
          </span>
          <span className="grid size-4 shrink-0 place-items-center text-white/50">
            <FileSystemIcon
              name={node.name}
              type={node.type}
              expanded={node.expanded}
              className="size-4"
            />
          </span>
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {node.loading && <span className="text-white/35">…</span>}
        </button>
        {directory &&
          node.expanded &&
          (node.error ? (
            <div
              className="py-1 pr-2 text-[11px] text-[#e75e78]/85"
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
              nodes={node.children}
              depth={depth + 1}
              activePath={activePath}
              dragPath={dragPath}
              dropPath={dropPath}
              onToggle={onToggle}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDrop={onDrop}
            />
          ))}
      </div>
    )
  })
}

export const FilesView = forwardRef(function FilesView(
  { root, visible, askText, onCornerResizeStart },
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
  const [dragPath, setDragPath] = useState(null)
  const [dropPath, setDropPath] = useState(null)
  const [message, setMessage] = useState({
    text: '从左侧目录选择文件以开始编辑',
    transient: false,
    error: false
  })

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
          showMessage('从左侧目录选择文件以开始编辑')
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
      x: Math.min(event.clientX, window.innerWidth - 210),
      y: Math.min(event.clientY, window.innerHeight - (node.type === 'directory' ? 305 : 240))
    })
  }, [])

  const startFileDrag = useCallback((event, node) => {
    setContextMenu(null)
    setDragPath(node.path)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', node.path)
  }, [])

  const finishFileDrag = useCallback(() => {
    setDragPath(null)
    setDropPath(null)
  }, [])

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
  }, [layout, visible, width])

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
  const tabNameCounts = tabs.reduce((counts, tab) => {
    counts.set(tab.name, (counts.get(tab.name) || 0) + 1)
    return counts
  }, new Map())

  return (
    <section
      ref={viewRef}
      className={`relative min-h-0 flex-1 bg-[#0e0e0e] no-drag ${visible ? 'flex' : 'hidden'}`}
    >
      <aside
        className="flex min-h-0 shrink-0 flex-col bg-[#111]"
        style={{ width }}
        aria-label="文件资源管理器"
      >
        <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-white/[.07] px-2">
          <button
            type="button"
            disabled={!tree.parent}
            title="返回上级目录"
            aria-label="返回上级目录"
            className="grid size-6.5 shrink-0 place-items-center rounded-sm text-white/45 hover:bg-white/[.06] hover:text-white disabled:opacity-30"
            onClick={() => loadRoot(tree.parent)}
          >
            <ArrowUp size={15} />
          </button>
          <div
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/65"
            title={tree.root || ''}
          >
            {tree.root}
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
            <FilePlus size={14} />
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
            <FolderPlus size={14} />
          </button>
          <button
            type="button"
            title="刷新"
            aria-label="刷新"
            className="grid size-6.5 shrink-0 place-items-center rounded-sm text-white/45 hover:bg-white/[.06] hover:text-white"
            onClick={refresh}
          >
            <RefreshCw size={14} />
          </button>
        </header>
        <div className="relative min-h-0 flex-1">
          <div
            className="thin-scrollbar h-full overflow-auto px-1.5 py-1 select-none"
            role="tree"
            aria-label="文件目录"
          >
            <FileTreeRows
              nodes={tree.children}
              activePath={activePath}
              dragPath={dragPath}
              dropPath={dropPath}
              onToggle={toggleDirectory}
              onOpen={openFile}
              onContextMenu={openContextMenu}
              onDragStart={startFileDrag}
              onDragEnd={finishFileDrag}
              onDrop={handleFileDrop}
            />
          </div>
          {tree.status && (
            <div
              role="status"
              className="absolute inset-0 grid place-items-center bg-[#111] px-4 text-center text-[11px] text-white/35"
            >
              {tree.status}
            </div>
          )}
        </div>
      </aside>
      {contextMenu && (
        <FileContextMenu
          menu={contextMenu}
          onAction={runFileAction}
          onClose={() => setContextMenu(null)}
        />
      )}
      <div
        {...separatorProps}
        className="pane-resizer z-10 w-1.25 shrink-0"
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
        className="flex min-w-0 min-h-0 flex-1 flex-col"
        aria-label={activeTab ? `${activeTab.name} 编辑器` : '文件编辑器'}
      >
        <div
          ref={tabListRef}
          className="thin-scrollbar flex h-9 shrink-0 overflow-x-auto overflow-y-hidden border-b border-white/[.07] bg-[#111]"
          role="tablist"
          aria-label="打开的文件"
        >
          {tabs.map((tab) => (
            <div
              key={tab.path}
              data-path={tab.path}
              title={tab.path}
              className={`group relative flex h-[35px] min-w-32 max-w-64 flex-[0_1_184px] items-center gap-2 border-r border-white/[.07] px-2.5 text-[11px] ${tab.path === activePath ? 'bg-[#0e0e0e] text-white' : 'text-white/50 hover:bg-white/[.035] hover:text-white/75'}`}
              onAuxClick={(event) => event.button === 1 && closeFile(tab.path)}
            >
              {tab.path === activePath && (
                <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-[#5aa7e8]" />
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
                    className={`${tab.dirty || tab.path !== activePath ? 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100' : ''} absolute inset-0 grid place-items-center rounded-sm text-white/45 hover:bg-white/10 hover:text-white`}
                    onClick={(event) => {
                      event.stopPropagation()
                      closeFile(tab.path)
                    }}
                  >
                    <X size={12} />
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
          {message && (
            <div
              role="status"
              className={
                message.transient
                  ? `absolute bottom-3.5 right-4 max-w-[calc(100%-32px)] rounded-sm border bg-[#181818]/96 px-2.5 py-1.5 text-xs shadow-xl ${message.error ? 'border-[#e75e78]/40 text-[#f08a9d]' : 'border-white/15 text-white/70'}`
                  : 'absolute inset-0 grid place-items-center bg-[#0e0e0e] p-6 text-center text-xs text-white/35'
              }
            >
              {message.text}
            </div>
          )}
        </div>
      </section>
    </section>
  )
})
