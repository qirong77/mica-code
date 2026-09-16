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
  IconArrowDown,
  IconBolt,
  IconCheck,
  IconCommand,
  IconCopy,
  IconCornerUpLeft,
  IconDots,
  IconExternalLink,
  IconGitCommit,
  IconGitFork,
  IconLoader2,
  IconMinimize,
  IconPhoto,
  IconSend,
  IconSquare,
  IconTerminal,
  IconTrash
} from '@tabler/icons-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { formatTokens as formatSharedTokens } from '@packages/mica-web-shared'
import { toolIcon as sharedToolIcon, toolLabel as sharedToolLabel } from '@packages/mica-web-shared'

function formatTokens(value) {
  return formatSharedTokens(value, { millionDecimals: 2 })
}
import { CHAT_COMMANDS, findChatCommand } from './chat-commands'
import {
  backgroundTaskStatusLabel,
  buildSubagentTimeline,
  isBackgroundTaskRunning,
  isSubagentRunning,
  subagentStatusLabel,
  taskElapsedMs,
  taskOutputWindowLabel
} from './chat-task-detail'
import { longPressHandlers, useLatest } from './hooks'
import { uid } from './workspace'
import TerminalComposer from './TerminalComposer'

const MAX_INPUT_ROWS = 10
const SCROLL_BOTTOM_THRESHOLD = 72
const MIN_TURN_LOG_HEIGHT = 60
const MAX_TURN_LOG_HEIGHT_RATIO = 0.6
const TURN_LOG_HEIGHT_KEY = 'mica.turnLogHeight'
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    ? CSS.supports('field-sizing', 'content')
    : false

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

const EFFORT_OPTIONS = [
  { value: 'none', detail: '不发送推理参数' },
  { value: 'low', detail: '轻量推理' },
  { value: 'medium', detail: '默认推理' },
  { value: 'high', detail: '深度推理' },
  { value: 'xhigh', detail: '最强推理' }
]

function getToolIcon(toolName) {
  return sharedToolIcon(toolName)
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
          {copied ? <IconCheck size={11} /> : <IconCopy size={11} />}
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
    // 浏览器无法加载 file://，HTTP 部署时改由服务端按路径回吐图片
    if (typeof window !== 'undefined' && window.mica?.isWeb) {
      return `/api/image?path=${encodeURIComponent(normalized)}`
    }
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
  // 文案与 CLI 的 waiting queue 提示保持一致（app 用按钮撤回，不展示
  // shift + ← 快捷键）。after_iteration 排队来自 host 的 mica/queue/queued
  // 扩展通知（Shift+Tab 注入活跃 turn），标题区分两种发送时机。
  const queueMode = items[0]?.queueMode
  const headerText =
    queueMode === 'after_iteration'
      ? 'waiting to send after a complete tool-call iteration'
      : 'waiting to send after current turn'
  return (
    <section className="chat-queue-dock" aria-label="等待发送的消息">
      <div className="chat-queue-dock-header">
        <span aria-hidden="true">↳</span>
        <span>{headerText}</span>
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
                <IconLoader2 size={11} className="animate-spin" />
              ) : (
                <IconCornerUpLeft size={11} />
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

const CTX_ROLE_STYLE = {
  user: 'bg-info/12 text-info-soft',
  assistant: 'bg-panel-hi text-fg-strong',
  tool: 'bg-success/12 text-success-soft',
  system: 'bg-purple/12 text-purple'
}
const CTX_ROLE_LABEL = {
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool',
  system: 'System'
}

function ctxMessageTokens(message) {
  let text = ''
  if (typeof message.content === 'string') text = message.content
  if (Array.isArray(message.toolCalls)) {
    for (const tc of message.toolCalls) {
      text += (tc.name || '') + (tc.arguments || '')
    }
  }
  return estimateTokens(text)
}

function ContextDetailPopover({ sessionId, contextWindowSize, onClose }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)
  const [expandedId, setExpandedId] = useState(null)

  useEffect(() => {
    const onKeyDown = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    if (!sessionId) {
      setError('No active session')
      return
    }
    window.mica.stats
      .sessionDetail(sessionId)
      .then((data) => {
        if (cancelled) return
        setDetail(data)
      })
      .catch((err) => {
        if (cancelled) return
        setError(String(err?.message || err))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const win = contextWindowSize || 0
  const allMessages = detail?.messages || []
  const lastUsage = detail?.lastUsage || null
  const totalInputTokens = lastUsage?.inputTokens || 0

  const items = useMemo(() => {
    const result = []
    let msgTokenSum = 0
    for (const msg of allMessages) {
      const tokens = ctxMessageTokens(msg)
      msgTokenSum += tokens
      const role = msg.role || 'assistant'
      let label = CTX_ROLE_LABEL[role] || role
      let detail_label = ''
      if (role === 'tool' && msg.toolCallId) {
        detail_label = msg.toolCallId
      } else if (role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
        detail_label = msg.toolCalls
          .map((tc) => tc.name)
          .filter(Boolean)
          .join(', ')
      }
      result.push({
        id: `msg-${result.length}`,
        type: 'message',
        role,
        label,
        detail_label,
        tokens,
        message: msg
      })
    }
    const overhead = Math.max(0, totalInputTokens - msgTokenSum)
    return { result, msgTokenSum, overhead }
  }, [allMessages, totalInputTokens])

  const breakdown = useMemo(() => {
    const list = []
    if (items.overhead > 0) {
      list.push({
        id: 'system-prompt',
        type: 'overhead',
        label: '系统提示词 + 工具定义',
        detail_label: `role: ${detail?.role || 'default'}`,
        tokens: items.overhead,
        note: '运行时构建，未持久化；包含 system prompt、AGENT.md、skills 索引、工具 schema 等'
      })
    }
    for (const it of items.result) {
      list.push(it)
    }
    return list
  }, [items, detail])

  const grandTotal = breakdown.reduce((s, it) => s + it.tokens, 0)
  const maxTokens = Math.max(grandTotal, totalInputTokens, 1)

  return (
    <div
      className="chat-ctx-modal-overlay no-drag"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="chat-ctx-modal" onClick={(e) => e.stopPropagation()}>
        <div className="chat-ctx-modal-header">
          <span>Context Breakdown</span>
          <button type="button" onClick={onClose} aria-label="关闭">
            Esc ✕
          </button>
        </div>
        <div className="chat-ctx-modal-body">
          {error ? (
            <div className="chat-ctx-modal-empty">{error}</div>
          ) : !detail ? (
            <div className="chat-ctx-modal-empty">加载中…</div>
          ) : (
            <>
              <div className="chat-ctx-modal-summary">
                <span>{breakdown.length} items</span>
                <span className="chat-ctx-modal-sep">·</span>
                <span className="tabular-nums">est. {formatTokens(grandTotal)} tokens</span>
                {totalInputTokens > 0 && (
                  <>
                    <span className="chat-ctx-modal-sep">·</span>
                    <span className="tabular-nums">
                      last req {formatTokens(totalInputTokens)} in
                    </span>
                  </>
                )}
                {win > 0 && (
                  <>
                    <span className="chat-ctx-modal-sep">·</span>
                    <span className="tabular-nums">ctx win {formatTokens(win)}</span>
                  </>
                )}
              </div>
              {breakdown.length === 0 ? (
                <div className="chat-ctx-modal-empty">无上下文数据</div>
              ) : (
                breakdown.map((it) => {
                  const pct = Math.min(100, Math.round((it.tokens / maxTokens) * 100))
                  const isExpanded = expandedId === it.id
                  const isOverhead = it.type === 'overhead'
                  return (
                    <div key={it.id} className="chat-ctx-modal-row-wrap">
                      <button
                        type="button"
                        className={`chat-ctx-modal-row ${isExpanded ? 'expanded' : ''}`}
                        onClick={() => setExpandedId(isExpanded ? null : it.id)}
                      >
                        {pct > 0 && (
                          <span
                            className="chat-ctx-modal-bar"
                            style={{
                              width: `${pct}%`,
                              background: `rgba(255,255,255,${0.03 + Math.min(0.07, (pct / 100) * 0.07)})`
                            }}
                          />
                        )}
                        <span
                          className={`chat-ctx-modal-badge ${CTX_ROLE_STYLE[it.role || (isOverhead ? 'system' : 'assistant')] || ''}`}
                        >
                          {it.label}
                        </span>
                        {it.detail_label && (
                          <span className="chat-ctx-modal-row-detail" title={it.detail_label}>
                            {it.detail_label}
                          </span>
                        )}
                        <span className="chat-ctx-modal-tokens tabular-nums">
                          ~{formatTokens(it.tokens)}
                        </span>
                        <span className="chat-ctx-modal-pct tabular-nums">{pct}%</span>
                        <span className="chat-ctx-modal-chevron">{isExpanded ? '▾' : '▸'}</span>
                      </button>
                      {isExpanded && (
                        <div className="chat-ctx-modal-detail">
                          {isOverhead ? (
                            <div className="chat-ctx-modal-detail-note">{it.note}</div>
                          ) : (
                            <>
                              <div className="chat-ctx-modal-detail-meta">
                                <span>Role</span>
                                <span>{it.role}</span>
                                <span>Est. tokens</span>
                                <span className="tabular-nums">{it.tokens.toLocaleString()}</span>
                                <span>Share</span>
                                <span className="tabular-nums">{pct}%</span>
                              </div>
                              {it.message.content && (
                                <div className="chat-ctx-modal-detail-content">
                                  <div className="chat-ctx-modal-detail-content-label">Content</div>
                                  <pre className="chat-ctx-modal-detail-pre">
                                    {it.message.content}
                                  </pre>
                                </div>
                              )}
                              {Array.isArray(it.message.toolCalls) &&
                                it.message.toolCalls.length > 0 && (
                                  <div className="chat-ctx-modal-detail-content">
                                    <div className="chat-ctx-modal-detail-content-label">
                                      Tool Calls ({it.message.toolCalls.length})
                                    </div>
                                    {it.message.toolCalls.map((tc, j) => (
                                      <div key={tc.id || j} className="chat-ctx-modal-detail-tc">
                                        <div className="chat-ctx-modal-detail-tc-name">
                                          {tc.name || 'tool_call'}
                                        </div>
                                        {tc.arguments && (
                                          <pre className="chat-ctx-modal-detail-pre">
                                            {tc.arguments}
                                          </pre>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </>
          )}
        </div>
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
        <div className="chat-table-wrap">
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
  return sharedToolLabel(tool.tool)
}

// 后台 subagent / 后台任务与 CLI TaskStatusBar 对齐：状态来自 app-server 的
// mica/*Tasks/updated 快照通知（跨 turn 常驻，不依赖当前 running 状态）。
function buildTaskForest(tasks) {
  const byId = new Map(tasks.map((task) => [task.taskId, task]))
  const childrenByParent = new Map()
  const roots = []
  for (const task of tasks) {
    const parentId = task.parentTaskId
    if (parentId && byId.has(parentId) && parentId !== task.taskId) {
      const list = childrenByParent.get(parentId) || []
      list.push(task)
      childrenByParent.set(parentId, list)
      continue
    }
    roots.push(task)
  }
  const byStarted = (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)
  roots.sort(byStarted)
  for (const children of childrenByParent.values()) children.sort(byStarted)
  return { roots, childrenByParent }
}

function shellBaseName(shell) {
  return (
    String(shell || '')
      .split('/')
      .filter(Boolean)
      .pop() || 'shell'
  )
}

// 详情字段可能是对象（工具结果 / 错误对象），直接渲染会抛 React 子节点错误。
function textOf(value) {
  if (value == null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function SubagentTaskRowView({ task, childrenByParent, depth = 0, nowMs, onOpen }) {
  const activities = (task.activities || []).filter((activity) => activity.toolName !== 'Agent')
  const childTasks = childrenByParent.get(task.taskId) || []
  const age = formatLogElapsed(Math.max(0, nowMs - (Date.parse(task.startedAt) || nowMs)))
  const indent = Math.min(depth * 14, 42)
  // 与 CLI SubagentTaskRow 对齐：嵌套行（depth > 0）和活动行共用同一个
  // ` ⎿ ` 前缀（⎿ 列对齐），并随深度缩进；5 列 grid 放不下第 6 个前缀格，
  // 嵌套行改用 flex 布局。
  const summaryRow = (
    <>
      {depth > 0 && <span className="chat-task-child-prefix"> ⎿ </span>}
      <span className="chat-task-kind">🤖(subagent)</span>
      <span className="chat-task-status chat-task-status-running">{task.status}</span>
      <span className="chat-task-runtime">{age}</span>
      <span className="chat-task-type">{task.subagentType}</span>
      <span className="chat-task-description">{compactLine(task.description, 180)}</span>
    </>
  )
  return (
    <div>
      <button
        type="button"
        className={`chat-task-summary-row chat-task-openable ${
          depth > 0 ? 'chat-task-summary-row-nested' : ''
        }`}
        style={depth > 0 ? { paddingLeft: indent } : undefined}
        title="查看 subagent 详情"
        onClick={() => onOpen?.(task)}
      >
        {summaryRow}
      </button>
      {activities.map((activity) => (
        <div className="chat-task-child" key={activity.id} style={{ paddingLeft: indent }}>
          <span className="chat-task-child-prefix"> ⎿ </span>
          <span className="chat-task-description">{compactLine(activity.summary, 180)}</span>
        </div>
      ))}
      {childTasks.map((child) => (
        <SubagentTaskRowView
          key={child.taskId}
          task={child}
          childrenByParent={childrenByParent}
          depth={depth + 1}
          nowMs={nowMs}
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}

function SubagentStatusDock({ tasks, now = Date.now(), onOpen }) {
  const { roots, childrenByParent } = useMemo(() => buildTaskForest(tasks), [tasks])
  if (!roots.length) return null
  return (
    <section className="chat-task-dock chat-subagent-dock" aria-label="运行中的 Subagent">
      {roots.map((task) => (
        <SubagentTaskRowView
          key={task.taskId}
          task={task}
          childrenByParent={childrenByParent}
          nowMs={now}
          onOpen={onOpen}
        />
      ))}
    </section>
  )
}

function BackgroundTasksDock({ tasks, now = Date.now(), onOpen, onKill, killingId }) {
  if (!tasks.length) return null
  return (
    <section className="chat-task-dock chat-background-dock" aria-label="运行中的后台任务">
      {tasks.map((task) => {
        const age = formatLogElapsed(Math.max(0, now - (Date.parse(task.startedAt) || now)))
        const shell = shellBaseName(task.shell)
        return (
          <div className="chat-task-row" key={task.id}>
            <button
              type="button"
              className="chat-task-summary-row chat-task-openable"
              title="查看输出"
              onClick={() => onOpen?.(task)}
            >
              <span className="chat-task-kind">$ ({shell})</span>
              <span className="chat-task-status chat-task-status-running">{task.status}</span>
              <span className="chat-task-runtime">{age}</span>
              <span className="chat-task-type">{task.id}</span>
              <span className="chat-task-description">{compactLine(task.command, 180)}</span>
            </button>
            <button
              type="button"
              className="chat-task-action"
              title="终止后台任务"
              aria-label={`终止后台任务 ${task.id}`}
              disabled={killingId === task.id}
              onClick={() => onKill(task)}
            >
              ✕
            </button>
          </div>
        )
      })}
    </section>
  )
}

function useTaskPolling({ task, isRunning, intervalMs, load }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const mountedRef = useRef(true)
  const inFlightRef = useRef(false)

  const poll = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      const res = await load()
      if (!mountedRef.current) return
      if (!res?.ok) {
        setError(res?.error || '获取详情失败')
        return
      }
      // host 侧成功，但 app-server 说这个任务不存在（已被回收/从未存在）。
      if (res.result?.ok === false) {
        setError(res.result.message || '获取详情失败')
        return
      }
      setDetail(res.result)
      setError(null)
    } catch (err) {
      if (mountedRef.current) setError(String(err?.message || err))
    } finally {
      inFlightRef.current = false
    }
  }, [load])

  useEffect(() => {
    mountedRef.current = true
    poll()
    return () => {
      mountedRef.current = false
    }
  }, [poll])

  const running = isRunning(detail?.task || task)

  useEffect(() => {
    if (!running) return undefined
    const timer = window.setInterval(poll, intervalMs)
    const ticker = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(timer)
      clearInterval(ticker)
    }
  }, [running, intervalMs, poll])

  return { detail, error, running, now }
}

function useStickToBottom(watch) {
  const bodyRef = useRef(null)
  const stickToBottomRef = useRef(true)

  // 与 TurnLogDock 一致：只有读者停留在底部时才跟随滚动。
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body && stickToBottomRef.current) body.scrollTop = body.scrollHeight
  }, [watch])

  const onBodyScroll = (event) => {
    const body = event.currentTarget
    stickToBottomRef.current =
      body.scrollHeight - body.scrollTop - body.clientHeight < SCROLL_BOTTOM_THRESHOLD
  }

  return { bodyRef, onBodyScroll }
}

function TaskDetailModal({ title, actions, onClose, bodyRef, onBodyScroll, children }) {
  useEffect(() => {
    const onKeyDown = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="chat-ctx-modal-overlay no-drag"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="chat-ctx-modal chat-task-modal" onClick={(event) => event.stopPropagation()}>
        <div className="chat-ctx-modal-header">
          <span className="chat-task-modal-title">{title}</span>
          <div className="chat-task-modal-header-actions">
            {actions}
            <button type="button" onClick={onClose} aria-label="关闭">
              Esc ✕
            </button>
          </div>
        </div>
        <div ref={bodyRef} className="chat-ctx-modal-body" onScroll={onBodyScroll}>
          {children}
        </div>
      </div>
    </div>
  )
}

function SubagentTimelineStep({ step }) {
  if (step.kind === 'thinking') {
    return <div className="chat-task-modal-thinking">{step.text}</div>
  }
  if (step.kind === 'text') {
    return <Markdown text={step.text} />
  }
  if (step.kind === 'tool') {
    return (
      <details className="chat-task-modal-step">
        <summary>
          {step.toolName} {compactLine(step.text, 90)}
        </summary>
        <pre>{step.text}</pre>
      </details>
    )
  }
  return (
    <details className="chat-task-modal-step">
      <summary>{step.toolName} 结果</summary>
      <pre>{step.text}</pre>
    </details>
  )
}

function SubagentDetailModal({ nodeId, task: initialTask, onClose, onStop }) {
  const load = useCallback(
    () => window.mica.chat.subagentDetail(nodeId, initialTask.taskId),
    [nodeId, initialTask.taskId]
  )
  const { detail, error, running, now } = useTaskPolling({
    task: initialTask,
    isRunning: isSubagentRunning,
    intervalMs: 1000,
    load
  })
  const [stopping, setStopping] = useState(false)
  const task = detail?.task || initialTask
  const steps = useMemo(() => buildSubagentTimeline(task), [task])
  const { bodyRef, onBodyScroll } = useStickToBottom(task)
  const elapsed = taskElapsedMs(task, now)
  const usage = task.usage

  const stop = async () => {
    if (stopping) return
    setStopping(true)
    try {
      await onStop?.(task.taskId)
    } finally {
      setStopping(false)
    }
  }

  return (
    <TaskDetailModal
      title={`🤖 ${task.subagentType || 'subagent'} · ${compactLine(task.description, 60)}`}
      onClose={onClose}
      bodyRef={bodyRef}
      onBodyScroll={onBodyScroll}
      actions={
        running ? (
          <button type="button" disabled={stopping} onClick={stop}>
            停止
          </button>
        ) : null
      }
    >
      {error && <div className="chat-task-modal-muted">{error}</div>}
      <div className="chat-ctx-modal-summary">
        <span>{subagentStatusLabel(task.status)}</span>
        {elapsed != null && (
          <>
            <span className="chat-ctx-modal-sep">·</span>
            <span className="tabular-nums">{formatLogElapsed(elapsed)}</span>
          </>
        )}
        {task.model && (
          <>
            <span className="chat-ctx-modal-sep">·</span>
            <span>{task.model}</span>
          </>
        )}
        {task.effort && (
          <>
            <span className="chat-ctx-modal-sep">·</span>
            <span>{task.effort}</span>
          </>
        )}
        <span className="chat-ctx-modal-sep">·</span>
        <span>{task.taskId}</span>
      </div>
      {usage && (
        <div className="chat-ctx-modal-summary">
          <span className="tabular-nums">
            {usage.records} requests · in {formatTokens(usage.inputTokens)} · out{' '}
            {formatTokens(usage.outputTokens)} · cached {formatTokens(usage.cachedInputTokens)} ·
            total {formatTokens(usage.totalTokens)}
          </span>
        </div>
      )}
      {task.prompt && (
        <details className="chat-task-modal-step">
          <summary>任务提示词</summary>
          <pre className="chat-task-modal-pre">{textOf(task.prompt)}</pre>
        </details>
      )}
      {task.timelineTruncated && <div className="chat-task-modal-muted">较早的步骤已省略。</div>}
      {steps.map((step) => (
        <SubagentTimelineStep key={step.key} step={step} />
      ))}
      {!running && <div className="chat-task-modal-muted">{subagentStatusLabel(task.status)}</div>}
      {task.result && (
        <div className="chat-task-modal-result">
          <div className="chat-task-modal-muted">结果</div>
          <Markdown text={textOf(task.result)} />
        </div>
      )}
      {task.error && <div className="chat-task-modal-error">{textOf(task.error)}</div>}
    </TaskDetailModal>
  )
}

function BackgroundTaskModal({ nodeId, task: initialTask, onClose, onKill }) {
  const load = useCallback(
    () => window.mica.chat.backgroundTaskOutput(nodeId, initialTask.id, 32000),
    [nodeId, initialTask.id]
  )
  const { detail, error, running, now } = useTaskPolling({
    task: initialTask,
    isRunning: isBackgroundTaskRunning,
    intervalMs: 1500,
    load
  })
  const task = detail?.task || initialTask
  const content = detail?.content || ''
  const { bodyRef, onBodyScroll } = useStickToBottom(detail)
  const elapsed = taskElapsedMs(task, now)

  return (
    <TaskDetailModal
      title={`$ (${shellBaseName(task.shell)}) · ${task.id}`}
      onClose={onClose}
      bodyRef={bodyRef}
      onBodyScroll={onBodyScroll}
      actions={
        running ? (
          <button
            type="button"
            className="chat-task-modal-danger"
            disabled={!onKill}
            onClick={() => onKill(task)}
          >
            终止
          </button>
        ) : null
      }
    >
      {error && <div className="chat-task-modal-muted">{error}</div>}
      <div className="chat-ctx-modal-summary">
        <span>{backgroundTaskStatusLabel(task.status)}</span>
        {elapsed != null && (
          <>
            <span className="chat-ctx-modal-sep">·</span>
            <span className="tabular-nums">{formatLogElapsed(elapsed)}</span>
          </>
        )}
        {task.exitCode != null && (
          <>
            <span className="chat-ctx-modal-sep">·</span>
            <span className="tabular-nums">exit {task.exitCode}</span>
          </>
        )}
        {task.signal && (
          <>
            <span className="chat-ctx-modal-sep">·</span>
            <span>{task.signal}</span>
          </>
        )}
        {detail && (
          <>
            <span className="chat-ctx-modal-sep">·</span>
            <span className="tabular-nums">{taskOutputWindowLabel(detail)}</span>
          </>
        )}
        <span className="chat-ctx-modal-sep">·</span>
        <span className="chat-task-modal-muted" title={task.cwd}>
          {compactLine(task.cwd, 60)}
        </span>
      </div>
      <div className="chat-task-modal-muted">{task.command}</div>
      {content ? (
        <pre className="chat-task-modal-output">{content}</pre>
      ) : (
        <div className="chat-ctx-modal-empty">（暂无输出）</div>
      )}
    </TaskDetailModal>
  )
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return ''
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
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
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </button>
  )
}

/** 双击用户消息进入的就地编辑：确认由 host 侧（app-server 的 mica/turn/editMessage）
 *  截断该消息及其之后的会话历史并用新文本重跑。截断后的历史不能与在跑的 turn
 *  竞争，所以确认只在 mica 空闲（!running）且有内容时可用。 */
export function canSubmitMessageEdit({ running, text }) {
  return !running && String(text ?? '').trim().length > 0
}

/** 与 app-server 的 `comparableText` 同款的定位归一化：折叠空白，并把 UI 侧的
 *  图片占位符统一成 CLI 的写法（host 的 readHistory 产出「[图片]」，provider
 *  历史里的图片块产出「[Image]」）。两边不一致定位就会错位。 */
function messageEditKey(text) {
  return String(text ?? '')
    .replace(/\[图片\]/g, '[Image]')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 同文本的用户消息在会话里出现多次时，被编辑的是从末尾数第几条（1 起）。
 *  持久化历史没有逐条消息 id，app-server 只能按文本定位，必须用同一套计数。 */
export function promptOccurrenceFromEnd(messages = [], messageId) {
  const index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) return 1
  const key = messageEditKey(messages[index]?.text)
  if (!key) return 1
  let occurrence = 1
  for (let cursor = index + 1; cursor < messages.length; cursor++) {
    const message = messages[cursor]
    if (message?.role !== 'user' || message.queued) continue
    if (messageEditKey(message.text) === key) occurrence += 1
  }
  return occurrence
}

function UserMessageEditor({ text, busy, canSubmit, onChange, onCancel, onSubmit }) {
  const ref = useRef(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return undefined
    // composer 的聚焦也在 mouseup 的 rAF 里排队，编辑框必须更晚拿到焦点。
    const frame = requestAnimationFrame(() => {
      element.focus()
      element.setSelectionRange(element.value.length, element.value.length)
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <div className="chat-message-edit" data-no-chat-focus>
      <textarea
        ref={ref}
        className="chat-message-edit-input"
        value={text}
        spellCheck={false}
        aria-label="编辑消息"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            if (canSubmit) onSubmit()
          }
        }}
      />
      <div className="chat-message-edit-actions">
        {busy && <span className="chat-message-edit-hint">Mica 正在运行，空闲后才能确认</span>}
        <button type="button" className="chat-message-edit-cancel" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="chat-message-edit-confirm"
          disabled={!canSubmit}
          title={busy ? 'Mica 正在运行，空闲后才能确认' : '改写这条消息并重新运行 mica'}
          onClick={onSubmit}
        >
          确认
        </button>
      </div>
    </div>
  )
}

function lastTodoState(messages) {
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
    if (valid && inProgress <= 1) {
      return { items: normalized, turnId: message.turnId || null, index }
    }
  }
  return null
}

function latestTodoState(messages) {
  return lastTodoState(messages) ?? { items: [], turnId: null }
}

export function latestTodoItems(messages) {
  return latestTodoState(messages).items
}

// 与 Todo 插件的 turn:after 规则同款：正常结束的 turn 把未完成项（in_progress 与
// pending）全部标为 completed，列表随之隐藏，否则残留的 pending 项会让计划面板在
// 运行结束后一直显示 "N remaining"。桌面端没有插件状态、计划是从工具事件重建的，
// 所以在 turn 正常结束时就地收口；abort/error 交给 todoItemsForTurn 的暂停展示。
export function completeRemainingTodoItems(messages) {
  const state = lastTodoState(messages)
  if (!state || state.items.every((item) => item.status === 'completed')) return messages
  return messages.map((message, index) => {
    if (index !== state.index) return message
    const todos = message.tool.input.todos
    return {
      ...message,
      tool: {
        ...message.tool,
        input: {
          ...message.tool.input,
          todos: todos.map((item) =>
            item.status === 'completed' ? item : { ...item, status: 'completed' }
          )
        }
      }
    }
  })
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
      <div className="chat-task-children">
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
                <IconLoader2 size={10} className="animate-spin" />
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
          {message.action === 'terminal' && <IconTerminal size={12} />}
          {message.actionLabel || '打开'}
          <IconExternalLink size={10} />
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

function visibleShellOutput(tool, durationMs) {
  // 阈值与 CLI 的 MICA_RUN_SHELL_* 同源（preload 注入），默认值一致。
  const config = typeof window !== 'undefined' ? window.mica?.runShellLogConfig : undefined
  const threshold = config?.verboseThresholdMs ?? 10_000
  const maxLines = config?.maxLines ?? 10
  if (tool.tool !== 'run_shell' || durationMs <= threshold || !tool.output) return []
  return String(tool.output).replace(/\n$/, '').split('\n').slice(-maxLines)
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
            <IconLoader2 size={10} className="animate-spin" />
          </span>
        )}
        <span className="chat-turn-log-icon">{getToolIcon(tool.tool)}</span>
        <span className="chat-turn-log-display">
          {tool.displayText ||
            `${toolDisplayName(tool)}${toolSummary(tool) ? ` ${toolSummary(tool)}` : ''}`}
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
        className="chat-turn-log-scroll"
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
  const ref = useRef(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })
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
  useLayoutEffect(() => {
    if (!ref.current) return
    const w = ref.current.offsetWidth
    const h = ref.current.offsetHeight
    let px = menu.x
    let py = menu.y
    if (px + w > window.innerWidth - 4) px = Math.max(4, window.innerWidth - w - 4)
    if (py + h > window.innerHeight - 4) py = Math.max(4, window.innerHeight - h - 4)
    setPos({ x: px, y: py })
  }, [menu.x, menu.y])
  const items = [
    {
      id: 'compact-local',
      label: '快速压缩（本地）',
      title: '本地压缩：仅把工具结果替换为占位符，不改动对话内容、不丢弃轮次；不调用模型',
      icon: IconBolt,
      disabled: !menu.hasSession || menu.running
    },
    {
      id: 'compact-model',
      label: '模型压缩',
      title: '调用模型生成会话摘要',
      icon: IconMinimize,
      disabled: !menu.hasSession || menu.running
    },
    {
      id: 'commit',
      label: 'Commit',
      icon: IconGitCommit,
      disabled: menu.running || commitRunning,
      title: commitRunning ? 'commit 任务正在执行' : undefined
    },
    { id: 'fork', label: 'Fork', icon: IconGitFork, disabled: !menu.hasSession || menu.running },
    { separator: true },
    { id: 'clear', label: 'Clear', icon: IconTrash, disabled: menu.running, danger: true }
  ]
  return (
    <div
      ref={ref}
      className="fixed z-[10000] min-w-[220px] rounded-md border border-white/12 bg-panel/98 p-1 shadow-2xl backdrop-blur"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      data-no-chat-focus
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={`separator-${index}`} className="mx-1 my-1 h-px bg-white/10" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            title={item.title}
            className={`flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[13px] enabled:hover:bg-white/[.08] disabled:opacity-35 ${item.danger ? 'text-danger-soft' : 'text-white/90 enabled:hover:text-white'}`}
            onClick={() => onAction(item.id)}
          >
            <span className="grid w-4 shrink-0 place-items-center">
              <item.icon size={14} className="shrink-0 opacity-75" />
            </span>
            <span className="flex-1">{item.label}</span>
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
        <IconCommand size={12} /> {title}
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

function MessageRow({
  message,
  onOpenFile,
  onPreviewImage,
  onCommandAction,
  edit,
  onEditStart,
  onEditChange,
  onEditCancel,
  onEditSubmit
}) {
  if (message.kind === 'command') {
    return <CommandRow message={message} onCommandAction={onCommandAction} />
  }
  if (message.kind === 'notice') {
    const title =
      message.command ||
      (message.variant === 'compact' ? '/compact' : message.variant === 'error' ? '/error' : '')
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
    if (edit) {
      return (
        <div className="chat-message chat-message-user chat-message-editing">
          <div className="chat-message-marker">▌</div>
          <UserMessageEditor
            text={edit.text}
            busy={edit.busy}
            canSubmit={edit.canSubmit}
            onChange={onEditChange}
            onCancel={onEditCancel}
            onSubmit={onEditSubmit}
          />
        </div>
      )
    }
    return (
      <div
        className={`chat-message chat-message-user ${message.queued ? 'chat-message-queued' : ''}`}
        onDoubleClick={(event) => {
          if (event.target.closest('button')) return
          onEditStart?.(message)
        }}
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
    variant: row.variant ?? (row.role === 'notice' ? 'info' : undefined),
    command: row.command ?? undefined,
    status: row.status ?? undefined,
    usage: row.usage ?? null,
    done: true
  }))
}

// 会话里的用户文本把图片块渲染成 [图片] 占位符，输入框原文是 [Image](路径)；
// 比对用户消息边界时忽略占位符与首尾空白，否则带图片的输入永远匹配不到。
function promptKey(text) {
  return String(text || '')
    .replace(/\[图片\]/g, '')
    .trim()
}

export function hasPersistedTurn(messages, prompt) {
  if (!prompt) return false
  const key = promptKey(prompt)
  const userIndex = messages.findLastIndex(
    (message) => message.role === 'user' && promptKey(message.text) === key
  )
  return (
    userIndex >= 0 &&
    messages.slice(userIndex + 1).some((message) => message.role === 'assistant' && message.text)
  )
}

export function historyBeforeRunReplay(messages, prompt) {
  if (!prompt) return messages
  const key = promptKey(prompt)
  const userIndex = messages.findLastIndex(
    (message) => message.role === 'user' && promptKey(message.text) === key
  )
  if (userIndex < 0) return messages
  // 只丢掉会被事件重放重建的 assistant 输出；本轮内持久化的用户消息
  // （shift+tab 注入的排队输入夹在回答之间）必须保留，否则重开后消失。
  return [
    ...messages.slice(0, userIndex + 1),
    ...messages.slice(userIndex + 1).filter((message) => message.role === 'user')
  ]
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

export function activateQueuedMessage(messages, queuedMessageId) {
  if (!queuedMessageId) return messages
  const index = messages.findIndex((message) => message.id === queuedMessageId)
  if (index < 0) return messages
  const queuedMessage = messages[index]
  return [
    ...messages.slice(0, index),
    ...messages.slice(index + 1),
    { ...queuedMessage, queued: false }
  ]
}

// 会话顶部「最后一条用户消息」栏：取最后一条已发送的用户消息。排队中的消息不算
// （它们在输入框上方的 queue dock 里单独展示），空文本消息也不参与。
export function lastUserPromptText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user' || message.queued) continue
    const text = typeof message.text === 'string' ? message.text.trim() : ''
    if (text) return text
  }
  return ''
}

// 输入框内 Tab / Shift+Tab 的行为：
// - agent 运行中（queueReady）：Tab 与 Shift+Tab 都把当前输入排队发送（Shift+Tab 对应 CLI 的 after_iteration 快速排队）；
// - 空闲时 Shift+Tab：打开角色选择器，与 CLI 的 Shift+Tab 角色循环对齐；
// - 空闲 Tab：不拦截，交给浏览器默认行为。
export function resolveComposerTabAction({ shiftKey, queueReady }) {
  if (queueReady) return 'queue'
  if (shiftKey) return 'cycle-role'
  return null
}

// 模型切换的协议校验：有历史会话时同协议放行、跨协议拒绝；新会话或
// 无法判定协议（协议信息缺失）时保守放行。返回 { allowed: true } 或
// { allowed: false, reason }。reason 文案与 CLI 的跨协议提示保持一致。
export function resolveModelSwitchProtocol({ modelId, hasHistory, protocolMap, currentProtocol }) {
  if (!hasHistory) return { allowed: true }
  const nextProtocol = protocolMap?.[modelId]?.protocol
  if (!nextProtocol || !currentProtocol || nextProtocol === currentProtocol) {
    return { allowed: true }
  }
  return {
    allowed: false,
    reason: `当前会话使用 ${currentProtocol} 协议，目标模型使用 ${nextProtocol} 协议；跨协议切换会丢失会话历史，请先新建会话或清空当前会话`
  }
}

export function switchChatDraft(drafts, previousNodeId, nextNodeId, currentInput) {
  if (previousNodeId === nextNodeId) return currentInput
  if (previousNodeId) drafts.set(previousNodeId, currentInput)
  return drafts.get(nextNodeId) || ''
}

// 输入框历史浏览：direction < 0 为 ArrowUp（往旧），> 0 为 ArrowDown（往新）。
// cursor 为 -1 表示处于 draft 模式（未发送输入），>= 0 时直接索引 history（最新在末尾）。
// draft 只在首次 ArrowUp 进入历史时保存一次，浏览过程中不允许覆盖；
// 回到 draft 模式（cursor 回到 -1）时恢复原始输入。返回 null 表示无变化。
export function navigateChatHistory(drafts, history, cursorRef, direction, currentInput, nodeId) {
  if (!history.length) return null
  let cursor = cursorRef.current
  if (direction < 0) {
    if (cursor < 0) drafts.set(nodeId, currentInput)
    cursor = cursor < 0 ? history.length - 1 : Math.max(0, cursor - 1)
  } else {
    if (cursor < 0) return null
    cursor = Math.min(history.length, cursor + 1)
  }
  const nextCursor = cursor === history.length ? -1 : cursor
  cursorRef.current = nextCursor
  return nextCursor < 0 ? drafts.get(nodeId) || '' : history[nextCursor]
}

// 光标位于第一行（按 ArrowUp 触发输入历史）时返回 true；多行输入下
// 保持"非第一行时上箭头先移动光标"的编辑习惯（对齐 ChatGPT 等终端式输入框）。
export function isCaretOnFirstLine(element) {
  const value = typeof element?.value === 'string' ? element.value : ''
  const start = element?.selectionStart ?? 0
  return value.slice(0, start).indexOf('\n') < 0
}

// 光标位于最后一行（按 ArrowDown 触发输入历史）时返回 true。
export function isCaretOnLastLine(element) {
  const value = typeof element?.value === 'string' ? element.value : ''
  const end = element?.selectionEnd ?? value.length
  return value.slice(end).indexOf('\n') < 0
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
  onSessionRenamed,
  onDraftChange
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
  const onDraftChangeRef = useLatest(onDraftChange)
  const sessionIdRef = useRef(node?.sessionId || null)
  const streamRef = useRef({ id: null, kind: null, turnId: null })
  const turnRef = useRef(null)
  const finishedRef = useRef(true)
  // 当前 turn 的开始时间戳（ref 形式，applyEvent 闭包里可读），
  // 用于 step_finish 时计算整轮耗时并在状态行展示（对齐 CLI completed <elapsed>）。
  const turnStartedAtRef = useRef(0)
  const restoringRef = useRef(false)
  const restoreGenerationRef = useRef(0)
  const pendingEventsRef = useRef([])
  const pendingExitRef = useRef(null)
  const loadedNodeRef = useRef(null)
  const transcriptCacheRef = useRef(new Map())
  const draftsRef = useRef(new Map())
  // 已经上报给侧栏的「哪个节点的未发送文本」，用来去重（每次按键都 setState 会把
  // 整个 App 拖着重渲染）。
  const draftReportRef = useRef({ nodeId: null, text: '' })
  const todoHiddenRef = useRef(new Map())
  // 输入历史与 CLI 共享（~/.mica/storage.json 的 inputHistory），跨节点共用
  // 一份数组；挂载时从磁盘加载，发送时异步回写。
  const inputHistoryRef = useRef([])
  const queuedMessageIdsRef = useRef([])
  const recallingQueueRef = useRef(null)
  const historyCursorRef = useRef(-1)
  const stickToBottomRef = useRef(true)
  const shellPointerRef = useRef(null)

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const inputRef = useLatest(input)
  const [running, setRunning] = useState(false)
  // 这个会话正被别处跑着（另一窗口/页签，或另一个进程持着它的 turn lease）：
  // 本窗口拿不到那一轮的事件流，只能显示状态并挡下发送，等它结束后自己收敛。
  const [remoteRunning, setRemoteRunning] = useState(false)
  const remoteRunningRef = useLatest(remoteRunning)
  const [queuedItems, setQueuedItems] = useState([])
  const [recallingQueueId, setRecallingQueueId] = useState(null)
  // 跨 turn 常驻的后台任务 / subagent 状态（来自 app-server 快照通知，
  // 与 CLI TaskStatusBar 一致地展示在输入框上方）。
  const [backgroundTasks, setBackgroundTasks] = useState([])
  const [subagentTasks, setSubagentTasks] = useState([])
  const [taskNow, setTaskNow] = useState(() => Date.now())
  // 点开的任务详情弹窗（单槽位）：{ kind: 'subagent' | 'background', task } | null
  const [taskDetail, setTaskDetail] = useState(null)
  const [killingTaskId, setKillingTaskId] = useState(null)
  const [stopping, setStopping] = useState(false)
  const [phase, setPhase] = useState('idle')
  const [runStartedAt, setRunStartedAt] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  // 最近一次 turn 的结束结果：{ state: 'completed' | 'error', durationMs }。
  // 运行结束后状态行左侧展示它（对齐 CLI：completed 绿色带耗时、error 红色、aborted 不展示）。
  const [lastRun, setLastRun] = useState(null)
  // 当前阶段/工具的实时耗时（对齐 CLI WorkingStatus：状态文本带 elapsed，
  // working 阶段从最早 running 工具 startedAt 起算，其余阶段从 phase 切换起算）。
  const phaseStartedAtRef = useRef(0)
  const [phaseElapsed, setPhaseElapsed] = useState(0)

  // 有活跃后台任务 / subagent 时每秒刷新耗时，空闲时停表。
  const hasLiveTasks = backgroundTasks.length > 0 || subagentTasks.length > 0
  useEffect(() => {
    if (!hasLiveTasks) return undefined
    const timer = window.setInterval(() => setTaskNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [hasLiveTasks])

  useEffect(() => {
    if (phase === 'idle' || !running) return undefined
    phaseStartedAtRef.current = Date.now()
    return undefined
  }, [phase, running])
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
  const [contextDetail, setContextDetail] = useState(false)
  const [commitRunning, setCommitRunning] = useState(false)
  // 双击用户消息进入的就地编辑（单槽位）：{ id, prompt, text } | null
  const [messageEdit, setMessageEdit] = useState(null)
  const commitTaskRef = useRef(null) // { id, noticeId, cwd, nodeId }
  // 输入框区域手动设定的最小高度（px）；null 表示跟随默认 30px
  const [composerMinHeight, setComposerMinHeight] = useState(null)
  const pickerRef = useRef(null)
  const messagesRef = useRef([])
  const modelProtocolsRef = useRef(null) // { map: { [modelId]: { protocol, efforts } }, currentProtocol }
  const protocolBlockRef = useRef('')
  const compactBusyRef = useRef(false)
  const listRef = useRef(null)
  const transcriptRef = useRef(null)
  const composerDockRef = useRef(null)
  const textareaRef = useRef(null)
  const imageInputRef = useRef(null)

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

  const openTaskDetail = useCallback((kind, task) => setTaskDetail({ kind, task }), [])

  const killBackgroundTask = useCallback(
    async (task) => {
      if (
        !window.confirm(`确定要终止后台任务 ${task.id} 吗？\n\n${compactLine(task.command, 160)}`)
      ) {
        return
      }
      setKillingTaskId(task.id)
      try {
        const res = await window.mica.chat.killBackgroundTask(nodeId, task.id)
        if (!res?.ok || res.result?.ok === false) {
          appendNotice(res?.error || res?.result?.message || '终止后台任务失败', 'error')
        } else if (res.result?.stillRunning) {
          appendNotice(res.result.message || '后台任务仍在运行', 'warn')
        }
      } catch (error) {
        appendNotice(`终止后台任务失败：${error?.message || error}`, 'error')
      } finally {
        setKillingTaskId(null)
      }
    },
    [appendNotice, nodeId]
  )

  const stopSubagent = useCallback(
    async (taskId) => {
      if (!window.confirm('确定要停止这个 subagent 任务吗？')) return
      try {
        const res = await window.mica.chat.killSubagent(nodeId, taskId)
        if (!res?.ok || res.result?.ok === false) {
          appendNotice(res?.error || res?.result?.message || '停止 subagent 失败', 'error')
        }
      } catch (error) {
        appendNotice(`停止 subagent 失败：${error?.message || error}`, 'error')
      }
    },
    [appendNotice, nodeId]
  )

  // 把文本插到光标处（粘贴图片与移动端「上传照片」共用）。以 textarea 当前的值为准，
  // 因为选照片/上传是异步的，回调执行时闭包里的 input 可能已经过期。
  const insertComposerText = useCallback(
    (text) => {
      if (!text) return
      const element = textareaRef.current
      const current = element?.value ?? inputRef.current ?? ''
      const start = element?.selectionStart ?? current.length
      const end = element?.selectionEnd ?? current.length
      const next = current.slice(0, start) + text + current.slice(end)
      draftsRef.current.set(nodeId, next)
      setInput(next)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.setSelectionRange(start + text.length, start + text.length)
        el.focus()
      })
    },
    [inputRef, nodeId]
  )

  // 相册/拍照选到的图片与粘贴一样：先落到 mica 的 images 目录，再把 [Image](...) 引用
  // 插进输入框（引用格式由 CLI 解析，见 host/chat-images.js）。
  const attachImages = useCallback(
    async (files) => {
      const list = Array.from(files || [])
      if (!list.length) return
      const refs = []
      for (const file of list) {
        try {
          const result = await window.mica.chat.savePastedImage({ file })
          if (result?.ok && result.ref) refs.push(result.ref)
          else appendNotice(result?.error || `上传 ${file.name || '图片'} 失败`, 'error')
        } catch (error) {
          appendNotice(`上传 ${file.name || '图片'} 失败：${error?.message || error}`, 'error')
        }
      }
      if (refs.length) insertComposerText(refs.map((ref) => `[Image](${ref})`).join(' '))
    },
    [appendNotice, insertComposerText]
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

  // host 每个工具迭代都会推一次实时用量：长 turn 期间用它刷新输入框状态栏的
  // tokens/cached/ctx，而不是等 step_finish。刻意不动 turnState/updatedAt——
  // 它们参与 isPersistedRunComplete 的「本轮是否已落盘」判定，运行中改写会让
  // 恢复流程误判本轮已结束。
  const applyStreamingUsageMeta = useCallback((tokens) => {
    const usage = metaUsageFromStepTokens(tokens)
    if (!usage) return
    setMeta((previous) => {
      const cachedRate =
        usage.inputTokens > 0
          ? usage.cachedInputTokens / usage.inputTokens
          : previous?.cachedRate || 0
      return { ...(previous || {}), lastUsage: usage, cachedRate }
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
            updateMessages((previous) => activateQueuedMessage(previous, queuedMessageId))
          }
          if (event.sessionID && !sessionIdRef.current) {
            sessionIdRef.current = event.sessionID
            onSessionBoundRef.current?.(nodeIdRef.current, event.sessionID)
          }
          turnRef.current = `${event.sessionID || nodeIdRef.current}:${timestamp}`
          streamRef.current = { id: null, kind: null, turnId: turnRef.current }
          finishedRef.current = false
          turnStartedAtRef.current = timestamp
          setLastRun(null)
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
            displayText: part.displayText || null,
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
        case 'notice':
          // Host 侧非致命降级（stale --dir、MCP 初始化失败、游离 rejection）：
          // 只提示，不改变运行状态，turn 继续。
          if (event.text) appendNotice(event.text, event.variant || 'info')
          break
        case 'usage':
          // 实时用量（每次模型请求后到达）：只刷新状态栏数字，不改变 turn 状态。
          if (event.tokens) applyStreamingUsageMeta(event.tokens)
          break
        case 'step_finish': {
          finishStream(timestamp)
          finishPendingTools(event.part?.reason === 'aborted' ? 'aborted' : 'error', timestamp)
          // 对齐 Todo 插件的 turn:after：正常结束的 turn 之后不再展示残留计划项。
          if (event.part?.reason === 'completed') {
            updateMessages(completeRemainingTodoItems)
          }
          // failed turn 的真实原因在 turn/completed 通知的 error 字段里透传，
          // 否则模型 400 / provider 配置错误等失败只会把 phase 置为 error，
          // 用户看到“运行了又马上停止”却没有任何提示。
          if (event.part?.reason === 'error' && event.part?.error) {
            appendNotice(compactLine(String(event.part.error), 1000), 'error')
          }
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
          // 运行结束后状态行左侧展示结果（对齐 CLI WorkingStatus 的 completed/error）。
          const turnStartedAt = turnStartedAtRef.current
          const durationMs = turnStartedAt ? Math.max(0, timestamp - turnStartedAt) : 0
          const reason = event.part?.reason
          if (reason === 'completed') setLastRun({ state: 'completed', durationMs })
          else if (reason === 'error') setLastRun({ state: 'error', durationMs })
          else setLastRun(null) // aborted：对齐 CLI abort 后 idle 空白
          if (event.sessionID) refreshMetaSoon(event.sessionID)
          break
        }
        case 'background_tasks':
          // Host 快照：整体替换后台任务列表（跨 turn 常驻展示）。
          setBackgroundTasks(Array.isArray(event.tasks) ? event.tasks : [])
          break
        case 'subagent_tasks':
          // Host 快照：整体替换运行中 subagent 列表（含后台 subagent）。
          setSubagentTasks(Array.isArray(event.tasks) ? event.tasks : [])
          break
        case 'session_history_replaced': {
          // session_compact 工具在 host 侧替换了持久化历史（主进程已重新
          // 读取会话文件）：立即用新历史替换消息列表，而不是保留旧记录直到
          // 会话重开。流式行随替换一并丢弃（turn 已完成，紧随其后的
          // step_finish 只做收尾）。
          finishStream(timestamp)
          const rows = historyMessages(
            Array.isArray(event.history) ? event.history : [],
            event.sessionID || nodeIdRef.current
          )
          updateMessages((previous) => {
            const queued = previous.filter((message) => message.queued)
            return queued.length > 0 ? [...rows, ...queued] : rows
          })
          setHistoryLoaded(true)
          break
        }
      }
    },
    [
      appendNotice,
      appendPart,
      finishPendingTools,
      finishStream,
      setHistoryLoaded,
      nodeIdRef,
      onSessionBoundRef,
      applyLiveUsageMeta,
      applyStreamingUsageMeta,
      refreshMetaSoon,
      updateMessages,
      setBackgroundTasks,
      setSubagentTasks
    ]
  )
  const applyEventRef = useLatest(applyEvent)

  const processExit = useCallback(
    (payload) => {
      finishStream()
      finishPendingTools(payload?.aborted ? 'aborted' : 'error')
      const finished = finishedRef.current
      if (!finished && payload?.error) {
        const message = compactLine(payload.error, 1000)
        appendNotice(message || 'mica 进程异常退出', 'error')
      }
      if (!finished && payload?.exitCode && !payload?.error) {
        appendNotice(`mica 进程已退出（code ${payload.exitCode}）`, 'error')
      }
      finishedRef.current = true
      setRunning(false)
      setStopping(false)
      // step_finish 已到达时保留其 phase（error 保持 error 以展示 turn log），
      // 否则（进程异常退出）回落到 idle。
      setPhase((current) => (finished ? current : 'idle'))
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
      const items = Array.isArray(payload.queuedItems) ? payload.queuedItems : []
      setQueuedItems(items)
      // 同步消息的排队标记：host 的 after_iteration 排队（mica/queue/queued
      // 扩展通知）也会把对应乐观消息标记为排队，dequeue 后恢复，与本地
      // after_turn 排队展示一致。
      const queuedIds = new Set(items.map((item) => item?.id))
      updateMessages((previous) => {
        let changed = false
        const next = previous.map((message) => {
          const isQueued = queuedIds.has(message.id)
          if (message.queued === isQueued) return message
          changed = true
          return { ...message, queued: isQueued }
        })
        return changed ? next : previous
      })
    })
    const offQueueError = window.mica.chat.onQueueError((payload) => {
      if (payload.id !== nodeIdRef.current) return
      // turn/start 或 turn/steer 被 host 拒绝：这条消息从未进入队列，撤回
      // 乐观气泡（否则它会永远显示为"已排队"），输入框空闲时把原文放回去，
      // 语义对齐 CLI 撤回排队消息。
      const rejectedId = payload.clientMessageId
      if (rejectedId) {
        queuedMessageIdsRef.current = queuedMessageIdsRef.current.filter((id) => id !== rejectedId)
        updateMessages((previous) => previous.filter((message) => message.id !== rejectedId))
        setQueuedItems((items) => items.filter((item) => item.id !== rejectedId))
      }
      if (payload.text && !(inputRef.current || '').trim()) {
        draftsRef.current.set(nodeIdRef.current, payload.text)
        setInput(payload.text)
      }
      appendNotice(payload.error || '消息发送失败', 'error')
    })
    return () => {
      offEvent?.()
      offExit?.()
      offQueueState?.()
      offQueueError?.()
    }
  }, [appendNotice, applyEventRef, nodeId, nodeIdRef, processExitRef, updateMessages])

  // 切走之后输入框就看不见了，未发送的文本由侧栏那行代为提示。必须声明在下面那个
  // 切换 effect 之前：切换那一帧 input 还是上一个会话的，先让它按 nodeId 覆盖式上报，
  // 紧接着切换 effect 会把旧节点的文本与落到本节点上的草稿各上报一次，收敛到正确值。
  useEffect(() => {
    if (!nodeId) return
    const text = input || ''
    const reported = draftReportRef.current
    if (reported.nodeId === nodeId && reported.text === text) return
    draftReportRef.current = { nodeId, text }
    onDraftChangeRef.current?.(nodeId, text)
  }, [input, nodeId])

  useEffect(() => {
    if (!nodeId) return undefined
    const previousNodeId = loadedNodeRef.current
    if (previousNodeId && previousNodeId !== nodeId && messagesRef.current.length > 0) {
      transcriptCacheRef.current.set(previousNodeId, messagesRef.current)
    }
    const nextInput = switchChatDraft(draftsRef.current, previousNodeId, nodeId, inputRef.current)
    if (previousNodeId && previousNodeId !== nodeId) {
      onDraftChangeRef.current?.(previousNodeId, inputRef.current)
    }
    draftReportRef.current = { nodeId, text: nextInput || '' }
    onDraftChangeRef.current?.(nodeId, nextInput)
    loadedNodeRef.current = nodeId
    const cachedTranscript = transcriptCacheRef.current.get(nodeId)
    const generation = ++restoreGenerationRef.current
    restoringRef.current = true
    pendingEventsRef.current = []
    pendingExitRef.current = null
    stickToBottomRef.current = true
    setShowJump(false)
    updateMessages([])
    setInput(nextInput)
    setTodoHidden(todoHiddenRef.current.get(nodeId) === true)
    setPicker(null)
    setPickerIndex(0)
    queuedMessageIdsRef.current = []
    recallingQueueRef.current = null
    setRunning(false)
    setQueuedItems([])
    setRecallingQueueId(null)
    setBackgroundTasks([])
    setSubagentTasks([])
    setStopping(false)
    setPhase('idle')
    setRunStartedAt(0)
    setLastRun(null)
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

      const state = await window.mica.chat
        .isRunning(nodeId, sessionId || sessionIdRef.current || null)
        .catch(() => null)
      if (generation !== restoreGenerationRef.current || nodeIdRef.current !== nodeId) return
      setRemoteRunning(Boolean(state?.remoteRunning))
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
      const replayEvents = mergeReplayEvents(state?.events, pendingEventsRef.current)
      // 磁盘上的中间 checkpoint（每个工具迭代边界保存）与完成保存已经把本轮
      // 已生成的回答写进 conversationMessages，host 的事件缓冲又会重建同一段
      // 内容：重放前必须先裁掉本轮已持久化的 assistant 输出，否则切换节点
      // 回来会看到同一条消息渲染两遍。
      const trimActiveTurn = (messages) =>
        replayEvents.length > 0 ? historyBeforeRunReplay(messages, state.prompt) : messages

      if (state?.running) {
        if (state.sessionId && !sessionIdRef.current) {
          sessionIdRef.current = state.sessionId
          onSessionBoundRef.current?.(nodeId, state.sessionId)
        }
        updateMessages(trimActiveTurn(restored))
        // 裁剪后本轮用户消息仍在列表里；只有匹配不到边界（例如带图片的输入
        // 文本与会话展示文本不一致）时才补一条，避免重复渲染同一条用户消息。
        if (state.prompt) {
          const key = promptKey(state.prompt)
          const hasPrompt = messagesRef.current.some(
            (message) => message.role === 'user' && promptKey(message.text) === key
          )
          if (!hasPrompt) {
            updateMessages((previous) => [
              ...previous,
              { id: uid('msg'), kind: 'message', role: 'user', text: state.prompt, done: true }
            ])
          }
        }
        setRunStartedAt(state.startedAt || Date.now())
        setRunning(true)
        finishedRef.current = false
      } else if (cachedTranscript && canReuseVisualTranscript(cachedTranscript, restored)) {
        updateMessages(trimActiveTurn(cachedTranscript))
      } else {
        updateMessages(trimActiveTurn(restored))
      }

      for (const event of replayEvents) {
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
    inputRef,
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

  // 别处那一轮结束后本窗口自己收敛：复查 turn lease，释放了就解除只读并重拉会话历史
  // （那一轮的 assistant 消息由对方的进程写进文件，本窗口没有对应的事件流）。
  useEffect(() => {
    if (!remoteRunning) return undefined
    const timer = window.setInterval(async () => {
      const state = await window.mica.chat
        .isRunning(nodeIdRef.current, sessionIdRef.current || null)
        .catch(() => null)
      if (!state || state.remoteRunning || state.running) return
      setRemoteRunning(false)
      const finalSessionId = state.sessionId || sessionIdRef.current
      if (!finalSessionId) return
      const rows = await window.mica.chat.history(finalSessionId).catch(() => null)
      if (!Array.isArray(rows)) return
      updateMessages(historyMessages(rows, finalSessionId))
      refreshMetaSoon(finalSessionId)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [remoteRunning, nodeIdRef, refreshMetaSoon, updateMessages])

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

  // 挂载时加载与 CLI 共享的输入历史（~/.mica/storage.json）；失败静默，
  // 历史为空时上下键导航保持原样（无操作）。
  useEffect(() => {
    window.mica.chat.inputHistory
      .read()
      .then((history) => {
        if (Array.isArray(history) && history.length) inputHistoryRef.current = history
      })
      .catch(() => {})
  }, [])

  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current
    if (!element || SUPPORTS_FIELD_SIZING) return
    // Chromium 117+ 的 field-sizing: content 让 textarea 高度自动跟随内容，
    // 无需 JS 逐键测量（style.height='auto' + scrollHeight 读取会强制整页
    // 布局，模型流式渲染时表现为输入抖动）。旧内核才走这里。
    element.style.height = 'auto'
    element.style.height = `${Math.max(30, Math.min(element.scrollHeight, MAX_INPUT_ROWS * 22))}px`
  }, [])

  const startComposerResize = useCallback((event) => {
    event.preventDefault()
    event.stopPropagation()
    const startY = event.clientY
    const startH = textareaRef.current?.parentElement?.offsetHeight ?? 30
    const resizer = event.currentTarget
    const onMove = (moveEvent) => {
      const delta = startY - moveEvent.clientY
      const next = Math.max(30, Math.min(400, startH + delta))
      setComposerMinHeight(next)
      composerDockRef.current?.style.setProperty('--chat-composer-min-h', `${next}px`)
      composerDockRef.current?.style.setProperty(
        '--chat-composer-max-h',
        `${Math.max(next, 180)}px`
      )
      resizer.classList.add('is-dragging')
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      resizer.classList.remove('is-dragging')
      document.body.classList.remove('is-resizing-composer')
    }
    document.body.classList.add('is-resizing-composer')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }, [])

  useEffect(() => resizeTextarea(), [input, resizeTextarea])

  const rememberInput = useCallback(
    (text) => {
      const history = inputHistoryRef.current
      inputHistoryRef.current = [...history.filter((item) => item !== text), text].slice(-200)
      // 与 CLI 的 storage.json inputHistory 共享；失败静默，不影响发送路径。
      window.mica.chat.inputHistory.append(text).catch(() => {})
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
      const info = modelProtocolsRef.current
      const result = resolveModelSwitchProtocol({
        modelId,
        hasHistory,
        protocolMap: info?.map,
        currentProtocol: meta?.protocol || info?.currentProtocol
      })
      if (result.allowed) return true
      protocolBlockRef.current = result.reason
      appendNotice(result.reason, 'error')
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
            const rawStrategy = String(result.strategy || '')
            const strategy = rawStrategy.replaceAll('_', ' ')
            // 与交互式 /compact 同源：只替换工具结果，消息条数不变。
            const toolResultsOnly = rawStrategy === 'tool_results_only'
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
              ...(toolResultsOnly
                ? [
                    `- Tool results replaced: ${Number(result.toolResultsReplaced) || 0}`,
                    `- Messages: ${Number(result.beforeCount) || 0} (unchanged)`
                  ]
                : [
                    `- Messages: ${Number(result.beforeCount) || 0} → ${Number(result.afterCount) || 0}`
                  ]),
              `- Saved: ~${formatTokens(savedTokens).toLowerCase()} tokens (${savedPercent}%)`,
              ...(toolResultsOnly
                ? []
                : [`- Recent kept: ${Number(result.keptCount) || 0} messages`]),
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
            const localHint = String(result?.error || '').includes('可清理')
              ? '\n提示：上下文大主要是由大量小消息构成，本地压缩无法缩减；如需摘要压缩请使用「模型压缩」。'
              : ''
            updateNotice(
              compactNoticeId,
              `${compactMode === 'local' ? '暂无可快速清理内容' : '暂不需要模型压缩'}：${result.error || '当前会话内容较少。'}${localHint}`,
              'compact',
              'skipped'
            )
          } else {
            updateNotice(
              compactNoticeId,
              `压缩失败：${result?.error || '未知错误'}${
                result?.cwdMissing
                  ? '\n提示：会话工作目录不存在，请点击右下角路径切换到正确目录后重试。'
                  : ''
              }`,
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
      // 会话正被别处跑着：host 会拒绝这一条，先在本地挡下，避免乐观消息闪现再回滚。
      if (remoteRunningRef.current) {
        appendNotice('该会话正在另一处运行，请等待完成后再发送', 'warn')
        return
      }
      const optimisticId = uid('msg')
      const queueing = running || !finishedRef.current
      // 单槽排队（对齐 CLI）：已有排队消息时拒绝新的排队输入，避免乐观消息闪现后回滚。
      if (queueing && queuedMessageIdsRef.current.length > 0) {
        appendNotice('已有一条排队消息，等待发送或重新编辑', 'warn')
        return
      }
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
        turnStartedAtRef.current = Date.now()
        setRemoteRunning(false)
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
          queueMode: options.queueMode || null,
          maxTurns: 9999,
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
            if (result.error) rollback(result.error)
          }
        })
        .catch((error) => rollback(error instanceof Error ? error.message : String(error)))
    },
    [
      appendNotice,
      cwdRef,
      input,
      nodeId,
      nodeIdRef,
      rememberInput,
      remoteRunningRef,
      running,
      updateMessages
    ]
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

  const startMessageEdit = useCallback((message) => {
    if (!message?.id || message.queued) return
    const text = String(message.text ?? '')
    // prompt 留作定位依据：会话历史里没有逐条消息 id，host 只能按原文匹配。
    setMessageEdit({ id: message.id, prompt: text, text })
  }, [])

  const changeMessageEdit = useCallback((value) => {
    setMessageEdit((current) => (current ? { ...current, text: value } : current))
  }, [])

  const cancelMessageEdit = useCallback(() => setMessageEdit(null), [])

  const submitMessageEdit = useCallback(() => {
    const current = messageEdit
    if (!current || running) return
    const text = current.text.trim()
    if (!text) return
    const targetNodeId = nodeId
    setMessageEdit(null)
    // 编辑重发走 host 的就地改写（截断历史 + 新 turn），不是 send：send 会追加
    // 一条新的用户消息，旧问答仍留在上下文里。成功后由 mica/sessionHistory/replaced
    // 事件把 transcript 换成截断后的历史；失败则把编辑框交还给用户。
    const overrides = overridesRef.current.get(nodeId) || {}
    window.mica.chat
      .editMessage({
        id: nodeId,
        sessionId: sessionIdRef.current || null,
        cwd: cwdRef.current || null,
        prompt: current.prompt,
        text,
        occurrenceFromEnd: promptOccurrenceFromEnd(messagesRef.current, current.id),
        model: overrides.model || null,
        variant: overrides.variant || null
      })
      .then((result) => {
        if (nodeIdRef.current !== targetNodeId) return
        if (result?.ok) return
        appendNotice(result?.error || '编辑重发失败', 'error')
        setMessageEdit(current)
      })
      .catch((error) => {
        if (nodeIdRef.current !== targetNodeId) return
        appendNotice(
          `编辑重发失败：${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
        setMessageEdit(current)
      })
  }, [appendNotice, cwdRef, messageEdit, nodeId, nodeIdRef, running])

  // 编辑中的消息从历史里消失（clear / compact / 恢复快照）时收起编辑框；
  // 切换会话（nodeId 变化）同样收起。
  useEffect(() => {
    setMessageEdit(null)
  }, [nodeId])

  useEffect(() => {
    if (!messageEdit) return
    if (messages.some((message) => message.id === messageEdit.id)) return
    setMessageEdit(null)
  }, [messageEdit, messages])

  const navigateInputHistory = useCallback(
    (direction) => {
      const value = navigateChatHistory(
        draftsRef.current,
        inputHistoryRef.current,
        historyCursorRef,
        direction,
        inputRef.current,
        nodeId
      )
      if (value === null) return
      setInput(value)
      requestAnimationFrame(() => {
        const element = textareaRef.current
        if (element) element.setSelectionRange(value.length, value.length)
      })
    },
    [inputRef, nodeId]
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
      items.push({ id: message.id, text: message.text, pending: true, queueMode: 'after_turn' })
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
  // 当前工具（working）阶段的实时耗时：取最早 running 工具的 startedAt。
  const activeToolStartedAt = useMemo(() => {
    if (phase !== 'working') return null
    const starts = turnActivityMessages
      .filter(
        (message) =>
          message.kind === 'tool' && ['pending', 'running'].includes(message.tool?.status)
      )
      .map((message) => message.tool?.startedAt)
      .filter(Boolean)
    return starts.length ? Math.min(...starts) : null
  }, [phase, turnActivityMessages])

  useEffect(() => {
    if (!running) {
      setPhaseElapsed(0)
      return undefined
    }
    const startedAt = phase === 'working' ? activeToolStartedAt : phaseStartedAtRef.current
    if (!startedAt) {
      setPhaseElapsed(0)
      return undefined
    }
    const update = () => setPhaseElapsed(Math.max(0, Date.now() - startedAt))
    update()
    const timer = window.setInterval(update, 250)
    return () => clearInterval(timer)
  }, [running, phase, activeToolStartedAt])
  const activeStreamText =
    streamRef.current.id && ['thinking', 'streaming'].includes(phase)
      ? messages.find((message) => message.id === streamRef.current.id)?.text || ''
      : ''
  const activeStreamTokenEstimate = activeStreamText ? estimateTokens(activeStreamText) : 0
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
        x: event.clientX,
        y: event.clientY,
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
    const offExit = window.mica.chat.onCommitExit(({ commitId, exitCode, error, summary }) => {
      const task = commitTaskRef.current
      if (!task || task.id !== commitId) return
      commitTaskRef.current = null
      setCommitRunning(false)
      if (error) {
        updateNotice(task.noticeId, `commit 失败：${compactLine(error, 400)}`, 'error')
      } else if (exitCode !== 0) {
        updateNotice(task.noticeId, `commit 异常退出（code ${exitCode}）`, 'error')
      } else {
        const text = (summary || '').trim()
        updateNotice(
          task.noticeId,
          text ? `commit: 已完成 ${compactLine(text, 300)}` : 'commit: 已完成',
          'info'
        )
      }
    })
    return () => {
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

  const focusComposerFromShell = useCallback((event) => {
    if (event.button != null && event.button !== 0) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (
      target.closest(
        'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="listbox"], [role="option"], .chat-command-palette, [data-no-chat-focus]'
      )
    ) {
      shellPointerRef.current = null
      return
    }

    if (event.type === 'pointerdown') {
      shellPointerRef.current = {
        x: event.clientX,
        y: event.clientY,
        moved: false,
        inTranscript: Boolean(target.closest('.chat-scroll, .chat-transcript'))
      }
      if (shellPointerRef.current.inTranscript) return
      textareaRef.current?.focus()
      return
    }

    const pointer = shellPointerRef.current
    shellPointerRef.current = null
    if (pointer?.inTranscript) {
      requestAnimationFrame(() => {
        const selection = window.getSelection?.()
        if (pointer.moved || (selection && !selection.isCollapsed)) return
        textareaRef.current?.focus()
      })
      return
    }

    const selection = window.getSelection?.()
    if (selection && !selection.isCollapsed) return
    textareaRef.current?.focus()
  }, [])

  const trackShellPointerMove = useCallback((event) => {
    const pointer = shellPointerRef.current
    if (!pointer) return
    if (Math.abs(event.clientX - pointer.x) > 3 || Math.abs(event.clientY - pointer.y) > 3) {
      pointer.moved = true
    }
  }, [])

  const statusLine = (
    <div className="chat-status-line">
      <div className="chat-status-primary">
        {remoteRunning ? (
          <>
            <IconLoader2 size={11} className="animate-spin" />
            <span>正在另一处运行</span>
          </>
        ) : running ? (
          <>
            <IconLoader2 size={11} className="animate-spin" />
            <span>{statusLabel(phase, runningToolNames)}</span>
            {phaseElapsed > 0 && (
              <span className="chat-status-phase-elapsed">{formatLogElapsed(phaseElapsed)}</span>
            )}
            {activeStreamTokenEstimate > 0 && (
              <span className="chat-status-token-delta">↓{activeStreamTokenEstimate} tokens</span>
            )}
          </>
        ) : lastRun ? (
          <span className={`chat-status-last-run chat-status-${lastRun.state}`}>
            {lastRun.state === 'completed' ? 'completed' : 'error'}
            {lastRun.durationMs > 0 && (
              <span className="chat-status-elapsed"> {formatLogElapsed(lastRun.durationMs)}</span>
            )}
          </span>
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
          <span
            className="chat-status-context-trigger"
            role="button"
            tabIndex={0}
            title="点击查看上下文使用详情"
            onClick={() => setContextDetail(true)}
          >
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
          </span>
        )}
        {running && (
          <span className="chat-status-elapsed" title="本次任务总运行时间">
            {formatLogElapsed(elapsed)}
          </span>
        )}
      </div>
    </div>
  )

  return (
    <div
      className={`chat-view no-drag ${visible ? 'flex' : 'hidden'}`}
      onPointerDownCapture={focusComposerFromShell}
      onPointerMoveCapture={trackShellPointerMove}
      onMouseUp={focusComposerFromShell}
      onContextMenu={openChatContextMenu}
      {...longPressHandlers(openChatContextMenu)}
    >
      <div
        ref={listRef}
        className="chat-scroll"
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
                edit={
                  messageEdit?.id === message.id
                    ? {
                        text: messageEdit.text,
                        busy: running,
                        canSubmit: canSubmitMessageEdit({ running, text: messageEdit.text })
                      }
                    : null
                }
                onEditStart={startMessageEdit}
                onEditChange={changeMessageEdit}
                onEditCancel={cancelMessageEdit}
                onEditSubmit={submitMessageEdit}
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
            <IconArrowDown size={13} /> 最新消息
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
        <SubagentStatusDock
          tasks={subagentTasks}
          now={taskNow}
          onOpen={(task) => openTaskDetail('subagent', task)}
        />
        <BackgroundTasksDock
          tasks={backgroundTasks}
          now={taskNow}
          onOpen={(task) => openTaskDetail('background', task)}
          onKill={killBackgroundTask}
          killingId={killingTaskId}
        />
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
          style={
            composerMinHeight != null
              ? {
                  '--chat-composer-min-h': `${composerMinHeight}px`,
                  '--chat-composer-max-h': `${Math.max(composerMinHeight, 180)}px`
                }
              : undefined
          }
        >
          <button
            type="button"
            className="chat-composer-resizer"
            aria-label="拖动调整输入框高度"
            title="拖动调整输入框高度"
            onPointerDown={startComposerResize}
          >
            <IconDots size={14} stroke={1.6} />
          </button>
          {queueReady && (
            <span className="chat-composer-frame-label">
              Enter/Tab 等 agent 执行完成后发送，shift + tab 本轮工具调用迭代后发送
            </span>
          )}
          {/* 与 CLI 的 prompt 同款：非默认角色时在标记前显示角色名，点这里直接切换角色 */}
          <button
            type="button"
            className="chat-prompt-mark"
            title={`当前角色：${activeRole}（点击切换）`}
            aria-label="切换角色"
            data-chat-picker-trigger
            onClick={() => openPicker('role')}
          >
            {activeRole !== 'default' && <span className="chat-prompt-role">{activeRole}</span>}
            <span className="chat-prompt-caret" aria-hidden="true">
              {queueReady ? '↳' : '›'}
            </span>
          </button>
          {/* 相册/拍照：手机上没有系统剪贴板粘贴，只能靠文件选择器（accept 限定成
              CLI 认识的格式，iOS 会据此把 HEIC 转成 JPEG）。 */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="sr-only"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              const files = Array.from(event.target.files || [])
              // 先取走 FileList 再清空，否则同一个文件不会二次触发 change
              event.target.value = ''
              void attachImages(files)
            }}
          />
          <TerminalComposer
            value={input}
            placeholder={
              running ? '消息会在当前 turn 完成后自动发送' : 'Type something and press Enter...'
            }
            textareaRef={textareaRef}
            onChange={(nextValue) => {
              draftsRef.current.set(nodeId, nextValue)
              historyCursorRef.current = -1
              setInput(nextValue)
            }}
            onPaste={(event) => {
              const imageItem = Array.from(event.clipboardData?.items ?? []).find((item) =>
                item.type.startsWith('image/')
              )
              if (!imageItem) return
              event.preventDefault()
              // Electron 主进程直接读系统剪贴板；浏览器只能拿到粘贴事件里的文件
              const file = imageItem.getAsFile?.() || null
              const fallback = event.clipboardData?.getData('text/plain') ?? ''
              window.mica.chat
                .savePastedImage(window.mica.isWeb ? { file } : undefined)
                .then((result) =>
                  insertComposerText(result?.ok ? `[Image](${result.ref})` : fallback)
                )
                .catch(() => {})
            }}
            onKeyDown={(event) => {
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
              if (event.altKey && event.key === 'ArrowUp' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                navigateInputHistory(-1)
                return
              }
              if (event.altKey && event.key === 'ArrowDown' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                navigateInputHistory(1)
                return
              }
              if (
                event.key === 'ArrowUp' &&
                !event.shiftKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.nativeEvent.isComposing &&
                isCaretOnFirstLine(event.currentTarget)
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
                !event.nativeEvent.isComposing &&
                isCaretOnLastLine(event.currentTarget)
              ) {
                event.preventDefault()
                navigateInputHistory(1)
                return
              }
              if (event.key === 'Tab' && !event.nativeEvent.isComposing) {
                const tabAction = resolveComposerTabAction({
                  shiftKey: event.shiftKey,
                  queueReady
                })
                if (tabAction === 'queue') {
                  event.preventDefault()
                  send(null, { queueMode: event.shiftKey ? 'after_iteration' : 'after_turn' })
                  return
                }
                if (tabAction === 'cycle-role') {
                  event.preventDefault()
                  openPicker('role')
                  return
                }
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                send()
              }
            }}
          />
          <div className="chat-composer-actions">
            <button
              type="button"
              title="上传图片"
              aria-label="上传图片"
              onClick={() => imageInputRef.current?.click()}
            >
              <IconPhoto size={13} />
            </button>
            <span>{input.length > 4000 ? input.length.toLocaleString() : ''}</span>
            {running ? (
              <>
                {input.trim() && (
                  <button
                    type="button"
                    className="chat-composer-queue-send"
                    title="加入发送队列"
                    aria-label="加入发送队列"
                    onClick={send}
                  >
                    <IconSend size={13} />
                  </button>
                )}
                <button
                  type="button"
                  className="chat-composer-stop"
                  title="停止生成"
                  aria-label="停止生成"
                  onClick={stop}
                >
                  {stopping ? (
                    <IconLoader2 size={13} className="animate-spin" />
                  ) : (
                    <IconSquare size={12} />
                  )}
                </button>
              </>
            ) : input.trim() ? (
              <button
                type="button"
                title={remoteRunning ? '该会话正在另一处运行' : '发送'}
                aria-label="发送"
                disabled={!input.trim() || remoteRunning}
                onClick={send}
              >
                <IconSend size={13} />
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
      {contextDetail && (
        <ContextDetailPopover
          sessionId={sessionIdRef.current}
          contextWindowSize={windowSize}
          onClose={() => setContextDetail(false)}
        />
      )}
      {taskDetail?.kind === 'subagent' && (
        <SubagentDetailModal
          nodeId={nodeId}
          task={taskDetail.task}
          onClose={() => setTaskDetail(null)}
          onStop={stopSubagent}
        />
      )}
      {taskDetail?.kind === 'background' && (
        <BackgroundTaskModal
          nodeId={nodeId}
          task={taskDetail.task}
          onClose={() => setTaskDetail(null)}
          onKill={killBackgroundTask}
        />
      )}
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
