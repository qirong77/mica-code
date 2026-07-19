const FILE_RESULT_LIMIT = 100
const TEXT_RESULT_LIMIT = 200
const SEARCH_DEBOUNCE_MS = 160

const MODES = {
  files: {
    label: '快速打开',
    placeholder: '搜索当前工作区中的文件',
    method: 'find',
    limit: FILE_RESULT_LIMIT
  },
  text: {
    label: '全文搜索',
    placeholder: '在当前工作区中搜索文本',
    method: 'search',
    limit: TEXT_RESULT_LIMIT
  }
}

function isAbsolutePath(value) {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(value)
}

function resolvePath(root, value) {
  const path = String(value || '')
  if (!path || isAbsolutePath(path) || !root) return path

  const separator = String(root).includes('\\') ? '\\' : '/'
  return `${String(root).replace(/[\\/]+$/, '')}${separator}${path.replace(/^[\\/]+/, '')}`
}

function relativePath(root, value) {
  const path = String(value || '')
  const normalizedRoot = String(root || '').replace(/[\\/]+$/, '')
  if (!normalizedRoot) return path

  const pathLower = path.toLocaleLowerCase()
  const rootLower = normalizedRoot.toLocaleLowerCase()
  if (pathLower === rootLower) return path.split(/[\\/]/).at(-1) || path
  if (!pathLower.startsWith(`${rootLower}/`) && !pathLower.startsWith(`${rootLower}\\`)) {
    return path
  }

  return path.slice(normalizedRoot.length + 1)
}

function positiveInteger(value, fallback = 1) {
  const number = Number.parseInt(value, 10)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function responseItems(response) {
  if (Array.isArray(response)) return response
  if (!response || typeof response !== 'object') return []
  if (Array.isArray(response.results)) return response.results
  if (Array.isArray(response.files)) return response.files
  if (Array.isArray(response.items)) return response.items
  if (Array.isArray(response.matches)) return response.matches
  return []
}

function flattenTextItems(items) {
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object' || !Array.isArray(item.matches)) return [item]
    return item.matches.map((match) => ({ ...item, ...match, matches: undefined }))
  })
}

function resultTotal(response, fallback) {
  const total = Number(response?.total ?? response?.count)
  return Number.isFinite(total) && total >= fallback ? total : fallback
}

function fuzzyMatchIndexes(text, query) {
  const source = String(text).toLocaleLowerCase()
  const needle = String(query).replace(/\s+/g, '').toLocaleLowerCase()
  if (!needle) return []

  const indexes = []
  let sourceIndex = 0
  for (const character of needle) {
    const matchIndex = source.indexOf(character, sourceIndex)
    if (matchIndex === -1) return []
    indexes.push(matchIndex)
    sourceIndex = matchIndex + 1
  }
  return indexes
}

function exactMatchIndexes(text, query) {
  const source = String(text).toLocaleLowerCase()
  const needle = String(query).trim().toLocaleLowerCase()
  if (!needle) return []

  const indexes = []
  let start = 0
  while (start < source.length) {
    const matchIndex = source.indexOf(needle, start)
    if (matchIndex === -1) break
    for (let offset = 0; offset < needle.length; offset += 1) {
      indexes.push(matchIndex + offset)
    }
    start = matchIndex + needle.length
  }
  return indexes
}

function appendHighlightedText(element, text, query, fuzzy = false) {
  const value = String(text || '')
  const indexes = fuzzy ? fuzzyMatchIndexes(value, query) : exactMatchIndexes(value, query)
  if (indexes.length === 0) {
    element.textContent = value
    return
  }

  const matched = new Set(indexes)
  let start = 0
  let highlighted = matched.has(0)
  for (let index = 1; index <= value.length; index += 1) {
    const nextHighlighted = index < value.length && matched.has(index)
    if (index < value.length && nextHighlighted === highlighted) continue

    const node = highlighted ? document.createElement('mark') : document.createTextNode('')
    node.textContent = value.slice(start, index)
    element.append(node)
    start = index
    highlighted = nextHighlighted
  }
}

export class QuickSearch {
  constructor({ getRoot, openFile, closeActiveFile } = {}) {
    this.getRoot = typeof getRoot === 'function' ? getRoot : () => null
    this.openFile = typeof openFile === 'function' ? openFile : () => {}
    this.closeActiveFile = typeof closeActiveFile === 'function' ? closeActiveFile : () => false

    this.overlay = document.getElementById('quick-search-overlay')
    this.panel = document.getElementById('quick-search-panel')
    this.modeLabel = document.getElementById('quick-search-mode')
    this.input = document.getElementById('quick-search-input')
    this.resultsElement = document.getElementById('quick-search-results')
    this.message = document.getElementById('quick-search-message')
    this.summary = document.getElementById('quick-search-summary')

    if (
      !this.overlay ||
      !this.panel ||
      !this.modeLabel ||
      !this.input ||
      !this.resultsElement ||
      !this.message ||
      !this.summary
    ) {
      throw new Error('QuickSearch requires the quick search elements in index.html')
    }

    this.mode = 'files'
    this.results = []
    this.selectedIndex = -1
    this.requestId = 0
    this.debounceTimer = null

    this.handleGlobalKeydown = this.handleGlobalKeydown.bind(this)
    this.handleInput = this.handleInput.bind(this)
    this.handleInputKeydown = this.handleInputKeydown.bind(this)
    this.handleOverlayClick = this.handleOverlayClick.bind(this)

    window.addEventListener('keydown', this.handleGlobalKeydown, true)
    this.input.addEventListener('input', this.handleInput)
    this.input.addEventListener('keydown', this.handleInputKeydown)
    this.overlay.addEventListener('click', this.handleOverlayClick)
  }

  get isOpen() {
    return !this.overlay.hidden
  }

  destroy() {
    clearTimeout(this.debounceTimer)
    this.requestId += 1
    window.removeEventListener('keydown', this.handleGlobalKeydown, true)
    this.input.removeEventListener('input', this.handleInput)
    this.input.removeEventListener('keydown', this.handleInputKeydown)
    this.overlay.removeEventListener('click', this.handleOverlayClick)
  }

  handleGlobalKeydown(event) {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return

    const key = event.key.toLocaleLowerCase()
    if (key === 'p' && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      this.show('files')
      return
    }

    if (key === 'f' && event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      this.show('text')
      return
    }

    if (key !== 'w' || event.shiftKey) return
    if (this.isOpen) {
      event.preventDefault()
      event.stopPropagation()
      this.hide()
      return
    }

    let didClose = false
    try {
      didClose = this.closeActiveFile() === true
    } catch (error) {
      console.error('close active file failed', error)
    }
    if (didClose) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  handleInput() {
    clearTimeout(this.debounceTimer)
    this.requestId += 1
    this.debounceTimer = setTimeout(() => this.search(), SEARCH_DEBOUNCE_MS)
  }

  handleInputKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.hide()
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      this.moveSelection(event.key === 'ArrowDown' ? 1 : -1)
      return
    }

    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      event.stopPropagation()
      this.openSelected()
    }
  }

  handleOverlayClick(event) {
    if (event.target === this.overlay) this.hide()
  }

  show(mode) {
    const config = MODES[mode]
    if (!config) return

    clearTimeout(this.debounceTimer)
    this.requestId += 1
    this.panel.removeAttribute('aria-busy')
    this.mode = mode
    this.modeLabel.textContent = config.label
    this.input.placeholder = config.placeholder
    this.input.setAttribute('aria-label', config.placeholder)
    this.input.value = ''
    this.overlay.hidden = false
    this.results = []
    this.selectedIndex = -1
    this.renderResults()
    this.setMessage(mode === 'text' ? '输入文本以搜索当前工作区' : '正在加载文件…')
    this.summary.textContent = ''

    requestAnimationFrame(() => {
      this.input.focus()
      this.input.select()
    })

    if (mode === 'files') this.search()
  }

  hide() {
    if (!this.isOpen) return
    clearTimeout(this.debounceTimer)
    this.requestId += 1
    this.panel.removeAttribute('aria-busy')
    this.overlay.hidden = true
    this.results = []
    this.selectedIndex = -1
  }

  async search() {
    if (!this.isOpen) return

    const mode = this.mode
    const config = MODES[mode]
    const query = this.input.value.trim()
    const root = await this.getRoot()
    const currentRequest = ++this.requestId

    if (!root) {
      this.results = []
      this.renderResults()
      this.setMessage('请先打开一个工作区文件夹')
      this.summary.textContent = ''
      return
    }

    if (mode === 'text' && !query) {
      this.results = []
      this.renderResults()
      this.setMessage('输入文本以搜索当前工作区')
      this.summary.textContent = ''
      return
    }

    const searchMethod = window.mica?.files?.[config.method]
    if (typeof searchMethod !== 'function') {
      this.results = []
      this.renderResults()
      this.setMessage('当前版本不支持工作区搜索', true)
      this.summary.textContent = ''
      return
    }

    this.results = []
    this.selectedIndex = -1
    this.renderResults()
    this.setMessage(mode === 'files' ? '正在搜索文件…' : '正在搜索工作区…')
    this.summary.textContent = ''
    this.panel.setAttribute('aria-busy', 'true')

    try {
      const response = await searchMethod(root, query)
      if (currentRequest !== this.requestId || !this.isOpen || mode !== this.mode) return

      const rawItems = responseItems(response)
      const items = mode === 'text' ? flattenTextItems(rawItems) : rawItems
      const normalized = items.map((item) => this.normalizeResult(item, root, mode)).filter(Boolean)
      const total = resultTotal(response, normalized.length)
      this.results = normalized.slice(0, config.limit)
      this.selectedIndex = this.results.length > 0 ? 0 : -1
      this.renderResults(query)
      this.setMessage(this.results.length === 0 ? '没有找到匹配结果' : '')
      this.summary.textContent = this.resultSummary(total, this.results.length, config.limit)
    } catch (error) {
      if (currentRequest !== this.requestId || !this.isOpen) return
      this.results = []
      this.selectedIndex = -1
      this.renderResults()
      this.setMessage(error?.message ? `搜索失败：${error.message}` : '搜索失败，请稍后重试', true)
      this.summary.textContent = ''
    } finally {
      if (currentRequest === this.requestId) this.panel.removeAttribute('aria-busy')
    }
  }

  normalizeResult(item, root, mode) {
    const source = typeof item === 'string' ? { path: item } : item
    if (!source || typeof source !== 'object') return null

    const candidatePath =
      source.path ||
      source.filePath ||
      source.absolutePath ||
      source.file ||
      source.relativePath ||
      source.relative
    const path = resolvePath(root, candidatePath)
    if (!path) return null

    const displayPath = String(
      source.relativePath || source.relative || source.displayPath || relativePath(root, path)
    )
    if (mode === 'files') return { path, relativePath: displayPath }

    return {
      path,
      relativePath: displayPath,
      line: positiveInteger(source.line ?? source.lineNumber),
      column: positiveInteger(source.column ?? source.columnNumber),
      preview: String(source.preview ?? source.lineText ?? source.text ?? source.content ?? '')
    }
  }

  resultSummary(total, visible, limit) {
    if (total > visible || visible === limit) return `显示 ${visible} 项，共 ${total} 项`
    return `${visible} 个结果`
  }

  setMessage(text, isError = false) {
    this.message.textContent = text
    this.message.classList.toggle('is-error', isError)
  }

  renderResults(query = this.input.value.trim()) {
    const fragment = document.createDocumentFragment()
    this.results.forEach((result, index) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'quick-search-result'
      row.id = `quick-search-result-${index}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(index === this.selectedIndex))
      row.tabIndex = -1
      if (index === this.selectedIndex) row.classList.add('is-selected')

      const main = document.createElement('span')
      main.className = 'quick-search-result-main'
      const path = document.createElement('span')
      path.className = 'quick-search-result-path'
      appendHighlightedText(path, result.relativePath, query, this.mode === 'files')
      main.append(path)

      if (this.mode === 'text') {
        const preview = document.createElement('span')
        preview.className = 'quick-search-result-preview'
        appendHighlightedText(preview, result.preview, query)
        main.append(preview)

        const location = document.createElement('span')
        location.className = 'quick-search-result-location'
        location.textContent = `${result.line}:${result.column}`
        row.append(main, location)
      } else {
        row.append(main)
      }

      row.addEventListener('mouseenter', () => this.select(index, false))
      row.addEventListener('mousedown', (event) => event.preventDefault())
      row.addEventListener('click', () => {
        this.select(index, false)
        this.openSelected()
      })
      fragment.append(row)
    })

    this.resultsElement.replaceChildren(fragment)
    this.input.setAttribute(
      'aria-activedescendant',
      this.selectedIndex >= 0 ? `quick-search-result-${this.selectedIndex}` : ''
    )
  }

  moveSelection(delta) {
    if (this.results.length === 0) return
    const next =
      this.selectedIndex < 0
        ? delta > 0
          ? 0
          : this.results.length - 1
        : (this.selectedIndex + delta + this.results.length) % this.results.length
    this.select(next)
  }

  select(index, scroll = true) {
    if (index < 0 || index >= this.results.length || index === this.selectedIndex) return

    this.selectedIndex = index
    const rows = this.resultsElement.querySelectorAll('.quick-search-result')
    rows.forEach((row, rowIndex) => {
      const selected = rowIndex === index
      row.classList.toggle('is-selected', selected)
      row.setAttribute('aria-selected', String(selected))
    })
    this.input.setAttribute('aria-activedescendant', `quick-search-result-${index}`)
    if (scroll) rows[index]?.scrollIntoView({ block: 'nearest' })
  }

  openSelected() {
    const result = this.results[this.selectedIndex]
    if (!result) return

    try {
      const opening =
        this.mode === 'text'
          ? this.openFile(result.path, { line: result.line, column: result.column })
          : this.openFile(result.path)
      if (opening && typeof opening.catch === 'function') {
        opening.catch((error) => console.error('open search result failed', error))
      }
      this.hide()
    } catch (error) {
      this.setMessage(error?.message ? `打开文件失败：${error.message}` : '打开文件失败', true)
    }
  }
}
