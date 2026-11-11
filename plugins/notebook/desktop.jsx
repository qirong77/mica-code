import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Check, ChevronDown, ChevronRight, Download, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, Menu, MoreHorizontal, PanelLeftClose, Plus, RefreshCw, Search, Trash2, Undo2, X } from 'lucide-react'
import { Alert, Button, Empty, Input, SelectMenu } from '@mica-config-ui/web'
import { Modal } from '../../packages/mica-config-ui/web/components/Modal'
import { createNotebookController, NotebookConflictError } from './controller'
import { createNode, createNodeId, emptyIndex, flattenVisibleTree, moveNode, renameNode, restoreNode, trashNode } from './model'
import { createEditorBridge } from './bridge'
import './notebook.css'

const message = (error) => error instanceof NotebookConflictError
  ? '这篇笔记已在其他窗口修改。当前草稿已保留，请先下载草稿备份，再重新打开最新版本。'
  : error instanceof Error ? error.message : String(error)

function download(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${name.replace(/[/\\:*?"<>|]/g, '-')}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 所有笔记在插件数据目录内，不属于会话、工作区或浏览器 localStorage。 */
export default function NotebookPage({ api }) {
  const [index, setIndex] = useState(emptyIndex)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [activeId, setActiveId] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [expanded, setExpanded] = useState(new Set())
  const [query, setQuery] = useState('')
  const [trash, setTrash] = useState(false)
  const [railOpen, setRailOpen] = useState(true)
  const [dialog, setDialog] = useState(null)
  const [busy, setBusy] = useState(false)
  const [saveState, setSaveState] = useState('saved')
  const [frameState, setFrameState] = useState('loading')
  const [frameKey, setFrameKey] = useState(0)
  const iframe = useRef(null)
  const bridge = useRef(null)
  const ready = useRef(false)
  const current = useRef(null)
  const drafts = useRef(new Map())
  const saveTimer = useRef(null)
  const writer = useRef(null)
  const mounted = useRef(true)
  const switching = useRef(false)
  const loadedNote = useRef(null)
  const tree = useRef(null)
  const actions = useRef({})
  const token = useMemo(() => createNodeId(), [frameKey])
  const controller = useMemo(() => createNotebookController({ host: api, onIndex: setIndex }), [api])
  const active = index.nodes.find((node) => node.id === activeId && !node.trashedAt)
  const selected = index.nodes.find((node) => node.id === selectedId)
  const visible = useMemo(() => flattenVisibleTree(index, { expanded, query, showTrash: trash }), [index, expanded, query, trash])
  const notesCount = index.nodes.filter((node) => node.kind === 'note' && !node.trashedAt).length

  const save = useCallback(async (target = current.current) => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (writer.current) { await writer.current; if (!target?.dirty) return true }
    const work = async () => {
      const draft = target
      if (!draft) return true
      while (draft.dirty) {
        const snapshot = draft.document
        const serialized = JSON.stringify(snapshot)
        setSaveState('saving')
        try {
          draft.version = await controller.saveDocument(draft.id, snapshot, { expectedVersion: draft.version })
          draft.saved = serialized
          draft.dirty = JSON.stringify(draft.document) !== serialized
        } catch (cause) {
          draft.dirty = true
          setSaveState('error')
          if (mounted.current) setError(message(cause))
          return false
        }
      }
      if (mounted.current) setSaveState('saved')
      return true
    }
    const task = work()
    writer.current = task
    try { return await task } finally { if (writer.current === task) writer.current = null }
  }, [controller])

  const acceptChange = useCallback((id, document) => {
    const draft = drafts.current.get(id)
    if (!draft || current.current !== draft) return
    draft.document = document
    draft.dirty = JSON.stringify(document) !== draft.saved
    if (!draft.dirty) return
    setSaveState('pending')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void save(draft) }, 650)
  }, [save])

  const flush = useCallback(async (includeIndex = true) => {
    try {
      if (switching.current && includeIndex) throw new Error('正在切换笔记，请稍后再返回')
      if (current.current && ready.current && loadedNote.current === current.current.id) {
        const result = await bridge.current.flush()
        if (result.noteId !== current.current.id) throw new Error('笔记切换尚未完成，请稍后再试')
        acceptChange(result.noteId, result.document)
      }
      if (!(await save())) return false
      if (includeIndex) await controller.flushIndex()
      return true
    } catch (cause) { setError(message(cause)); return false }
  }, [controller, save, acceptChange])

  const openNote = useCallback(async (id) => {
    if (switching.current) return
    if (current.current?.id === id) { if (window.matchMedia('(max-width: 760px)').matches) setRailOpen(false); return }
    switching.current = true
    bridge.current?.freeze(true)
    setBusy(true)
    try {
      if (!(await flush(false))) return
      let draft = drafts.current.get(id)
      if (!draft || !draft.dirty) {
        const snapshot = await controller.readDocument(id)
        draft = { id, document: snapshot.value, version: snapshot.version, saved: JSON.stringify(snapshot.value), dirty: false }
        drafts.current.set(id, draft)
      }
      current.current = draft
      setActiveId(id)
      setSelectedId(id)
      setSaveState(draft.dirty ? 'pending' : 'saved')
      setError('')
      loadedNote.current = null
      if (ready.current) await bridge.current.load(id, draft.document)
      if (window.matchMedia('(max-width: 760px)').matches) setRailOpen(false)
    } catch (cause) { setError(message(cause)) } finally { switching.current = false; bridge.current?.freeze(false); setBusy(false) }
  }, [controller, flush])

  actions.current = { flush, openNote, save }

  useEffect(() => {
    let alive = true
    mounted.current = true
    void controller.loadIndex().then(async (result) => {
      if (!alive) return
      setExpanded(new Set(result.nodes.filter((node) => node.kind === 'folder').map((node) => node.id)))
      setLoaded(true)
      const first = result.nodes.find((node) => node.kind === 'note' && !node.trashedAt)
      if (first) await actions.current.openNote(first.id)
    }).catch((cause) => { if (alive) { setError(message(cause)); setLoaded(true) } })
    return () => { alive = false; mounted.current = false; if (saveTimer.current) clearTimeout(saveTimer.current); void actions.current.save() }
  }, [controller])

  useEffect(() => {
    ready.current = false
    setFrameState('loading')
    const instance = createEditorBridge({
      token,
      target: () => iframe.current?.contentWindow ?? null,
      onReady() {
        ready.current = true
        setFrameState('ready')
        syncTheme()
        if (current.current) void instance.load(current.current.id, current.current.document).catch((cause) => setError(message(cause)))
      },
      onLoaded(id) { loadedNote.current = id },
      onChange: acceptChange,
      onError(text) { setError(text); setFrameState(ready.current ? 'ready' : 'error') }
    })
    bridge.current = instance
    function syncTheme() {
      const style = getComputedStyle(document.documentElement)
      const swatch = document.createElement('span')
      document.body.appendChild(swatch)
      const tokens = {}
      for (const key of [...style]) {
        if (!key.startsWith('--color-')) continue
        swatch.style.color = `var(${key})`
        tokens[key] = getComputedStyle(swatch).color
      }
      tokens['--chat-text-size'] = style.getPropertyValue('--chat-text-size').trim()
      tokens['font-family'] = getComputedStyle(document.body).fontFamily
      swatch.remove()
      instance.theme(document.documentElement.dataset.appearance || 'light', tokens)
    }
    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-appearance'] })
    window.addEventListener('message', instance.receive)
    const timer = setTimeout(() => { if (!ready.current) { setFrameState('error'); setError('CDN 依赖加载较慢或不可达。笔记仍保存在本机，可稍后重试。') } }, 45000)
    return () => { clearTimeout(timer); observer.disconnect(); window.removeEventListener('message', instance.receive); instance.dispose() }
  }, [token, acceptChange])

  useEffect(() => {
    const beforeUnload = (event) => {
      if (!current.current?.dirty && !controller.getPendingIndexCount()) return
      event.preventDefault()
      event.returnValue = ''
      void save()
    }
    const pagehide = () => { void save() }
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('pagehide', pagehide)
    const stop = api.page?.beforeClose(async () => {
      bridge.current?.freeze(true)
      const ok = await actions.current.flush()
      if (!ok) bridge.current?.freeze(false)
      return ok
    })
    return () => { stop?.(); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('pagehide', pagehide) }
  }, [api, controller, save])

  const toggleFolder = (id) => setExpanded((previous) => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const parentForNew = selected && !selected.trashedAt ? (selected.kind === 'folder' ? selected.id : selected.parentId) : null
  const mutate = async (operation) => {
    setBusy(true)
    try { operation(index); const result = await controller.mutateIndex(operation); setError(''); return result }
    catch (cause) { setError(message(cause)); return null }
    finally { setBusy(false) }
  }
  const loadLatest = async () => {
    const draft = current.current
    if (!draft) return
    setBusy(true)
    bridge.current?.freeze(true)
    try {
      download(draft.document, `${active?.title || '笔记'}-冲突草稿`)
      const snapshot = await controller.readDocument(draft.id)
      const latest = { id: draft.id, document: snapshot.value, version: snapshot.version, saved: JSON.stringify(snapshot.value), dirty: false }
      drafts.current.set(draft.id, latest)
      current.current = latest
      if (ready.current) await bridge.current.load(draft.id, latest.document)
      setSaveState('saved')
      setError('')
      setDialog(null)
    } catch (cause) { setError(message(cause)) } finally { bridge.current?.freeze(false); setBusy(false) }
  }
  const create = (kind) => setDialog({ type: 'create', id: createNodeId(), now: new Date().toISOString(), kind, title: kind === 'folder' ? '新建文件夹' : '新建笔记', name: '', parentId: parentForNew })
  const edit = (node) => setDialog({ type: 'rename', node, title: '重命名', name: node.title })
  const submitDialog = async () => {
    const value = dialog
    if (!value || busy) return
    if (value.type === 'reload') { await loadLatest(); return }
    if (value.type === 'delete') {
      if (!(await flush())) return
      const now = new Date().toISOString()
      const result = await mutate((latest) => trashNode(latest, value.node.id, now))
      if (!result) return
      const removed = result.nodes.find((node) => node.id === current.current?.id)?.trashedAt
      if (removed) { current.current = null; setActiveId(null); loadedNote.current = null }
    } else if (value.type === 'move') {
      const now = new Date().toISOString()
      if (!(await mutate((latest) => moveNode(latest, value.node.id, value.parentId || null, now)))) return
    } else if (value.type === 'rename') {
      const now = new Date().toISOString()
      if (!(await mutate((latest) => renameNode(latest, value.node.id, value.name, now)))) return
    } else {
      if (!(await flush())) return
      const { id, now } = value
      const result = await mutate((latest) => latest.nodes.some((node) => node.id === id) ? latest : createNode(latest, { id, now, kind: value.kind, title: value.name, parentId: value.parentId }))
      if (!result) return
      if (value.parentId) setExpanded((previous) => new Set([...previous, value.parentId]))
      if (value.kind === 'folder') { setSelectedId(id); setExpanded((previous) => new Set([...previous, id])) }
      else { await openNote(id) }
      setTrash(false)
    }
    setDialog(null)
  }

  const selectRow = (node) => {
    setSelectedId(node.id)
    if (trash) return
    if (node.kind === 'folder') toggleFolder(node.id)
    else void openNote(node.id)
  }
  const navigateTree = (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter', 'F2'].includes(event.key)) return
    if (event.target.closest('input')) return
    const position = visible.findIndex(({ node }) => node.id === selectedId)
    const row = visible[position]
    if (event.key === 'F2' && row && !trash) { event.preventDefault(); edit(row.node); return }
    if (event.key === 'Enter' && row) { event.preventDefault(); selectRow(row.node); return }
    let target
    if (event.key === 'ArrowDown') target = visible[Math.min(visible.length - 1, position + 1)]
    if (event.key === 'ArrowUp') target = visible[Math.max(0, position - 1)]
    if (event.key === 'Home') target = visible[0]
    if (event.key === 'End') target = visible.at(-1)
    if (event.key === 'ArrowRight' && row?.node.kind === 'folder') { if (!expanded.has(row.node.id)) toggleFolder(row.node.id); else target = visible[position + 1] }
    if (event.key === 'ArrowLeft' && row) { if (expanded.has(row.node.id)) toggleFolder(row.node.id); else target = visible.find(({ node }) => node.id === row.node.parentId) }
    if (target) { setSelectedId(target.node.id); requestAnimationFrame(() => tree.current?.querySelector(`[data-node-id="${target.node.id}"]`)?.focus()) }
    event.preventDefault()
  }

  const path = []
  let ancestor = active
  while (ancestor) { path.unshift(ancestor.title); ancestor = index.nodes.find((node) => node.id === ancestor.parentId) }
  const folders = index.nodes.filter((node) => node.kind === 'folder' && !node.trashedAt)
  const forbidden = new Set(dialog?.node ? [dialog.node.id] : [])
  for (let i = 0; i < folders.length; i++) for (const folder of folders) if (forbidden.has(folder.parentId)) forbidden.add(folder.id)

  return (
    <div className={`notebook-page ${railOpen ? 'is-rail-open' : ''}`}>
      <aside className="notebook-rail" aria-label="笔记目录">
        <div className="notebook-rail-title"><span><BookOpen size={17} /><strong>我的笔记</strong></span><Button variant="ghost" icon={<PanelLeftClose size={16} />} title="收起目录" aria-label="收起目录" onClick={() => setRailOpen(false)} /></div>
        <div className="notebook-search"><Search size={14} /><Input value={query} onChange={setQuery} placeholder="搜索笔记标题" aria-label="搜索笔记标题" /></div>
        <div className="notebook-tree-heading"><span>{trash ? '最近删除' : '目录'}<small>{trash ? index.nodes.filter((node) => node.trashedAt).length : notesCount}</small></span><div><Button variant="ghost" icon={<FilePlus2 size={15} />} title="新建笔记" aria-label="新建笔记" disabled={!loaded || busy || trash} onClick={() => create('note')} /><Button variant="ghost" icon={<FolderPlus size={15} />} title="新建文件夹" aria-label="新建文件夹" disabled={!loaded || busy || trash} onClick={() => create('folder')} /></div></div>
        <div className="notebook-tree" role="tree" aria-label={trash ? '最近删除' : '笔记目录树'} ref={tree} onKeyDown={navigateTree}>
          {!loaded ? <div className="notebook-tree-skeleton"><i /><i /><i /></div> : visible.length ? visible.map(({ node, depth }) => (
            <div className={`notebook-tree-entry ${node.id === selectedId ? 'is-selected' : ''} ${node.id === activeId ? 'is-active' : ''}`} key={node.id} style={{ '--depth': depth }}>
              <button type="button" role="treeitem" aria-selected={node.id === selectedId} aria-expanded={node.kind === 'folder' ? expanded.has(node.id) : undefined} aria-level={depth + 1} data-node-id={node.id} tabIndex={node.id === selectedId || (!selectedId && visible[0]?.node.id === node.id) ? 0 : -1} title={node.title} className="notebook-tree-row" onClick={() => selectRow(node)}>
                <span className="notebook-tree-chevron">{node.kind === 'folder' ? expanded.has(node.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}</span>
                {node.kind === 'folder' ? expanded.has(node.id) ? <FolderOpen size={15} /> : <Folder size={15} /> : <FileText size={15} />}
                <span>{node.title}</span>
              </button>
              <Button variant="ghost" icon={trash ? <Undo2 size={13} /> : <MoreHorizontal size={14} />} title={trash ? '恢复' : '更多操作'} aria-label={`${trash ? '恢复' : '更多操作'}：${node.title}`} className="notebook-row-actions" onClick={() => {
                setSelectedId(node.id)
                if (trash) { let root = node; while (index.nodes.find((item) => item.id === root.parentId)?.trashedAt) root = index.nodes.find((item) => item.id === root.parentId); const now = new Date().toISOString(); void mutate((latest) => restoreNode(latest, root.id, now)) }
                else setDialog({ type: 'actions', title: node.title, node })
              }} />
            </div>
          )) : <div className="notebook-tree-empty">{query ? '没有匹配的笔记' : trash ? '还没有删除的内容' : '还没有笔记'}{!query && !trash && <Button variant="ghost" onClick={() => create('note')}>创建第一篇笔记</Button>}</div>}
        </div>
        <div className="notebook-rail-footer"><Button variant="ghost" icon={trash ? <BookOpen size={14} /> : <Trash2 size={14} />} onClick={() => { setTrash(!trash); setQuery('') }}>{trash ? '返回笔记' : '最近删除'}</Button><span>仅保存在本机</span></div>
      </aside>
      {railOpen && <button type="button" className="notebook-mobile-mask" aria-label="关闭目录" onClick={() => setRailOpen(false)} />}
      <main className="notebook-main">
        <header className="notebook-document-header">
          {!railOpen && <Button variant="ghost" icon={<Menu size={17} />} title="展开目录" aria-label="展开目录" onClick={() => setRailOpen(true)} />}
          <span className="notebook-breadcrumb" title={path.join(' / ')}>{active ? path.slice(0, -1).join(' / ') || '我的笔记' : '本地笔记本'}{active && <><ChevronRight size={12} /><strong>{active.title}</strong></>}</span>
          {active && <><span className={`notebook-save notebook-save--${saveState}`} role="status">{saveState === 'saved' ? <Check size={12} /> : null}{saveState === 'saved' ? '已保存' : saveState === 'error' ? '未保存' : '保存中'}</span><Button variant="ghost" icon={<Download size={15} />} title="下载当前笔记" aria-label="下载当前笔记" onClick={async () => {
            if (ready.current && loadedNote.current === activeId) { try { const value = await bridge.current.flush(); acceptChange(value.noteId, value.document) } catch (cause) { setError(message(cause)) } }
            if (current.current) download(current.current.document, active.title)
          }} /><Button variant="ghost" icon={<MoreHorizontal size={16} />} title="笔记操作" aria-label="笔记操作" onClick={() => setDialog({ type: 'actions', title: active.title, node: active })} /></>}
        </header>
        {error && <div className="notebook-error"><Alert message={error} /><div>{current.current?.dirty && <Button size="compact" variant="ghost" onClick={() => download(current.current.document, `${active?.title || '笔记'}-草稿`)}>下载草稿</Button>}<Button size="compact" variant="ghost" onClick={async () => { const ok = await flush(); if (ok) setError('') }}>重试保存</Button>{current.current?.dirty && <Button size="compact" variant="ghost" onClick={() => setDialog({ type: 'reload', title: '备份草稿并加载最新版' })}>加载最新版</Button>}<Button size="compact" variant="ghost" icon={<X size={13} />} aria-label="收起提示" onClick={() => setError('')} /></div></div>}
        <div className={`notebook-editor-area ${active ? 'has-note' : ''}`}>
          <iframe key={frameKey} ref={iframe} className="notebook-editor-frame" title="笔记富文本编辑器" src={`/editor/index.html#${token}`} sandbox="allow-scripts allow-downloads allow-popups" allow="clipboard-read; clipboard-write" />
          {!active ? <div className="notebook-welcome"><span className="notebook-welcome-icon"><BookOpen size={31} strokeWidth={1.5} /></span><h1>留住每一个想法</h1><p>一处安静的空间，记录文字、表格和灵感。<br />所有笔记自动保存到本机。</p><Button variant="accent" icon={<Plus size={16} />} disabled={!loaded || busy} onClick={() => create('note')}>新建笔记</Button><div className="notebook-feature-hints"><span>丰富排版</span><span>灵活表格</span><span>图片与公式</span></div></div> : frameState === 'loading' ? <div className="notebook-editor-skeleton"><i /><i /><i /><i /><span>首次打开将从 CDN 加载编辑器，笔记内容不会上传。</span></div> : frameState === 'error' ? <div className="notebook-load-error"><Empty title="编辑器暂时无法加载" description="请检查 CDN 网络连接。正文仍保存在本机，重试不会清空笔记。" /><Button icon={<RefreshCw size={14} />} onClick={() => { if (!current.current?.dirty) { setError(''); setFrameKey((key) => key + 1) } }}>重新加载编辑器</Button></div> : null}
        </div>
      </main>
      {dialog && <Modal title={dialog.title} onClose={() => !busy && setDialog(null)} portal>
        {dialog.type === 'actions' ? <div className="notebook-action-list">
          <Button variant="ghost" fullWidth onClick={() => edit(dialog.node)}>重命名</Button>
          <Button variant="ghost" fullWidth onClick={() => setDialog({ ...dialog, type: 'move', title: '移动到', parentId: dialog.node.parentId || '' })}>移动到…</Button>
          <Button variant="danger-ghost" fullWidth onClick={() => setDialog({ ...dialog, type: 'delete', title: '移到最近删除' })}>移到最近删除</Button>
        </div> : <div className="notebook-dialog">
          {dialog.type === 'reload' ? <p>将先下载当前草稿备份，再载入磁盘上的最新正文。不会覆盖其他窗口的内容。</p> : dialog.type === 'delete' ? <p>将「{dialog.node.title}」{dialog.node.kind === 'folder' ? '及其全部内容' : ''}移到最近删除？之后可以恢复，正文文件不会被删除。</p> : dialog.type === 'move' ? <label>目标文件夹<SelectMenu value={dialog.parentId} ariaLabel="目标文件夹" options={[{ value: '', label: '我的笔记（根目录）' }, ...folders.filter((folder) => !forbidden.has(folder.id)).map((folder) => ({ value: folder.id, label: folder.title }))]} onChange={(parentId) => setDialog({ ...dialog, parentId })} /></label> : <label>名称<Input autoFocus value={dialog.name} maxLength={100} placeholder={dialog.kind === 'folder' ? '文件夹名称' : '笔记标题'} aria-label="名称" onChange={(name) => setDialog({ ...dialog, name })} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && dialog.name.trim()) void submitDialog() }} /></label>}
          <footer><Button onClick={() => setDialog(null)} disabled={busy}>取消</Button><Button variant={dialog.type === 'delete' ? 'danger' : 'accent'} disabled={busy || (['create', 'rename'].includes(dialog.type) && !dialog.name.trim())} onClick={() => void submitDialog()}>{busy ? '处理中' : dialog.type === 'delete' ? '移到最近删除' : dialog.type === 'create' ? '创建' : '确定'}</Button></footer>
        </div>}
      </Modal>}
    </div>
  )
}
