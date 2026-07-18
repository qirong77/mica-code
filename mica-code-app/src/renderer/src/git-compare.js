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

function languageFor(filePath) {
  const name = filePath.split('/').at(-1) || ''
  const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : ''
  return LANGUAGE_BY_EXTENSION[extension] || 'plaintext'
}

function makeTree(files) {
  const root = { folders: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] })
      node = node.folders.get(part)
    }
    node.files.push({ ...file, name: parts.at(-1) })
  }
  return root
}

export class GitCompareView {
  constructor({ onSummary }) {
    this.onSummary = onSummary
    this.treeEl = document.getElementById('git-change-tree')
    this.pathEl = document.getElementById('git-repository-path')
    this.statusEl = document.getElementById('git-compare-status')
    this.headerEl = document.getElementById('git-diff-header')
    this.fileEl = document.getElementById('git-diff-file')
    this.statEl = document.getElementById('git-diff-stat')
    this.editorHost = document.getElementById('git-diff-editor')
    this.viewEl = document.getElementById('git-compare-view')
    this.resizerEl = document.getElementById('git-pane-resizer')
    this.cwd = null
    this.repository = null
    this.selectedPath = null
    this.editor = null
    this.editorMode = null
    this.originalModel = null
    this.modifiedModel = null
    this.requestId = 0
    this.summarySignature = null

    monaco.editor.defineTheme('mica-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0e0e0e',
        'diffEditor.insertedTextBackground': '#1f6b403f',
        'diffEditor.removedTextBackground': '#9b33413f',
        'diffEditor.insertedLineBackground': '#183d2b66',
        'diffEditor.removedLineBackground': '#49242a66'
      }
    })
    this.bindResizer()
  }

  bindResizer() {
    const savedWidth = Number(localStorage.getItem('mica.gitTreeWidth'))
    if (Number.isFinite(savedWidth) && savedWidth > 0) this.setTreeWidth(savedWidth)

    const resize = (clientX, persist = false) => {
      const bounds = this.viewEl.getBoundingClientRect()
      const maximum = Math.max(160, bounds.width - 300)
      this.setTreeWidth(Math.min(Math.max(clientX - bounds.left, 160), maximum), persist)
    }

    this.resizerEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      this.resizerEl.setPointerCapture(event.pointerId)
      document.body.classList.add('is-resizing-git-pane')
    })
    this.resizerEl.addEventListener('pointermove', (event) => {
      if (!this.resizerEl.hasPointerCapture(event.pointerId)) return
      resize(event.clientX)
    })
    const finishResize = (event) => {
      if (!this.resizerEl.hasPointerCapture(event.pointerId)) return
      resize(event.clientX, true)
      this.resizerEl.releasePointerCapture(event.pointerId)
      document.body.classList.remove('is-resizing-git-pane')
    }
    this.resizerEl.addEventListener('pointerup', finishResize)
    this.resizerEl.addEventListener('pointercancel', (event) => {
      if (this.resizerEl.hasPointerCapture(event.pointerId)) {
        this.resizerEl.releasePointerCapture(event.pointerId)
      }
      document.body.classList.remove('is-resizing-git-pane')
    })
    this.resizerEl.addEventListener('dblclick', () => this.setTreeWidth(260, true))
    this.resizerEl.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      const current = Number.parseFloat(
        getComputedStyle(this.viewEl).getPropertyValue('--git-tree-width')
      )
      this.setTreeWidth(current + (event.key === 'ArrowLeft' ? -16 : 16), true)
    })
  }

  setTreeWidth(width, persist = false) {
    const maximum =
      this.viewEl.clientWidth > 0
        ? Math.max(160, this.viewEl.clientWidth - 300)
        : Math.max(160, width)
    const normalized = Math.round(Math.min(Math.max(width, 160), maximum))
    this.viewEl.style.setProperty('--git-tree-width', `${normalized}px`)
    this.resizerEl.setAttribute('aria-valuenow', String(normalized))
    this.resizerEl.setAttribute('aria-valuemax', String(Math.round(maximum)))
    if (persist) localStorage.setItem('mica.gitTreeWidth', String(normalized))
    this.editor?.layout()
  }

  async load(cwd, { quiet = false } = {}) {
    const requestId = ++this.requestId
    this.cwd = cwd
    if (!cwd) {
      this.showMessage('选择一个终端会话以查看 Git 变化')
      this.onSummary(null)
      return
    }
    if (!quiet) this.showMessage('正在读取 Git 工作区…')
    const result = await window.mica.git.summary(cwd)
    if (requestId !== this.requestId) return
    if (!result.repository) {
      this.repository = null
      this.summarySignature = null
      this.treeEl.replaceChildren()
      this.pathEl.textContent = ''
      this.clearEditor()
      this.showMessage('当前目录不在 Git 仓库中')
      this.onSummary(null)
      return
    }

    const signature = JSON.stringify({
      root: result.repository.root,
      files: result.repository.files
    })
    if (quiet && signature === this.summarySignature) {
      this.onSummary(result.repository)
      return
    }
    this.summarySignature = signature
    this.repository = result.repository
    this.pathEl.textContent = result.repository.root
    this.pathEl.title = result.repository.root
    this.onSummary(result.repository)
    this.renderTree(result.repository.files)

    if (!result.repository.files.length) {
      this.selectedPath = null
      this.clearEditor()
      this.showMessage('工作区没有文件变化')
      return
    }

    const selected = result.repository.files.find((file) => file.path === this.selectedPath)
    await this.selectFile(selected || result.repository.files[0])
  }

  renderTree(files) {
    this.treeEl.replaceChildren()
    const root = makeTree(files)
    this.renderNode(root, this.treeEl, 0)
  }

  renderNode(node, parent, depth) {
    for (const [name, folder] of node.folders) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'git-tree-row git-tree-folder'
      row.style.setProperty('--tree-depth', depth)
      row.innerHTML = `<span class="git-tree-chevron">${iconHtml('chevron', { size: 13 })}</span><span class="git-tree-icon">${iconHtml('folder', { size: 14 })}</span>`
      const label = document.createElement('span')
      label.className = 'git-tree-label'
      label.textContent = name
      row.appendChild(label)
      const children = document.createElement('div')
      children.className = 'git-tree-children'
      row.addEventListener('click', () => {
        const collapsed = children.toggleAttribute('hidden')
        row.classList.toggle('is-collapsed', collapsed)
      })
      parent.append(row, children)
      this.renderNode(folder, children, depth + 1)
    }

    for (const file of node.files) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'git-tree-row git-tree-file'
      row.dataset.path = file.path
      row.style.setProperty('--tree-depth', depth)
      row.title = file.path
      row.innerHTML = `<span class="git-tree-spacer"></span><span class="git-tree-icon">${iconHtml('file', { size: 14 })}</span>`
      const label = document.createElement('span')
      label.className = 'git-tree-label'
      label.textContent = file.name
      const state = document.createElement('span')
      state.className = `git-file-state is-${file.status}`
      state.textContent = file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'
      row.append(label, state)
      row.addEventListener('click', () => this.selectFile(file))
      parent.appendChild(row)
    }
  }

  async selectFile(file) {
    if (!file || !this.repository) return
    this.selectedPath = file.path
    for (const row of this.treeEl.querySelectorAll('.git-tree-file')) {
      row.classList.toggle('is-selected', row.dataset.path === file.path)
    }
    this.fileEl.textContent = file.path
    this.fileEl.title = file.path
    this.statEl.innerHTML = `<span class="git-additions">+${file.additions}</span> <span class="git-deletions">−${file.deletions}</span>`
    this.headerEl.hidden = false
    this.showMessage('正在加载对比…')

    try {
      const content = await window.mica.git.file(this.cwd, file.path)
      if (file.path !== this.selectedPath) return
      if (content.binary || file.binary) {
        this.clearEditor(false)
        this.showMessage('二进制文件无法进行文本对比')
        return
      }
      const language = languageFor(file.path)
      if (file.status === 'added') {
        this.showSingle(content.modified, language)
      } else if (file.status === 'deleted') {
        this.showSingle(content.original, language)
      } else {
        this.showDiff(content.original, content.modified, language)
      }
    } catch (error) {
      this.clearEditor(false)
      this.showMessage(`无法加载文件对比：${error?.message || error}`)
    }
  }

  showDiff(original, modified, language) {
    this.ensureEditor('diff')
    this.editor.setModel(null)
    this.originalModel?.dispose()
    this.modifiedModel?.dispose()
    this.originalModel = monaco.editor.createModel(original, language)
    this.modifiedModel = monaco.editor.createModel(modified, language)
    this.editor.setModel({ original: this.originalModel, modified: this.modifiedModel })
    this.revealEditor()
  }

  showSingle(content, language) {
    this.ensureEditor('single')
    this.editor.setModel(null)
    this.originalModel?.dispose()
    this.modifiedModel?.dispose()
    this.originalModel = null
    this.modifiedModel = monaco.editor.createModel(content, language)
    this.editor.setModel(this.modifiedModel)
    this.revealEditor()
  }

  ensureEditor(mode) {
    if (this.editor && this.editorMode === mode) return
    this.editor?.dispose()
    this.originalModel?.dispose()
    this.modifiedModel?.dispose()
    this.originalModel = null
    this.modifiedModel = null
    this.editorMode = mode

    const options = {
      theme: 'mica-dark',
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      stickyScroll: { enabled: false },
      padding: { top: 8 }
    }

    if (mode === 'diff') {
      this.editor = monaco.editor.createDiffEditor(this.editorHost, {
        ...options,
        originalEditable: false,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: false
      })
    } else {
      this.editor = monaco.editor.create(this.editorHost, options)
    }
  }

  revealEditor() {
    this.editorHost.hidden = false
    this.statusEl.hidden = true
    requestAnimationFrame(() => this.editor?.layout())
  }

  showMessage(message) {
    this.editorHost.hidden = true
    this.statusEl.textContent = message
    this.statusEl.hidden = false
  }

  clearEditor(hideHeader = true) {
    this.editor?.setModel(null)
    this.originalModel?.dispose()
    this.modifiedModel?.dispose()
    this.originalModel = null
    this.modifiedModel = null
    this.editorHost.hidden = true
    if (hideHeader) this.headerEl.hidden = true
  }

  layout() {
    this.editor?.layout()
  }
}
