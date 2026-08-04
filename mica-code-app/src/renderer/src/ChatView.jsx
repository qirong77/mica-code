import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import {
  ArrowDown,
  Check,
  Command,
  Copy,
  ExternalLink,
  GitCommitHorizontal,
  GitFork,
  LoaderCircle,
  Minimize2,
  Send,
  Square,
  Terminal,
  Trash2,
  Undo2,
  Zap
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CHAT_COMMANDS, findChatCommand } from './chat-commands'
import { useLatest } from './hooks'
import { uid } from './workspace'

const MAX_INPUT_ROWS = 10
const SCROLL_BOTTOM_THRESHOLD = 72
const TERMINAL_CURSOR_WIDTH = 8
const MIN_TURN_LOG_HEIGHT = 60
const MAX_TURN_LOG_HEIGHT_RATIO = 0.6
const TURN_LOG_HEIGHT_KEY = 'mica.turnLogHeight'
const CURSOR_ACTIVE_DURATION_MS = 1200
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    ? CSS.supports('field-sizing', 'content')
    : false

const TEXTAREA_CURSOR_STYLE_PROPS = [
  'boxSizing',
  'width',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
  'tabSize'
]

let textareaCursorMirror = null

const TOKEN_THRESHOLDS = [80_000, 120_000, 200_000, 300_000]
const RATIO_THRESHOLDS = [40, 50, 60, 70]
const TOKEN_LEVEL_CLASS = [
  '',
  'chat-status-warn',
  'chat-status-warn',
  'chat-status-hot',
  'chat-status-error'
]
const RATIO_LEVEL_CLASS = [
  '',
  'chat-status-warn',
  'chat-status-hot',
  'chat-status-error',
  'chat-status-error'
]

function levelFor(value, thresholds) {
  let level = 0
  for (const threshold of thresholds) {
    if (value >= threshold) level += 1
  }
  return level
}

function formatTokens(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens < 1000) return `${Math.round(tokens)}`
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`
  return `${(tokens / 1_000_000).toFixed(2)}M`
}

function measureTextareaCursor(element, text, selectionStart, selectionEnd) {
  if (!element || selectionStart !== selectionEnd) return null
  const styles = window.getComputedStyle(element)
  const lineHeight = Number.parseFloat(styles.lineHeight) || 20
  const fontSize = Number.parseFloat(styles.fontSize) || 13
  const cursorHeight = Math.max(12, Math.min(lineHeight, Math.ceil(fontSize * 1.18)))
  const cursorOffset = Math.max(0, (lineHeight - cursorHeight) / 2)

  if (!text) {
    return {
      left: Math.max(0, (Number.parseFloat(styles.paddingLeft) || 0) - element.scrollLeft),
      top: Math.max(
        0,
        (Number.parseFloat(styles.paddingTop) || 0) - element.scrollTop + cursorOffset
      ),
      width: TERMINAL_CURSOR_WIDTH,
      height: cursorHeight
    }
  }

  if (!textareaCursorMirror) {
    textareaCursorMirror = {
      mirror: document.createElement('div'),
      marker: document.createElement('span'),
      measure: document.createElement('span')
    }
    const { mirror, marker, measure } = textareaCursorMirror
    mirror.style.position = 'fixed'
    mirror.style.left = '-10000px'
    mirror.style.top = '0'
    mirror.style.height = 'auto'
    mirror.style.minHeight = '0'
    mirror.style.overflow = 'hidden'
    mirror.style.visibility = 'hidden'
    mirror.style.pointerEvents = 'none'
    mirror.style.whiteSpace = 'pre-wrap'
    marker.textContent = '\u200b'
    marker.style.display = 'inline-block'
    marker.style.width = '0'
    measure.style.display = 'inline-block'
    measure.style.whiteSpace = 'pre'
  }

  const { mirror, marker, measure } = textareaCursorMirror

  for (const property of TEXTAREA_CURSOR_STYLE_PROPS) mirror.style[property] = styles[property]
  mirror.style.width = `${element.clientWidth}px`

  const before = text.slice(0, selectionStart).replace(/\n$/u, '\n\u200b')
  marker.style.height = styles.lineHeight
  const nextChar = Array.from(text.slice(selectionStart))[0]
  measure.textContent = nextChar && nextChar !== '\n' ? nextChar : ' '
  mirror.replaceChildren(document.createTextNode(before), marker, measure)
  if (!mirror.isConnected) document.body.append(mirror)

  const mirrorRect = mirror.getBoundingClientRect()
  const markerRect = marker.getBoundingClientRect()
  const position = {
    left: Math.max(0, markerRect.left - mirrorRect.left - element.scrollLeft),
    top: Math.max(0, markerRect.top - mirrorRect.top - element.scrollTop + cursorOffset),
    width: Math.max(TERMINAL_CURSOR_WIDTH, measure.getBoundingClientRect().width),
    height: cursorHeight
  }
  return position
}

const EFFORT_OPTIONS = [
  { value: 'none', detail: '不发送推理参数' },
  { value: 'low', detail: '轻量推理' },
  { value: 'medium', detail: '默认推理' },
  { value: 'high', detail: '深度推理' },
  { value: 'xhigh', detail: '最强推理' }
]

const TOOL_ICONS = {
  read_file: '📖',
  read_image: '📷',
  write_file: '✍️',
  apply_patch: '🩹',
  list_files: '📂',
  grep_search: '📊',
  run_shell: '⚡️',
  web_fetch: '🔗',
  web_search: '🌐',
  Skill: '✨',
  Agent: '🤖',
  TodoWrite: '📝',
  background_tasks: '📋',
  read_task_output: '📋',
  kill_task: '📋'
}

const TOOL_LABELS = {
  read_file: 'Read file',
  read_image: 'Read image',
  write_file: 'Write file',
  apply_patch: 'Apply patch',
  list_files: 'List files',
  grep_search: 'Search code',
  run_shell: 'Shell',
  web_fetch: 'Fetch web',
  web_search: 'Search web',
  Skill: 'Load skill',
  Agent: 'Subagent',
  TodoWrite: 'Plan',
  background_tasks: 'Background tasks',
  read_task_output: 'Task output',
  kill_task: 'Stop task'
}

function copyText(text) {
  if (!text) return Promise.resolve()
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => {})
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
  return Promise.resolve()
}

function useCopied(resetMs = 1400) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(
    (text) => {
      void copyText(text).then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), resetMs)
      })
    },
    [resetMs]
  )
  return [copied, copy]
}

function nodeText(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  return nodeText(node.props?.children)
}

function CodeBlock({ children }) {
  const [copied, copy] = useCopied()
  const child = Array.isArray(children) ? children[0] : children
  const code = nodeText(child?.props?.children ?? children).replace(/\n$/, '')
  const language = /language-([^\s]+)/.exec(child?.props?.className || '')?.[1] || 'text'

  return (
    <div className="chat-code-block">
      <div className="chat-code-header">
        <span>{language}</span>
        <button type="button" onClick={() => copy(code)} aria-label="复制代码">
          {copied ? <Check size={11} /> : <Copy size={11} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

function isExternalHref(href) {
  return /^(https?:|mailto:)/i.test(href || '')
}

function resolveImageSource(source) {
  const value = String(source || '').trim()
  if (!value) return ''
  if (/^(https?:|data:|blob:|file:)/i.test(value)) return value
  const homeDir = typeof window !== 'undefined' ? window.mica?.homeDir || '' : ''
  const expanded = value.startsWith('~/') && homeDir ? `${homeDir}${value.slice(1)}` : value
  if (/^(?:\/|[a-zA-Z]:[\\/])/.test(expanded)) {
    const normalized = expanded.replace(/\\/g, '/')
    return `file://${encodeURI(normalized.startsWith('/') ? normalized : `/${normalized}`)}`
  }
  return expanded
}

function imageReferences(text) {
  const result = []
  const pattern = /!?(?:\[([^\]]*)\])\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let match
  while ((match = pattern.exec(text || ''))) {
    const source = match[2]
    if (!result.some((item) => item.source === source))
      result.push({ alt: match[1] || '图片', source })
  }
  return result
}

function composerMarkdownNodes(text) {
  const nodes = []
  const pattern =
    /(```[\s\S]*?```|`[^`\n]+`|!?\[[^\]]*\]\([^)\n]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|^ {0,3}(?:#{1,6}|[-*+]|\d+\.) +)/gm
  let cursor = 0
  let match
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    const token = match[0]
    const kind = token.startsWith('```')
      ? 'code'
      : token.startsWith('!')
        ? 'image'
        : token.startsWith('[')
          ? 'link'
          : 'syntax'
    nodes.push(
      <span
        key={`${match.index}:${token}`}
        className={`chat-composer-token chat-composer-token-${kind}`}
      >
        {token}
      </span>
    )
    cursor = match.index + token.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function ComposerImageStrip({ text, onPreview }) {
  const images = imageReferences(text)
  if (!images.length) return null
  return (
    <div className="chat-composer-images" aria-label="输入中的图片">
      {images.map((image) => (
        <button
          key={image.source}
          type="button"
          title="预览图片"
          onClick={() => onPreview(image.source, image.alt)}
        >
          <img src={resolveImageSource(image.source)} alt={image.alt} loading="lazy" />
        </button>
      ))}
    </div>
  )
}

function QueueDock({ items, onRecall, recallingId }) {
  if (!items.length) return null
  return (
    <section className="chat-queue-dock" aria-label="等待发送的消息">
      <div className="chat-queue-dock-header">
        <span aria-hidden="true">↳</span>
        <span>waiting queue (after current turn)</span>
        <span>{items.length}</span>
      </div>
      <div className="chat-queue-dock-items">
        {items.map((item, index) => (
          <div key={item.id || `${index}:${item.text}`} className="chat-queue-dock-item">
            <span>▌</span>
            <span>{item.text}</span>
            <button
              type="button"
              title={item.pending ? '正在加入队列' : '撤回到输入框'}
              aria-label={`撤回排队消息 ${index + 1}`}
              disabled={item.pending || Boolean(recallingId)}
              onClick={() => onRecall(item.id)}
            >
              {recallingId === item.id ? (
                <LoaderCircle size={11} className="animate-spin" />
              ) : (
                <Undo2 size={11} />
              )}
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

function ImagePreviewModal({ source, alt, onClose }) {
  useEffect(() => {
    const onKeyDown = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="chat-image-preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="chat-image-preview">
        <img src={resolveImageSource(source)} alt={alt || '图片预览'} />
        <button type="button" onClick={onClose} aria-label="关闭图片预览">
          关闭
        </button>
      </div>
    </div>
  )
}

export function chatUrlTransform(url) {
  if (!url) return ''
  if (
    isExternalHref(url) ||
    url.startsWith('#') ||
    url.startsWith('file://') ||
    /^[a-zA-Z]:[\\/]/.test(url)
  ) {
    return url
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url)) return ''
  return url
}

export function fileTarget(href) {
  if (!href || href.startsWith('#') || isExternalHref(href)) return null
  let decoded = href
  if (href.startsWith('file://')) {
    try {
      const fileUrl = new URL(href)
      let pathname = fileUrl.pathname
      try {
        pathname = decodeURIComponent(pathname)
      } catch {
        // Keep the encoded path when it contains malformed escapes.
      }
      decoded = `${fileUrl.host ? `//${fileUrl.host}` : ''}${pathname}${fileUrl.hash}`
      if (/^\/[a-zA-Z]:\//.test(decoded)) decoded = decoded.slice(1)
    } catch {
      return null
    }
  } else {
    try {
      decoded = decodeURIComponent(href)
    } catch {
      // Keep the original href when it is not URI encoded.
    }
  }
  const hashLine = /#L(\d+)(?:C(\d+))?$/.exec(decoded)
  if (hashLine) {
    return {
      path: decoded.slice(0, hashLine.index),
      line: Number(hashLine[1]),
      column: Number(hashLine[2]) || 1
    }
  }
  const suffix = /^(.*?):(\d+)(?::(\d+))?$/.exec(decoded)
  if (suffix) {
    return {
      path: suffix[1],
      line: Number(suffix[2]),
      column: Number(suffix[3]) || 1
    }
  }
  return { path: decoded, line: 1, column: 1 }
}

export function resolveChatPath(target, cwd) {
  if (
    !target ||
    !cwd ||
    target.startsWith('~') ||
    target.startsWith('\\\\') ||
    /^(?:\/|[a-zA-Z]:[\\/])/.test(target)
  ) {
    return target
  }
  const windows = /^[a-zA-Z]:[\\/]/.test(cwd)
  const separator = windows ? '\\' : '/'
  const base = cwd.replace(/[\\/]+$/, '')
  const relative = target.replace(/^[\\/]+/, '').replace(windows ? /\//g : /\\/g, separator)
  return `${base}${separator}${relative}`
}

function MarkdownLink({ href, children, onOpenFile }) {
  const target = fileTarget(href)
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        if (target && onOpenFile) {
          onOpenFile(target.path, { line: target.line, column: target.column })
          return
        }
        if (isExternalHref(href)) window.mica.terminal.openExternal(href).catch(() => {})
      }}
    >
      {children}
    </a>
  )
}

export function Markdown({ text, muted = false, onOpenFile, onPreviewImage }) {
  const components = useMemo(
    () => ({
      a: ({ href, children }) => (
        <MarkdownLink href={href} onOpenFile={onOpenFile}>
          {children}
        </MarkdownLink>
      ),
      pre: CodeBlock,
      table: ({ children }) => (
        <div className="chat-table-wrap thin-scrollbar">
          <table>{children}</table>
        </div>
      ),
      input: (props) => <input {...props} disabled />,
      img: ({ alt, src, ...props }) => (
        <button
          type="button"
          className="chat-markdown-image-button"
          onClick={() => onPreviewImage?.(src, alt)}
          title="预览图片"
        >
          <img {...props} src={resolveImageSource(src)} alt={alt || ''} loading="lazy" />
        </button>
      )
    }),
    [onOpenFile, onPreviewImage]
  )

  return (
    <div className={`chat-markdown ${muted ? 'chat-markdown-muted' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={chatUrlTransform}
        skipHtml
      >
        {text || ''}
      </ReactMarkdown>
    </div>
  )
}

function compactLine(value, max = 110) {
  const line = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function toolSummary(tool) {
  const input = tool.input || {}
  switch (tool.tool) {
    case 'read_file':
    case 'read_image':
      return compactLine(input.file_path || input.source || input.path)
    case 'write_file':
      return compactLine(input.file_path)
    case 'apply_patch':
      return compactLine(
        String(input.patch || '').match(/\*\*\* (?:Update|Add) File: ([^\n]+)/)?.[1] || ''
      )
    case 'list_files':
      return compactLine([input.path, input.pattern].filter(Boolean).join(' · '))
    case 'grep_search':
      return compactLine([input.pattern, input.path].filter(Boolean).join(' · '))
    case 'run_shell':
      return compactLine(input.command)
    case 'web_search':
      return compactLine(input.query)
    case 'web_fetch':
      return compactLine(input.url)
    case 'Skill':
      return compactLine(input.skill)
    case 'Agent':
      return compactLine(
        [input.subagent_type, input.description || input.operation].filter(Boolean).join(' · ')
      )
    case 'background_tasks':
      return compactLine(input.status || 'all')
    case 'read_task_output':
    case 'kill_task':
      return compactLine(input.task_id)
    default:
      return compactLine(Object.values(input).find((value) => typeof value === 'string') || '')
  }
}

function toolDisplayName(tool) {
  if (tool.tool === 'Agent') {
    const operation = tool.input?.operation || 'run'
    if (operation === 'run_many') return 'Subagents'
    if (operation !== 'run') return `Subagent · ${operation}`
  }
  return TOOL_LABELS[tool.tool] || tool.tool
}

function subagentTasks(tool) {
  if (tool.tool !== 'Agent') return []
  const input = tool.input || {}
  if (input.operation === 'run_many' && Array.isArray(input.tasks)) {
    return input.tasks.map((task, index) => ({
      id: task.id || String(index + 1),
      type: task.subagent_type || 'general-purpose',
      description: task.description || task.prompt || '执行子任务',
      dependsOn: Array.isArray(task.depends_on) ? task.depends_on : []
    }))
  }
  return [
    {
      id: input.task_id || '1',
      type: input.subagent_type || 'general-purpose',
      description: input.description || input.prompt || input.operation || '执行子任务',
      dependsOn: []
    }
  ]
}

function SubagentStatusDock({ messages, now = Date.now() }) {
  if (!messages.length) return null

  return (
    <section className="chat-task-dock chat-subagent-dock" aria-label="运行中的 Subagent">
      {messages.flatMap((message) => {
        const tool = message.tool
        const age = formatLogElapsed(Math.max(0, now - (tool.startedAt || now)))
        return subagentTasks(tool).map((task) => (
          <div className="chat-task-summary-row" key={`${message.id}:${task.id}`}>
            <span className="chat-task-kind">🤖(subagent)</span>
            <span className="chat-task-status chat-task-status-running">running</span>
            <span className="chat-task-runtime">{age}</span>
            <span className="chat-task-type">{task.type}</span>
            <span className="chat-task-description">
              {compactLine(task.description, 180)}
              {task.dependsOn.length > 0 ? ` · after ${task.dependsOn.join(', ')}` : ''}
            </span>
          </div>
        ))
      })}
    </section>
  )
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return ''
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function formatLogElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return formatDuration(ms)
}

function estimateTokens(text) {
  let ascii = 0
  let cjk = 0
  for (const char of String(text || '')) {
    const code = char.codePointAt(0)
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2ceaf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1
    } else {
      ascii += 1
    }
  }
  return Math.max(1, Math.ceil(ascii / 4 + cjk / 1.5))
}

function usageValues(usage) {
  if (!usage) return null
  const total = usage.total_tokens ?? usage.totalTokens ?? usage.total ?? null
  const input = usage.prompt_tokens ?? usage.inputTokens ?? usage.input ?? null
  const output = usage.completion_tokens ?? usage.outputTokens ?? usage.output ?? null
  const cached = usage.cachedInputTokens ?? usage.cacheRead ?? usage.cache?.read ?? null
  if (total == null && input == null && output == null && cached == null) return null
  return { total, input, output, cached }
}

function metaUsageFromStepTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return null
  const total = tokens.total_tokens ?? tokens.totalTokens ?? tokens.total ?? null
  const input = tokens.prompt_tokens ?? tokens.inputTokens ?? tokens.input ?? null
  const output = tokens.completion_tokens ?? tokens.outputTokens ?? tokens.output ?? null
  const cached = tokens.cachedInputTokens ?? tokens.cacheRead ?? tokens.cache?.read ?? null
  if (total == null && input == null && output == null && cached == null) return null
  return {
    totalTokens: Number(total) || 0,
    inputTokens: Number(input) || 0,
    outputTokens: Number(output) || 0,
    cachedInputTokens: Number(cached) || 0
  }
}

function tokenCount(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  if (number < 1000) return String(Math.round(number))
  return `${(number / 1000).toFixed(number < 10_000 ? 1 : 0)}K`
}

function UsageLine({ usage }) {
  const values = usageValues(usage)
  if (!values) return null
  const parts = []
  if (values.total != null) parts.push(`${tokenCount(values.total)} tokens`)
  if (values.input != null) parts.push(`in ${tokenCount(values.input)}`)
  if (values.output != null) parts.push(`out ${tokenCount(values.output)}`)
  if (values.cached) parts.push(`cached ${tokenCount(values.cached)}`)
  return <div className="chat-usage">{parts.join(' · ')}</div>
}

function MessageActions({ text }) {
  const [copied, copy] = useCopied()
  return (
    <button
      type="button"
      className="chat-message-copy"
      aria-label="复制消息"
      title={copied ? '已复制' : '复制'}
      onClick={() => copy(text)}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

function latestTodoState(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.kind !== 'tool' || message.tool?.tool !== 'TodoWrite') continue
    if (message.tool.status !== 'completed') continue
    const todos = message.tool.input?.todos
    if (!Array.isArray(todos) || todos.length > 20) continue
    const normalized = []
    let inProgress = 0
    let valid = true
    for (const item of todos) {
      const keys = item && typeof item === 'object' ? Object.keys(item) : []
      const content = typeof item?.content === 'string' ? item.content.trim() : ''
      const activeForm = typeof item?.activeForm === 'string' ? item.activeForm.trim() : ''
      if (
        keys.some((key) => !['content', 'activeForm', 'status'].includes(key)) ||
        !content ||
        !activeForm ||
        content.length > 240 ||
        activeForm.length > 240 ||
        !['pending', 'in_progress', 'completed'].includes(item?.status)
      ) {
        valid = false
        break
      }
      if (item.status === 'in_progress') inProgress += 1
      normalized.push({ content, activeForm, status: item.status })
    }
    if (valid && inProgress <= 1) return { items: normalized, turnId: message.turnId || null }
  }
  return { items: [], turnId: null }
}

export function latestTodoItems(messages) {
  return latestTodoState(messages).items
}

export function todoItemsForTurn(messages, turnId, running) {
  const state = latestTodoState(messages)
  const paused = !running || !state.turnId || state.turnId !== turnId
  return paused
    ? state.items.map((item) =>
        item.status === 'in_progress' ? { ...item, status: 'pending' } : item
      )
    : state.items
}

function TodoDock({ items, hidden }) {
  const completed = items.filter((item) => item.status === 'completed').length
  const allCompleted = items.length > 0 && completed === items.length
  const active = items.some((item) => item.status === 'in_progress')
  const remaining = items.length - completed

  if (!items.length || allCompleted || hidden) return null

  return (
    <section className="chat-task-dock chat-todo-dock" aria-label="当前运行计划">
      <div className="chat-task-summary-row">
        <span className="chat-task-kind">📝(todo)</span>
        <span className={`chat-task-status ${active ? 'chat-task-status-running' : ''}`}>
          {active ? 'running' : 'pending'}
        </span>
        <span className="chat-task-runtime">
          {completed}/{items.length}
        </span>
        <span className="chat-task-description">{remaining} remaining</span>
      </div>
      <div className="chat-task-children thin-scrollbar">
        {items.map((item, index) => (
          <div
            key={`${index}:${item.content}`}
            className={`chat-task-child chat-todo-${item.status}`}
          >
            <span className="chat-task-child-prefix"> ⎿ </span>
            <span className="chat-task-child-marker" aria-hidden="true">
              {item.status === 'completed' ? (
                '✓'
              ) : item.status === 'in_progress' ? (
                <LoaderCircle size={10} className="animate-spin" />
              ) : (
                '○'
              )}
            </span>
            <span className="chat-task-description">
              {item.status === 'in_progress' ? item.activeForm : item.content}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function CommandRow({ message, onCommandAction }) {
  return (
    <div className={`chat-command-result chat-command-${message.variant || 'info'}`}>
      <span className="chat-command-marker" aria-hidden="true">
        ▌
      </span>
      <div className="chat-command-result-body">
        <div className="chat-command-result-title">{message.title}</div>
        {message.detail && <pre>{message.detail}</pre>}
      </div>
      {message.action && (
        <button type="button" onClick={() => onCommandAction?.(message)}>
          {message.action === 'terminal' && <Terminal size={12} />}
          {message.actionLabel || '打开'}
          <ExternalLink size={10} />
        </button>
      )}
    </div>
  )
}

function isActivityMessage(message) {
  return message?.kind === 'reasoning' || message?.kind === 'tool'
}

export function currentTurnActivityMessages(messages, turnId) {
  if (!turnId) return []
  return messages.filter((message) => message.turnId === turnId && isActivityMessage(message))
}

export function activeSubagentMessages(messages, turnId) {
  return currentTurnActivityMessages(messages, turnId).filter(
    (message) =>
      message.kind === 'tool' &&
      message.tool?.tool === 'Agent' &&
      ['pending', 'running'].includes(message.tool.status)
  )
}

function visibleShellOutput(tool, durationMs) {
  if (tool.tool !== 'run_shell' || durationMs <= 10_000 || !tool.output) return []
  return String(tool.output).replace(/\n$/, '').split('\n').slice(-10)
}

function TurnLogItem({ message, now }) {
  if (message.kind === 'reasoning') {
    return <div className="chat-turn-log-thinking">{message.text}</div>
  }

  const tool = message.tool
  if (!tool) return null
  const running = ['pending', 'running'].includes(tool.status)
  const failed = tool.status === 'error'
  const statusClass = running
    ? 'chat-turn-log-running'
    : failed
      ? 'chat-turn-log-error'
      : 'chat-turn-log-complete'
  const durationMs = Math.max(
    0,
    (running ? now : tool.finishedAt || tool.updatedAt || now) -
      (tool.startedAt || tool.updatedAt || now)
  )
  const duration = formatLogElapsed(durationMs)
  const outputLines = visibleShellOutput(tool, durationMs)

  return (
    <div className={`chat-turn-log-tool ${statusClass}`}>
      <div className="chat-turn-log-tool-row">
        {running && (
          <span className="chat-turn-log-spinner" aria-hidden="true">
            <LoaderCircle size={10} className="animate-spin" />
          </span>
        )}
        <span className="chat-turn-log-icon">{TOOL_ICONS[tool.tool] || '⚙'}</span>
        <span className="chat-turn-log-display">
          {toolDisplayName(tool)}
          {toolSummary(tool) ? ` ${toolSummary(tool)}` : ''}
        </span>
        {duration && (
          <span className="chat-turn-log-duration">{running ? duration : `(${duration})`}</span>
        )}
      </div>
      {outputLines.map((line, index) => (
        <div className="chat-turn-log-output" key={`${index}:${line}`}>
          <span> │ </span>
          {line}
        </div>
      ))}
    </div>
  )
}

function savedTurnLogHeight() {
  const value = Number(localStorage.getItem(TURN_LOG_HEIGHT_KEY))
  return Number.isFinite(value) && value >= MIN_TURN_LOG_HEIGHT
    ? Math.min(value, window.innerHeight * MAX_TURN_LOG_HEIGHT_RATIO)
    : null
}

function TurnLogDock({ messages, now = Date.now() }) {
  const scrollRef = useRef(null)
  const [height, setHeight] = useState(savedTurnLogHeight)
  const stickToBottomRef = useRef(true)

  // 只有用户停留在底部时才跟随滚动，手动上翻后不打扰。
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (scroll && stickToBottomRef.current) scroll.scrollTop = scroll.scrollHeight
  }, [messages, height])

  const startResize = useCallback((event, direction) => {
    if (event.button !== 0) return
    event.preventDefault()
    document.body.classList.add('is-resizing-terminal')
    const startY = event.clientY
    const startHeight = scrollRef.current?.getBoundingClientRect().height || 0
    const onMove = (moveEvent) => {
      const delta = direction === 'top' ? startY - moveEvent.clientY : moveEvent.clientY - startY
      const next = Math.round(
        Math.min(
          window.innerHeight * MAX_TURN_LOG_HEIGHT_RATIO,
          Math.max(MIN_TURN_LOG_HEIGHT, startHeight + delta)
        )
      )
      setHeight(next)
      localStorage.setItem(TURN_LOG_HEIGHT_KEY, String(next))
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.classList.remove('is-resizing-terminal')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }, [])

  if (!messages.length) return null

  return (
    <section className="chat-turn-log" aria-label="当前回合的思考与工具日志">
      <div
        className="chat-turn-log-resizer chat-turn-log-resizer-top"
        onPointerDown={(event) => startResize(event, 'top')}
        title="拖动调整日志高度"
      />
      <div
        ref={scrollRef}
        className="chat-turn-log-scroll thin-scrollbar"
        style={height != null ? { height, maxHeight: 'none' } : undefined}
        onScroll={(event) => {
          const element = event.currentTarget
          stickToBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            SCROLL_BOTTOM_THRESHOLD
        }}
      >
        {messages.map((message) => (
          <TurnLogItem key={message.id} message={message} now={now} />
        ))}
      </div>
      <div
        className="chat-turn-log-resizer"
        onPointerDown={(event) => startResize(event, 'bottom')}
        title="拖动调整日志高度"
      />
    </section>
  )
}

function ChatContextMenu({ menu, onAction, onClose, commitRunning = false }) {
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
  const items = [
    {
      id: 'compact-local',
      label: '快速压缩（本地）',
      title: '只清理工具结果、图片和文档，不调用模型',
      icon: Zap,
      disabled: !menu.hasSession || menu.running
    },
    {
      id: 'compact-model',
      label: '模型压缩',
      title: '调用模型生成会话摘要',
      icon: Minimize2,
      disabled: !menu.hasSession || menu.running
    },
    {
      id: 'commit',
      label: 'Commit',
      icon: GitCommitHorizontal,
      disabled: menu.running || commitRunning,
      title: commitRunning ? 'commit 任务正在执行' : undefined
    },
    { id: 'fork', label: 'Fork', icon: GitFork, disabled: !menu.hasSession || menu.running },
    { separator: true },
    { id: 'clear', label: 'Clear', icon: Trash2, disabled: menu.running, danger: true }
  ]
  return (
    <div
      className="fixed z-[10000] min-w-40 rounded-md border border-white/15 bg-[#181818]/98 p-1.5 text-xs shadow-2xl backdrop-blur"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      data-no-chat-focus
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
            disabled={item.disabled}
            title={item.title}
            className={`flex h-7 w-full items-center gap-2 rounded px-2 text-left enabled:hover:bg-white/[.08] disabled:opacity-35 ${item.danger ? 'text-[#ef7288]' : 'text-white/75 enabled:hover:text-white'}`}
            onClick={() => onAction(item.id)}
          >
            <item.icon size={14} className="shrink-0 opacity-75" />
            {item.label}
          </button>
        )
      )}
    </div>
  )
}

function SelectPalette({
  paletteRef,
  title,
  options,
  activeIndex,
  onActiveIndex,
  onSelect,
  selectedValue,
  loading,
  error
}) {
  return (
    <div
      ref={paletteRef}
      className="chat-command-palette chat-select-palette"
      role="listbox"
      aria-label={title}
    >
      <div className="chat-command-palette-title">
        <Command size={12} /> {title}
        <span>↑↓ 选择 · Enter 确认 · Esc 关闭</span>
      </div>
      {loading && <div className="chat-select-empty">正在加载…</div>}
      {!loading && error && <div className="chat-select-empty chat-select-error">{error}</div>}
      {!loading &&
        !error &&
        options.map((option, index) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={index === activeIndex ? 'chat-command-active' : ''}
            onMouseEnter={() => onActiveIndex(index)}
            onClick={() => onSelect(option)}
          >
            <span className="chat-select-check">{option.value === selectedValue ? '✓' : ''}</span>
            <span className="chat-select-label">{option.label ?? option.value}</span>
            {option.detail && <span className="chat-select-detail">{option.detail}</span>}
          </button>
        ))}
    </div>
  )
}

function useClickOutside(ref, active, onClose) {
  useEffect(() => {
    if (!active) return undefined
    const onPointerDown = (event) => {
      if (event.target.closest?.('[data-chat-picker-trigger]')) return
      if (!ref.current?.contains(event.target)) onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [active, onClose, ref])
}

export function shortPath(path, max = 46) {
  if (!path) return ''
  const value = String(path)
  if (value.length <= max) return value
  const parts = value.split(/[\\/]/).filter(Boolean)
  let head = ''
  let tail = ''
  if (value.startsWith('/')) head = '/'
  else if (/^[a-zA-Z]:[\\/]/.test(value)) head = value.slice(0, 3)
  const budget = max - head.length - 3
  for (const part of parts) {
    if (tail.length + part.length + 1 <= budget) tail = tail ? `${tail}/${part}` : part
    else break
  }
  return `${head}…/${tail}`.slice(0, max)
}

function MessageRow({ message, onOpenFile, onPreviewImage, onCommandAction }) {
  if (message.kind === 'command') {
    return <CommandRow message={message} onCommandAction={onCommandAction} />
  }
  if (message.kind === 'notice') {
    const title =
      message.variant === 'compact' ? '/compact' : message.variant === 'error' ? '/error' : ''
    const noticeLines = String(message.text || '').split('\n')
    return (
      <div className={`chat-notice chat-notice-${message.variant || 'info'}`}>
        <span>▌</span>
        <div className="chat-notice-body">
          {title && (
            <span className="chat-notice-title">
              {title}
              {message.status ? ` ${message.status}` : ''}{' '}
            </span>
          )}
          {message.variant === 'compact' && noticeLines.length > 1 ? (
            <>
              <span className="chat-notice-summary">{noticeLines[0]}</span>
              <span className="chat-notice-text">{noticeLines.slice(1).join('\n')}</span>
            </>
          ) : (
            <span className="chat-notice-text">{message.text}</span>
          )}
        </div>
      </div>
    )
  }
  if (message.kind === 'tool') {
    return null
  }
  if (message.kind === 'reasoning') {
    return null
  }
  if (message.role === 'user') {
    return (
      <div
        className={`chat-message chat-message-user ${message.queued ? 'chat-message-queued' : ''}`}
      >
        <div className="chat-message-marker">{message.queued ? '↳' : '▌'}</div>
        <div className="chat-message-body whitespace-pre-wrap break-words">{message.text}</div>
        <MessageActions text={message.text} />
      </div>
    )
  }
  return (
    <div
      className={`chat-message chat-message-assistant ${message.done ? '' : 'chat-message-active'}`}
    >
      <div className="chat-message-marker">●</div>
      <div className="chat-message-body">
        <Markdown
          text={message.text || ''}
          onOpenFile={onOpenFile}
          onPreviewImage={onPreviewImage}
        />
        <UsageLine usage={message.usage} />
      </div>
      {message.done && <MessageActions text={message.text} />}
    </div>
  )
}

function WelcomeHint({ cwd }) {
  return (
    <div className="chat-welcome">
      <div className="chat-welcome-command">
        <span>❯</span> mica
      </div>
      <p>输入任务开始对话。Mica 会直接在当前工作区读取代码、调用工具并持续汇报进度。</p>
      {cwd && <code>{cwd}</code>}
    </div>
  )
}

function statusLabel(phase, toolNames = []) {
  switch (phase) {
    case 'connecting':
      return 'waiting_model'
    case 'thinking':
      return 'thinking'
    case 'streaming':
      return 'streaming'
    case 'working':
      return toolNames.length ? toolNames.join(', ') : 'calling_tool'
    case 'stopping':
      return 'stopping'
    default:
      return 'waiting_model'
  }
}

function modelSummary(meta) {
  if (!meta) return ''
  const model = meta.model || meta.providerId || ''
  const effort = meta.effort && meta.effort !== 'none' ? `_${meta.effort}` : ''
  return `${model}${effort}`
}

function modelSummaryTitle(meta) {
  if (!meta) return ''
  const usage = usageValues(meta.lastUsage)
  const context = usage?.total != null ? tokenCount(usage.total) : ''
  const cached = meta.cachedRate > 0 ? `cached ${Math.round(meta.cachedRate * 100)}%` : ''
  const contextPercent =
    usage?.total != null && meta.contextWindowSize
      ? `ctx ${Math.round((usage.total / meta.contextWindowSize) * 100)}%`
      : ''
  return [
    modelSummary(meta),
    context,
    cached || contextPercent ? `(${[cached, contextPercent].filter(Boolean).join(', ')})` : ''
  ]
    .filter(Boolean)
    .join(' ')
}

function eventKey(event) {
  try {
    return JSON.stringify(event)
  } catch {
    return `${event?.type}:${event?.timestamp}`
  }
}

export function mergeReplayEvents(buffered = [], pending = []) {
  const events = []
  const seen = new Set()
  let lastSequence = 0
  for (const record of buffered) {
    const event = record?.event || record
    const sequence = Number(record?.sequence) || 0
    if (sequence) lastSequence = Math.max(lastSequence, sequence)
    else seen.add(eventKey(event))
    events.push(event)
  }
  for (const record of pending) {
    const event = record?.event || record
    const sequence = Number(record?.sequence) || 0
    if (sequence ? sequence > lastSequence : !seen.has(eventKey(event))) events.push(event)
  }
  return events
}

function historyMessages(rows, key) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => ({
    id: `history-${key}-${index}`,
    kind: row.role === 'notice' ? 'notice' : 'message',
    role: row.role,
    text: row.text || '',
    usage: row.usage ?? null,
    done: true,
    variant: row.role === 'notice' ? 'info' : undefined
  }))
}

export function hasPersistedTurn(messages, prompt) {
  if (!prompt) return false
  const userIndex = messages.findLastIndex(
    (message) => message.role === 'user' && message.text === prompt
  )
  return (
    userIndex >= 0 &&
    messages.slice(userIndex + 1).some((message) => message.role === 'assistant' && message.text)
  )
}

export function historyBeforeRunReplay(messages, prompt) {
  if (!prompt) return messages
  const userIndex = messages.findLastIndex(
    (message) => message.role === 'user' && message.text === prompt
  )
  return userIndex >= 0 ? messages.slice(0, userIndex + 1) : messages
}

export function isPersistedRunComplete(meta, startedAt) {
  if (!meta?.turnState || meta.turnState === 'running' || !startedAt) return false
  const updatedAt = Date.parse(meta.updatedAt || '')
  return Number.isFinite(updatedAt) && updatedAt > startedAt
}

function persistedTranscript(messages) {
  const result = []
  for (const message of messages) {
    if (message.kind !== 'message' && message.kind !== 'notice') continue
    const role = message.role
    const text = message.text || ''
    const previous = result.at(-1)
    if (previous?.role === role && role === 'assistant') previous.text += text
    else result.push({ role, text })
  }
  return result
}

export function canReuseVisualTranscript(cached, persisted) {
  return (
    JSON.stringify(persistedTranscript(cached)) === JSON.stringify(persistedTranscript(persisted))
  )
}

export function ChatView({
  node,
  cwd,
  visible,
  onSessionBound,
  onOpenFile,
  onNewSession,
  onResumeSession,
  onOpenTerminal,
  onSessionRenamed
}) {
  const nodeId = node?.id || null
  const nodeIdRef = useLatest(nodeId)
  const cwdRef = useLatest(cwd)
  const onSessionBoundRef = useLatest(onSessionBound)
  const onOpenFileRef = useLatest(onOpenFile)
  const onNewSessionRef = useLatest(onNewSession)
  const onResumeSessionRef = useLatest(onResumeSession)
  const onOpenTerminalRef = useLatest(onOpenTerminal)
  const onSessionRenamedRef = useLatest(onSessionRenamed)
  const sessionIdRef = useRef(node?.sessionId || null)
  const streamRef = useRef({ id: null, kind: null, turnId: null })
  const turnRef = useRef(null)
  const finishedRef = useRef(true)
  const restoringRef = useRef(false)
  const restoreGenerationRef = useRef(0)
  const pendingEventsRef = useRef([])
  const pendingExitRef = useRef(null)
  const loadedNodeRef = useRef(null)
  const transcriptCacheRef = useRef(new Map())
  const draftsRef = useRef(new Map())
  const todoHiddenRef = useRef(new Map())
  const inputHistoryRef = useRef(new Map())
  const queuedMessageIdsRef = useRef([])
  const recallingQueueRef = useRef(null)
  const historyCursorRef = useRef(-1)
  const stickToBottomRef = useRef(true)

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [inputFocused, setInputFocused] = useState(false)
  const [terminalCursor, setTerminalCursor] = useState(null)
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())
  const [running, setRunning] = useState(false)
  const [queuedCount, setQueuedCount] = useState(0)
  const [queuedItems, setQueuedItems] = useState([])
  const [recallingQueueId, setRecallingQueueId] = useState(null)
  const [stopping, setStopping] = useState(false)
  const [phase, setPhase] = useState('idle')
  const [runStartedAt, setRunStartedAt] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const [meta, setMeta] = useState(null)
  const [todoHidden, setTodoHidden] = useState(false)
  const overridesRef = useRef(new Map()) // nodeId -> { model, variant, role }
  const forceRender = useReducer((version) => version + 1, 0)[1]
  const [picker, setPicker] = useState(null) // { kind, title, options, loading, error }
  const [pickerIndex, setPickerIndex] = useState(0)
  const [contextMenu, setContextMenu] = useState(null)
  const [imagePreview, setImagePreview] = useState(null)
  const [commitRunning, setCommitRunning] = useState(false)
  const commitTaskRef = useRef(null) // { id, noticeId, cwd, nodeId }
  const commitNoticeTextRef = useRef('')
  const pickerRef = useRef(null)
  const messagesRef = useRef([])
  const modelProtocolsRef = useRef(null) // { map: { [modelId]: { protocol, efforts } }, currentProtocol }
  const protocolBlockRef = useRef('')
  const compactBusyRef = useRef(false)
  const listRef = useRef(null)
  const transcriptRef = useRef(null)
  const composerDockRef = useRef(null)
  const textareaRef = useRef(null)
  const cursorFrameRef = useRef(0)
  const cursorMeasureRef = useRef({ signature: null, position: null })
  const cursorActiveTimerRef = useRef(null)
  const [cursorActive, setCursorActive] = useState(false)

  const updateMessages = useCallback((update) => {
    const next = typeof update === 'function' ? update(messagesRef.current) : update
    messagesRef.current = next
    setMessages(next)
  }, [])

  useEffect(() => {
    sessionIdRef.current = node?.sessionId || null
  }, [node?.sessionId])

  const finishStream = useCallback(
    (finishedAt = Date.now()) => {
      const activeId = streamRef.current.id
      if (!activeId) return
      updateMessages((previous) =>
        previous.map((message) =>
          message.id === activeId ? { ...message, done: true, finishedAt } : message
        )
      )
      streamRef.current = { id: null, kind: null, turnId: streamRef.current.turnId }
    },
    [updateMessages]
  )

  const finishPendingTools = useCallback(
    (status, timestamp = Date.now()) => {
      updateMessages((previous) =>
        previous.map((message) => {
          if (message.kind !== 'tool' || !['pending', 'running'].includes(message.tool.status)) {
            return message
          }
          return {
            ...message,
            tool: {
              ...message.tool,
              status,
              updatedAt: timestamp,
              finishedAt: timestamp,
              output:
                message.tool.output ||
                (status === 'aborted'
                  ? '工具执行随当前 turn 一起停止。'
                  : '工具调用结束前未收到结果。')
            }
          }
        })
      )
    },
    [updateMessages]
  )

  const appendPart = useCallback(
    (kind, text, timestamp = Date.now()) => {
      if (!text) return
      updateMessages((previous) => {
        const active = streamRef.current
        if (active.id && active.kind === kind) {
          return previous.map((message) =>
            message.id === active.id
              ? { ...message, text: `${message.text}${text}`, updatedAt: timestamp }
              : message
          )
        }

        const finalized = active.id
          ? previous.map((message) =>
              message.id === active.id ? { ...message, done: true, finishedAt: timestamp } : message
            )
          : previous
        const id = uid(kind === 'reasoning' ? 'thought' : 'msg')
        streamRef.current = { id, kind, turnId: turnRef.current }
        return [
          ...finalized,
          {
            id,
            kind: kind === 'reasoning' ? 'reasoning' : 'message',
            role: 'assistant',
            text,
            done: false,
            turnId: turnRef.current,
            startedAt: timestamp,
            updatedAt: timestamp
          }
        ]
      })
    },
    [updateMessages]
  )

  const appendNotice = useCallback(
    (text, variant = 'info', status = '') => {
      if (!text) return null
      const id = uid('notice')
      updateMessages((previous) => [
        ...previous,
        { id, kind: 'notice', role: 'notice', text, variant, status }
      ])
      return id
    },
    [updateMessages]
  )

  const updateNotice = useCallback(
    (id, text, variant = 'info', status = '') => {
      if (!id || !text) return
      updateMessages((previous) =>
        previous.map((message) =>
          message.id === id ? { ...message, text, variant, status } : message
        )
      )
    },
    [updateMessages]
  )

  const refreshMeta = useCallback(
    (sessionId = sessionIdRef.current, options = {}) => {
      if (!sessionId) return
      const targetNodeId = nodeIdRef.current
      window.mica.chat
        .meta(sessionId)
        .then((value) => {
          if (value && nodeIdRef.current === targetNodeId && sessionIdRef.current === sessionId) {
            setMeta((previous) => {
              const hasFreshUsage = Boolean(value.lastUsage)
              // 快速压缩会保留会话快照里的 lastUsage（供 Stats 对账），磁盘上的
              // 值仍是压缩前的上下文占用。keepLiveUsage 让压缩结果继续显示在
              // 输入框右下角，直到下一次真实 turn 的用量事件刷新它。
              const keepLiveUsage = options.keepLiveUsage === true
              return {
                ...value,
                contextWindowSize: keepLiveUsage
                  ? previous?.contextWindowSize || value.contextWindowSize || null
                  : value.contextWindowSize || previous?.contextWindowSize || null,
                lastUsage: keepLiveUsage
                  ? previous?.lastUsage || value.lastUsage || null
                  : value.lastUsage || previous?.lastUsage || null,
                cachedRate: hasFreshUsage ? value.cachedRate || 0 : previous?.cachedRate || 0
              }
            })
          }
        })
        .catch(() => {})
    },
    [nodeIdRef]
  )

  const refreshMetaSoon = useCallback(
    (sessionId = sessionIdRef.current, options) => {
      if (!sessionId) return
      refreshMeta(sessionId, options)
      for (const delay of [250, 1000, 2500]) {
        window.setTimeout(() => refreshMeta(sessionId, options), delay)
      }
    },
    [refreshMeta]
  )

  const applyLiveUsageMeta = useCallback((tokens) => {
    const usage = metaUsageFromStepTokens(tokens)
    if (!usage) return
    setMeta((previous) => {
      const cachedRate =
        usage.inputTokens > 0
          ? usage.cachedInputTokens / usage.inputTokens
          : previous?.cachedRate || 0
      return {
        ...(previous || {}),
        lastUsage: usage,
        cachedRate,
        turnState: 'completed',
        updatedAt: new Date().toISOString()
      }
    })
  }, [])

  const applyCompactMeta = useCallback((result) => {
    const totalTokens = Number(result?.afterTokenEstimate) || 0
    if (totalTokens <= 0 && !result?.contextWindowSize) return
    setMeta((previous) => ({
      ...(previous || {}),
      contextWindowSize: Number(result?.contextWindowSize) || previous?.contextWindowSize || null,
      lastUsage:
        totalTokens > 0
          ? {
              totalTokens,
              inputTokens: totalTokens,
              outputTokens: 0,
              cachedInputTokens: 0
            }
          : previous?.lastUsage || null,
      cachedRate: previous?.cachedRate || 0,
      turnState: 'completed',
      updatedAt: new Date().toISOString()
    }))
  }, [])

  const applyEvent = useCallback(
    (event) => {
      if (!event) return
      const timestamp = Number(event.timestamp) || Date.now()
      switch (event.type) {
        case 'step_start': {
          const queuedMessageId = queuedMessageIdsRef.current.shift()
          if (queuedMessageId) {
            updateMessages((previous) =>
              previous.map((message) =>
                message.id === queuedMessageId ? { ...message, queued: false } : message
              )
            )
          }
          if (event.sessionID && !sessionIdRef.current) {
            sessionIdRef.current = event.sessionID
            onSessionBoundRef.current?.(nodeIdRef.current, event.sessionID)
          }
          turnRef.current = `${event.sessionID || nodeIdRef.current}:${timestamp}`
          streamRef.current = { id: null, kind: null, turnId: turnRef.current }
          finishedRef.current = false
          setRunning(true)
          setStopping(false)
          setPhase('connecting')
          setRunStartedAt((current) => current || timestamp)
          break
        }
        case 'reasoning':
          setPhase('thinking')
          appendPart('reasoning', event.part?.text || '', timestamp)
          break
        case 'text':
          setPhase('streaming')
          appendPart('text', event.part?.text || '', timestamp)
          break
        case 'tool_use': {
          finishStream(timestamp)
          const part = event.part
          if (!part?.tool) break
          const callID = part.callID || uid('tool-call')
          const tool = {
            tool: part.tool,
            callID,
            status: part.state?.status || 'completed',
            input: part.state?.input ?? {},
            output: part.state?.output ?? part.state?.error ?? '',
            startedAt: timestamp,
            updatedAt: timestamp,
            ...((part.state?.status || 'completed') === 'pending' ? {} : { finishedAt: timestamp })
          }
          updateMessages((previous) => {
            const existing = previous.findIndex(
              (message) => message.kind === 'tool' && message.tool.callID === callID
            )
            if (existing < 0) {
              return [
                ...previous,
                { id: uid('tool'), kind: 'tool', role: 'tool', tool, turnId: turnRef.current }
              ]
            }
            return previous.map((message, index) => {
              if (index !== existing) return message
              return {
                ...message,
                tool: {
                  ...message.tool,
                  ...tool,
                  startedAt: message.tool.startedAt || timestamp,
                  updatedAt: timestamp
                }
              }
            })
          })
          setPhase('working')
          break
        }
        case 'error':
          finishStream(timestamp)
          appendNotice(event.error?.data?.message || event.error?.name || '运行出错', 'error')
          setPhase('error')
          break
        case 'step_finish': {
          finishStream(timestamp)
          finishPendingTools(event.part?.reason === 'aborted' ? 'aborted' : 'error', timestamp)
          const usage = event.part?.tokens
          if (usage) {
            applyLiveUsageMeta(usage)
            const turnId = turnRef.current
            updateMessages((previous) => {
              const index = previous.findLastIndex(
                (message) =>
                  message.kind === 'message' &&
                  message.role === 'assistant' &&
                  (!turnId || message.turnId === turnId)
              )
              if (index < 0) return previous
              return previous.map((message, messageIndex) =>
                messageIndex === index
                  ? {
                      ...message,
                      usage: {
                        total: usage.total,
                        input: usage.input,
                        output: usage.output,
                        cacheRead: usage.cache?.read
                      }
                    }
                  : message
              )
            })
          }
          finishedRef.current = true
          setRunning(false)
          setStopping(false)
          setPhase(event.part?.reason === 'error' ? 'error' : 'idle')
          if (event.sessionID) refreshMetaSoon(event.sessionID)
          break
        }
      }
    },
    [
      appendNotice,
      appendPart,
      finishPendingTools,
      finishStream,
      nodeIdRef,
      onSessionBoundRef,
      applyLiveUsageMeta,
      refreshMetaSoon,
      updateMessages
    ]
  )
  const applyEventRef = useLatest(applyEvent)

  const processExit = useCallback(
    (payload) => {
      finishStream()
      finishPendingTools(payload?.aborted ? 'aborted' : 'error')
      if (!finishedRef.current && payload?.error) {
        const message = compactLine(payload.error, 1000)
        appendNotice(message || 'mica 进程异常退出', 'error')
      }
      if (!finishedRef.current && payload?.exitCode && !payload?.error) {
        appendNotice(`mica 进程已退出（code ${payload.exitCode}）`, 'error')
      }
      finishedRef.current = true
      setRunning(false)
      setQueuedCount(Number(payload?.queuedCount) || 0)
      setStopping(false)
      setPhase('idle')
      if (payload?.sessionId) {
        refreshMetaSoon(payload.sessionId)
      }
    },
    [appendNotice, finishPendingTools, finishStream, refreshMetaSoon]
  )
  const processExitRef = useLatest(processExit)

  useEffect(() => {
    if (!nodeId) return undefined
    const offEvent = window.mica.chat.onEvent(({ id, sequence, event }) => {
      if (id !== nodeIdRef.current) return
      if (restoringRef.current) pendingEventsRef.current.push({ sequence, event })
      else applyEventRef.current(event)
    })
    const offExit = window.mica.chat.onExit((payload) => {
      if (payload.id !== nodeIdRef.current) return
      if (restoringRef.current) pendingExitRef.current = payload
      else processExitRef.current(payload)
    })
    const offQueueState = window.mica.chat.onQueueState((payload) => {
      if (payload.id !== nodeIdRef.current) return
      setQueuedCount(Number(payload.queuedCount) || 0)
      setQueuedItems(Array.isArray(payload.queuedItems) ? payload.queuedItems : [])
    })
    const offQueueError = window.mica.chat.onQueueError((payload) => {
      if (payload.id !== nodeIdRef.current) return
      appendNotice(`排队消息发送失败：${payload.error || '未知错误'}`, 'error')
    })
    return () => {
      offEvent?.()
      offExit?.()
      offQueueState?.()
      offQueueError?.()
    }
  }, [appendNotice, applyEventRef, nodeId, nodeIdRef, processExitRef])

  useEffect(() => {
    if (!nodeId) return undefined
    const previousNodeId = loadedNodeRef.current
    if (previousNodeId && previousNodeId !== nodeId && messagesRef.current.length > 0) {
      transcriptCacheRef.current.set(previousNodeId, messagesRef.current)
    }
    loadedNodeRef.current = nodeId
    const cachedTranscript = transcriptCacheRef.current.get(nodeId)
    const generation = ++restoreGenerationRef.current
    restoringRef.current = true
    pendingEventsRef.current = []
    pendingExitRef.current = null
    stickToBottomRef.current = true
    setShowJump(false)
    updateMessages([])
    setInput(draftsRef.current.get(nodeId) || '')
    setTodoHidden(todoHiddenRef.current.get(nodeId) === true)
    setPicker(null)
    setPickerIndex(0)
    queuedMessageIdsRef.current = []
    recallingQueueRef.current = null
    setRunning(false)
    setQueuedCount(0)
    setQueuedItems([])
    setRecallingQueueId(null)
    setStopping(false)
    setPhase('idle')
    setRunStartedAt(0)
    setMeta(null)
    setHistoryLoaded(false)
    streamRef.current = { id: null, kind: null, turnId: null }
    turnRef.current = null
    finishedRef.current = true
    historyCursorRef.current = -1
    const sessionId = sessionIdRef.current

    const restoreFinalSession = async (finalSessionId, fallbackRows) => {
      if (!sessionIdRef.current) {
        sessionIdRef.current = finalSessionId
        onSessionBoundRef.current?.(nodeId, finalSessionId)
      }
      const [finalRows, finalMeta] = await Promise.all([
        window.mica.chat.history(finalSessionId).catch(() => fallbackRows),
        window.mica.chat.meta(finalSessionId).catch(() => null)
      ])
      if (generation !== restoreGenerationRef.current || nodeIdRef.current !== nodeId) return false
      const finalMessages = historyMessages(finalRows, finalSessionId)
      const liveTranscript = messagesRef.current
      updateMessages(
        canReuseVisualTranscript(liveTranscript, finalMessages)
          ? liveTranscript
          : cachedTranscript && canReuseVisualTranscript(cachedTranscript, finalMessages)
            ? cachedTranscript
            : finalMessages
      )
      if (finalMeta) setMeta(finalMeta)
      setHistoryLoaded(true)
      setRunning(false)
      setQueuedCount(0)
      setQueuedItems([])
      setStopping(false)
      setPhase('idle')
      finishedRef.current = true
      pendingEventsRef.current = []
      restoringRef.current = false
      if (pendingExitRef.current) {
        processExitRef.current(pendingExitRef.current)
        pendingExitRef.current = null
      }
      return true
    }

    const restore = async () => {
      const [rows, sessionMeta] = await Promise.all([
        sessionId ? window.mica.chat.history(sessionId).catch(() => []) : [],
        sessionId
          ? window.mica.chat.meta(sessionId).catch(() => null)
          : window.mica.chat.meta(null, cwd).catch(() => null)
      ])
      if (generation !== restoreGenerationRef.current || nodeIdRef.current !== nodeId) return
      const restored = historyMessages(rows, sessionId || nodeId)
      updateMessages(restored)
      setMeta(sessionMeta)
      setHistoryLoaded(true)

      const state = await window.mica.chat.isRunning(nodeId).catch(() => null)
      if (generation !== restoreGenerationRef.current || nodeIdRef.current !== nodeId) return
      setQueuedCount(Number(state?.queuedCount) || 0)
      setQueuedItems(Array.isArray(state?.queuedItems) ? state.queuedItems : [])
      const stateSessionId = state?.sessionId || sessionIdRef.current
      if (state?.running && stateSessionId && hasPersistedTurn(restored, state.prompt)) {
        const latestMeta = await window.mica.chat.meta(stateSessionId).catch(() => null)
        if (generation !== restoreGenerationRef.current || nodeIdRef.current !== nodeId) return
        if (isPersistedRunComplete(latestMeta, state.startedAt)) {
          updateMessages(historyBeforeRunReplay(restored, state.prompt))
          for (const event of mergeReplayEvents(state.events, pendingEventsRef.current)) {
            applyEventRef.current(event)
          }
          pendingEventsRef.current = []
          await restoreFinalSession(stateSessionId, rows)
          return
        }
      }
      const pendingFinished = pendingEventsRef.current.some(
        (record) => (record?.event || record)?.type === 'step_finish'
      )
      const pendingSessionId = pendingEventsRef.current.find(
        (record) => (record?.event || record)?.sessionID
      )?.event?.sessionID
      if (state?.finished && Array.isArray(state.events) && state.events.length > 0) {
        const replay = mergeReplayEvents(state.events, pendingEventsRef.current)
        const replayFinished = replay.some((event) => event?.type === 'step_finish')
        updateMessages(historyBeforeRunReplay(restored, state.prompt))
        for (const event of replay) applyEventRef.current(event)
        if (!replayFinished) {
          finishPendingTools(state.exit?.aborted ? 'aborted' : 'error')
        }
        pendingEventsRef.current = []
        const finalSessionId = state.sessionId || sessionIdRef.current || pendingSessionId
        if (finalSessionId) await restoreFinalSession(finalSessionId, rows)
        else {
          restoringRef.current = false
          setRunning(false)
          finishedRef.current = true
        }
        if (!replayFinished && state.exit?.error) {
          appendNotice(compactLine(state.exit.error, 1000), 'error')
        }
        return
      }
      if (
        !state?.running &&
        pendingFinished &&
        (state?.sessionId || sessionIdRef.current || pendingSessionId)
      ) {
        const finalSessionId = state?.sessionId || sessionIdRef.current || pendingSessionId
        for (const event of mergeReplayEvents(state?.events, pendingEventsRef.current)) {
          applyEventRef.current(event)
        }
        pendingEventsRef.current = []
        await restoreFinalSession(finalSessionId, rows)
        return
      }
      if (state?.running) {
        if (state.sessionId && !sessionIdRef.current) {
          sessionIdRef.current = state.sessionId
          onSessionBoundRef.current?.(nodeId, state.sessionId)
        }
        if (state.prompt && restored.at(-1)?.text !== state.prompt) {
          updateMessages((previous) => [
            ...previous,
            { id: uid('msg'), kind: 'message', role: 'user', text: state.prompt, done: true }
          ])
        }
        setRunStartedAt(state.startedAt || Date.now())
        setRunning(true)
        finishedRef.current = false
      } else if (cachedTranscript && canReuseVisualTranscript(cachedTranscript, restored)) {
        updateMessages(cachedTranscript)
      }

      for (const event of mergeReplayEvents(state?.events, pendingEventsRef.current)) {
        applyEventRef.current(event)
      }
      pendingEventsRef.current = []
      restoringRef.current = false
      if (pendingExitRef.current) {
        processExitRef.current(pendingExitRef.current)
        pendingExitRef.current = null
      }
    }
    void restore()
    return undefined
  }, [
    appendNotice,
    applyEventRef,
    finishPendingTools,
    nodeId,
    nodeIdRef,
    cwd,
    onSessionBoundRef,
    processExitRef,
    updateMessages
  ])

  useEffect(() => {
    if (!running || !runStartedAt) {
      setElapsed(0)
      return undefined
    }
    const update = () => setElapsed(Math.max(0, Date.now() - runStartedAt))
    update()
    const timer = window.setInterval(update, 250)
    return () => clearInterval(timer)
  }, [runStartedAt, running])

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return undefined
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
    return undefined
  }, [messages, running, historyLoaded])

  useEffect(() => {
    const transcript = transcriptRef.current
    const composerDock = composerDockRef.current
    if ((!transcript && !composerDock) || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return
      const list = listRef.current
      if (list) list.scrollTop = list.scrollHeight
    })
    if (transcript) observer.observe(transcript)
    if (composerDock) observer.observe(composerDock)
    return () => observer.disconnect()
  }, [nodeId])

  useEffect(() => {
    if (!visible || !nodeId || !historyLoaded) return
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 40)
    return () => clearTimeout(timer)
  }, [historyLoaded, nodeId, visible])

  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current
    if (!element || SUPPORTS_FIELD_SIZING) return
    // Chromium 117+ 的 field-sizing: content 让 textarea 高度自动跟随内容，
    // 无需 JS 逐键测量（style.height='auto' + scrollHeight 读取会强制整页
    // 布局，模型流式渲染时表现为输入抖动）。旧内核才走这里。
    element.style.height = 'auto'
    element.style.height = `${Math.max(30, Math.min(element.scrollHeight, MAX_INPUT_ROWS * 22))}px`
  }, [])

  useEffect(() => resizeTextarea(), [input, resizeTextarea])

  const updateTerminalCursor = useCallback(() => {
    cursorFrameRef.current = 0
    const element = textareaRef.current
    if (!element) {
      cursorMeasureRef.current = { signature: null, position: null }
      setTerminalCursor(null)
      return
    }
    const selectionStart = element.selectionStart ?? element.value.length
    const selectionEnd = element.selectionEnd ?? element.value.length
    const signature = [
      element.value,
      selectionStart,
      selectionEnd,
      element.scrollLeft,
      element.scrollTop,
      element.clientWidth
    ]
    const previous = cursorMeasureRef.current
    if (
      previous.signature &&
      previous.signature.length === signature.length &&
      previous.signature.every((value, index) => value === signature[index])
    ) {
      return
    }
    const next = measureTextareaCursor(element, element.value, selectionStart, selectionEnd)
    cursorMeasureRef.current = { signature, position: next }
    const last = previous.position
    if (
      last &&
      next &&
      last.left === next.left &&
      last.top === next.top &&
      last.width === next.width &&
      last.height === next.height
    ) {
      return
    }
    if (!last && !next) return
    setTerminalCursor(next)
  }, [])

  const markCursorActive = useCallback(() => {
    setCursorActive(true)
    if (cursorActiveTimerRef.current) clearTimeout(cursorActiveTimerRef.current)
    cursorActiveTimerRef.current = setTimeout(
      () => setCursorActive(false),
      CURSOR_ACTIVE_DURATION_MS
    )
  }, [])

  const scheduleTerminalCursorUpdate = useCallback(() => {
    markCursorActive()
    if (cursorFrameRef.current) return
    cursorFrameRef.current = requestAnimationFrame(updateTerminalCursor)
  }, [markCursorActive, updateTerminalCursor])

  useLayoutEffect(() => {
    resizeTextarea()
    // 光标测量涉及 DOM 写+读（layout thrash），移到 rAF 异步执行，
    // 避免每次按键在 layout 阶段同步强制整页重排（模型流式渲染时表现为抖动）。
    scheduleTerminalCursorUpdate()
  }, [input, resizeTextarea, scheduleTerminalCursorUpdate])

  useEffect(() => {
    window.addEventListener('resize', scheduleTerminalCursorUpdate)
    return () => window.removeEventListener('resize', scheduleTerminalCursorUpdate)
  }, [scheduleTerminalCursorUpdate])

  useEffect(() => {
    if (!inputFocused) return undefined
    document.addEventListener('selectionchange', scheduleTerminalCursorUpdate)
    return () => document.removeEventListener('selectionchange', scheduleTerminalCursorUpdate)
  }, [inputFocused, scheduleTerminalCursorUpdate])

  useEffect(() => {
    const onWindowFocus = () => setWindowFocused(true)
    const onWindowBlur = () => setWindowFocused(false)
    window.addEventListener('focus', onWindowFocus)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      window.removeEventListener('focus', onWindowFocus)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [])

  useEffect(
    () => () => {
      if (cursorFrameRef.current) cancelAnimationFrame(cursorFrameRef.current)
      if (cursorActiveTimerRef.current) clearTimeout(cursorActiveTimerRef.current)
    },
    []
  )

  const rememberInput = useCallback(
    (text) => {
      const history = inputHistoryRef.current.get(nodeId) || []
      inputHistoryRef.current.set(
        nodeId,
        [...history.filter((item) => item !== text), text].slice(-100)
      )
      historyCursorRef.current = -1
      draftsRef.current.set(nodeId, '')
      setInput('')
    },
    [nodeId]
  )

  const applyOverride = useCallback(
    (kind, value) => {
      const current = overridesRef.current.get(nodeId) || {}
      const next = { ...current }
      if (kind === 'model') next.model = value || undefined
      else if (kind === 'variant') next.variant = value || undefined
      else if (kind === 'role') next.role = value || undefined
      overridesRef.current.set(nodeId, next)
      forceRender()
    },
    [forceRender, nodeId]
  )

  const canSwitchModelProtocol = useCallback(
    (modelId, hasHistory) => {
      if (!hasHistory) return true
      const info = modelProtocolsRef.current
      const nextProtocol = info?.map?.[modelId]
      const currentProtocol = meta?.protocol || info?.currentProtocol
      if (!nextProtocol || !currentProtocol || nextProtocol === currentProtocol) return true
      const reason = `当前会话使用 ${currentProtocol} 协议，目标模型使用 ${nextProtocol} 协议；跨协议切换会丢失会话历史，请先新建会话或清空当前会话`
      protocolBlockRef.current = reason
      appendNotice(reason, 'error')
      return false
    },
    [appendNotice, meta?.protocol]
  )

  const openPicker = useCallback(
    (kind) => {
      if (running) {
        appendNotice('当前 turn 仍在运行，请完成或停止后再切换')
        return
      }
      setPickerIndex(0)
      const titles = { model: '选择模型', variant: '选择推理强度', role: '选择角色' }
      setPicker({ kind, title: titles[kind] || kind, options: [], loading: true, error: '' })
      const needsModels = kind === 'model' || kind === 'variant'
      const request =
        kind === 'model' || kind === 'variant'
          ? window.mica.chat.models()
          : window.mica.chat.roles()
      request
        .then((result) => {
          if (needsModels && result?.ok) {
            const map = {}
            for (const item of result.models || [])
              map[item.id] = { protocol: item.protocol, efforts: item.efforts || [] }
            modelProtocolsRef.current = { map, currentProtocol: result.currentProtocol }
          }
          setPicker((current) => {
            if (current?.kind !== kind) return current
            if (!result?.ok)
              return { ...current, loading: false, error: result?.error || '加载失败' }
            if (kind === 'variant') {
              const activeModel = overridesRef.current.get(nodeId)?.model || meta?.model || ''
              const entry = (result.models || []).find((item) => {
                if (!activeModel) return false
                return item.id === activeModel || item.id.endsWith(`/${activeModel}`)
              })
              const efforts = entry?.efforts?.length
                ? entry.efforts
                : EFFORT_OPTIONS.map((option) => option.value)
              const effortSet = new Set(efforts)
              const options = EFFORT_OPTIONS.filter((option) => effortSet.has(option.value))
              return {
                ...current,
                loading: false,
                options: options.length ? options : EFFORT_OPTIONS
              }
            }
            const options =
              kind === 'model'
                ? (result.models || []).map((item) => ({
                    value: item.id,
                    label: item.id,
                    protocol: item.protocol
                  }))
                : [
                    { value: 'default', detail: '内置默认系统提示' },
                    ...(result.roles || []).map((name) => ({ value: name }))
                  ]
            return { ...current, loading: false, options }
          })
        })
        .catch((error) => {
          setPicker((current) =>
            current?.kind === kind
              ? {
                  ...current,
                  loading: false,
                  error: error instanceof Error ? error.message : String(error)
                }
              : current
          )
        })
    },
    [appendNotice, meta, nodeId, running]
  )

  const selectPickerOption = useCallback(
    (option) => {
      const kind = picker?.kind
      if (!kind) return
      const value = option.value
      if (kind === 'model' && !canSwitchModelProtocol(value, messages.length)) return
      applyOverride(kind, value)
      setPicker(null)
      const title =
        kind === 'model'
          ? `模型已设置为 ${value}`
          : kind === 'variant'
            ? `推理强度已切换为 ${value}`
            : value === 'default'
              ? '已恢复默认角色'
              : `角色已切换为 ${value}`
      appendNotice(
        `${title}（下次对话开始生效）。提示词缓存可能失效，如上下文较大可在 Chat 区域右键选择 Compact`
      )
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [appendNotice, applyOverride, canSwitchModelProtocol, messages.length, picker]
  )

  const closePicker = useCallback(() => setPicker(null), [])
  useClickOutside(pickerRef, Boolean(picker), closePicker)

  const appendCommandResult = useCallback(
    (command, title, detail = '', options = {}) => {
      stickToBottomRef.current = true
      setShowJump(false)
      updateMessages((previous) => [
        ...previous,
        {
          id: uid('command'),
          kind: 'command',
          role: 'notice',
          command,
          title,
          detail,
          variant: options.variant || 'info',
          action: options.action,
          actionLabel: options.actionLabel
        }
      ])
    },
    [updateMessages]
  )

  const runSlashCommand = useCallback(
    async (parsed) => {
      const targetNodeId = nodeId
      const isCurrentNode = () => nodeIdRef.current === targetNodeId
      const command = findChatCommand(parsed.name)
      if (!parsed.preserveDraft) rememberInput(parsed.raw)
      if (!command) {
        appendCommandResult(
          parsed.raw,
          `未知命令 /${parsed.name || ''}`,
          '输入 /help 查看 Chat 支持的命令。未知 slash 命令不会发送给模型。',
          { variant: 'error' }
        )
        return
      }
      if (command.availability === 'terminal') {
        appendCommandResult(
          parsed.raw,
          `/${command.name} 需要交互式 Mica`,
          `${command.description}\nWeb Chat 暂不模拟该命令的 Ink 面板；可复制命令并在 Terminal 中运行 mica 后粘贴。`,
          { action: 'terminal', actionLabel: '复制并打开终端' }
        )
        return
      }

      if (parsed.name === 'help') {
        const chat = CHAT_COMMANDS.filter((item) => item.availability === 'chat')
          .map(
            (item) =>
              `/${item.name}${item.argument ? ` ${item.argument}` : ''}  ${item.description}`
          )
          .join('\n')
        const terminal = CHAT_COMMANDS.filter((item) => item.availability === 'terminal')
          .map((item) => `/${item.name}`)
          .join('  ')
        appendCommandResult(parsed.raw, 'Mica commands', `${chat}\n\nTerminal：${terminal}`)
        return
      }

      if (parsed.name === 'status') {
        appendCommandResult(
          parsed.raw,
          'Current session',
          [
            `session  ${sessionIdRef.current || '尚未创建'}`,
            `provider ${meta?.providerId || '—'}`,
            `model    ${meta?.model || '—'}`,
            `effort   ${meta?.effort || 'none'}`,
            `role     ${meta?.role || 'default'}`,
            `state    ${running ? statusLabel(phase) : meta?.turnState || 'idle'}`,
            `cwd      ${cwdRef.current || '—'}`
          ].join('\n')
        )
        return
      }

      if (parsed.name === 'context') {
        const usage = usageValues(meta?.lastUsage)
        const percent =
          usage?.total != null && meta?.contextWindowSize
            ? `${Math.round((usage.total / meta.contextWindowSize) * 100)}%`
            : '—'
        appendCommandResult(
          parsed.raw,
          'Context usage',
          [
            `tokens   ${usage?.total != null ? tokenCount(usage.total) : '—'}`,
            `input    ${usage?.input != null ? tokenCount(usage.input) : '—'}`,
            `output   ${usage?.output != null ? tokenCount(usage.output) : '—'}`,
            `cached   ${usage?.cached != null ? tokenCount(usage.cached) : '—'}`,
            `window   ${meta?.contextWindowSize ? tokenCount(meta.contextWindowSize) : '—'}`,
            `used     ${percent}`
          ].join('\n')
        )
        return
      }

      if (parsed.name === 'todo') {
        const action = parsed.args.toLowerCase()
        if (action && action !== 'show' && action !== 'hide') {
          appendCommandResult(parsed.raw, 'Usage: /todo [show|hide]', '', { variant: 'error' })
          return
        }
        const hidden = action === 'hide' ? true : action === 'show' ? false : !todoHidden
        todoHiddenRef.current.set(nodeId, hidden)
        setTodoHidden(hidden)
        appendCommandResult(parsed.raw, hidden ? '运行计划已隐藏' : '运行计划已显示')
        return
      }

      if (parsed.name === 'role') {
        const kind = 'role'
        if (running) {
          appendCommandResult(parsed.raw, '当前 turn 仍在运行，请完成或停止后再切换', '', {
            variant: 'error'
          })
          return
        }
        const value = parsed.args
        if (!value) {
          openPicker(kind)
          return
        }
        const normalized = kind === 'variant' ? value.toLowerCase() : value
        applyOverride(kind, normalized)
        const title = normalized === 'default' ? '已恢复默认角色' : `角色已切换为 ${normalized}`
        appendCommandResult(
          parsed.raw,
          title,
          '下次对话开始生效。提示词缓存可能失效，如上下文较大可考虑 /compact'
        )
        return
      }

      if (parsed.name === 'config') {
        await window.mica.settings.open()
        if (isCurrentNode()) appendCommandResult(parsed.raw, '已打开 Mica 配置')
        return
      }

      if (parsed.name === 'rename') {
        if (running) {
          appendCommandResult(parsed.raw, '当前 turn 仍在运行，请完成或停止后再重命名', '', {
            variant: 'error'
          })
          return
        }
        if (!parsed.args) {
          appendCommandResult(parsed.raw, 'Usage: /rename <title>', '', { variant: 'error' })
          return
        }
        if (!sessionIdRef.current) {
          appendCommandResult(parsed.raw, '发送第一条消息后才能重命名会话', '', {
            variant: 'error'
          })
          return
        }
        const targetSessionId = sessionIdRef.current
        try {
          const title = await window.mica.stats.renameSession(targetSessionId, parsed.args)
          if (!isCurrentNode()) return
          appendCommandResult(parsed.raw, `会话已重命名为 ${title}`)
          onSessionRenamedRef.current?.()
        } catch (error) {
          if (!isCurrentNode()) return
          appendCommandResult(
            parsed.raw,
            '重命名失败',
            error instanceof Error ? error.message : String(error),
            { variant: 'error' }
          )
        }
        return
      }

      if (parsed.name === 'new' || parsed.name === 'clear') {
        if (running) {
          appendCommandResult(parsed.raw, '当前 turn 仍在运行，请先停止再新建会话', '', {
            variant: 'error'
          })
          return
        }
        onNewSessionRef.current?.(cwdRef.current)
        return
      }

      if (parsed.name === 'compact') {
        if (running) {
          appendNotice('当前 turn 仍在运行，请先停止再压缩', 'error')
          return
        }
        const targetSessionId = sessionIdRef.current
        if (!targetSessionId) {
          appendNotice('暂无会话可压缩。发送第一条消息后即可压缩当前会话上下文。', 'error')
          return
        }
        if (compactBusyRef.current) {
          appendNotice('正在压缩中，请等待上一次压缩完成后再试。', 'compact')
          return
        }
        compactBusyRef.current = true
        const compactNoticeId = appendNotice(
          parsed.compactMode === 'local' ? '正在快速压缩上下文…' : '正在进行模型压缩…',
          'compact'
        )
        try {
          const compactMode = parsed.compactMode === 'local' ? 'local' : 'model'
          const result = await window.mica.chat.compact(targetSessionId, compactMode)
          if (!isCurrentNode()) return
          if (result?.ok) {
            const beforeTokens = Number(result.beforeTokenEstimate) || 0
            const afterTokens = Number(result.afterTokenEstimate) || 0
            const savedTokens = Math.max(
              0,
              Number(result.savedTokenEstimate) || beforeTokens - afterTokens
            )
            const savedPercent = Math.round((Number(result.savedRatio) || 0) * 100)
            const strategy = String(result.strategy || '').replaceAll('_', ' ')
            const mode = `${result.mode || (compactMode === 'local' ? 'pruned' : 'summarized')}${strategy ? ` (${strategy})` : ''}`
            const contextAfter =
              result.contextUsageRatio != null
                ? `${Math.round(Number(result.contextUsageRatio) * 100)}%`
                : result.contextWindowSize > 0
                  ? `${Math.round((afterTokens / Number(result.contextWindowSize)) * 100)}%`
                  : '—'
            const finalNotice = [
              'compact complete',
              '',
              `- Mode: ${mode}`,
              `- Messages: ${Number(result.beforeCount) || 0} → ${Number(result.afterCount) || 0}`,
              `- Saved: ~${formatTokens(savedTokens).toLowerCase()} tokens (${savedPercent}%)`,
              `- Recent kept: ${Number(result.keptCount) || 0} messages`,
              `- Context after compact: ${contextAfter}`
            ].join('\n')
            applyCompactMeta(result)
            refreshMetaSoon(targetSessionId, { keepLiveUsage: true })
            const rows = await window.mica.chat.history(targetSessionId).catch(() => [])
            if (isCurrentNode() && sessionIdRef.current === targetSessionId) {
              updateMessages([
                ...historyMessages(rows, targetSessionId),
                {
                  id: compactNoticeId,
                  kind: 'notice',
                  role: 'notice',
                  text: finalNotice,
                  variant: 'compact',
                  status: 'success'
                }
              ])
            }
          } else if (result?.code === 'not_needed') {
            updateNotice(
              compactNoticeId,
              `${compactMode === 'local' ? '暂无可快速清理内容' : '暂不需要模型压缩'}：${result.error || '当前会话内容较少。'}`,
              'compact',
              'skipped'
            )
          } else {
            updateNotice(
              compactNoticeId,
              `压缩失败：${result?.error || '未知错误'}`,
              'error',
              'error'
            )
          }
        } catch (error) {
          if (isCurrentNode()) {
            updateNotice(
              compactNoticeId,
              `压缩失败：${error instanceof Error ? error.message : String(error)}`,
              'error',
              'error'
            )
          }
        } finally {
          compactBusyRef.current = false
        }
        return
      }

      if (parsed.name === 'resume') {
        if (running) {
          appendCommandResult(parsed.raw, '当前 turn 仍在运行，请先停止再切换会话', '', {
            variant: 'error'
          })
          return
        }
        if (!parsed.args) {
          appendCommandResult(parsed.raw, 'Usage: /resume <session-id|title>', '', {
            variant: 'error'
          })
          return
        }
        try {
          const result = await window.mica.stats.listSessions()
          if (!isCurrentNode()) return
          const sessions = result?.sessions || []
          const target = sessions.find(
            (session) => session.id === parsed.args || session.title === parsed.args
          )
          if (!target) {
            const nearby = sessions
              .filter((session) =>
                `${session.id} ${session.title}`.toLowerCase().includes(parsed.args.toLowerCase())
              )
              .slice(0, 5)
              .map((session) => `${session.id}  ${session.title}`)
              .join('\n')
            appendCommandResult(
              parsed.raw,
              '未找到匹配会话',
              nearby ? `可能匹配：\n${nearby}` : '可在左侧 History 中选择会话。',
              { variant: 'error' }
            )
            return
          }
          onResumeSessionRef.current?.(target)
        } catch (error) {
          if (!isCurrentNode()) return
          appendCommandResult(
            parsed.raw,
            '加载会话列表失败',
            error instanceof Error ? error.message : String(error),
            { variant: 'error' }
          )
        }
      }
    },
    [
      applyOverride,
      applyCompactMeta,
      appendCommandResult,
      appendNotice,
      cwdRef,
      meta,
      nodeId,
      nodeIdRef,
      onNewSessionRef,
      onResumeSessionRef,
      onSessionRenamedRef,
      openPicker,
      phase,
      refreshMetaSoon,
      rememberInput,
      running,
      todoHidden,
      updateNotice,
      updateMessages
    ]
  )

  const send = useCallback(
    (requestedInput, options = {}) => {
      const text = (typeof requestedInput === 'string' ? requestedInput : input).trim()
      if (!text || !nodeId) return
      const optimisticId = uid('msg')
      const queueing = running || !finishedRef.current
      const previousTurnId = turnRef.current
      let acceptedIntoQueue = false
      stickToBottomRef.current = true
      setShowJump(false)
      updateMessages((previous) => [
        ...previous,
        { id: optimisticId, kind: 'message', role: 'user', text, done: true, queued: queueing }
      ])
      if (queueing) queuedMessageIdsRef.current.push(optimisticId)
      if (!options.preserveDraft) rememberInput(text)
      if (!queueing) {
        turnRef.current = `pending:${optimisticId}`
        streamRef.current = { id: null, kind: null, turnId: turnRef.current }
        finishedRef.current = false
        setRunning(true)
        setStopping(false)
        setPhase('connecting')
        setRunStartedAt(Date.now())
      }
      const targetNodeId = nodeId

      const rollback = (message, variant = 'error') => {
        if (nodeIdRef.current !== targetNodeId) return
        updateMessages((previous) => previous.filter((item) => item.id !== optimisticId))
        appendNotice(message, variant)
        if (!options.preserveDraft) {
          draftsRef.current.set(nodeId, text)
          setInput(text)
        }
        if (queueing) {
          if (acceptedIntoQueue) {
            setQueuedCount((count) => Math.max(0, count - 1))
            setQueuedItems((items) => items.filter((item) => item.id !== optimisticId))
          }
        } else {
          turnRef.current = previousTurnId
          setRunning(false)
          setPhase('idle')
          finishedRef.current = true
        }
      }

      const overrides = overridesRef.current.get(nodeId) || {}
      window.mica.chat
        .start({
          id: nodeId,
          sessionId: sessionIdRef.current || null,
          cwd: cwdRef.current || null,
          prompt: text,
          clientMessageId: optimisticId,
          maxTurns: 100,
          model: overrides.model || null,
          variant: overrides.variant || null,
          role: overrides.role || null
        })
        .then((result) => {
          if (!result) return
          if (result.queued) {
            acceptedIntoQueue = true
            if (!queuedMessageIdsRef.current.includes(optimisticId)) {
              queuedMessageIdsRef.current.push(optimisticId)
            }
            updateMessages((previous) =>
              previous.map((message) =>
                message.id === optimisticId ? { ...message, queued: true } : message
              )
            )
            setQueuedCount(Number(result.position) || 1)
            setQueuedItems(Array.isArray(result.queuedItems) ? result.queuedItems : [])
          } else {
            queuedMessageIdsRef.current = queuedMessageIdsRef.current.filter(
              (id) => id !== optimisticId
            )
            updateMessages((previous) =>
              previous.map((message) =>
                message.id === optimisticId ? { ...message, queued: false } : message
              )
            )
            setQueuedItems((items) => items.filter((item) => item.id !== optimisticId))
            if (result.busy) rollback('该会话暂时无法排队，请稍后重试', 'error')
            else if (result.error) rollback(result.error)
          }
        })
        .catch((error) => rollback(error instanceof Error ? error.message : String(error)))
    },
    [appendNotice, cwdRef, input, nodeId, nodeIdRef, rememberInput, running, updateMessages]
  )

  const stop = useCallback(() => {
    if (!nodeId || stopping) return
    const targetNodeId = nodeId
    setStopping(true)
    setPhase('stopping')
    window.mica.chat
      .abort(nodeId)
      .then((aborted) => {
        if (nodeIdRef.current !== targetNodeId) return
        if (!aborted) {
          setStopping(false)
          setRunning(false)
          setPhase('idle')
        }
      })
      .catch(() => {
        if (nodeIdRef.current === targetNodeId) setStopping(false)
      })
  }, [nodeId, nodeIdRef, stopping])

  const navigateInputHistory = useCallback(
    (direction) => {
      const history = inputHistoryRef.current.get(nodeId) || []
      if (!history.length) return
      let cursor = historyCursorRef.current
      if (direction < 0) {
        if (cursor < 0) draftsRef.current.set(nodeId, input)
        cursor = cursor < 0 ? history.length - 1 : Math.max(0, cursor - 1)
      } else cursor = cursor < 0 ? -1 : Math.min(history.length, cursor + 1)
      historyCursorRef.current = cursor === history.length ? -1 : cursor
      const value =
        historyCursorRef.current < 0
          ? draftsRef.current.get(nodeId) || ''
          : history[historyCursorRef.current]
      draftsRef.current.set(nodeId, value)
      setInput(value)
      requestAnimationFrame(() => {
        const element = textareaRef.current
        if (element) element.setSelectionRange(value.length, value.length)
      })
    },
    [input, nodeId]
  )

  const showEmpty = historyLoaded && !running && messages.length === 0
  const queueReady = running && input.trim().length > 0
  const transcriptMessages = useMemo(
    () => messages.filter((message) => !message.queued && !isActivityMessage(message)),
    [messages]
  )
  const queuedDisplayItems = useMemo(() => {
    const items = [...queuedItems]
    for (const message of messages) {
      if (!message.queued || items.some((item) => item.id === message.id)) continue
      items.push({ id: message.id, text: message.text, pending: true })
    }
    return items
  }, [messages, queuedItems])
  const recallQueued = useCallback(
    async (requestedId) => {
      if (!nodeId || recallingQueueRef.current) return
      const item = requestedId
        ? queuedDisplayItems.find((candidate) => candidate.id === requestedId)
        : queuedDisplayItems[queuedDisplayItems.length - 1]
      if (!item || item.pending) return
      const targetNodeId = nodeId
      recallingQueueRef.current = item.id
      setRecallingQueueId(item.id)
      try {
        const result = await window.mica.chat.recallQueued(nodeId, item.id)
        if (nodeIdRef.current !== targetNodeId) return
        setQueuedCount(Number(result?.queuedCount) || 0)
        setQueuedItems(Array.isArray(result?.queuedItems) ? result.queuedItems : [])
        if (!result?.ok) {
          appendNotice(result?.error || '排队消息撤回失败', 'error')
          return
        }
        queuedMessageIdsRef.current = queuedMessageIdsRef.current.filter((id) => id !== item.id)
        updateMessages((previous) => previous.filter((message) => message.id !== item.id))
        const recalledText = result.text || item.text || ''
        setInput((current) => {
          const next = current.trim() ? `${current}\n\n${recalledText}` : recalledText
          draftsRef.current.set(nodeId, next)
          return next
        })
        historyCursorRef.current = -1
        requestAnimationFrame(() => {
          const element = textareaRef.current
          if (!element) return
          element.focus()
          element.setSelectionRange(element.value.length, element.value.length)
        })
      } catch (error) {
        if (nodeIdRef.current === targetNodeId) {
          appendNotice(
            `排队消息撤回失败：${error instanceof Error ? error.message : String(error)}`,
            'error'
          )
        }
      } finally {
        if (recallingQueueRef.current === item.id) recallingQueueRef.current = null
        if (nodeIdRef.current === targetNodeId) setRecallingQueueId(null)
      }
    },
    [appendNotice, nodeId, nodeIdRef, queuedDisplayItems, updateMessages]
  )
  const activityTurnId =
    turnRef.current ||
    messages.findLast((message) => isActivityMessage(message) && message.turnId)?.turnId ||
    null
  const turnActivityMessages = useMemo(
    () => currentTurnActivityMessages(messages, activityTurnId),
    [activityTurnId, messages]
  )
  const visibleTurnLogMessages = running || phase === 'error' ? turnActivityMessages : []
  const runningToolNames = useMemo(
    () =>
      turnActivityMessages
        .filter(
          (message) =>
            message.kind === 'tool' && ['pending', 'running'].includes(message.tool?.status)
        )
        .map((message) => message.tool?.tool)
        .filter(Boolean),
    [turnActivityMessages]
  )
  const activeStreamText =
    streamRef.current.id && ['thinking', 'streaming'].includes(phase)
      ? messages.find((message) => message.id === streamRef.current.id)?.text || ''
      : ''
  const activeStreamTokenEstimate = activeStreamText ? estimateTokens(activeStreamText) : 0
  const activeSubagents = useMemo(
    () => (running ? activeSubagentMessages(messages, activityTurnId) : []),
    [activityTurnId, messages, running]
  )
  const todoItems = useMemo(() => {
    return todoItemsForTurn(messages, activityTurnId, running)
  }, [activityTurnId, messages, running])
  const activeOverrides = overridesRef.current.get(nodeId) || {}
  const activeModel = activeOverrides.model || meta?.model || ''
  const activeEffort = activeOverrides.variant || meta?.effort || 'none'
  const activeRole = activeOverrides.role || meta?.role || 'default'
  const contextUsage = usageValues(meta?.lastUsage)
  const contextTokens = contextUsage?.total ?? 0
  const windowSize = meta?.contextWindowSize ?? 0
  const inputTokens = contextUsage?.input ?? 0
  const cachedTokens = contextUsage?.cached ?? 0
  const hasContext = contextTokens > 0
  const tokenStr = hasContext ? formatTokens(contextTokens) : ''
  const metaCachedRate = Number(meta?.cachedRate)
  const cachedPct = Math.min(
    100,
    Math.max(
      0,
      Number.isFinite(metaCachedRate)
        ? Math.round(metaCachedRate * 100)
        : inputTokens > 0
          ? Math.round((cachedTokens / inputTokens) * 100)
          : 0
    )
  )
  const hasContextWindow = hasContext && windowSize > 0
  const contextPct = hasContextWindow
    ? Math.min(100, Math.max(0, Math.round((contextTokens / windowSize) * 100)))
    : 0
  const tokenClass = hasContext ? TOKEN_LEVEL_CLASS[levelFor(contextTokens, TOKEN_THRESHOLDS)] : ''
  const ctxClass = hasContextWindow ? RATIO_LEVEL_CLASS[levelFor(contextPct, RATIO_THRESHOLDS)] : ''
  const statusMetaTitle = modelSummaryTitle({
    ...meta,
    model: activeModel || null,
    effort: activeEffort === 'none' ? null : activeEffort,
    role: activeRole
  })
  const closeContextMenu = useCallback(() => setContextMenu(null), [])
  const openChatContextMenu = useCallback(
    (event) => {
      event.preventDefault()
      setPicker(null)
      setContextMenu({
        x: Math.max(4, Math.min(event.clientX, window.innerWidth - 172)),
        y: Math.max(4, Math.min(event.clientY, window.innerHeight - 196)),
        hasSession: Boolean(sessionIdRef.current),
        running
      })
    },
    [running]
  )
  const startCommitTask = useCallback(() => {
    if (commitTaskRef.current) return
    const commitId = uid('commit')
    const cwd = cwdRef.current
    const noticeId = appendNotice('commit: 正在分析 Git 变化...', 'info')
    commitTaskRef.current = { id: commitId, noticeId, cwd, nodeId: nodeIdRef.current }
    commitNoticeTextRef.current = ''
    setCommitRunning(true)
    window.mica.chat
      .commit({ commitId, cwd })
      .then((result) => {
        if (!result?.ok) {
          const error = result?.error || 'commit 任务启动失败'
          updateNotice(noticeId, `commit 启动失败：${compactLine(error, 400)}`, 'error')
          commitTaskRef.current = null
          setCommitRunning(false)
        }
      })
      .catch((error) => {
        updateNotice(noticeId, `commit 启动失败：${compactLine(String(error), 400)}`, 'error')
        commitTaskRef.current = null
        setCommitRunning(false)
      })
  }, [appendNotice, cwdRef, nodeIdRef, updateNotice])

  useEffect(() => {
    const offEvent = window.mica.chat.onCommitEvent(({ commitId, event }) => {
      const task = commitTaskRef.current
      if (!task || task.id !== commitId) return
      if (event?.type === 'tool_use' && event.part?.tool) {
        updateNotice(task.noticeId, `commit: 正在执行 ${event.part.tool} ...`, 'info')
      } else if (event?.type === 'text' && event.part?.text) {
        commitNoticeTextRef.current = `${commitNoticeTextRef.current}${event.part.text}`.slice(-400)
      } else if (event?.type === 'reasoning') {
        updateNotice(task.noticeId, 'commit: 正在分析提交信息...', 'info')
      }
    })
    const offExit = window.mica.chat.onCommitExit(({ commitId, exitCode, error }) => {
      const task = commitTaskRef.current
      if (!task || task.id !== commitId) return
      commitTaskRef.current = null
      setCommitRunning(false)
      if (error) {
        updateNotice(task.noticeId, `commit 失败：${compactLine(error, 400)}`, 'error')
      } else if (exitCode !== 0) {
        updateNotice(task.noticeId, `commit 异常退出（code ${exitCode}）`, 'error')
      } else {
        const summary = commitNoticeTextRef.current.trim()
        updateNotice(
          task.noticeId,
          summary ? `commit: 已完成 ${compactLine(summary, 300)}` : 'commit: 已完成',
          'info'
        )
      }
    })
    return () => {
      offEvent?.()
      offExit?.()
    }
  }, [updateNotice])

  const runContextMenuAction = useCallback(
    async (action) => {
      setContextMenu(null)
      if (action === 'compact-local' || action === 'compact-model' || action === 'clear') {
        await runSlashCommand({
          name: action === 'clear' ? 'clear' : 'compact',
          args: '',
          raw:
            action === 'compact-local'
              ? '快速压缩（本地）'
              : action === 'compact-model'
                ? '模型压缩'
                : 'Clear',
          compactMode: action === 'compact-local' ? 'local' : 'model',
          preserveDraft: true
        })
        return
      }
      if (action === 'commit') {
        startCommitTask()
        return
      }
      if (action !== 'fork') return
      const sessionId = sessionIdRef.current
      if (!sessionId) {
        appendNotice('发送第一条消息后才能分叉会话', 'error')
        return
      }
      try {
        const forked = await window.mica.chat.fork(sessionId)
        onSessionRenamedRef.current?.()
        onResumeSessionRef.current?.(forked)
      } catch (error) {
        appendNotice(
          `分叉会话失败：${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
      }
    },
    [appendNotice, onResumeSessionRef, onSessionRenamedRef, runSlashCommand, startCommitTask]
  )

  const focusComposerFromShell = useCallback(
    (event) => {
      if (event.button != null && event.button !== 0) return
      const target = event.target
      if (!(target instanceof Element)) return
      if (
        target.closest(
          'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="listbox"], [role="option"], .chat-command-palette, [data-no-chat-focus]'
        )
      ) {
        return
      }
      if (event.type === 'pointerdown' && target.closest('.chat-scroll, .chat-transcript')) return
      const selection = window.getSelection?.()
      if (selection && !selection.isCollapsed) return
      textareaRef.current?.focus()
      scheduleTerminalCursorUpdate()
    },
    [scheduleTerminalCursorUpdate]
  )

  const statusLine = (
    <div className="chat-status-line">
      <div className="chat-status-primary">
        {queuedCount > 0 ? (
          <span className="chat-status-queue">
            消息已排队，将在当前任务完成后发送{queuedCount > 1 ? ` · ${queuedCount}` : ''}
          </span>
        ) : running ? (
          <>
            <LoaderCircle size={11} className="animate-spin" />
            <span>{statusLabel(phase, runningToolNames)}</span>
            {elapsed > 0 && <span>{formatDuration(elapsed)}</span>}
            {activeStreamTokenEstimate > 0 && (
              <span className="chat-status-token-delta">↓{activeStreamTokenEstimate} tokens</span>
            )}
          </>
        ) : null}
      </div>
      <div className="chat-status-meta" title={statusMetaTitle}>
        {activeModel && (
          <span className="chat-status-model-group">
            <span
              className="chat-status-model"
              role="button"
              tabIndex={0}
              title="切换模型"
              data-chat-picker-trigger
              onClick={() => openPicker('model')}
            >
              {activeModel}
            </span>
            <span className="chat-status-sep">_</span>
            <span
              className="chat-status-model"
              role="button"
              tabIndex={0}
              title="切换推理强度"
              data-chat-picker-trigger
              onClick={() => openPicker('variant')}
            >
              {activeEffort}
            </span>
          </span>
        )}
        {hasContext && (
          <>
            <span className={`chat-status-tokens ${tokenClass}`}>{tokenStr}</span>
            <span className="chat-status-cached"> (cached {cachedPct}%, </span>
            {hasContextWindow ? (
              <span className={`chat-status-ctx ${ctxClass}`}>ctx {contextPct}%</span>
            ) : (
              <span className="chat-status-cached" title="当前会话尚未提供上下文窗口大小">
                ctx —
              </span>
            )}
            <span className="chat-status-cached">)</span>
          </>
        )}
      </div>
    </div>
  )

  return (
    <div
      className={`chat-view no-drag ${visible ? 'flex' : 'hidden'}`}
      onPointerDownCapture={focusComposerFromShell}
      onMouseUp={focusComposerFromShell}
      onContextMenu={openChatContextMenu}
    >
      <div
        ref={listRef}
        className="chat-scroll thin-scrollbar"
        onScroll={(event) => {
          const element = event.currentTarget
          const atBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            SCROLL_BOTTOM_THRESHOLD
          stickToBottomRef.current = atBottom
          setShowJump(!atBottom)
        }}
      >
        <div ref={transcriptRef} className="chat-transcript">
          {!historyLoaded && <div className="chat-loading">正在加载会话…</div>}
          {showEmpty && <WelcomeHint cwd={cwd} />}
          {transcriptMessages.map((message) => {
            const onOpenFile = (path, position) =>
              onOpenFileRef.current?.(resolveChatPath(path, cwdRef.current), position)
            const onPreviewImage = (source, alt) => setImagePreview({ source, alt })
            return (
              <MessageRow
                key={message.id}
                message={message}
                onOpenFile={onOpenFile}
                onPreviewImage={onPreviewImage}
                onCommandAction={(item) => {
                  if (item.action === 'terminal') {
                    void copyText(item.command)
                    onOpenTerminalRef.current?.()
                  }
                }}
              />
            )
          })}
          <TurnLogDock messages={visibleTurnLogMessages} now={Date.now()} />
        </div>
      </div>

      <div ref={composerDockRef} className="chat-composer-dock">
        {showJump && (
          <button
            type="button"
            className="chat-jump"
            onClick={() => {
              stickToBottomRef.current = true
              setShowJump(false)
              const list = listRef.current
              if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
            }}
          >
            <ArrowDown size={13} /> 最新消息
          </button>
        )}
        {picker && (
          <SelectPalette
            paletteRef={pickerRef}
            title={picker.title}
            options={picker.options || []}
            activeIndex={Math.min(pickerIndex, Math.max(0, (picker.options?.length || 1) - 1))}
            onActiveIndex={setPickerIndex}
            onSelect={selectPickerOption}
            selectedValue={
              (overridesRef.current.get(nodeId) || {})[picker.kind] ||
              (picker.kind === 'variant'
                ? meta?.effort || 'none'
                : picker.kind === 'role'
                  ? meta?.role || 'default'
                  : meta?.model) ||
              ''
            }
            loading={picker.loading}
            error={picker.error}
          />
        )}
        <TodoDock items={todoItems} hidden={todoHidden} />
        <SubagentStatusDock messages={activeSubagents} now={Date.now()} />
        <QueueDock
          items={queuedDisplayItems}
          onRecall={recallQueued}
          recallingId={recallingQueueId}
        />
        <ComposerImageStrip
          text={input}
          onPreview={(source, alt) => setImagePreview({ source, alt })}
        />
        <div
          className={`chat-composer ${running ? 'chat-composer-running' : ''} ${queueReady ? 'chat-composer-queue' : ''}`}
        >
          {queueReady && (
            <span className="chat-composer-frame-label">
              Enter/Tab/Shift+Tab 等 agent 执行完成后发送
            </span>
          )}
          <span className="chat-prompt-mark" aria-hidden="true">
            {queueReady ? '↳' : '›'}
          </span>
          <div className="chat-composer-input">
            <div className="chat-composer-markdown-layer" aria-hidden="true">
              {input ? (
                composerMarkdownNodes(input)
              ) : (
                <span className="chat-composer-placeholder">
                  {running
                    ? '消息会在当前 turn 完成后自动发送'
                    : 'Type a message to start a conversation'}
                </span>
              )}
            </div>
            {windowFocused && terminalCursor && (
              <span
                className={`chat-composer-terminal-cursor${cursorActive ? ' cursor-active' : ''}`}
                aria-hidden="true"
                style={{
                  left: `${terminalCursor.left}px`,
                  top: `${terminalCursor.top}px`,
                  width: `${terminalCursor.width || TERMINAL_CURSOR_WIDTH}px`,
                  height: `${terminalCursor.height}px`
                }}
              />
            )}
            <textarea
              ref={textareaRef}
              value={input}
              rows={1}
              spellCheck={false}
              aria-label="对话输入"
              placeholder=""
              onChange={(event) => {
                draftsRef.current.set(nodeId, event.target.value)
                historyCursorRef.current = -1
                setInput(event.target.value)
                scheduleTerminalCursorUpdate()
              }}
              onFocus={() => {
                setInputFocused(true)
                scheduleTerminalCursorUpdate()
              }}
              onBlur={() => {
                setInputFocused(false)
              }}
              onSelect={scheduleTerminalCursorUpdate}
              onKeyUp={scheduleTerminalCursorUpdate}
              onClick={scheduleTerminalCursorUpdate}
              onPaste={(event) => {
                const hasImage = Array.from(event.clipboardData?.items ?? []).some((item) =>
                  item.type.startsWith('image/')
                )
                if (!hasImage) return
                event.preventDefault()
                window.mica.chat
                  .savePastedImage()
                  .then((result) => {
                    const element = textareaRef.current
                    const start = element?.selectionStart ?? input.length
                    const end = element?.selectionEnd ?? input.length
                    const insertion = result?.ok
                      ? `[Image](${result.ref})`
                      : (event.clipboardData?.getData('text/plain') ?? '')
                    const next = input.slice(0, start) + insertion + input.slice(end)
                    draftsRef.current.set(nodeId, next)
                    setInput(next)
                    requestAnimationFrame(() => {
                      const el = textareaRef.current
                      if (el) {
                        el.setSelectionRange(start + insertion.length, start + insertion.length)
                        updateTerminalCursor()
                      }
                    })
                  })
                  .catch(() => {})
              }}
              onKeyDown={(event) => {
                scheduleTerminalCursorUpdate()
                if (picker) {
                  const options = picker.options || []
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    if (options.length) setPickerIndex((value) => (value + 1) % options.length)
                    return
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    if (options.length) {
                      setPickerIndex((value) => (value - 1 + options.length) % options.length)
                    }
                    return
                  }
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    if (options.length) {
                      selectPickerOption(options[Math.min(pickerIndex, options.length - 1)])
                    }
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setPicker(null)
                    return
                  }
                  return
                }
                if (
                  event.key === 'ArrowLeft' &&
                  event.shiftKey &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  queuedDisplayItems.length > 0 &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  void recallQueued()
                  return
                }
                if (event.altKey && event.key === 'ArrowUp') {
                  event.preventDefault()
                  navigateInputHistory(-1)
                  return
                }
                if (event.altKey && event.key === 'ArrowDown') {
                  event.preventDefault()
                  navigateInputHistory(1)
                  return
                }
                if (
                  event.key === 'ArrowUp' &&
                  !event.shiftKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  event.currentTarget.selectionStart === 0 &&
                  event.currentTarget.selectionEnd === 0
                ) {
                  event.preventDefault()
                  navigateInputHistory(-1)
                  return
                }
                if (
                  event.key === 'ArrowDown' &&
                  !event.shiftKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  event.currentTarget.selectionStart === event.currentTarget.value.length &&
                  event.currentTarget.selectionEnd === event.currentTarget.value.length
                ) {
                  event.preventDefault()
                  navigateInputHistory(1)
                  return
                }
                if (event.key === 'Tab' && queueReady) {
                  event.preventDefault()
                  send()
                  return
                }
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  send()
                }
              }}
              onScroll={(event) => {
                const layer = event.currentTarget.parentElement?.querySelector(
                  '.chat-composer-markdown-layer'
                )
                if (layer) layer.scrollTop = event.currentTarget.scrollTop
                scheduleTerminalCursorUpdate()
              }}
            />
          </div>
          <div className="chat-composer-actions">
            <span>{input.length > 4000 ? input.length.toLocaleString() : ''}</span>
            {running ? (
              <>
                {input.trim() && (
                  <button
                    type="button"
                    title="加入发送队列"
                    aria-label="加入发送队列"
                    onClick={send}
                  >
                    <Send size={13} />
                  </button>
                )}
                <button type="button" title="停止生成" aria-label="停止生成" onClick={stop}>
                  {stopping ? (
                    <LoaderCircle size={13} className="animate-spin" />
                  ) : (
                    <Square size={12} />
                  )}
                </button>
              </>
            ) : input.trim() ? (
              <button
                type="button"
                title="发送"
                aria-label="发送"
                disabled={!input.trim()}
                onClick={send}
              >
                <Send size={13} />
              </button>
            ) : null}
          </div>
        </div>
        {imagePreview && (
          <ImagePreviewModal
            source={imagePreview.source}
            alt={imagePreview.alt}
            onClose={() => setImagePreview(null)}
          />
        )}
        {statusLine}
      </div>
      {contextMenu && (
        <ChatContextMenu
          menu={contextMenu}
          onAction={runContextMenuAction}
          onClose={closeContextMenu}
          commitRunning={commitRunning}
        />
      )}
    </div>
  )
}
