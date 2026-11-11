import '@arco-design/web-react/es/_util/react-19-adapter'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Code2,
  FilePlus2,
  FileText,
  Focus,
  Folder,
  FolderOpen,
  Hash,
  Image,
  Layers3,
  ListTree,
  Menu,
  Moon,
  MoreHorizontal,
  Network,
  PanelLeftClose,
  PanelTop,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Table2,
  X
} from 'lucide-react'
import {
  ArcoProvider,
  Input
} from '../../../../packages/mica-config-ui/web/components/ArcoSettings'
import { Button, Segmented } from '../../../../packages/mica-config-ui/web/components/Ui'
import { SelectMenu } from '../../../../packages/mica-config-ui/web/components/SelectMenu'
import { Modal } from '../../../../packages/mica-config-ui/web/components/Modal'
import { createEditorBridge } from '../../../../plugins/notebook/bridge'
import { THEMES } from '../../../../packages/mica-web-shared/theme'
import { applyResolvedTheme } from '../../src/renderer/src/theme'
import { previewNotes, primaryNoteId } from './fixture'
import '../../src/renderer/assets/app.css'
import './preview.css'
import './variants-preview.css'

const DESIGNS = {
  a: {
    name: '清透',
    tagline: '轻盈、熟悉，专注内容本身。',
    detail: '轻侧栏 · 单行工具栏 · 舒展正文',
    icon: Sparkles
  },
  b: {
    name: '书页',
    tagline: '让每一篇笔记，都值得慢慢读。',
    detail: '居中纸面 · 浮动工具栏 · 阅读排版',
    icon: BookOpen
  },
  c: {
    name: '工作台',
    tagline: '信息更紧凑，长文也有清楚的线索。',
    detail: '紧凑布局 · 常驻大纲 · 高效浏览',
    context: '文档工作台',
    icon: ListTree
  },
  d: {
    name: '分区工作台',
    shortName: '分区',
    tagline: '把工具、内容和线索，安放在清楚的位置。',
    detail: '轻量分区 · 快捷页签 · 清晰层次',
    context: '分区工作台',
    icon: Layers3
  },
  e: {
    name: '一体工作台',
    shortName: '一体',
    tagline: '让工作台退后一步，让内容更靠近。',
    detail: '一体画布 · 轻量工具栏 · 开阔正文',
    context: '一体工作台',
    icon: PanelTop
  }
}
const workbenchDesigns = ['c', 'd', 'e']
const query = new URLSearchParams(location.search)
const initialDesign = Object.hasOwn(DESIGNS, query.get('design')) ? query.get('design') : 'c'
const initialTheme = THEMES.some((item) => item.id === query.get('theme'))
  ? query.get('theme')
  : 'light'
const themeOptions = THEMES.map(({ id, label }) => ({ value: id, label }))
const initialId = previewNotes.some((note) => note.id === query.get('note'))
  ? query.get('note')
  : primaryNoteId
applyResolvedTheme(initialTheme)

function IconButton({ icon: Icon, title, ...props }) {
  return (
    <Button
      variant="ghost"
      size="compact"
      icon={<Icon size={16} strokeWidth={1.65} />}
      title={title}
      ariaLabel={title}
      {...props}
    />
  )
}
function updatedLabel(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : `${date.getMonth() + 1} 月 ${date.getDate()} 日 · 示例文档`
}
function readThemeTokens() {
  const style = getComputedStyle(document.documentElement)
  const swatch = document.createElement('span')
  const tokens = {}
  // Sampling must ignore global reduced-motion transitions as well as normal
  // theme transitions, otherwise successive colors can resolve to one frame.
  swatch.style.setProperty('transition', 'none', 'important')
  swatch.style.setProperty('animation', 'none', 'important')
  swatch.style.position = 'fixed'
  swatch.style.visibility = 'hidden'
  document.body.appendChild(swatch)
  for (const key of style) {
    if (!key.startsWith('--color-')) continue
    swatch.style.color = `var(${key})`
    tokens[key] = getComputedStyle(swatch).color
  }
  tokens['font-family'] = getComputedStyle(document.body).fontFamily
  swatch.remove()
  return tokens
}
function downloadDocument(note, document) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
  )
  const link = window.document.createElement('a')
  link.href = url
  link.download = `${note.title}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function NotebookDesignPreview() {
  const [design, setDesign] = useState(initialDesign)
  const [theme, setTheme] = useState(initialTheme)
  const [notes, setNotes] = useState(previewNotes)
  const [activeId, setActiveId] = useState(initialId)
  const [recentIds, setRecentIds] = useState(() =>
    [
      initialId,
      ...previewNotes
        .filter((note) => note.id !== initialId && note.folder === '工作手记')
        .map((note) => note.id)
    ].slice(0, 3)
  )
  const [queryText, setQueryText] = useState('')
  const [expanded, setExpanded] = useState(new Set(previewNotes.map((note) => note.folder)))
  const [starred, setStarred] = useState(new Set([primaryNoteId]))
  const [filter, setFilter] = useState('all')
  const [railOpen, setRailOpen] = useState(!matchMedia('(max-width: 760px)').matches)
  const [outlineOpen, setOutlineOpen] = useState(
    workbenchDesigns.includes(initialDesign) && !matchMedia('(max-width: 1050px)').matches
  )
  const [focus, setFocus] = useState(false)
  const [outline, setOutline] = useState([])
  const [blocks, setBlocks] = useState({ table: false, code: false, mermaid: false, image: false })
  const [position, setPosition] = useState('0')
  const [status, setStatus] = useState('loading')
  const [switching, setSwitching] = useState(false)
  const [modified, setModified] = useState(false)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState(null)
  const [newTitle, setNewTitle] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const frame = useRef(null)
  const bridge = useRef(null)
  const ready = useRef(false)
  const currentId = useRef(initialId)
  const changing = useRef(false)
  const drafts = useRef(new Map(previewNotes.map((note) => [note.id, note.document])))
  const changed = useRef(new Set())
  const designRef = useRef(design)
  const focusRef = useRef(focus)
  const token = useRef(crypto.randomUUID()).current
  const current = notes.find((note) => note.id === activeId) || notes[0]
  const meta = DESIGNS[design]
  const DesignIcon = meta.icon
  const folders = [...new Set(notes.map((note) => note.folder))]
  const outlinePosition = outline.findIndex((item) => item.id === position)
  const outlineProgress = outline.length ? ((outlinePosition + 1) / outline.length) * 100 : 0
  const shortcutNotes = recentIds.map((id) => notes.find((note) => note.id === id)).filter(Boolean)
  const filtered = useMemo(
    () =>
      notes.filter(
        (note) =>
          (!queryText ||
            `${note.title} ${note.description}`.toLowerCase().includes(queryText.toLowerCase())) &&
          (filter === 'all' || starred.has(note.id))
      ),
    [notes, queryText, filter, starred]
  )

  const postDesign = (type, data = {}) =>
    frame.current?.contentWindow?.postMessage(
      { channel: 'mica-notebook-design', token, type, ...data },
      '*'
    )
  const syncDesign = () =>
    postDesign('design', { design: designRef.current, focus: focusRef.current })
  const syncTheme = () =>
    bridge.current?.theme(document.documentElement.dataset.appearance || 'light', readThemeTokens())
  const jump = (data) => postDesign('jump', data)

  useEffect(() => {
    const instance = createEditorBridge({
      token,
      target: () => frame.current?.contentWindow || null,
      onReady() {
        ready.current = true
        syncTheme()
        syncDesign()
        void instance
          .load(currentId.current, drafts.current.get(currentId.current))
          .catch((cause) => setError(cause.message))
      },
      onLoaded() {
        setStatus('ready')
        syncDesign()
      },
      onChange(id, document) {
        if (id !== currentId.current) return
        drafts.current.set(id, document)
        changed.current.add(id)
        setModified(true)
      },
      onError(message) {
        setError(message)
      }
    })
    bridge.current = instance
    const receive = (event) => {
      instance.receive(event)
      const data = event.data
      if (
        event.source !== frame.current?.contentWindow ||
        data?.channel !== 'mica-notebook-design' ||
        data.token !== token
      )
        return
      if (data.type === 'ready') syncDesign()
      else if (data.type === 'outline') {
        setOutline(data.items)
        setBlocks(data.blocks)
      } else if (data.type === 'interact') setMoreOpen(false)
      else if (data.type === 'escape') {
        setFocus(false)
        setMoreOpen(false)
        if (matchMedia('(max-width: 760px)').matches) setRailOpen(false)
      } else if (data.type === 'position') setPosition(data.id)
      else if (data.type === 'measurement') window.__notebookPreview.measurement = data
    }
    window.addEventListener('message', receive)
    return () => {
      window.removeEventListener('message', receive)
      instance.dispose()
      ready.current = false
    }
  }, [])

  useEffect(() => {
    designRef.current = design
    focusRef.current = focus
    syncDesign()
    const url = new URL(location.href)
    url.searchParams.set('design', design)
    url.searchParams.set('theme', theme)
    url.searchParams.set('note', activeId)
    history.replaceState({}, '', url)
    window.document.title = `${design.toUpperCase()} · ${meta.name} — Notebook 界面预览`
  }, [design, focus, theme, activeId])
  useEffect(() => {
    applyResolvedTheme(theme)
    syncTheme()
  }, [theme])
  useEffect(() => {
    const shortcuts = (event) => {
      if (event.key === 'Escape' && !dialog && !moreOpen) {
        if (focus) setFocus(false)
        else if (matchMedia('(max-width: 760px)').matches) setRailOpen(false)
      }
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
  }, [focus, dialog, moreOpen])
  useEffect(() => {
    if (!moreOpen) return
    const close = (event) => {
      if (!event.target.closest('.document-more')) setMoreOpen(false)
    }
    const escape = (event) => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', escape)
    }
  }, [moreOpen])

  async function flush() {
    if (!ready.current) throw new Error('编辑器仍在加载，请稍候')
    const result = await bridge.current.flush()
    drafts.current.set(result.noteId, result.document)
    return result.document
  }
  async function openNote(id) {
    if (changing.current || id === currentId.current) return
    changing.current = true
    setSwitching(true)
    bridge.current?.freeze(true)
    try {
      await flush()
      await bridge.current.load(id, drafts.current.get(id))
      currentId.current = id
      setActiveId(id)
      setRecentIds((previous) => [id, ...previous.filter((value) => value !== id)].slice(0, 3))
      setModified(changed.current.has(id))
      setError('')
      if (matchMedia('(max-width: 760px)').matches) setRailOpen(false)
      jump({ block: 'top' })
    } catch (cause) {
      setError(cause.message)
    } finally {
      bridge.current?.freeze(false)
      changing.current = false
      setSwitching(false)
    }
  }
  function changeDesign(next) {
    setDesign(next)
    setOutlineOpen(workbenchDesigns.includes(next) && !matchMedia('(max-width: 1050px)').matches)
    setFocus(false)
  }
  const toggleStar = () =>
    setStarred((previous) => {
      const next = new Set(previous)
      if (next.has(activeId)) next.delete(activeId)
      else next.add(activeId)
      return next
    })
  const toggleFolder = (folder) =>
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  const restore = async () => {
    const original = previewNotes.find((note) => note.id === activeId)
    if (!original) return
    try {
      await bridge.current.load(activeId, original.document)
      drafts.current.set(activeId, original.document)
      changed.current.delete(activeId)
      setModified(false)
      setDialog(null)
      jump({ block: 'top' })
    } catch (cause) {
      setError(cause.message)
    }
  }
  const createNote = async () => {
    const title = newTitle.trim()
    if (!title) return
    const id = `preview-${crypto.randomUUID()}`
    const document = { version: 1, editorState: null, comments: [] }
    const note = {
      id,
      title,
      folder: '随手记录',
      description: '新建的预览笔记',
      updatedAt: '刚刚',
      document
    }
    drafts.current.set(id, document)
    setNotes((previous) => [...previous, note])
    setExpanded((previous) => new Set([...previous, note.folder]))
    setFilter('all')
    setQueryText('')
    setDialog(null)
    await openNote(id)
  }

  // Observability for repeatable browser verification; no real host API/data.
  window.__notebookPreview = {
    ...window.__notebookPreview,
    state: {
      design,
      theme,
      activeId,
      status,
      modified,
      outline: outline.length,
      focus,
      switching,
      notes: notes.length
    },
    snapshot: flush,
    measure: () => postDesign('measure')
  }

  return (
    <div
      className={`notebook-design-preview design-${design}${workbenchDesigns.includes(design) ? ' workbench-design' : ''}${focus ? ' is-focus' : ''}`}
      data-design={design}
    >
      <header className="design-bar">
        <div className="design-brand">
          <span className="mica-mark">
            <BookOpen size={17} strokeWidth={1.8} />
          </span>
          <span>
            <strong>Notebook</strong>
            <small>C · D · E 界面预览</small>
          </span>
        </div>
        <Segmented
          size="compact"
          ariaLabel="界面方案"
          value={design}
          onChange={changeDesign}
          options={Object.entries(DESIGNS)
            .filter(([value]) => workbenchDesigns.includes(value) || value === design)
            .map(([value, item]) => ({
              value,
              label: `${value.toUpperCase()} · ${item.shortName || item.name}`
            }))}
        />
        <span className="design-divider" />
        <span className="design-caption">{meta.detail}</span>
        <div className="design-utilities">
          <a className="design-comparison-link" href="./comparison.html">
            方案对比 <ArrowUpRight size={12} />
          </a>
          <span className="theme-label">
            {THEMES.find((item) => item.id === theme)?.appearance === 'dark' ? (
              <Moon size={13} />
            ) : (
              <Sun size={13} />
            )}
          </span>
          <SelectMenu
            ariaLabel="预览主题"
            value={theme}
            options={themeOptions}
            menuMinWidth={188}
            onChange={setTheme}
            size="compact"
          />
        </div>
      </header>
      <div
        className={`notebook-layout${railOpen ? ' rail-open' : ''}${outlineOpen ? ' outline-open' : ''}`}
      >
        <aside className="design-rail" aria-label="笔记目录">
          <div className="rail-heading">
            <div className="rail-book-icon">
              <BookOpen size={17} strokeWidth={1.65} />
            </div>
            <div>
              <strong>我的笔记</strong>
              <span>想法，慢慢成形</span>
              {['d', 'e'].includes(design) && <small className="rail-edition">{meta.name}</small>}
            </div>
            <IconButton icon={PanelLeftClose} title="收起目录" onClick={() => setRailOpen(false)} />
          </div>
          <div className="rail-search">
            <Search size={14} />
            <Input
              aria-label="搜索示例笔记"
              value={queryText}
              onChange={setQueryText}
              placeholder="搜索笔记…"
            />
          </div>
          <div className="rail-quick-nav">
            <button
              type="button"
              className={`rail-nav-row${filter === 'all' ? ' is-active' : ''}`}
              onClick={() => setFilter('all')}
            >
              <BookOpen size={15} />
              <span>所有笔记</span>
              <small>{notes.length}</small>
            </button>
            <button
              type="button"
              className={`rail-nav-row${filter === 'starred' ? ' is-active' : ''}`}
              onClick={() => setFilter('starred')}
            >
              <Star size={15} />
              <span>我的收藏</span>
              <small>{starred.size}</small>
            </button>
          </div>
          <div className="rail-section-heading">
            <span>{queryText ? '搜索结果' : filter === 'starred' ? '收藏的笔记' : '笔记目录'}</span>
            <IconButton
              icon={Plus}
              title="新建预览笔记"
              disabled={status !== 'ready'}
              onClick={() => {
                setNewTitle('')
                setDialog('new')
              }}
            />
          </div>
          <nav className="design-tree" aria-label="笔记列表">
            {folders.map((folder) => {
              const children = filtered.filter((note) => note.folder === folder)
              if (!children.length) return null
              const open = expanded.has(folder) || !!queryText || filter === 'starred'
              return (
                <div className="tree-folder" key={folder}>
                  <button
                    type="button"
                    className="tree-folder-button"
                    aria-expanded={open}
                    onClick={() => toggleFolder(folder)}
                  >
                    <ChevronRight size={12} className={open ? 'is-open' : ''} />
                    {open ? <FolderOpen size={15} /> : <Folder size={15} />}
                    <span>{folder}</span>
                    <small>{children.length}</small>
                  </button>
                  {open && (
                    <div className="tree-folder-children">
                      {children.map((note) => (
                        <button
                          type="button"
                          key={note.id}
                          title={note.title}
                          className={`tree-note${note.id === activeId ? ' is-active' : ''}`}
                          aria-current={note.id === activeId ? 'page' : undefined}
                          disabled={switching || status !== 'ready'}
                          onClick={() => void openNote(note.id)}
                        >
                          <FileText size={14} strokeWidth={1.65} />
                          <span>{note.title}</span>
                          {starred.has(note.id) && <Star size={10} className="note-star" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            {!filtered.length && (
              <div className="tree-empty">
                <Search size={20} />
                <span>没有找到匹配的笔记</span>
                <button
                  type="button"
                  onClick={() => {
                    setQueryText('')
                    setFilter('all')
                  }}
                >
                  查看所有笔记
                </button>
              </div>
            )}
          </nav>
          <div className="rail-new">
            <Button
              variant="ghost"
              icon={<FilePlus2 size={15} />}
              fullWidth
              disabled={status !== 'ready'}
              onClick={() => {
                setNewTitle('')
                setDialog('new')
              }}
            >
              新建笔记
            </Button>
          </div>
          <div className="rail-bottom">
            <ShieldCheck size={13} />
            <span>当前页暂存</span>
            <span className="rail-preview-label">设计预览</span>
          </div>
        </aside>
        {railOpen && !focus && (
          <button
            className="rail-mask"
            type="button"
            aria-label="关闭目录"
            onClick={() => setRailOpen(false)}
          />
        )}
        <main className="design-main">
          <header className="document-header">
            <div className="document-path">
              {(!railOpen || focus) && (
                <IconButton
                  icon={Menu}
                  title={focus ? '退出专注' : '展开目录'}
                  onClick={() => {
                    setFocus(false)
                    setRailOpen(true)
                  }}
                />
              )}
              <span className="path-root">我的笔记</span>
              <ChevronRight size={12} />
              <span className="path-folder">{current.folder}</span>
              <ChevronRight size={12} />
              <strong title={current.title}>{current.title}</strong>
            </div>
            <div className="document-actions">
              <span className="document-save" role="status">
                <Check size={12} />
                {modified ? '草稿已暂存' : '示例笔记'}
              </span>
              <IconButton
                icon={Star}
                title={starred.has(activeId) ? '取消收藏' : '收藏笔记'}
                pressed={starred.has(activeId)}
                onClick={toggleStar}
              />
              <span className="header-divider" />
              <IconButton
                icon={Focus}
                title={focus ? '退出专注' : '专注写作'}
                pressed={focus}
                onClick={() => setFocus(!focus)}
              />
              <IconButton
                icon={ListTree}
                title={outlineOpen ? '收起大纲' : '展开大纲'}
                pressed={outlineOpen}
                onClick={() => setOutlineOpen(!outlineOpen)}
              />
              <div className="document-more">
                <IconButton
                  icon={MoreHorizontal}
                  title="笔记选项"
                  onClick={() => setMoreOpen(!moreOpen)}
                />
                {moreOpen && (
                  <div className="document-menu" role="menu">
                    <button
                      role="menuitem"
                      type="button"
                      onClick={async () => {
                        setMoreOpen(false)
                        try {
                          downloadDocument(current, await flush())
                        } catch (cause) {
                          setError(cause.message)
                        }
                      }}
                    >
                      <ArrowDownToLine size={14} />
                      下载当前笔记
                    </button>
                    <button
                      role="menuitem"
                      type="button"
                      disabled={!previewNotes.some((note) => note.id === activeId)}
                      onClick={() => {
                        setMoreOpen(false)
                        setDialog('restore')
                      }}
                    >
                      <RotateCcw size={14} />
                      还原这篇示例
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>
          {design === 'd' && (
            <nav className="session-tabs document-tabs" aria-label="快捷切换笔记">
              {shortcutNotes.map((note) => (
                <button
                  type="button"
                  key={note.id}
                  className={`session-tab document-tab${note.id === activeId ? ' is-active' : ''}`}
                  aria-current={note.id === activeId ? 'page' : undefined}
                  title={note.title}
                  disabled={switching || status !== 'ready'}
                  onClick={() => void openNote(note.id)}
                >
                  <FileText size={13} />
                  <span>{note.title}</span>
                </button>
              ))}
              <span className="document-tabs-caption">最近阅读</span>
            </nav>
          )}
          <div className="document-context">
            <div>
              <span className="context-kind">
                <DesignIcon size={12} />
                {meta.context || (design === 'b' ? 'THE NOTEBOOK' : '写作空间')}
              </span>
              <span className="context-dot">·</span>
              <span className="context-date">{updatedLabel(current.updatedAt)}</span>
            </div>
            <div className="format-jumps" aria-label="格式示例快速跳转">
              <button
                type="button"
                disabled={!blocks.table}
                onClick={() => jump({ block: 'table' })}
              >
                <Table2 size={12} />
                <span>表格</span>
              </button>
              <button type="button" disabled={!blocks.code} onClick={() => jump({ block: 'code' })}>
                <Code2 size={12} />
                <span>代码</span>
              </button>
              <button
                type="button"
                disabled={!blocks.mermaid}
                onClick={() => jump({ block: 'mermaid' })}
              >
                <Network size={12} />
                <span>图表</span>
              </button>
              <button
                type="button"
                disabled={!blocks.image}
                onClick={() => jump({ block: 'image' })}
              >
                <Image size={12} />
                <span>图片</span>
              </button>
              <button type="button" onClick={() => jump({ block: 'top' })} title="返回文首">
                <ArrowUpRight size={12} />
              </button>
            </div>
          </div>
          {error && (
            <div className="preview-error" role="alert">
              <span>{error}</span>
              <IconButton icon={X} title="收起提示" onClick={() => setError('')} />
            </div>
          )}
          <div className="document-body">
            <section className="design-editor-region" aria-label="Notebook 编辑区">
              <iframe
                ref={frame}
                title="Notebook 真实编辑器"
                src={`/editor/index.html#${token}`}
                sandbox="allow-scripts allow-downloads allow-popups"
                allow="clipboard-read; clipboard-write"
              />
              {status === 'loading' && (
                <div className="editor-loading">
                  <div className="loading-heading" />
                  <i />
                  <i />
                  <i />
                  <p>
                    正在加载编辑器…
                    <br />
                    <span>首次使用通过 CDN 加载，示例内容不会上传。</span>
                  </p>
                </div>
              )}
            </section>
            {outlineOpen && !focus && (
              <aside className="design-outline" aria-label="文档大纲">
                <div className="outline-title">
                  <span>文档大纲</span>
                  <IconButton icon={X} title="关闭大纲" onClick={() => setOutlineOpen(false)} />
                </div>
                {['d', 'e'].includes(design) && (
                  <div className="outline-summary">
                    <span>
                      {outline.length} 处标题 · 当前{' '}
                      {outline.length ? Math.max(1, outlinePosition + 1) : 0}
                    </span>
                    <div className="outline-position-track" aria-hidden="true">
                      <i style={{ width: `${outlineProgress}%` }} />
                    </div>
                  </div>
                )}
                <div className="outline-list">
                  {!outline.length && (
                    <p className="outline-empty">添加标题后，文档结构会显示在这里。</p>
                  )}
                  {outline.map((item, index) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`outline-entry level-${item.level}${position === item.id ? ' is-active' : ''}`}
                      aria-current={position === item.id ? 'location' : undefined}
                      onClick={() => {
                        jump({ heading: item.id })
                        if (matchMedia('(max-width: 1050px)').matches) setOutlineOpen(false)
                      }}
                      title={item.text}
                    >
                      {['d', 'e'].includes(design) ? (
                        <span className="outline-number" aria-hidden="true">
                          {item.level === 2
                            ? String(
                                outline.slice(0, index + 1).filter((heading) => heading.level === 2)
                                  .length
                              ).padStart(2, '0')
                            : item.level === 1
                              ? '—'
                              : '·'}
                        </span>
                      ) : (
                        <Hash size={item.level === 1 ? 12 : 10} />
                      )}
                      <span>
                        {['d', 'e'].includes(design)
                          ? item.text.replace(/^\d+\s*[·.、]\s*/, '')
                          : item.text}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="outline-bottom">
                  <span className="outline-eyebrow">看看不同内容的呈现</span>
                  <div>
                    <button
                      type="button"
                      disabled={!blocks.table}
                      onClick={() => jump({ block: 'table' })}
                    >
                      <Table2 size={13} />
                      数据表格
                    </button>
                    <button
                      type="button"
                      disabled={!blocks.mermaid}
                      onClick={() => jump({ block: 'mermaid' })}
                    >
                      <Network size={13} />
                      Mermaid 图表
                    </button>
                    <button
                      type="button"
                      disabled={!blocks.code}
                      onClick={() => jump({ block: 'code' })}
                    >
                      <Code2 size={13} />
                      代码与链接
                    </button>
                    <button
                      type="button"
                      disabled={!blocks.image}
                      onClick={() => jump({ block: 'image' })}
                    >
                      <Image size={13} />
                      图片与公式
                    </button>
                  </div>
                </div>
              </aside>
            )}
          </div>
        </main>
      </div>
      {dialog && (
        <Modal
          title={dialog === 'new' ? '新建预览笔记' : '还原这篇示例'}
          portal
          onClose={() => setDialog(null)}
        >
          {dialog === 'new' ? (
            <div className="preview-dialog">
              <p>笔记只在当前页面暂存，不写入你的本地笔记库。</p>
              <Input
                autoFocus
                aria-label="笔记标题"
                placeholder="给这篇笔记起个名字"
                maxLength={80}
                value={newTitle}
                onChange={setNewTitle}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) void createNote()
                }}
              />
              <footer>
                <Button onClick={() => setDialog(null)}>取消</Button>
                <Button
                  variant="accent"
                  disabled={!newTitle.trim()}
                  onClick={() => void createNote()}
                >
                  创建
                </Button>
              </footer>
            </div>
          ) : (
            <div className="preview-dialog">
              <p>将恢复「{current.title}」的初始示例内容，当前页对这篇笔记的编辑会被替换。</p>
              <footer>
                <Button onClick={() => setDialog(null)}>取消</Button>
                <Button variant="accent" onClick={() => void restore()}>
                  还原示例
                </Button>
              </footer>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <ArcoProvider>
    <NotebookDesignPreview />
  </ArcoProvider>
)
