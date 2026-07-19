import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution'
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution'
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution'
import 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution'
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution'
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution'
import { iconHtml } from './icons.js'

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}

const LANGUAGE_BY_EXTENSION = {
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  css: 'css',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml'
}

const MIN_TREE_WIDTH = 180
const MIN_EDITOR_WIDTH = 300
const DEFAULT_TREE_WIDTH = 260
const TREE_WIDTH_STORAGE_KEY = 'mica.filesTreeWidth'

function fileName(filePath) {
  return String(filePath).split(/[\\/]/).filter(Boolean).at(-1) || String(filePath)
}

function languageFor(filePath) {
  const name = fileName(filePath)
  const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : ''
  return LANGUAGE_BY_EXTENSION[extension] || 'plaintext'
}

function relativeParts(rootPath, filePath) {
  const root = String(rootPath || '')
    .replaceAll('\\', '/')
    .replace(/\/$/, '')
  const target = String(filePath || '').replaceAll('\\', '/')
  const comparableRoot = window.mica?.platform === 'win32' ? root.toLowerCase() : root
  const comparableTarget = window.mica?.platform === 'win32' ? target.toLowerCase() : target
  const relative = comparableTarget.startsWith(`${comparableRoot}/`)
    ? target.slice(root.length + 1)
    : target
  return relative.split('/').filter(Boolean)
}

function makeDirectoryNode(entry) {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type,
    expanded: false,
    loaded: false,
    loading: false,
    error: '',
    children: []
  }
}

export class FileEditorView {
  constructor() {
    this.viewEl = document.getElementById('files-view')
    this.treeEl = document.getElementById('files-list')
    this.treeStatusEl = document.getElementById('files-status')
    this.pathEl = document.getElementById('files-path')
    this.upEl = document.getElementById('files-up')
    this.refreshEl = document.getElementById('files-refresh')
    this.resizerEl = document.getElementById('files-pane-resizer')
    this.tabsEl = document.getElementById('file-editor-tabs')
    this.breadcrumbEl = document.getElementById('file-editor-breadcrumb')
    this.editorHost = document.getElementById('file-editor')
    this.editorStatusEl = document.getElementById('file-editor-status')

    this.rootPath = null
    this.parentPath = null
    this.rootChildren = []
    this.nodes = new Map()
    this.tabs = new Map()
    this.activePath = null
    this.treeRequestId = 0
    this.editorMessageTimer = null

    monaco.editor.defineTheme('mica-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0e0e0e',
        'editorGutter.background': '#0e0e0e',
        'editorLineNumber.foreground': '#555555',
        'editorLineNumber.activeForeground': '#a0a0a0',
        'editor.selectionBackground': '#4a4a4a80',
        'diffEditor.insertedTextBackground': '#1f6b403f',
        'diffEditor.removedTextBackground': '#9b33413f',
        'diffEditor.insertedLineBackground': '#183d2b66',
        'diffEditor.removedLineBackground': '#49242a66'
      }
    })

    this.editor = monaco.editor.create(this.editorHost, {
      theme: 'mica-dark',
      automaticLayout: true,
      model: null,
      minimap: { enabled: false },
      fontFamily: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      stickyScroll: { enabled: false },
      padding: { top: 8 }
    })

    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      this.saveActive().catch((error) => console.error('save file failed', error))
    })

    this.bindControls()
    this.bindResizer()
    this.renderTabs()
    this.showEditorMessage('从左侧目录选择文件以开始编辑')
  }

  bindControls() {
    this.upEl.innerHTML = iconHtml('arrow-up', { size: 15 })
    this.refreshEl.innerHTML = iconHtml('refresh', { size: 14 })
    this.upEl.disabled = true
    this.upEl.addEventListener('click', () => {
      this.goUp().catch((error) => console.error('open parent folder failed', error))
    })
    this.refreshEl.addEventListener('click', () => {
      this.refresh().catch((error) => console.error('refresh files failed', error))
    })

    this.tabsEl.addEventListener('click', (event) => {
      const closeButton =
        event.target instanceof Element ? event.target.closest('[data-close]') : null
      if (closeButton) {
        event.stopPropagation()
        this.closeFile(closeButton.getAttribute('data-close'))
        return
      }
      const tabEl =
        event.target instanceof Element ? event.target.closest('[data-file-path]') : null
      if (tabEl) this.activateFile(tabEl.getAttribute('data-file-path'))
    })
    this.tabsEl.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return
      const tabEl =
        event.target instanceof Element ? event.target.closest('[data-file-path]') : null
      if (tabEl) this.closeFile(tabEl.getAttribute('data-file-path'))
    })
    this.tabsEl.addEventListener('keydown', (event) => {
      const tabEl =
        event.target instanceof Element ? event.target.closest('[data-file-path]') : null
      if (!tabEl || !['Enter', ' '].includes(event.key)) return
      event.preventDefault()
      this.activateFile(tabEl.getAttribute('data-file-path'))
    })

    document.addEventListener('keydown', (event) => {
      if (this.viewEl.hidden || !(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.key.toLowerCase() !== 's') return
      event.preventDefault()
      this.saveActive().catch((error) => console.error('save file failed', error))
    })
    window.addEventListener('beforeunload', (event) => {
      if (![...this.tabs.values()].some((tab) => tab.dirty || tab.saving)) return
      event.preventDefault()
      event.returnValue = ''
    })
  }

  bindResizer() {
    const savedWidth = Number(localStorage.getItem(TREE_WIDTH_STORAGE_KEY))
    this.setTreeWidth(
      Number.isFinite(savedWidth) && savedWidth > 0 ? savedWidth : DEFAULT_TREE_WIDTH
    )

    const resize = (clientX, persist = false) => {
      const bounds = this.viewEl.getBoundingClientRect()
      this.setTreeWidth(clientX - bounds.left, persist)
    }

    this.resizerEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      this.resizerEl.setPointerCapture(event.pointerId)
      document.body.classList.add('is-resizing-files-pane')
    })
    this.resizerEl.addEventListener('pointermove', (event) => {
      if (this.resizerEl.hasPointerCapture(event.pointerId)) resize(event.clientX)
    })
    const finishResize = (event) => {
      if (!this.resizerEl.hasPointerCapture(event.pointerId)) return
      resize(event.clientX, true)
      this.resizerEl.releasePointerCapture(event.pointerId)
      document.body.classList.remove('is-resizing-files-pane')
    }
    this.resizerEl.addEventListener('pointerup', finishResize)
    this.resizerEl.addEventListener('pointercancel', (event) => {
      if (this.resizerEl.hasPointerCapture(event.pointerId)) {
        this.resizerEl.releasePointerCapture(event.pointerId)
      }
      document.body.classList.remove('is-resizing-files-pane')
    })
    this.resizerEl.addEventListener('dblclick', () => this.setTreeWidth(DEFAULT_TREE_WIDTH, true))
    this.resizerEl.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      const current = Number.parseFloat(
        getComputedStyle(this.viewEl).getPropertyValue('--files-tree-width')
      )
      this.setTreeWidth(current + (event.key === 'ArrowLeft' ? -16 : 16), true)
    })
  }

  setTreeWidth(width, persist = false) {
    const maximum =
      this.viewEl.clientWidth > 0
        ? Math.max(MIN_TREE_WIDTH, this.viewEl.clientWidth - MIN_EDITOR_WIDTH - 5)
        : Math.max(MIN_TREE_WIDTH, width)
    const normalized = Math.round(Math.min(Math.max(width, MIN_TREE_WIDTH), maximum))
    this.viewEl.style.setProperty('--files-tree-width', `${normalized}px`)
    this.resizerEl.setAttribute('aria-valuenow', String(normalized))
    this.resizerEl.setAttribute('aria-valuemax', String(Math.round(maximum)))
    if (persist) localStorage.setItem(TREE_WIDTH_STORAGE_KEY, String(normalized))
    this.editor.layout()
  }

  async load(root) {
    const target = typeof root === 'string' && root.trim() ? root : ''
    const requestId = ++this.treeRequestId
    this.rootPath = target || null
    this.parentPath = null
    this.rootChildren = []
    this.nodes.clear()
    this.treeEl.replaceChildren()
    this.pathEl.textContent = target
    this.pathEl.title = target
    this.upEl.disabled = true

    if (!target) {
      this.setTreeStatus('选择一个终端会话以查看文件')
      return
    }

    this.setTreeStatus('正在读取…')
    try {
      const result = await window.mica.files.list(target)
      if (requestId !== this.treeRequestId) return
      this.rootPath = result.path
      this.parentPath = result.parentPath
      this.pathEl.textContent = result.path
      this.pathEl.title = result.path
      this.upEl.disabled = !result.parentPath
      this.rootChildren = result.entries.map(makeDirectoryNode)
      this.registerNodes(this.rootChildren)
      this.renderTree()
      this.setTreeStatus(this.rootChildren.length ? '' : '这个文件夹是空的')
    } catch (error) {
      if (requestId !== this.treeRequestId) return
      this.treeEl.replaceChildren()
      this.setTreeStatus(`无法读取文件夹：${error?.message || error}`)
    }
  }

  async goUp() {
    if (!this.parentPath) return
    await this.load(this.parentPath)
  }

  async refresh() {
    if (!this.rootPath) return
    const expandedPaths = new Set(
      [...this.nodes.values()].filter((node) => node.expanded).map((node) => node.path)
    )
    const requestId = ++this.treeRequestId
    this.setTreeStatus('正在刷新…')

    try {
      const result = await window.mica.files.list(this.rootPath)
      if (requestId !== this.treeRequestId) return
      this.rootPath = result.path
      this.parentPath = result.parentPath
      this.pathEl.textContent = result.path
      this.pathEl.title = result.path
      this.upEl.disabled = !result.parentPath
      this.nodes.clear()
      this.rootChildren = result.entries.map(makeDirectoryNode)
      this.registerNodes(this.rootChildren)
      await this.restoreExpanded(this.rootChildren, expandedPaths, requestId)
      if (requestId !== this.treeRequestId) return
      this.renderTree()
      this.setTreeStatus(this.rootChildren.length ? '' : '这个文件夹是空的')
    } catch (error) {
      if (requestId !== this.treeRequestId) return
      this.setTreeStatus(`无法刷新文件夹：${error?.message || error}`)
    }
  }

  async restoreExpanded(nodes, expandedPaths, requestId) {
    for (const node of nodes) {
      if (requestId !== this.treeRequestId) return
      if (node.type !== 'directory' || !expandedPaths.has(node.path)) continue
      node.expanded = true
      try {
        const result = await window.mica.files.list(node.path)
        if (requestId !== this.treeRequestId) return
        node.loaded = true
        node.children = result.entries.map(makeDirectoryNode)
        this.registerNodes(node.children)
        await this.restoreExpanded(node.children, expandedPaths, requestId)
      } catch (error) {
        node.loaded = false
        node.error = error?.message || String(error)
      }
    }
  }

  registerNodes(nodes) {
    for (const node of nodes) this.nodes.set(node.path, node)
  }

  async toggleDirectory(node) {
    if (node.loading) return
    if (node.expanded) {
      node.expanded = false
      this.renderTree()
      return
    }

    node.expanded = true
    if (node.loaded) {
      this.renderTree()
      return
    }

    node.loading = true
    node.error = ''
    const requestId = this.treeRequestId
    this.renderTree()
    try {
      const result = await window.mica.files.list(node.path)
      if (requestId !== this.treeRequestId || this.nodes.get(node.path) !== node) return
      node.children = result.entries.map(makeDirectoryNode)
      node.loaded = true
      this.registerNodes(node.children)
    } catch (error) {
      if (requestId !== this.treeRequestId || this.nodes.get(node.path) !== node) return
      node.loaded = false
      node.error = error?.message || String(error)
    } finally {
      if (this.nodes.get(node.path) === node) {
        node.loading = false
        this.renderTree()
      }
    }
  }

  renderTree() {
    this.treeEl.replaceChildren()
    this.renderTreeNodes(this.rootChildren, this.treeEl, 0)
  }

  renderTreeNodes(nodes, parent, depth) {
    for (const node of nodes) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'files-tree-row'
      row.dataset.path = node.path
      row.dataset.type = node.type
      row.style.setProperty('--files-tree-depth', depth)
      row.title = node.path
      row.setAttribute('role', 'treeitem')

      const isDirectory = node.type === 'directory'
      if (isDirectory) row.setAttribute('aria-expanded', String(node.expanded))
      if (!isDirectory && node.path === this.activePath) row.classList.add('is-selected')

      const chevron = document.createElement('span')
      chevron.className = `files-tree-chevron${node.expanded ? ' is-open' : ''}`
      chevron.innerHTML = isDirectory ? iconHtml('chevron-right', { size: 13 }) : ''
      const icon = document.createElement('span')
      icon.className = 'files-tree-icon'
      icon.innerHTML = iconHtml(isDirectory ? (node.expanded ? 'folder-open' : 'folder') : 'file', {
        size: 14
      })
      const label = document.createElement('span')
      label.className = 'files-tree-label'
      label.textContent = node.name
      row.append(chevron, icon, label)

      if (node.loading) {
        const progress = document.createElement('span')
        progress.className = 'files-tree-progress'
        progress.textContent = '…'
        row.appendChild(progress)
      }

      row.addEventListener('click', () => {
        if (isDirectory) {
          this.toggleDirectory(node).catch((error) => console.error('open folder failed', error))
        } else {
          this.openFile(node.path).catch((error) => console.error('open file failed', error))
        }
      })
      parent.appendChild(row)

      if (isDirectory && node.expanded) {
        if (node.error) {
          const message = document.createElement('div')
          message.className = 'files-tree-message is-error'
          message.style.setProperty('--files-tree-depth', depth + 1)
          message.textContent = `无法读取：${node.error}`
          parent.appendChild(message)
        } else if (node.loaded && !node.children.length) {
          const message = document.createElement('div')
          message.className = 'files-tree-message'
          message.style.setProperty('--files-tree-depth', depth + 1)
          message.textContent = '空文件夹'
          parent.appendChild(message)
        } else {
          this.renderTreeNodes(node.children, parent, depth + 1)
        }
      }
    }
  }

  async openFile(filePath, position = null) {
    if (!filePath) return
    const existing = this.tabs.get(filePath)
    if (existing) {
      this.activateFile(filePath)
      this.revealPosition(position)
      return
    }

    const previous = this.tabs.get(this.activePath)
    if (previous?.model) previous.viewState = this.editor.saveViewState()

    const tab = {
      path: filePath,
      name: fileName(filePath),
      model: null,
      modelSubscription: null,
      viewState: null,
      savedAlternativeVersionId: null,
      diskVersion: null,
      dirty: false,
      loading: true,
      saving: false
    }
    this.tabs.set(filePath, tab)
    this.activePath = filePath
    this.editor.setModel(null)
    this.renderTabs()
    this.renderTree()
    this.renderBreadcrumb()
    this.showEditorMessage(`正在打开 ${tab.name}…`)

    try {
      const result = await window.mica.files.read(filePath)
      if (this.tabs.get(filePath) !== tab) return
      const model = monaco.editor.createModel(
        result.content,
        languageFor(filePath),
        monaco.Uri.file(filePath)
      )
      tab.model = model
      tab.diskVersion = result.version
      tab.loading = false
      tab.savedAlternativeVersionId = model.getAlternativeVersionId()
      tab.modelSubscription = model.onDidChangeContent(() => this.syncDirty(tab))
      if (this.activePath === filePath) this.activateFile(filePath, { focus: true })
      if (this.activePath === filePath) this.revealPosition(position)
      this.renderTabs()
    } catch (error) {
      if (this.tabs.get(filePath) !== tab) return
      const message = `无法打开文件：${error?.message || error}`
      tab.loading = false
      this.tabs.delete(filePath)
      if (this.activePath === filePath) {
        this.activePath = null
        this.editor.setModel(null)
        const fallbackPath = [...this.tabs.keys()].at(-1)
        if (fallbackPath) {
          this.activateFile(fallbackPath, { focus: false })
          this.showTransientMessage(message, true)
        } else {
          this.renderTabs()
          this.renderTree()
          this.renderBreadcrumb()
          this.showEditorMessage(message)
        }
      } else {
        this.renderTabs()
        const activeTab = this.tabs.get(this.activePath)
        if (activeTab?.model) {
          this.showTransientMessage(message, true)
        } else if (activeTab?.loading) {
          this.showEditorMessage(`正在打开 ${activeTab.name}…`)
        }
      }
    }
  }

  revealPosition(position) {
    if (!position || !this.editor.getModel()) return
    const lineNumber = Math.max(1, Number(position.line) || 1)
    const column = Math.max(1, Number(position.column) || 1)
    this.editor.setPosition({ lineNumber, column })
    this.editor.revealPositionInCenter({ lineNumber, column })
    this.editor.focus()
  }

  activateFile(filePath, { focus = true } = {}) {
    const tab = this.tabs.get(filePath)
    if (!tab) return
    if (this.activePath === filePath && this.editor.getModel() === tab.model) {
      if (tab.model) this.hideEditorMessage()
      if (focus) this.editor.focus()
      return
    }
    const previous = this.tabs.get(this.activePath)
    if (previous?.model && previous.path !== filePath) {
      previous.viewState = this.editor.saveViewState()
    }

    this.activePath = filePath
    this.editor.setModel(tab.model)
    this.renderTabs()
    this.renderTree()
    this.renderBreadcrumb()

    if (!tab.model) {
      this.showEditorMessage(`正在打开 ${tab.name}…`)
      return
    }

    this.hideEditorMessage()
    if (tab.viewState) this.editor.restoreViewState(tab.viewState)
    requestAnimationFrame(() => {
      this.editor.layout()
      if (focus) this.editor.focus()
    })
  }

  syncDirty(tab) {
    if (!tab.model) return
    const dirty = tab.model.getAlternativeVersionId() !== tab.savedAlternativeVersionId
    if (tab.dirty === dirty) return
    tab.dirty = dirty
    this.renderTabs()
    if (tab.path === this.activePath) this.renderBreadcrumb()
  }

  async saveActive() {
    const tab = this.tabs.get(this.activePath)
    if (!tab?.model || !tab.dirty || tab.loading || tab.saving) return
    const content = tab.model.getValue()
    const savedVersion = tab.model.getAlternativeVersionId()
    tab.saving = true
    this.renderBreadcrumb()

    try {
      const result = await window.mica.files.write(tab.path, content, tab.diskVersion)
      if (this.tabs.get(tab.path) !== tab) return
      tab.savedAlternativeVersionId = savedVersion
      tab.diskVersion = result.version
      tab.dirty = tab.model.getAlternativeVersionId() !== savedVersion
      this.renderTabs()
      this.renderBreadcrumb()
      this.showTransientMessage(tab.dirty ? '已保存，文件仍有新的更改' : '已保存')
    } catch (error) {
      if (this.tabs.get(tab.path) === tab) {
        this.showTransientMessage(`保存失败：${error?.message || error}`, true)
      }
      throw error
    } finally {
      if (this.tabs.get(tab.path) === tab) {
        tab.saving = false
        this.renderBreadcrumb()
      }
    }
  }

  closeFile(filePath) {
    const tab = this.tabs.get(filePath)
    if (!tab) return false
    if (tab.saving) {
      this.showTransientMessage('文件正在保存，请稍后再关闭', true)
      return false
    }
    if (tab.dirty) {
      const confirmed = window.confirm(`“${tab.name}” 的更改尚未保存。是否放弃更改并关闭？`)
      if (!confirmed) return false
    }

    const paths = [...this.tabs.keys()]
    const closedIndex = paths.indexOf(filePath)
    const wasActive = this.activePath === filePath
    tab.modelSubscription?.dispose()
    if (this.editor.getModel() === tab.model) this.editor.setModel(null)
    tab.model?.dispose()
    this.tabs.delete(filePath)

    if (wasActive) {
      const remaining = [...this.tabs.keys()]
      this.activePath = remaining[Math.min(closedIndex, remaining.length - 1)] || null
      if (this.activePath) {
        this.activateFile(this.activePath, { focus: false })
      } else {
        this.renderTabs()
        this.renderTree()
        this.renderBreadcrumb()
        this.showEditorMessage('从左侧目录选择文件以开始编辑')
      }
    } else {
      this.renderTabs()
    }
    return true
  }

  renderTabs() {
    this.tabsEl.replaceChildren()
    for (const tab of this.tabs.values()) {
      const tabEl = document.createElement('div')
      tabEl.className = 'file-editor-tab'
      tabEl.dataset.filePath = tab.path
      tabEl.title = tab.path
      tabEl.setAttribute('role', 'tab')
      tabEl.setAttribute('tabindex', tab.path === this.activePath ? '0' : '-1')
      tabEl.setAttribute('aria-selected', String(tab.path === this.activePath))
      if (tab.path === this.activePath) tabEl.classList.add('is-active')
      if (tab.dirty) tabEl.classList.add('is-dirty')

      const icon = document.createElement('span')
      icon.className = 'file-editor-tab-icon'
      icon.innerHTML = iconHtml('file', { size: 13 })
      const label = document.createElement('span')
      label.className = 'file-editor-tab-label'
      label.textContent = tab.name
      const dirty = document.createElement('span')
      dirty.className = 'file-editor-tab-dirty'
      dirty.setAttribute('aria-label', tab.dirty ? '未保存' : '')
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'file-editor-tab-close'
      close.dataset.close = tab.path
      close.title = `关闭 ${tab.name}`
      close.setAttribute('aria-label', close.title)
      close.innerHTML = iconHtml('x', { size: 12 })
      tabEl.append(icon, label, dirty, close)
      this.tabsEl.appendChild(tabEl)
    }
  }

  renderBreadcrumb() {
    this.breadcrumbEl.replaceChildren()
    const tab = this.tabs.get(this.activePath)
    if (!tab) {
      this.breadcrumbEl.hidden = true
      return
    }

    this.breadcrumbEl.hidden = false
    const parts = relativeParts(this.rootPath, tab.path)
    parts.forEach((part, index) => {
      if (index > 0) {
        const separator = document.createElement('span')
        separator.className = 'file-editor-breadcrumb-separator'
        separator.textContent = '›'
        this.breadcrumbEl.appendChild(separator)
      }
      const segment = document.createElement('span')
      segment.className = 'file-editor-breadcrumb-segment'
      if (index === parts.length - 1) segment.classList.add('is-current')
      segment.textContent = part
      this.breadcrumbEl.appendChild(segment)
    })

    const state = document.createElement('span')
    state.className = 'file-editor-breadcrumb-state'
    state.textContent = tab.saving ? '正在保存…' : tab.dirty ? '未保存' : ''
    this.breadcrumbEl.appendChild(state)
  }

  setTreeStatus(message = '') {
    this.treeStatusEl.textContent = message
    this.treeStatusEl.classList.toggle('is-visible', Boolean(message))
  }

  showEditorMessage(message) {
    clearTimeout(this.editorMessageTimer)
    this.editorStatusEl.textContent = message
    this.editorStatusEl.className = 'file-editor-status is-visible'
  }

  hideEditorMessage() {
    clearTimeout(this.editorMessageTimer)
    this.editorStatusEl.className = 'file-editor-status'
  }

  showTransientMessage(message, isError = false) {
    clearTimeout(this.editorMessageTimer)
    this.editorStatusEl.textContent = message
    this.editorStatusEl.className = `file-editor-status is-visible is-transient${isError ? ' is-error' : ''}`
    this.editorMessageTimer = window.setTimeout(
      () => this.hideEditorMessage(),
      isError ? 4000 : 1800
    )
  }

  layout() {
    const current = Number.parseFloat(
      getComputedStyle(this.viewEl).getPropertyValue('--files-tree-width')
    )
    if (Number.isFinite(current)) this.setTreeWidth(current)
    this.editor.layout()
  }
}
