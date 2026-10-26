import {
  useCallback,
  useEffect,
  useLayoutEffect,
  memo,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import {
  IconAdjustments,
  IconArrowDown,
  IconArrowUp,
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
  IconMessageChatbot,
  IconMinimize,
  IconPhoto,
  IconQuote,
  IconSend,
  IconShare,
  IconSquare,
  IconTerminal,
  IconTrash,
  IconX
} from '@tabler/icons-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { formatTokens as formatSharedTokens, toolIcon } from '@packages/mica-web-shared'
import { comparableText } from '@packages/mica-common/promptText.js'
import { ContextUsageSection } from './stats/ContextUsagePanel'
import { ChatPathContext, PathText, PathToken } from './PathToken'
import { ChatFind } from './ChatFind'
import { parsePathHref, remarkPathLinks, splitTextByImages } from './chat-paths'
import { remarkAutolinkPunctuation } from './chat-autolink'
import { ComposerImageStrip, resolveImageSource } from './composer-images'
import { pasteIntoComposer } from './composer-paste'
import { formatLogElapsed, parseToolArgs, toolDisplayName, toolSummary } from './chat-tool-display'
import { ReasoningRow, ToolActivityRow } from './chat-tool-views'
import { ModalMeta, ModalSection, ModalShell } from './chat-modal'
import { ToolDetailDialog } from './chat-tool-detail'
import { CodeView } from './CodeView'
import { newlyAnsweredBtwEntries } from './btw-thread'

function formatTokens(value) {
  return formatSharedTokens(value, { millionDecimals: 2 })
}

/**
 * By The Way 草稿的键：`节点:线程`。
 *
 * 一个节点可以有多个 tab，每个 tab 都是另一条对话，所以半句话必须按 tab 分开存
 * （只按节点存的话，切个 tab 就把没发出去的问题带到别人嘴里去了）。
 */
function btwDraftKey(nodeId, threadId) {
  return `${nodeId || ''}:${threadId || ''}`
}

/** 补全浮层的空态文案：加载中 / 失败 / 没有匹配（文件侧与 CLI 的措辞一致）。 */
function completionEmptyText(kind, loading, failed) {
  if (kind === 'skill') {
    if (loading) return '正在加载…'
    return failed ? '加载 skill / MCP 失败' : '没有匹配的 skill 或 MCP'
  }
  if (loading) return '正在搜索文件…'
  return failed ? '文件搜索失败' : '没有找到匹配文件'
}
import { CHAT_COMMANDS, findChatCommand } from './chat-commands'
import {
  FILE_COMPLETION_DEBOUNCE_MS,
  activeCompletion,
  applyCompletion,
  completionInsertText,
  fileCompletionOptions,
  slashCompletionOptions
} from './chat-completions'
import ComposerCompletionPalette from './ComposerCompletionPalette'
import { BtwDrawer } from './BtwDrawer'
import { LoopBadge } from './LoopBadge'
import { SessionSettingsDialog } from './SessionSettingsDialog'
import { Popover } from './Popover'
import { formatLoopInterval, loopForNode } from './loop-command'
import {
  backgroundTaskStatusLabel,
  buildSubagentTimeline,
  isBackgroundTaskRunning,
  isSubagentRunning,
  sameTaskDetail,
  subagentStatusLabel,
  taskElapsedMs,
  taskOutputWindowLabel,
  timelineSignature,
  waitTaskKindLabel,
  waitTaskSummary,
  waitTaskTooltip
} from './chat-task-detail'
import { longPressHandlers, useLatest } from './hooks'
import { canGoToPreviousConversation, conversationNavTarget } from './chat-conversation-nav'
import { readScrollEntry, resolveScrollRestore, writeScrollEntry } from './chat-scroll'
import { resolveQueueRecall } from './chat-recall'
import { uid } from './workspace'
import { setUiStateEntries, subscribeUiState, uiStateKeys, useSharedState } from './ui-state'
import {
  findQuoteBlocks,
  quoteIntoDraft,
  removeQuoteBlock,
  splitQuoteSegments
} from './quote-message'
import TerminalComposer from './TerminalComposer'

const MAX_INPUT_ROWS = 10
const SCROLL_BOTTOM_THRESHOLD = 72
const MIN_TURN_LOG_HEIGHT = 60
const MAX_TURN_LOG_HEIGHT_RATIO = 0.6
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

/**
 * 各条用户消息（一轮对话的起点）在滚动坐标系里的位置。`offsetTop` 的起点依赖最近的定位
 * 祖先，这里统一用「相对滚动容器视口的差值 + scrollTop」算，结果与 `scrollTop` 同口径。
 */
function conversationTops(list) {
  const rows = list.querySelectorAll('[data-chat-user-message]')
  if (!rows.length) return []
  const base = list.getBoundingClientRect().top - list.scrollTop
  const tops = []
  for (const row of rows) tops.push(row.getBoundingClientRect().top - base)
  return tops
}

/**
 * 上方还有没有对话。滚动时每次都要判一次，所以只量前两条：锚点大于 0 等价于第二条已经滚到
 * 视野顶部（判定本身在 chat-conversation-nav.js，这里只负责量位置）。
 */
function hasPreviousConversation(list) {
  const rows = list.querySelectorAll('[data-chat-user-message]')
  if (rows.length < 2) return false
  const base = list.getBoundingClientRect().top - list.scrollTop
  return canGoToPreviousConversation(
    [rows[0].getBoundingClientRect().top - base, rows[1].getBoundingClientRect().top - base],
    list.scrollTop
  )
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
      <CodeView text={code} language={language} />
    </div>
  )
}

function isExternalHref(href) {
  return /^(https?:|mailto:)/i.test(href || '')
}

/** 引用条上那行摘要：首行、折叠空白、限长。 */
function quoteSummary(text) {
  const first = String(text ?? '')
    .split('\n')
    .find((line) => line.trim().length > 0)
  const line = (first ?? '').replace(/\s+/g, ' ').trim()
  return line.length > 42 ? `${line.slice(0, 42)}…` : line
}

/**
 * 输入框上方的引用条：草稿里有几个引用块就列几条，✕ 只删那一个块。
 *
 * 和 ComposerImageStrip 同源——都是从草稿文本反推出来的视图，不另存状态，所以它
 * 天然跟着草稿一起持久化、一起在窗口之间同步；用户删引用也不必自己划选 20 行代码。
 */
function ComposerQuoteStrip({ text, onRemove }) {
  const blocks = findQuoteBlocks(text)
  if (!blocks.length) return null
  return (
    <div className="chat-composer-quotes" aria-label="输入中的引用">
      {blocks.map((block) => (
        <div className="chat-composer-quote" key={`${block.start}:${block.end}`}>
          <IconQuote size={11} aria-hidden="true" />
          <span className="chat-composer-quote-label">{block.label}</span>
          <span className="chat-composer-quote-text">{quoteSummary(block.text)}</span>
          <span className="chat-composer-quote-size">{`${block.text.split('\n').length} 行`}</span>
          <button
            type="button"
            className="chat-composer-quote-remove"
            title="移除引用"
            aria-label="移除引用"
            onClick={() => onRemove(block)}
          >
            <IconX size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}

// `[Image](路径)` / `![alt](路径)` 里没有信息量的 alt：显示时退回路径本身。
const GENERIC_IMAGE_ALT = new Set(['Image', '图片', 'image', 'img', 'IMG'])
// 伪协议（`data:`/`blob:`）与被 urlTransform 拦下的写法：没有可点的路径，只留标签。
const IMAGE_URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const IMAGE_LOCAL_PATH = /^(?:~[\\/]|\/|[a-zA-Z]:[\\/]|\.{1,2}[\\/])/

/**
 * 对话区不内联渲染图片：图片引用一律降级成可点的链接文本。
 *
 * 本地图片交给 PathToken（单击弹预览、⌘ 单击开编辑器，与正文里的图片路径同一套手感），
 * 远程图片按外链打开发送，`data:` 只留一个可读标签——否则满屏 base64。
 * 输入框上方的附件缩略图（ComposerImageStrip）不受影响，发送之后才只剩链接文本。
 */
function ImageLink({ source, alt }) {
  const value = String(source || '').trim()
  if (/^https?:\/\//i.test(value)) {
    return (
      <a
        className="chat-image-link"
        href={value}
        onClick={(event) => {
          event.preventDefault()
          window.mica.terminal.openExternal(value).catch(() => {})
        }}
      >
        {alt || value}
      </a>
    )
  }
  if (!value || (IMAGE_URL_SCHEME.test(value) && !IMAGE_LOCAL_PATH.test(value))) {
    return <span className="chat-image-ref">{alt || '[图片]'}</span>
  }
  return <PathToken path={value} text={alt && !GENERIC_IMAGE_ALT.has(alt) ? alt : value} />
}

/**
 * 消息正文里的图片引用只保留链接文本（见 ImageLink），其余文本照旧走路径识别。
 *
 * 用户上传的图片在会话里就是一段 `[Image](~/.mica/images/xxx.jpg)` 文本，直接原样显示
 * 会带上多余的 `[Image](...)` 包装，所以按引用切成片段单独渲染。
 */
export function MessageText({ text }) {
  const segments = useMemo(() => splitTextByImages(text), [text])
  if (!segments.some((segment) => segment.type === 'image')) return <PathText text={text} />
  return segments.map((segment, index) =>
    segment.type === 'image' ? (
      <ImageLink
        key={`image:${index}:${segment.source}`}
        source={segment.source}
        alt={segment.alt}
      />
    ) : (
      <PathText key={`text:${index}`} text={segment.text} />
    )
  )
}

/**
 * 用户消息正文：点「引用」插进来的引用块渲染成引用区，其余照旧。
 *
 * 只改渲染，**原文一个字都不改**——编辑重发按文本定位（comparableText +
 * promptOccurrenceFromEnd），改动文本会让定位落到别的消息上。
 */
function UserMessageText({ text }) {
  const segments = useMemo(() => splitQuoteSegments(text), [text])
  if (segments.length <= 1) return <MessageText text={text} />
  return segments.map((segment, index) =>
    segment.type === 'quote' ? (
      <div className="chat-quote" key={`quote:${index}`}>
        <span className="chat-quote-label">{segment.label}</span>
        <div className="chat-quote-text">{segment.text}</div>
      </div>
    ) : (
      <MessageText key={`text:${index}`} text={segment.text.replace(/^\n+|\n+$/g, '')} />
    )
  )
}

function QueueDock({ items, onRecall, recallingId }) {
  if (!items.length) return null
  // 文案与 CLI 的 waiting queue 提示完全一致（含 shift + ← 撤回提示，app 也
  // 支持这个快捷键，另外每条还提供按钮）。忙时的 Enter/Tab/Shift+Tab 都走
  // host 的 after_iteration 单槽（mica/queue/queued 扩展通知，注入活跃
  // turn），after_turn 只留给显式请求，标题按投递时机区分。
  const queueMode = items[0]?.queueMode
  const headerText =
    queueMode === 'after_iteration'
      ? 'waiting to send after a complete tool-call iteration'
      : 'waiting to send after current turn'
  return (
    <section className="chat-queue-dock" aria-label="等待发送的消息">
      <div className="chat-queue-dock-header">
        <span aria-hidden="true">↳</span>
        <span>{`${headerText} · shift + ← or double click to re-edit`}</span>
        <span>{items.length}</span>
      </div>
      <div className="chat-queue-dock-items">
        {items.map((item, index) => (
          <div
            key={item.id || `${index}:${item.text}`}
            className="chat-queue-dock-item"
            title="双击撤回并重新编辑"
            onDoubleClick={() => onRecall(item.id)}
          >
            <span>▌</span>
            <span>{item.text}</span>
            <button
              type="button"
              // pending 只是「确认通知还没回来」的乐观行，同样要能撤回：否则
              // 确认一旦丢失，这一行就永远停在排队态（既发不出去也撤不回）。
              title="撤回到输入框（shift + ←）"
              aria-label={`撤回排队消息 ${index + 1}`}
              disabled={Boolean(recallingId)}
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

function isLocalPath(value) {
  return /^(?:~\/|\/|[a-zA-Z]:[\\/])/.test(String(value || '')) && !String(value).startsWith('//')
}

function ImagePreviewModal({ source, alt, onClose, onReveal, onOpenFile }) {
  useEffect(() => {
    const onKeyDown = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const local = isLocalPath(source)
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
        <div className="chat-image-preview-actions">
          {local && (
            <>
              <span className="chat-image-preview-path" title={source}>
                {source}
              </span>
              <button type="button" onClick={() => onOpenFile?.(source)}>
                在编辑器中打开
              </button>
              <button type="button" onClick={() => void onReveal?.(source)}>
                在 Finder 中显示
              </button>
            </>
          )}
          <button type="button" onClick={() => void copyText(source)}>
            复制路径
          </button>
          <button type="button" onClick={onClose} aria-label="关闭图片预览">
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

function ContextDetailPopover({ sessionId, contextWindowSize, onClose }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)

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

  return (
    <ModalShell title="上下文占用" onClose={onClose}>
      {error ? (
        <div className="chat-modal-empty">{error}</div>
      ) : !detail ? (
        <div className="chat-modal-empty">加载中…</div>
      ) : (
        <ContextUsageSection
          context={detail.context}
          messages={detail.messages}
          contextWindowSize={contextWindowSize || detail.contextWindowSize}
        />
      )}
    </ModalShell>
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
  // remark 插件把普通文本里的路径换成了 `#mica-path=` 链接（见 chat-paths.js），
  // 这里把它还原成可点的路径元素，DOM 里不会留下这个 href。
  const pathTarget = parsePathHref(href)
  if (pathTarget) {
    const text = nodeText(children)
    return (
      <PathToken
        path={pathTarget.path}
        text={text || pathTarget.path}
        line={pathTarget.line}
        column={pathTarget.column}
      />
    )
  }
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

// 插件数组必须是稳定引用，否则每次渲染都会让 react-markdown 重新解析整篇文档
const CHAT_REMARK_PLUGINS = [remarkAutolinkPunctuation, remarkGfm, remarkPathLinks]

function MarkdownView({ text, muted = false, onOpenFile }) {
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
      // markdown 图片同样不内联渲染：`![alt](src)` 降级成链接文本（见 ImageLink）
      img: ({ alt, src }) => <ImageLink source={src} alt={alt} />
    }),
    [onOpenFile]
  )

  return (
    <div className={`chat-markdown ${muted ? 'chat-markdown-muted' : ''}`}>
      <ReactMarkdown
        remarkPlugins={CHAT_REMARK_PLUGINS}
        components={components}
        urlTransform={chatUrlTransform}
        skipHtml
      >
        {text || ''}
      </ReactMarkdown>
    </div>
  )
}

// react-markdown 每次渲染都会重新解析整篇 markdown，而 ChatView 在运行中每 250ms
// 就要重渲染一次（状态行计时）。memo 之后只有内容真的变了的消息才会重新解析——
// 前提是调用方别每次渲染都传新的 onOpenFile（见 transcript 那段）。
export const Markdown = memo(MarkdownView)

function compactLine(value, max = 110) {
  const line = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
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

function WaitTasksDock({ tasks, now = Date.now(), onOpen }) {
  if (!tasks.length) return null
  return (
    <section className="chat-task-dock chat-wait-dock" aria-label="等待中的条件">
      {tasks.map((task) => {
        const age = formatLogElapsed(Math.max(0, now - (Date.parse(task.startedAt) || now)))
        return (
          <div className="chat-task-row" key={task.id}>
            <button
              type="button"
              className="chat-task-summary-row chat-task-openable"
              title={waitTaskTooltip(task)}
              onClick={() => onOpen?.(task)}
            >
              <span className="chat-task-kind">⏳ {waitTaskKindLabel(task.kind)}</span>
              <span className="chat-task-status chat-task-status-waiting">
                等待中
              </span>
              <span className="chat-task-runtime">已等 {age}</span>
              <span className="chat-task-type">{task.id}</span>
              <span className="chat-task-description">
                {compactLine(waitTaskSummary(task), 180)}
              </span>
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
  const mountedRef = useRef(true)
  const inFlightRef = useRef(false)

  const poll = useCallback(async () => {
    if (inFlightRef.current) return
    // 页面在后台时不再请求：任务记录只活在 host 里，没人看的时候刷新等于白花往返。
    if (document.visibilityState === 'hidden') return
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
      // 内容没变就复用旧对象，避免每秒把整棵弹窗重渲染一次（见 sameTaskDetail）。
      setDetail((previous) => (sameTaskDetail(previous, res.result) ? previous : res.result))
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
    return () => clearInterval(timer)
  }, [running, intervalMs, poll])

  return { detail, error, running }
}

/**
 * 一行自适应计时（`6m 16s`）。
 *
 * 以前弹窗自己拿 `now` 每 250ms/1s 重渲染整棵树，只为了让一个数字变化；
 * 计时收进这个组件后，父级不再跟着跳。
 */
function ElapsedText({ task, running }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) {
      setNow(Date.now())
      return undefined
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  const elapsed = taskElapsedMs(task, now)
  if (elapsed == null) return null
  return <span className="tabular-nums">{formatLogElapsed(elapsed)}</span>
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

function TaskDetailModal({
  title,
  icon,
  subtitle,
  meta,
  actions,
  onClose,
  bodyRef,
  onBodyScroll,
  children
}) {
  return (
    <ModalShell
      title={title}
      icon={icon}
      subtitle={subtitle}
      meta={meta}
      actions={actions}
      onClose={onClose}
      bodyRef={bodyRef}
      onBodyScroll={onBodyScroll}
      className="chat-modal-task"
    >
      {children}
    </ModalShell>
  )
}

/** 时间线默认只渲染末尾这么多步，更早的折成一行按钮（长任务动辄上百步）。 */
const SUBAGENT_STEP_WINDOW = 24
/** 思考默认只显示开头这么多字符，展开才渲染全文。 */
const THINKING_PREVIEW_CHARS = 320

/**
 * 一次工具调用：默认只有一行（图标 + 工具名 + 参数摘要 + 行数），
 * 展开才把入参和输出挂进 DOM。
 *
 * 之前的实现用 `<details>` 直接塞两个 `<pre>`：折叠时 DOM 里也已经有了全部
 * 文本，120 条 × 上千字符直接把弹窗拖死。这里的 body 只在展开时存在。
 */
function SubagentToolStep({ step, expanded, active, onToggle }) {
  const input = useMemo(() => parseToolArgs(step.argsText), [step.argsText])
  const name = toolDisplayName({ tool: step.toolName, input })
  const summary = toolSummary({ tool: step.toolName, input })
  const resultLines = step.resultText ? step.resultText.replace(/\n+$/, '').split('\n').length : 0
  // 最后一个还没有结果的调用就是正在跑的那一次，标成「运行中」而不是「无输出」。
  const pending = !resultLines && active

  return (
    <div className={`chat-timeline-step chat-timeline-tool ${expanded ? 'is-open' : ''}`}>
      <button
        type="button"
        className="chat-timeline-tool-row"
        aria-expanded={expanded}
        title={summary || name}
        onClick={() => onToggle(step.key)}
      >
        <span className="chat-timeline-caret" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="chat-timeline-icon" aria-hidden="true">
          {toolIcon(step.toolName)}
        </span>
        <span className="chat-timeline-tool-name">{name}</span>
        <span className="chat-timeline-tool-summary">{summary}</span>
        <span className={`chat-timeline-tool-meta ${pending ? 'is-running' : ''}`}>
          {resultLines ? `${resultLines} 行` : pending ? '运行中' : '无输出'}
        </span>
      </button>
      {expanded ? (
        <div className="chat-timeline-tool-body">
          <div className="chat-timeline-block">
            <div className="chat-timeline-block-head">参数</div>
            <CodeView
              className="chat-timeline-code"
              text={step.argsText}
              language={input && Object.keys(input).length ? 'json' : 'text'}
              wrap
            />
          </div>
          {resultLines ? (
            <div className="chat-timeline-block">
              <div className="chat-timeline-block-head">输出</div>
              <CodeView className="chat-timeline-code" text={step.resultText} wrap />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** 思考：左侧一条淡色竖线，默认只给开头一段，长文才出现「展开」。 */
function SubagentThinkingStep({ step, expanded, onToggle }) {
  const clipped = step.text.length > THINKING_PREVIEW_CHARS
  const text =
    expanded || !clipped ? step.text : `${step.text.slice(0, THINKING_PREVIEW_CHARS).trimEnd()}…`
  return (
    <div className="chat-timeline-step chat-timeline-thinking">
      <div className="chat-timeline-thinking-text">{text}</div>
      {clipped ? (
        <button type="button" className="chat-timeline-more" onClick={() => onToggle(step.key)}>
          {expanded ? '收起思考' : '展开思考'}
        </button>
      ) : null}
    </div>
  )
}

function SubagentTimelineStepView({ step, expanded, active, onToggle }) {
  if (step.kind === 'tool') {
    return <SubagentToolStep step={step} expanded={expanded} active={active} onToggle={onToggle} />
  }
  if (step.kind === 'thinking') {
    return <SubagentThinkingStep step={step} expanded={expanded} onToggle={onToggle} />
  }
  if (step.kind === 'tool_result') {
    // 时间线被截断后可能出现没有对应调用的孤立结果，单独给一块。
    return (
      <div className="chat-timeline-step chat-timeline-text">
        <div className="chat-timeline-block-head">{step.toolName || '工具'} 结果</div>
        <CodeView className="chat-timeline-code" text={step.text} wrap />
      </div>
    )
  }
  return (
    <div className="chat-timeline-step chat-timeline-text">
      <Markdown text={step.text} />
    </div>
  )
}

// 轮询会不断给出新的 detail 对象；只要这一步的内容没变（引用稳定）就不重渲染，
// 流式长任务里每秒上百次 markdown 解析就是这么省下来的。
const SubagentTimelineStep = memo(SubagentTimelineStepView)

function SubagentTimeline({ steps, running, expanded, onToggle }) {
  const [showAll, setShowAll] = useState(false)
  const hidden = showAll ? 0 : Math.max(0, steps.length - SUBAGENT_STEP_WINDOW)
  const visible = hidden > 0 ? steps.slice(hidden) : steps
  const lastKey = steps.at(-1)?.key

  return (
    <div className="chat-timeline">
      {hidden > 0 ? (
        <button type="button" className="chat-timeline-earlier" onClick={() => setShowAll(true)}>
          显示更早的 {hidden} 步
        </button>
      ) : null}
      {visible.map((step) => (
        <SubagentTimelineStep
          key={step.key}
          step={step}
          expanded={expanded.has(step.key)}
          active={running && step.key === lastKey}
          onToggle={onToggle}
        />
      ))}
    </div>
  )
}

function subagentStatusClass(status) {
  if (status === 'running') return 'is-running'
  if (status === 'failed') return 'is-error'
  return 'is-done'
}

// `runKey` 是持有这个 run 的节点 id（工作区只有一份，所以就是本节点的 id）：
// 任务记录只活在 host 进程里，所以详情/停止必须打到那个 run 上。
function SubagentDetailModalView({ runKey, task: initialTask, onClose, onStop }) {
  const load = useCallback(
    () => window.mica.chat.subagentDetail(runKey, initialTask.taskId),
    [runKey, initialTask.taskId]
  )
  const { detail, error, running } = useTaskPolling({
    task: initialTask,
    isRunning: isSubagentRunning,
    intervalMs: 1500,
    load
  })
  const [stopping, setStopping] = useState(false)
  const [expanded, setExpanded] = useState(() => new Set())
  const task = detail?.task || initialTask
  // 时间线是 append-only 的，用内容指纹当依赖：轮询给的数组引用每秒都新，
  // 直接依赖它会让所有步骤跟着重建，memo 全部失效。
  const signature = timelineSignature(task)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 指纹已经覆盖 timeline 内容
  const steps = useMemo(() => buildSubagentTimeline(task), [signature])
  // 只在步骤数变化时贴底：内容长高不算（否则展开一段输出就被拽回底部）。
  const { bodyRef, onBodyScroll } = useStickToBottom(steps.length)
  const usage = task.usage
  const toggleStep = useCallback((key) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

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
      icon="🤖"
      title={task.subagentType || 'subagent'}
      subtitle={compactLine(task.description, 90)}
      meta={
        <ModalMeta
          items={[
            <span className={`chat-modal-status ${subagentStatusClass(task.status)}`} key="status">
              {subagentStatusLabel(task.status)}
            </span>,
            <ElapsedText task={task} running={running} key="elapsed" />,
            task.model,
            task.effort,
            usage
              ? `↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)} · 缓存 ${formatTokens(usage.cachedInputTokens)} · ${usage.records} 次请求`
              : null,
            steps.length ? `${steps.length} 步` : null,
            <span className="chat-modal-id" title={task.taskId} key="id">
              {compactLine(task.taskId, 28)}
            </span>
          ]}
        />
      }
      onClose={onClose}
      bodyRef={bodyRef}
      onBodyScroll={onBodyScroll}
      actions={
        running ? (
          <button type="button" className="chat-modal-danger" disabled={stopping} onClick={stop}>
            停止
          </button>
        ) : null
      }
    >
      {error && <div className="chat-modal-note is-warn">{error}</div>}
      {task.prompt ? (
        <details className="chat-timeline-prompt">
          <summary>任务提示词</summary>
          <pre className="chat-modal-pre">{textOf(task.prompt)}</pre>
        </details>
      ) : null}
      {task.timelineTruncated ? (
        <div className="chat-modal-note">较早的步骤已被丢弃（只保留最近 120 步）。</div>
      ) : null}
      {steps.length ? (
        <SubagentTimeline
          steps={steps}
          running={running}
          expanded={expanded}
          onToggle={toggleStep}
        />
      ) : (
        <div className="chat-modal-empty">{running ? '正在等待第一个步骤…' : '没有步骤记录。'}</div>
      )}
      {task.result && (
        <ModalSection title="结果">
          <Markdown text={textOf(task.result)} />
        </ModalSection>
      )}
      {task.error && <div className="chat-modal-error">{textOf(task.error)}</div>}
    </TaskDetailModal>
  )
}

const SubagentDetailModal = memo(SubagentDetailModalView)

function BackgroundTaskModalView({ runKey, task: initialTask, onClose, onKill }) {
  const load = useCallback(
    () => window.mica.chat.backgroundTaskOutput(runKey, initialTask.id, 32000),
    [runKey, initialTask.id]
  )
  const { detail, error, running } = useTaskPolling({
    task: initialTask,
    isRunning: isBackgroundTaskRunning,
    intervalMs: 1500,
    load
  })
  const task = detail?.task || initialTask
  const content = detail?.content || ''
  const { bodyRef, onBodyScroll } = useStickToBottom(detail)

  return (
    <TaskDetailModal
      icon="$"
      title={task.id}
      subtitle={shellBaseName(task.shell)}
      meta={
        <ModalMeta
          items={[
            backgroundTaskStatusLabel(task.status),
            <ElapsedText task={task} running={running} key="elapsed" />,
            task.exitCode != null ? `exit ${task.exitCode}` : null,
            task.signal,
            detail ? <span className="tabular-nums">{taskOutputWindowLabel(detail)}</span> : null,
            <span title={task.cwd}>{compactLine(task.cwd, 60)}</span>
          ]}
        />
      }
      onClose={onClose}
      bodyRef={bodyRef}
      onBodyScroll={onBodyScroll}
      actions={
        running ? (
          <button
            type="button"
            className="chat-modal-danger"
            disabled={!onKill}
            onClick={() => onKill(task)}
          >
            终止
          </button>
        ) : null
      }
    >
      {error && <div className="chat-modal-note is-warn">{error}</div>}
      {task.command ? (
        <pre className="chat-modal-pre">
          <PathText text={task.command} />
        </pre>
      ) : null}
      {content ? (
        <pre className="chat-modal-pre">
          <PathText text={content} />
        </pre>
      ) : (
        <div className="chat-modal-note">（暂无输出）</div>
      )}
    </TaskDetailModal>
  )
}

// 输出可能有几万行，主对话每 250ms 的计时重渲染不该把它整棵树 diff 一遍。
const BackgroundTaskModal = memo(BackgroundTaskModalView)

// wait_for 的等待记录只活在 app-server 进程里，快照里就是全部信息（条件标签、
// 原因、已轮询次数、最近一次观察），所以详情不需要额外的 host 请求；dock 每秒
// 收到新快照，弹窗用同一份数据跟着刷新。
function WaitTaskModal({ task, now, onClose }) {
  const elapsed = taskElapsedMs(task, now)
  const polls = Number(task.polls)
  const label = String(task.label || '').trim() || '等待条件'
  const detail = String(task.detail || '').trim()
  return (
    <TaskDetailModal
      icon="⏳"
      title={waitTaskKindLabel(task.kind)}
      subtitle={compactLine(waitTaskSummary(task), 90)}
      meta={
        <ModalMeta
          items={[
            '等待中',
            elapsed != null ? (
              <span className="tabular-nums">已等 {formatLogElapsed(elapsed)}</span>
            ) : null,
            Number.isFinite(polls) && polls > 0 ? `已轮询 ${polls} 次` : null,
            task.id
          ]}
        />
      }
      onClose={onClose}
    >
      <ModalSection title="条件">
        <pre className="chat-modal-pre">{textOf(label)}</pre>
      </ModalSection>
      {task.reason && (
        <ModalSection title="为什么等">
          <div className="chat-modal-prose">{textOf(task.reason)}</div>
        </ModalSection>
      )}
      <ModalSection title="最近一次检查">
        {detail ? (
          <pre className="chat-modal-pre">{textOf(detail)}</pre>
        ) : (
          <div className="chat-modal-note">（还没有观测结果）</div>
        )}
      </ModalSection>
    </TaskDetailModal>
  )
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

function MessageActions({ text, role, onQuote }) {
  const [copied, copy] = useCopied()
  return (
    <>
      <button
        type="button"
        className="chat-message-quote"
        aria-label="引用这条消息"
        title="引用到输入框"
        onClick={() => onQuote?.({ role, text })}
      >
        <IconQuote size={12} />
      </button>
      <button
        type="button"
        className="chat-message-copy"
        aria-label="复制消息"
        title={copied ? '已复制' : '复制'}
        onClick={() => copy(text)}
      >
        {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
      </button>
    </>
  )
}

/** 双击用户消息进入的就地编辑：确认由 host 侧（app-server 的 mica/turn/editMessage）
 *  截断该消息及其之后的会话历史并用新文本重跑。截断后的历史不能与在跑的 turn
 *  竞争，所以确认只在 mica 空闲（!running）且有内容时可用。 */
export function canSubmitMessageEdit({ running, text }) {
  return !running && String(text ?? '').trim().length > 0
}

/** 同文本的用户消息在会话里出现多次时，被编辑的是从末尾数第几条（1 起）。
 *  持久化历史没有逐条消息 id，app-server 只能按文本定位，必须用同一套计数。
 *  归一化就是 app-server 侧那份（`@packages/mica-common/promptText`）：把图片
 *  占位符整体剥掉再折叠空白——界面侧的「[图片]」、provider 侧的「[Image]」与
 *  输入原文的「[Image](路径)」写法各不相同，只做替换仍然对不上。 */
export function promptOccurrenceFromEnd(messages = [], messageId) {
  const index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) return 1
  const key = comparableText(messages[index]?.text)
  if (!key) return 1
  let occurrence = 1
  for (let cursor = index + 1; cursor < messages.length; cursor++) {
    const message = messages[cursor]
    if (message?.role !== 'user' || message.queued) continue
    if (comparableText(message.text) === key) occurrence += 1
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
        {message.detail && (
          <pre>
            <PathText text={message.detail} />
          </pre>
        )}
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

function TurnLogItemView({ message, now, onOpen }) {
  if (message.kind === 'reasoning') {
    return <ReasoningRow text={message.text} />
  }
  return <ToolActivityRow tool={message.tool} now={now} onOpen={() => onOpen?.(message)} />
}

// 回合日志每 250ms 随 chat-status-line 一起重渲染，已完成的行没必要跟着 `now` 重算
// （多行输出展开后一次重渲染就是几千个节点）。
const TurnLogItem = memo(TurnLogItemView, (previous, next) => {
  if (previous.message !== next.message) return false
  if (previous.onOpen !== next.onOpen) return false
  const status = next.message?.tool?.status
  const settled = status && !['pending', 'running'].includes(status)
  return settled ? true : previous.now === next.now
})

function TurnLogDock({ messages, now = Date.now(), onOpenActivity }) {
  const scrollRef = useRef(null)
  // 这块日志的高度也是界面状态：换个窗口打开时保持同一高度，重启后还在。
  const [storedHeight, setStoredHeight] = useSharedState('turnLogHeight', null)
  const height =
    Number.isFinite(storedHeight) && storedHeight >= MIN_TURN_LOG_HEIGHT
      ? Math.min(storedHeight, window.innerHeight * MAX_TURN_LOG_HEIGHT_RATIO)
      : null
  const stickToBottomRef = useRef(true)

  // 只有用户停留在底部时才跟随滚动，手动上翻后不打扰。
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (scroll && stickToBottomRef.current) scroll.scrollTop = scroll.scrollHeight
  }, [messages, height])

  const startResize = useCallback(
    (event, direction) => {
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
        setStoredHeight(next)
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
    },
    [setStoredHeight]
  )

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
          <TurnLogItem key={message.id} message={message} now={now} onOpen={onOpenActivity} />
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

// 对话区里选中的文字（右键菜单的「引用」用它）：只认主对话列表与回合日志里的选区，
// 输入框、浮层里的选择不参与。选区跨了消息边界时不给署名——半句我、半句模型，
// 标成任何一方都是错的，交给默认的「对话」。
function readTranscriptSelection() {
  const selection = window.getSelection?.()
  if (!selection || selection.isCollapsed) return null
  const text = selection.toString().trim()
  if (!text) return null
  const containerOf = (node) => {
    const element = node instanceof Element ? node : node?.parentElement
    return element?.closest('.chat-scroll, .chat-turn-log') ? element : null
  }
  const start = containerOf(selection.anchorNode)
  const end = containerOf(selection.focusNode)
  if (!start || !end) return null
  const ownerOf = (element) => element.closest('.chat-message-user, .chat-message-assistant')
  const startOwner = ownerOf(start)
  const sameOwner = startOwner && startOwner === ownerOf(end)
  const role = sameOwner
    ? startOwner.classList.contains('chat-message-user')
      ? 'user'
      : 'assistant'
    : null
  return { text, role }
}

/** 选中对话文字后浮在选区上方的操作条，替代右键菜单里的「引用」。 */
function ChatSelectionBar({ bar, onQuote, onCopy, copied }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: bar.x, top: bar.y })
  useLayoutEffect(() => {
    if (!ref.current) return
    const width = ref.current.offsetWidth
    const height = ref.current.offsetHeight
    const left = Math.min(Math.max(8, bar.x - width / 2), window.innerWidth - width - 8)
    const top = bar.y - height - 8 < 8 ? bar.y + height + 8 : bar.y - height - 8
    setPos({ left, top })
  }, [bar.x, bar.y, bar.text])
  return (
    <div
      className="chat-selection-bar"
      ref={ref}
      style={{
        left: pos.left,
        top: pos.top
      }}
    >
      <button
        type="button"
        className="chat-selection-bar-btn"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onQuote}
      >
        引用
      </button>
      <button
        type="button"
        className="chat-selection-bar-btn"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onCopy}
      >
        {copied ? '已复制' : '复制'}
      </button>
    </div>
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
  const allItems = [
    {
      id: 'compact-local',
      label: '快速压缩（本地）',
      title:
        '本地压缩：把工具结果与工具参数的正文换成占位符/摘要（保留路径、命令等关键信息），不改动对话文本、不丢弃轮次；不调用模型',
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
    {
      id: 'share',
      label: '分享链接',
      title: '复制一条指向这个会话的地址：打开的人从这条会话开始，看到的界面与本机一样',
      icon: IconShare,
      disabled: !menu.hasSession
    },
    { separator: true },
    { id: 'clear', label: 'Clear', icon: IconTrash, disabled: menu.running, danger: true }
  ].filter(Boolean)
  // 去掉落到首尾的多余分隔线
  const items = allItems.filter(
    (item, index, all) => !item.separator || (index > 0 && index < all.length - 1)
  )
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
  title,
  options,
  activeIndex,
  onActiveIndex,
  onSelect,
  selectedValue,
  loading,
  error,
  onClose
}) {
  return (
    <Popover
      name="picker"
      role="listbox"
      icon={<IconCommand size={13} />}
      title={title}
      meta="↑↓ 选择 · Enter 确认 · Esc 关闭"
      closable={false}
      onClose={onClose}
      className="chat-select-palette"
    >
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
    </Popover>
  )
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

function PhaseElapsedLabel({ startedAt }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!startedAt) {
      setElapsed(0)
      return undefined
    }
    const update = () => setElapsed(Math.max(0, Date.now() - startedAt))
    update()
    const timer = window.setInterval(update, 250)
    return () => clearInterval(timer)
  }, [startedAt])
  if (elapsed <= 0) return null
  return <span className="chat-status-phase-elapsed">{formatLogElapsed(elapsed)}</span>
}

// 运行耗时单独成一个组件：它每 250ms 刷新一次，留在 ChatView 里会让整个会话面板
// （含全部消息行）每秒重渲染 4 次。这里只重渲染这一个 span。
function RunElapsedLabel({ runStartedAt }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!runStartedAt) {
      setElapsed(0)
      return undefined
    }
    const update = () => setElapsed(Math.max(0, Date.now() - runStartedAt))
    update()
    const timer = window.setInterval(update, 250)
    return () => clearInterval(timer)
  }, [runStartedAt])
  return (
    <span className="chat-status-elapsed" title="本次任务总运行时间">
      {formatLogElapsed(elapsed)}
    </span>
  )
}

function MessageRowView({
  message,
  onOpenFile,
  onCommandAction,
  onQuote,
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
              <span className="chat-notice-text">
                <PathText text={noticeLines.slice(1).join('\n')} />
              </span>
            </>
          ) : (
            <span className="chat-notice-text">
              <PathText text={message.text} />
            </span>
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
        <div
          className="chat-message chat-message-user chat-message-editing"
          data-chat-user-message=""
        >
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
        data-chat-user-message=""
        onDoubleClick={(event) => {
          if (event.target.closest('button')) return
          onEditStart?.(message)
        }}
      >
        <div className="chat-message-marker">{message.queued ? '↳' : '▌'}</div>
        <div className="chat-message-body whitespace-pre-wrap break-words">
          {/* 用户自己贴进来的路径同样可点：会话里读到的路径常常是用户先粘过来的；
              图片引用只保留链接文本，点击弹预览（见 ImageLink） */}
          <UserMessageText text={message.text} />
        </div>
        <MessageActions text={message.text} role="user" onQuote={onQuote} />
      </div>
    )
  }
  return (
    <div
      className={`chat-message chat-message-assistant ${message.done ? '' : 'chat-message-active'}`}
    >
      <div className="chat-message-marker">●</div>
      <div className="chat-message-body">
        <Markdown text={message.text || ''} onOpenFile={onOpenFile} />
        <UsageLine usage={message.usage} />
      </div>
      {message.done && <MessageActions text={message.text} role="assistant" onQuote={onQuote} />}
    </div>
  )
}

// 长会话里 ChatView 会因为输入、耗时计时、任务 tick 等高频重渲染，若每一行都跟着重算，
// 整篇对话（可能上千条、每条一个 Markdown）每帧都要重新 reconcile 一遍。流式追加只换掉
// 当前那一条消息对象（见 appendStreamText 的 map），其余保持引用，所以按引用比较就够：
// 只有正在流式输出的那一行会重渲染。回调都由 useCallback/ref 提供，引用稳定。
const MessageRow = memo(MessageRowView, (previous, next) => {
  return (
    previous.message === next.message &&
    previous.edit === next.edit &&
    previous.onOpenFile === next.onOpenFile &&
    previous.onCommandAction === next.onCommandAction &&
    previous.onQuote === next.onQuote &&
    previous.onEditStart === next.onEditStart &&
    previous.onEditChange === next.onEditChange &&
    previous.onEditCancel === next.onEditCancel &&
    previous.onEditSubmit === next.onEditSubmit
  )
})

function WelcomeHint({ cwd }) {
  return (
    <div className="chat-welcome">
      <div className="chat-welcome-command">
        <span>❯</span> mica
      </div>
      <p>输入任务开始对话。Mica 会直接在当前工作区读取代码、调用工具并持续汇报进度。</p>
      {cwd && (
        <code>
          {/* 欢迎页上的工作目录直接可点：省掉「先去 Files 面板找目录」这一步 */}
          <PathText text={cwd} />
        </code>
      )}
    </div>
  )
}

// 状态行展示用的阶段：`phase` 是一条工具结果回来后仍停在 `working`，而那时实际已经在等
// 下一次请求了——CLI 的 AgentRuntime 在 onToolResult 里就是当场把状态切回 connecting
// （显示为 waiting_model）。不换算的话，状态文本会退化成没有对象的 calling_tool，阶段计时
// 也会因为找不到 running 工具而失去锚点（见 PhaseElapsedLabel 的 startedAt），整段时间从界面消失。
export function statusLinePhase(phase, toolNames = []) {
  return phase === 'working' && toolNames.length === 0 ? 'connecting' : phase
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

// 重试是 host 内部行为（最多 5 次、固定 10s），没有这两段文案时，等待期间与卡死
// 无法区分：状态行只说第几次，会话里的 notice 额外带上一次失败的原因。
export function retryStatusLabel(retryInfo) {
  if (!retryInfo) return ''
  const seconds = Math.max(1, Math.round((Number(retryInfo.delayMs) || 0) / 1000))
  return `retrying ${retryInfo.attempt}/${retryInfo.maxAttempts} · ${seconds}s`
}

export function retryNoticeText(retryInfo) {
  if (!retryInfo) return ''
  const seconds = Math.max(1, Math.ceil((Number(retryInfo.delayMs) || 0) / 1000))
  const line = `请求暂时失败，将在 ${seconds}s 后自动重试（第 ${retryInfo.attempt}/${retryInfo.maxAttempts} 次）`
  return retryInfo.error ? `${line}\n错误：${retryInfo.error}` : line
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

// 会话里的用户文本把图片块渲染成 [图片] 占位符，输入框原文是 [Image](路径)，
// provider 历史里还有第三种写法；比对用户消息边界时统一剥掉这些占位符再折叠
// 空白，否则带图片的输入永远匹配不到（会补出重复的用户行）。
function promptKey(text) {
  return comparableText(text)
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

/**
 * host 主动发起的一轮（定时任务、after_turn 排队重放、另一个窗口发起的发送）不经过本页的
 * `send()`，用户气泡只能由 host 的 `chat:run-started` 补进对话——否则运行中只看得到回答，
 * 用户消息要等重新加载会话才出现。
 *
 * 幂等：本页已经为本轮插过行（乐观行的 id 就是 clientMessageId），或对话末尾还停着一条
 * 同样文本的用户消息（after_turn 排队行、编辑重发截断后留下的那一行）就不再追加。
 * 不能在整篇对话里按文本去重——定时任务每一轮的文本都一样，那样从第二轮起用户行会全部消失。
 */
export function appendRunStartedMessage(messages, run) {
  const text = String(run?.prompt || '').trim()
  if (!text) return messages
  const id = run?.clientMessageId || null
  if (id && messages.some((message) => message.id === id)) return messages
  // 末尾最后一条 user/assistant 消息就是这一轮的上文：它还是一条未被回答的用户消息
  // （文本相同）时，本轮的用户行已经在列表里了；如果是 assistant 回答，则是新一轮。
  const lastTurnMessage = [...messages]
    .reverse()
    .find((message) => message?.role === 'user' || message?.role === 'assistant')
  if (lastTurnMessage?.role === 'user' && promptKey(lastTurnMessage.text) === promptKey(text)) {
    return messages
  }
  return [...messages, { id: id || uid('msg'), kind: 'message', role: 'user', text, done: true }]
}

export function isPersistedRunComplete(meta, startedAt) {
  if (!meta?.turnState || meta.turnState === 'running' || !startedAt) return false
  const updatedAt = Date.parse(meta.updatedAt || '')
  return Number.isFinite(updatedAt) && updatedAt > startedAt
}

function persistedTranscript(messages) {
  if (!Array.isArray(messages)) return []
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

/**
 * 会话的**渲染结果**缓存（模块级，按节点 id，有界 LRU）。
 *
 * 磁盘上的会话历史只有 role/text：思考、工具调用、TODO 都只存在于事件流里。所以离开一个
 * 会话再回来时，如果只能从磁盘重建，那些内容就没了（而 host 的事件缓冲本身有上限，长 turn
 * 里早期的思考与 TODO 也早被挤掉）。把上一次的渲染结果留着，切回来先用它渲染，再用事件流
 * 补差量，界面就不会「状态在跑但思考是空的、TODO 卡住」。
 *
 * 放在模块级而不是组件内的 ref：组件被淘汰（切过的会话超过保留上限）后重建时也还能命中。
 */
const TRANSCRIPT_CACHE_LIMIT = 8
const transcriptCache = new Map()

/**
 * 滚动位置按节点记。缓存实例切走时只是被加上 `hidden`（display:none），而 display:none 会把
 * 滚动容器的 `scrollTop` 清成 0，再显示回来也不会自己恢复；显示回来那一下 React 还可能重建
 * 这段 DOM。所以位置只能自己记、自己放回去。判定见 chat-scroll.js。
 */
const scrollCache = new Map()

/**
 * 重放时会往消息列表上「追加」的事件类型：重放它们必须从磁盘历史重建，否则会与本轮
 * 已渲染的内容重复。其余事件（用量、后台任务/subagent/等待/btw 快照）是整体替换语义，
 * 可以安全地叠加在已有的 transcript 之上。
 */
const ACCUMULATING_EVENT_TYPES = new Set([
  'step_start',
  'reasoning',
  'text',
  'tool_use',
  'error',
  'notice',
  'step_finish',
  'session_history_replaced'
])

function readCachedTranscript(nodeId) {
  if (!nodeId) return null
  const cached = transcriptCache.get(nodeId)
  if (cached === undefined) return null
  // 命中即刷新到 LRU 末尾
  transcriptCache.delete(nodeId)
  transcriptCache.set(nodeId, cached)
  return cached
}

function writeCachedTranscript(nodeId, messages) {
  if (!nodeId || !Array.isArray(messages) || messages.length === 0) return
  transcriptCache.delete(nodeId)
  transcriptCache.set(nodeId, messages)
  while (transcriptCache.size > TRANSCRIPT_CACHE_LIMIT) {
    const oldest = transcriptCache.keys().next().value
    if (oldest === undefined) break
    transcriptCache.delete(oldest)
  }
}

/** 只给测试用：清掉跨实例的缓存。 */
export function resetTranscriptCache() {
  transcriptCache.clear()
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
// - agent 运行中（queueReady）：Tab 与 Shift+Tab 都把当前输入排队发送（after_iteration，
//   在下一个工具调用迭代边界注入当前 turn；与忙时 Enter 同一条路径）；
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

export function ChatView({
  node,
  cwd,
  visible,
  isMobile = false,
  loops = [],
  onSessionBound,
  onOpenFile,
  onOpenDocument,
  onNewSession,
  onResumeSession,
  onOpenTerminal,
  onOpenSettings,
  onSessionRenamed,
  onShareSession
}) {
  const nodeId = node?.id || null
  const nodeIdRef = useLatest(nodeId)
  const cwdRef = useLatest(cwd)
  const onSessionBoundRef = useLatest(onSessionBound)
  const onOpenFileRef = useLatest(onOpenFile)
  const onOpenDocumentRef = useLatest(onOpenDocument)
  const onNewSessionRef = useLatest(onNewSession)
  const onResumeSessionRef = useLatest(onResumeSession)
  const onOpenTerminalRef = useLatest(onOpenTerminal)
  const onOpenSettingsRef = useLatest(onOpenSettings)
  const onSessionRenamedRef = useLatest(onSessionRenamed)
  const onShareSessionRef = useLatest(onShareSession)
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
  // 未发送的草稿与运行时同源（ui-state 的 `drafts` 键）：切走、刷新、换个窗口打开都在，
  // 别的窗口改了同一个会话的草稿这里也跟着变。ref 形态只是为了不改动读写它的那些调用点
  // （switchChatDraft / navigateChatHistory 按 Map 的形状用它）。
  const draftsRef = useRef(null)
  if (!draftsRef.current) {
    draftsRef.current = {
      get: (id) => uiStateKeys().drafts?.[id] ?? '',
      set: (id, text) => setUiStateEntries('drafts', { [id]: String(text ?? '') })
    }
  }
  // 本页最后为某个节点设置过/应用过的草稿文本，用来区分「别的窗口改了」与「自己的回声」。
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
  // 上一节点「最后一次滚动到哪」；切走时用它写进 scrollCache（那时旧节点已被隐藏，
  // 从 DOM 读 scrollTop 只会得到 0）。
  const scrollStateRef = useRef({ top: 0, stick: true })
  // 本节点待恢复的偏移；等 historyLoaded 之后再落到 DOM 上，早落会被夹到当时还很矮的内容里。
  const pendingScrollRestoreRef = useRef(null)
  const previousVisibleRef = useRef(visible)

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const inputRef = useLatest(input)
  const [running, setRunning] = useState(false)
  // 这个会话正被**另一个进程**跑着（终端里的 TUI / mica exec / 另一个运行时实例持着它的
  // turn lease）。同一运行时里的其它页面不算——工作区只有一份，它们跑的是同一个 run，
  // 事件流本来就会广播到这里。这种情况本页拿不到事件流，只能显示状态并挡下发送。
  const [remoteRunning, setRemoteRunning] = useState(false)
  const remoteRunningRef = useLatest(remoteRunning)
  // run 级操作（中止、撤回排队、任务详情/终止）打给谁。工作区只有一份，同一个会话在所有
  // 页面里就是同一个 chat 节点、同一个 run，所以就是本节点的 id——不再需要「附着到别的
  // 页签那个 run」的概念。
  const runKey = nodeId
  const [queuedItems, setQueuedItems] = useState([])
  const [recallingQueueId, setRecallingQueueId] = useState(null)
  // 跨 turn 常驻的后台任务 / subagent 状态（来自 app-server 快照通知，
  // 与 CLI TaskStatusBar 一致地展示在输入框上方）。
  const [backgroundTasks, setBackgroundTasks] = useState([])
  const [subagentTasks, setSubagentTasks] = useState([])
  // 正在阻塞 turn 的 wait_for 等待（来自 app-server 快照通知）。
  const [waitTasks, setWaitTasks] = useState([])
  const [taskNow, setTaskNow] = useState(() => Date.now())
  // 点开的任务详情弹窗（单槽位）：{ kind: 'subagent' | 'background', task } | null
  const [taskDetail, setTaskDetail] = useState(null)
  // 点开的回合日志详情（单槽位）：存消息 id 而不是快照，行还在流式更新时弹窗跟着刷新。
  const [activityDetailId, setActivityDetailId] = useState(null)
  // 输入框右侧齿轮点开的「会话设置」弹窗。存当前分类（能力 / 压缩 / 定时任务），
  // null 表示关闭；三块开关都落在会话快照，不落到应用设置。
  const [settingsSection, setSettingsSection] = useState(null)
  // By The Way（CLI 的 /btw）：线程活在 app-server 里，这里只存投影。
  // 一个会话可以有多个 tab（= 多条线程），按线程 id 存各自的快照；`btwActiveId` 是当前
  // 显示的那一个。快照整份替换，所以这里只需要一张 id → thread 的表。
  const [btwThreads, setBtwThreads] = useState({})
  const [btwActiveId, setBtwActiveId] = useState('')
  const btwThread = btwThreads[btwActiveId] || { id: btwActiveId, entries: [] }
  const [btwOpen, setBtwOpen] = useState(false)
  const [btwDraft, setBtwDraft] = useState('')
  const [btwSending, setBtwSending] = useState(false)
  const [btwCompacting, setBtwCompacting] = useState(false)
  // 上一次渲染的线程快照（在 applyBtwThread 里比较「刚回答完的那一条」），
  // 面板关着时补一条提示用；同时兼作「回答到达」的去重依据。
  const btwThreadsRef = useRef({})
  const btwActiveIdRef = useRef('')
  btwActiveIdRef.current = btwActiveId
  // 还没发出去的 By The Way 问题：按 `节点:线程` 存，切走再回来仍在（与主输入框的
  // drafts 同款，但多一维——每个 tab 有自己半句话）。
  const btwDraftsRef = useRef(new Map())
  const btwOpenRef = useRef(false)
  btwOpenRef.current = btwOpen

  /**
   * 打开抽屉时向 host 要一次 tab 清单。
   *
   * 线程活在 host 里（并落盘到 `$MICA_HOME/btw/<sessionId>.json`），所以页面刷新、
   * 换个窗口打开、甚至关掉 app 再打开，抽屉里该有哪些 tab 都只能问 host。这里只在
   * 「打开抽屉」时问一次：没打开时不需要为它起 host，也不需要维护一份可能过期的表。
   */
  useEffect(() => {
    if (!btwOpen || !nodeIdRef.current) return undefined
    let cancelled = false
    const targetNodeId = nodeIdRef.current
    void (async () => {
      try {
        const res = await window.mica.chat.btwThreads(targetNodeId, sessionIdRef.current || '')
        if (cancelled || nodeIdRef.current !== targetNodeId) return
        const list = Array.isArray(res?.threads) ? res.threads : []
        if (list.length === 0) return
        const table = {}
        for (const thread of list) {
          if (!thread?.id) continue
          table[thread.id] = {
            id: thread.id,
            entries: Array.isArray(thread.entries) ? thread.entries : [],
            ...(thread.context ? { context: thread.context } : {})
          }
        }
        if (Object.keys(table).length === 0) return
        // host 是权威的：整表替换（未回答完的 tab 在重开后会以 running 条目出现，
        // 后续快照照常覆盖），但保留客户端认识的 tab 顺序感——这里以 host 顺序为准。
        btwThreadsRef.current = table
        setBtwThreads(table)
        if (!btwActiveIdRef.current || !table[btwActiveIdRef.current]) {
          const fallback = list[list.length - 1]?.id || ''
          btwActiveIdRef.current = fallback
          setBtwActiveId(fallback)
          setBtwDraft(btwDraftsRef.current.get(btwDraftKey(targetNodeId, fallback)) || '')
        }
      } catch {
        // 拿不到就当没有 tab（下一次提问会新建一条），不打扰用户
      }
    })()
    return () => {
      cancelled = true
    }
    // 依赖里带上 sessionId：从草稿发出第一条消息时节点会换成真会话，host 与落盘的
    // 线程都挂在 sessionId 上，换到它之后要再问一次。
  }, [btwOpen, node?.sessionId, nodeIdRef])

  const [killingTaskId, setKillingTaskId] = useState(null)
  const [stopping, setStopping] = useState(false)
  const [phase, setPhase] = useState('idle')
  // 当前 turn 正在 host 内部重试：{ attempt, maxAttempts, delayMs, error }。
  // 只在 running 时影响状态行，收到响应（step_start/text/...）后清空。
  const [retryInfo, setRetryInfo] = useState(null)
  const [runStartedAt, setRunStartedAt] = useState(0)
  // 最近一次 turn 的结束结果：{ state: 'completed' | 'error', durationMs }。
  // 运行结束后状态行左侧展示它（对齐 CLI：completed 绿色带耗时、error 红色、aborted 不展示）。
  const [lastRun, setLastRun] = useState(null)
  // 当前阶段/工具的实时耗时（对齐 CLI WorkingStatus：状态文本带 elapsed，
  // working 阶段从最早 running 工具 startedAt 起算，其余阶段从阶段切换起算）。
  // 起算点在 statusLinePhase 换算之后的那一段：见下方 displayPhase 的 effect。
  const phaseStartedAtRef = useRef(0)
  // 有活跃后台任务 / subagent / wait_for 等待时每秒刷新耗时，空闲时停表。
  const hasLiveTasks =
    backgroundTasks.length > 0 || subagentTasks.length > 0 || waitTasks.length > 0
  useEffect(() => {
    if (!hasLiveTasks) return undefined
    const timer = window.setInterval(() => setTaskNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [hasLiveTasks])

  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [showJump, setShowJump] = useState(false)
  // 「上一个对话」只有上方真的有对话时才可点，判定见 hasPreviousConversation
  const [canPrevConversation, setCanPrevConversation] = useState(false)
  const canPrevConversationRef = useRef(false)
  const [meta, setMeta] = useState(null)
  const [todoHidden, setTodoHidden] = useState(false)
  const overridesRef = useRef(new Map()) // nodeId -> { model, variant, role }
  const forceRender = useReducer((version) => version + 1, 0)[1]
  const [picker, setPicker] = useState(null) // { kind, title, options, loading, error }
  const [pickerIndex, setPickerIndex] = useState(0)
  // 输入框补全（`@` 文件 / `/` skill）：选中后只往输入框插入文本，不执行任何动作
  const [completion, setCompletion] = useState(null) // { kind: 'file' | 'skill', start, query }
  const [completionItems, setCompletionItems] = useState([])
  const [completionIndex, setCompletionIndex] = useState(0)
  const [completionLoading, setCompletionLoading] = useState(false)
  const [completionFailed, setCompletionFailed] = useState(false)
  // 当前候选列表属于哪一类触发字符（`@` 文件 / `/` skill），换类时先清空旧结果
  const completionKindRef = useRef(null)
  const [contextMenu, setContextMenu] = useState(null)
  // 选中对话文字后浮出的引用/复制条：{ text, role, x, y } | null
  const [selectionBar, setSelectionBar] = useState(null)
  const [selectionCopied, setSelectionCopied] = useState(false)
  const [imagePreview, setImagePreview] = useState(null)
  const [contextDetail, setContextDetail] = useState(false)
  const [commitRunning, setCommitRunning] = useState(false)
  // 双击用户消息进入的就地编辑（单槽位）：{ id, prompt, text } | null
  const [messageEdit, setMessageEdit] = useState(null)
  const commitTaskRef = useRef(null) // { id, noticeId, cwd, nodeId }
  // 输入框区域手动设定的最小高度（px）；null 表示跟随默认 30px
  const [composerMinHeight, setComposerMinHeight] = useState(null)
  const messagesRef = useRef([])
  const modelProtocolsRef = useRef(null) // { map: { [modelId]: { protocol, efforts } }, currentProtocol }
  const protocolBlockRef = useRef('')
  const compactBusyRef = useRef(false)
  const listRef = useRef(null)
  const transcriptRef = useRef(null)
  const composerDockRef = useRef(null)
  const textareaRef = useRef(null)
  const imageInputRef = useRef(null)

  // 主对话区的查找条（Cmd/Ctrl+F）。`findFocusSignal` 只为「已经开着时再按一次」服务：
  // 变化一次就重新聚焦并全选查询，和 VS Code 的 find widget 一样。
  const [findOpen, setFindOpen] = useState(false)
  const [findFocusSignal, setFindFocusSignal] = useState(0)
  const closeFind = useCallback(() => {
    setFindOpen(false)
    textareaRef.current?.focus({ preventScroll: true })
  }, [])

  // 切走时收起查找条：命中高亮是整页共用的（`CSS.highlights`），留着会在别的页签里
  // 覆盖或残留下不属于当前对话的高亮。
  useEffect(() => {
    if (!visible) setFindOpen(false)
  }, [visible])

  // Cmd/Ctrl+F 只在焦点落在这块对话区（或干脆没焦点）时接管：在终端、编辑器里按下时
  // 不属于「查找对话」，别把键抢走。
  useEffect(() => {
    if (!visible) return undefined
    const onKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLocaleLowerCase() !== 'f') return
      const active = document.activeElement
      if (active && active !== document.body && !active.closest?.('.chat-view')) return
      event.preventDefault()
      event.stopPropagation()
      setFindOpen(true)
      setFindFocusSignal((value) => value + 1)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [visible])

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

  // 复用同一条 notice（按 command 认领上一次的位置）：重试每次都刷新同一条，
  // 而不是往会话里堆 5 条。
  const upsertNotice = useCallback(
    (text, variant = 'info', command = '') => {
      if (!text) return null
      updateMessages((previous) => {
        const index = previous.findLastIndex(
          (message) => message.kind === 'notice' && command && message.command === command
        )
        if (index < 0) {
          return [
            ...previous,
            { id: uid('notice'), kind: 'notice', role: 'notice', text, variant, command }
          ]
        }
        return previous.map((message, i) => (i === index ? { ...message, text, variant } : message))
      })
    },
    [updateMessages]
  )

  const openTaskDetail = useCallback((kind, task) => setTaskDetail({ kind, task }), [])
  // 稳定的关闭回调：任务详情是 memo 组件，内联箭头会让它每次 tick 都重渲染。
  const closeTaskDetail = useCallback(() => setTaskDetail(null), [])
  // 回合日志的点开动作也必须是引用稳定的：TurnLogItem 是 memo 的，闭包一变，
  // 已经跑完的行就会跟着 250ms 计时器重渲染。
  const openActivityDetail = useCallback((message) => setActivityDetailId(message?.id ?? null), [])

  /**
   * 启动（或替换）当前会话的定时循环——输入条时钟面板（唯一入口）走这条链路。
   * 循环按 nodeId 归属，所以草稿会话也能启动：host 会立刻跑第一轮，那一轮创建会话。
   */
  const startLoop = useCallback(
    async ({ intervalMs, task }) => {
      const result = await window.mica.loops
        .start({
          nodeId,
          sessionId: sessionIdRef.current || null,
          cwd: cwdRef.current || null,
          intervalMs,
          task
        })
        .catch((error) => ({ ok: false, error: String(error?.message || error) }))
      if (!result?.ok) {
        appendNotice(`定时任务启动失败：${result?.error || '未知错误'}`, 'error')
        return false
      }
      appendNotice(
        `${result.replaced ? '定时任务已更新' : '定时循环已启动'}：每 ${formatLoopInterval(intervalMs)} 执行「${task}」，首轮已开始`,
        'success'
      )
      return true
    },
    [appendNotice, nodeId]
  )

  const handleLoopStart = useCallback(
    ({ intervalMs, task }) => {
      void startLoop({ intervalMs, task })
      setSettingsSection(null)
    },
    [startLoop]
  )

  const changeBtwDraft = useCallback(
    (value) => {
      btwDraftsRef.current.set(btwDraftKey(nodeIdRef.current, btwActiveIdRef.current), value)
      setBtwDraft(value)
    },
    [nodeIdRef]
  )

  /**
   * By The Way（CLI 的 `/btw`）。**不占队列、不改 run 状态**：host 收下问题立刻回，
   * 回答随后作为 `btw_thread` 快照到达——所以主流程正在跑也能问，问完也不用等它。
   * 失败（host 不在、已有问题在回答）时保留草稿，用户可以直接重试。
   */
  const askBtw = useCallback(
    async (question, options = {}) => {
      const text = String(question || '').trim()
      const targetNodeId = nodeIdRef.current
      // 提问落在当前 tab 上；没有 tab（第一次打开抽屉）时让 host 新建一条，
      // 之后按它返回的 id 归位——所以这里不预先造 id。
      const targetThreadId = btwActiveIdRef.current
      // 回答期间提交是**排队**（单槽位），不是第二次并发提问：btw 复用同一个子代理，
      // 它的消息数组不是并发安全的。
      const queue = options.queue === true
      if (!text || btwSending) return
      setBtwSending(true)
      try {
        // 草稿在发送成功后才清：失败时留在输入框里，用户不用重打。
        // sessionId/cwd 让 host 在没有常驻进程时按需起一个——「刚打开一条会话、
        // 还没发消息就想问一句」正是 btw 最该成立的场景。
        const res = await window.mica.chat.btwAsk(targetNodeId, text, {
          threadId: targetThreadId,
          queue,
          sessionId: sessionIdRef.current || '',
          cwd: cwdRef.current || ''
        })
        if (nodeIdRef.current !== targetNodeId) return
        if (!res?.ok) {
          appendNotice(`By The Way 失败：${res?.error || '未知错误'}`, 'error')
          return
        }
        if (res.result?.ok === false) {
          appendNotice(`By The Way 失败：${res.result.message || '未知错误'}`, 'warn')
          return
        }
        // host 可能新开了一条线程（原先没有 tab），按它给的 id 切过去；
        // 草稿也记在新 tab 名下（老的 key 上没有内容，留着也无害）。
        const resolvedThreadId = res.result?.threadId || targetThreadId
        if (resolvedThreadId && resolvedThreadId !== btwActiveIdRef.current) {
          btwActiveIdRef.current = resolvedThreadId
          setBtwActiveId(resolvedThreadId)
        }
        btwDraftsRef.current.set(btwDraftKey(targetNodeId, resolvedThreadId), '')
        setBtwDraft('')
      } catch (error) {
        if (nodeIdRef.current === targetNodeId) {
          appendNotice(
            `By The Way 失败：${error instanceof Error ? error.message : String(error)}`,
            'error'
          )
        }
      } finally {
        setBtwSending(false)
      }
    },
    // useLatest 返回的是稳定的 ref 盒子，列进来只为消掉 exhaustive-deps 的误报。
    [appendNotice, btwSending, cwdRef, nodeIdRef]
  )

  /**
   * 开一个新 tab（= host 侧一条新线程）。
   *
   * 上下文要等第一次提问才取：空 tab 不该被算成一次问答，也不该白占一份子代理。
   * 所以这里只让 host 把 id 建出来，然后切过去。
   */
  const addBtwThread = useCallback(async () => {
    const targetNodeId = nodeIdRef.current
    try {
      const res = await window.mica.chat.btwAsk(targetNodeId, '', {
        sessionId: sessionIdRef.current || '',
        cwd: cwdRef.current || ''
      })
      if (nodeIdRef.current !== targetNodeId) return
      if (!res?.ok) {
        appendNotice(`新建 By The Way 失败：${res?.error || '未知错误'}`, 'error')
        return
      }
      const createdId = res.result?.threadId
      if (!createdId) return
      setBtwThreads((current) => ({
        ...current,
        [createdId]: current[createdId] || { id: createdId, entries: [] }
      }))
      btwActiveIdRef.current = createdId
      setBtwActiveId(createdId)
      btwDraftsRef.current.set(btwDraftKey(targetNodeId, createdId), '')
      setBtwDraft('')
    } catch (error) {
      if (nodeIdRef.current === targetNodeId) {
        appendNotice(
          `新建 By The Way 失败：${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
      }
    }
  }, [appendNotice, cwdRef, nodeIdRef])

  /** 切 tab：把当前 tab 的半句话存下、把目标 tab 的草稿取回来。 */
  const selectBtwThread = useCallback(
    (threadId) => {
      const target = String(threadId || '')
      if (!target || target === btwActiveIdRef.current) return
      btwDraftsRef.current.set(btwDraftKey(nodeIdRef.current, btwActiveIdRef.current), btwDraft)
      btwActiveIdRef.current = target
      setBtwActiveId(target)
      setBtwDraft(btwDraftsRef.current.get(btwDraftKey(nodeIdRef.current, target)) || '')
    },
    [btwDraft, nodeIdRef]
  )

  /** 关 tab：host 侧线程也要删（正在回答的那条会被拒绝，原因如实提示）。 */
  const closeBtwThread = useCallback(
    async (threadId) => {
      const targetNodeId = nodeIdRef.current
      const target = String(threadId || '')
      if (!target) return
      try {
        const res = await window.mica.chat.btwClose(targetNodeId, target)
        if (nodeIdRef.current !== targetNodeId) return
        if (res?.result?.ok === false) {
          appendNotice(`关闭失败：${res.result.message || '未知错误'}`, 'warn')
          return
        }
        if (!res?.ok) {
          appendNotice(`关闭失败：${res?.error || 'chat host 不可用'}`, 'error')
          return
        }
        btwDraftsRef.current.delete(btwDraftKey(targetNodeId, target))
        setBtwThreads((current) => {
          const next = { ...current }
          delete next[target]
          return next
        })
        if (btwActiveIdRef.current === target) {
          // 关掉当前 tab 就落在剩下最后一个上（没有就回到空态，下一次提问新建）
          const remaining = Object.values(btwThreadsRef.current).filter(
            (thread) => thread.id !== target
          )
          const fallback = remaining[remaining.length - 1]?.id || ''
          btwActiveIdRef.current = fallback
          setBtwActiveId(fallback)
          setBtwDraft(btwDraftsRef.current.get(btwDraftKey(targetNodeId, fallback)) || '')
        }
      } catch (error) {
        if (nodeIdRef.current === targetNodeId) {
          appendNotice(
            `关闭失败：${error instanceof Error ? error.message : String(error)}`,
            'error'
          )
        }
      }
    },
    [appendNotice, nodeIdRef]
  )

  /**
   * By The Way 的「快速压缩」：与主对话的本地压缩同源（`toolResultsOnly`），只清理
   * 这条线程发给模型的历史——不调用模型、不丢轮次，所以可以反复点。
   */
  const compactBtw = useCallback(async () => {
    const targetNodeId = nodeIdRef.current
    const targetThreadId = btwActiveIdRef.current
    if (!targetThreadId) return
    if (btwCompacting) return
    setBtwCompacting(true)
    try {
      const res = await window.mica.chat.btwCompact(targetNodeId, targetThreadId, {
        sessionId: sessionIdRef.current || '',
        cwd: cwdRef.current || ''
      })
      if (nodeIdRef.current !== targetNodeId) return
      if (!res?.ok) {
        appendNotice(`压缩失败：${res?.error || 'chat host 不可用'}`, 'error')
        return
      }
      if (res.result?.ok === false) {
        appendNotice(`压缩失败：${res.result.message || '未知错误'}`, 'warn')
        return
      }
      const saved = Number(res.result?.savedTokens) || 0
      appendNotice(
        saved > 0
          ? `已压缩 By The Way 上下文，释放约 ${formatTokens(saved)} token`
          : '已压缩 By The Way 上下文',
        'info'
      )
    } catch (error) {
      if (nodeIdRef.current === targetNodeId) {
        appendNotice(`压缩失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    } finally {
      setBtwCompacting(false)
    }
  }, [appendNotice, btwCompacting, nodeIdRef])

  /** 停止正在回答的那一问（抽屉输入条的停止按钮）。只发中断、不 await 结果。 */
  const stopBtw = useCallback(async () => {
    const targetNodeId = nodeIdRef.current
    const targetThreadId = btwActiveIdRef.current
    if (!targetThreadId) return
    try {
      const res = await window.mica.chat.btwInterrupt(targetNodeId, targetThreadId, {
        sessionId: sessionIdRef.current || '',
        cwd: cwdRef.current || ''
      })
      if (nodeIdRef.current !== targetNodeId) return
      // 收尾（aborted 状态）由 host 经 `mica/btw/updated` 推回，这里只报业务性失败。
      if (!res?.ok) appendNotice(`停止失败：${res?.error || 'chat host 不可用'}`, 'error')
      else if (res.result?.ok === false) appendNotice(res.result.message || '停止失败', 'warn')
    } catch (error) {
      if (nodeIdRef.current === targetNodeId) {
        appendNotice(`停止失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
  }, [appendNotice, nodeIdRef])

  /**
   * 撤回排队中的问题：把问题取回输入框（等价主对话的 shift+←），不丢字。
   *
   * 撤回后草稿里已有内容时**追加**而不是覆盖——用户可能已经写了下一句。
   */
  const recallBtw = useCallback(async () => {
    const targetNodeId = nodeIdRef.current
    const targetThreadId = btwActiveIdRef.current
    if (!targetThreadId) return
    try {
      const res = await window.mica.chat.btwRecall(targetNodeId, targetThreadId, {
        sessionId: sessionIdRef.current || '',
        cwd: cwdRef.current || ''
      })
      if (nodeIdRef.current !== targetNodeId) return
      if (!res?.ok) {
        appendNotice(`取回失败：${res?.error || 'chat host 不可用'}`, 'error')
        return
      }
      if (res.result?.ok === false) {
        appendNotice(res.result.message || '没有排队中的问题', 'warn')
        return
      }
      const recalled = String(res.result?.question || '')
      if (!recalled) return
      const key = btwDraftKey(targetNodeId, targetThreadId)
      const current = btwDraftsRef.current.get(key) || ''
      const next = current ? `${current}${current.endsWith('\n') ? '' : '\n'}${recalled}` : recalled
      btwDraftsRef.current.set(key, next)
      setBtwDraft(next)
    } catch (error) {
      if (nodeIdRef.current === targetNodeId) {
        appendNotice(`取回失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
  }, [appendNotice, nodeIdRef])

  // 「点击路径」的默认动作：目录交给 Finder 打开、文件在文件管理器里定位。
  // 路径可能来自另一台机器（页面连的是远程运行时），失败必须提示而不是静默。
  const revealPathInFinder = useCallback(
    async (target) => {
      try {
        const result = await window.mica.files.openPath(target)
        if (result && result.ok === false) {
          appendNotice(`打开路径失败：${result.error || target}`, 'warn')
        }
        return result
      } catch (error) {
        appendNotice(
          `打开路径失败：${error instanceof Error ? error.message : String(error)}`,
          'warn'
        )
        return { ok: false }
      }
    },
    [appendNotice]
  )

  const killBackgroundTask = useCallback(
    async (task) => {
      if (
        !window.confirm(`确定要终止后台任务 ${task.id} 吗？\n\n${compactLine(task.command, 160)}`)
      ) {
        return
      }
      setKillingTaskId(task.id)
      try {
        const res = await window.mica.chat.killBackgroundTask(runKey, task.id)
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
    [appendNotice, runKey]
  )

  const stopSubagent = useCallback(
    async (taskId) => {
      if (!window.confirm('确定要停止这个 subagent 任务吗？')) return
      try {
        const res = await window.mica.chat.killSubagent(runKey, taskId)
        if (!res?.ok || res.result?.ok === false) {
          appendNotice(res?.error || res?.result?.message || '停止 subagent 失败', 'error')
        }
      } catch (error) {
        appendNotice(`停止 subagent 失败：${error?.message || error}`, 'error')
      }
    },
    [appendNotice, runKey]
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

  // 把一条消息引用进草稿（对话流里消息右侧的「引用」按钮）。和 insertComposerText
  // 同源：以 textarea 当前的值为准，插完把光标落在引用块后面的空行上；同一条消息
  // 重复点不重复插入（quoteIntoDraft 负责），只把光标送回已有的那个块。
  const quoteMessage = useCallback(
    ({ role, text, label }) => {
      const element = textareaRef.current
      const current = element?.value ?? inputRef.current ?? ''
      const caret = element ? element.selectionStart : current.length
      const next = quoteIntoDraft(current, caret, { role, text, label })
      draftsRef.current.set(nodeId, next.text)
      setInput(next.text)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(next.caret, next.caret)
      })
    },
    [inputRef, nodeId]
  )

  // 引用条上的 ✕：只删那一个引用块，用户自己写的正文不动。
  const removeQuoteFromComposer = useCallback(
    (block) => {
      const element = textareaRef.current
      const current = element?.value ?? inputRef.current ?? ''
      const next = removeQuoteBlock(current, block)
      if (next === current) return
      draftsRef.current.set(nodeId, next)
      setInput(next)
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [inputRef, nodeId]
  )

  // 补全触发器：`/` 只在行首且还没输入空白时算，`@` 要求词首；输入变化时重算一次，
  // 只在 kind/start/query 真的变了才换对象，避免每次按键都重渲染候选列表。
  useEffect(() => {
    const element = textareaRef.current
    const caret = element && element.value === input ? element.selectionStart : input.length
    const next = activeCompletion(input, caret)
    setCompletion((current) =>
      current &&
      next &&
      current.kind === next.kind &&
      current.start === next.start &&
      current.query === next.query
        ? current
        : next
    )
  }, [input])

  // 候选：skill 走 host 现扫（项目级 + 用户级）并在这里排序；文件走 host 的 files:mention，
  // 它和 CLI 的 `@` 共用 mica-file-mentions（同一个工作区扫描 + 同一套评分，扫描结果按
  // 工作区缓存），这里只做「有查询挡 100ms 击键、空查询立即出列表」的防抖。
  useEffect(() => {
    if (!completion) {
      completionKindRef.current = null
      setCompletionItems((items) => (items.length === 0 ? items : []))
      setCompletionLoading(false)
      setCompletionFailed(false)
      return undefined
    }
    // 换了触发字符（`/` ↔ `@`）就先清空：文件候选要等防抖，期间不能继续挂着 skill 的行
    if (completionKindRef.current !== completion.kind) {
      completionKindRef.current = completion.kind
      setCompletionItems((items) => (items.length === 0 ? items : []))
      setCompletionLoading(true)
      setCompletionFailed(false)
    }
    let cancelled = false
    const settle = (items) => {
      if (cancelled) return
      setCompletionItems(items)
      setCompletionLoading(false)
      setCompletionFailed(false)
    }
    const fail = () => {
      if (cancelled) return
      setCompletionItems([])
      setCompletionLoading(false)
      setCompletionFailed(true)
    }

    if (completion.kind === 'skill') {
      setCompletionLoading(true)
      // `/` 的候选是两个来源：本地 skills 与 config.json 里的 MCP server。任一失败仍然
      // 展示另一边，两边都拿不到才算失败。
      Promise.allSettled([
        window.mica.skills.list(cwd || null),
        window.mica.mcp.listCandidates()
      ]).then(([skills, mcpServers]) => {
        if (cancelled) return
        if (skills.status === 'rejected' && mcpServers.status === 'rejected') {
          fail()
          return
        }
        settle(
          slashCompletionOptions(
            {
              skills: skills.status === 'fulfilled' ? skills.value : [],
              mcpServers: mcpServers.status === 'fulfilled' ? mcpServers.value : []
            },
            completion.query
          )
        )
      })
      return () => {
        cancelled = true
      }
    }

    if (!cwd) {
      setCompletionItems((items) => (items.length === 0 ? items : []))
      return undefined
    }
    const timer = window.setTimeout(
      () => {
        setCompletionLoading(true)
        window.mica.files
          .mention(cwd, completion.query)
          .then((result) => settle(fileCompletionOptions(result)))
          .catch(fail)
      },
      completion.query ? FILE_COMPLETION_DEBOUNCE_MS : 0
    )
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [completion, cwd])

  useEffect(() => {
    setCompletionIndex(0)
  }, [completion])

  // 把光标前那段触发文本整体换成候选的插入文本（`@src/a.ts ` / `/ask `），只改输入框。
  const selectCompletion = useCallback(
    (item) => {
      if (!item) return
      const element = textareaRef.current
      const current = element?.value ?? inputRef.current ?? ''
      const caret = element?.selectionStart ?? current.length
      const { text: next, caret: nextCaret } = applyCompletion(
        current,
        caret,
        completion?.start ?? caret,
        completionInsertText(item)
      )
      draftsRef.current.set(nodeId, next)
      setInput(next)
      setCompletion(null)
      setCompletionItems([])
      setCompletionIndex(0)
      requestAnimationFrame(() => {
        const node = textareaRef.current
        if (!node) return
        node.setSelectionRange(nextCaret, nextCaret)
        node.focus()
      })
    },
    [completion, inputRef, nodeId]
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

  /**
   * 收下 host 推来的 btw 线程快照（整体替换，`mica/btw/updated`）。
   *
   * 面板关着时回答到达要补一条提示：btw 是后台发生的（可以在主流程运行中提问、
   * 也可以关了面板再回来），没有提示的话用户只会在某次打开面板时才发现答案早就
   * 到了。判定放在这里而不是「有事件就提」，是因为快照在恢复重放时也会来一次，
   * 那时不该再提示——比较的基准是上一份快照里那条 entry 是否还在 running。
   */
  const applyBtwThread = useCallback(
    (thread) => {
      const next = {
        id: typeof thread?.id === 'string' ? thread.id : '',
        entries: Array.isArray(thread?.entries) ? thread.entries : [],
        ...(thread?.context ? { context: thread.context } : {}),
        // 排队那一问只活在这份快照里（不进会话文件），照抄即可。
        ...(thread?.pendingQuestion ? { pendingQuestion: thread.pendingQuestion } : {})
      }
      const previous = next.id ? btwThreadsRef.current[next.id] : null
      if (next.id) btwThreadsRef.current = { ...btwThreadsRef.current, [next.id]: next }
      // 没有 id 的快照（理论上不该出现）不落表：tab 是按 id 组织的。
      if (next.id) setBtwThreads((current) => ({ ...current, [next.id]: next }))
      // 第一条线程到达时自动切过去：打开抽屉还没选过 tab 的场景（第一次提问）
      if (next.id && !btwActiveIdRef.current) {
        btwActiveIdRef.current = next.id
        setBtwActiveId(next.id)
      }
      if (btwOpenRef.current) return
      for (const entry of newlyAnsweredBtwEntries(previous, next)) {
        if (entry.status === 'error') {
          appendNotice(
            `By The Way 失败：${compactLine(entry.error || entry.question, 120)}`,
            'error'
          )
        } else {
          appendNotice(
            `By The Way 已回答：${compactLine(entry.question, 80)}（输入条上打开「By The Way」查看）`,
            'info'
          )
        }
      }
    },
    [appendNotice]
  )

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
          setRetryInfo(null)
          setRunStartedAt((current) => current || timestamp)
          break
        }
        case 'reasoning':
          setPhase('thinking')
          setRetryInfo(null)
          appendPart('reasoning', event.part?.text || '', timestamp)
          break
        case 'text':
          setPhase('streaming')
          setRetryInfo(null)
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
          setRetryInfo(null)
          break
        }
        case 'error':
          finishStream(timestamp)
          appendNotice(event.error?.data?.message || event.error?.name || '运行出错', 'error')
          setPhase('error')
          break
        case 'retrying': {
          // host 内部重试：状态行显示第几次，会话里留一条可复用的提示
          // （command 固定，重试期间反复替换同一行）。
          const retry = {
            attempt: Number(event.attempt) || 0,
            maxAttempts: Number(event.maxAttempts) || 0,
            delayMs: Number(event.delayMs) || 0,
            error: String(event.error || '')
          }
          setRetryInfo(retry)
          setPhase('retrying')
          upsertNotice(retryNoticeText(retry), 'error', '/retry')
          break
        }
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
          setRetryInfo(null)
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
        case 'wait_tasks':
          // Host 快照：整体替换 wait_for 正在等待的条件（阻塞 turn 期间常驻）。
          setWaitTasks(Array.isArray(event.tasks) ? event.tasks : [])
          break
        case 'btw_thread':
          // Host 快照：整体替换 By The Way 线程（跨 turn 常驻，与对话流无关）。
          applyBtwThread(event.thread)
          break
        case 'session_history_replaced': {
          // host 侧替换了持久化历史（编辑重跑、压缩；主进程已重新
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
      setSubagentTasks,
      applyBtwThread,
      upsertNotice
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
      // 别处那一轮结束（或被中止）：只读状态立刻解除，不必再等 3s 复查。
      setRemoteRunning(false)
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
    // 事件流是广播给所有页面的，帧里带的是持有 run 的那个节点的 id：工作区只有一份，
    // 所以「本会话的 run」在所有页面里都是同一个 node id，认领它就是认领本节点。
    const currentRunKey = () => nodeIdRef.current
    const offEvent = window.mica.chat.onEvent(({ id, sequence, event }) => {
      if (id !== currentRunKey()) return
      if (restoringRef.current) pendingEventsRef.current.push({ sequence, event })
      else applyEventRef.current(event)
    })
    const offExit = window.mica.chat.onExit((payload) => {
      if (payload.id !== currentRunKey()) return
      if (restoringRef.current) pendingExitRef.current = payload
      else processExitRef.current(payload)
    })
    const offQueueState = window.mica.chat.onQueueState((payload) => {
      if (payload.id !== currentRunKey()) return
      const items = Array.isArray(payload.queuedItems) ? payload.queuedItems : []
      setQueuedItems(items)
      // 同步消息的排队标记：host 的 after_iteration 排队（mica/queue/queued
      // 扩展通知）也会把对应乐观消息标记为排队，dequeue 后恢复，与本地
      // after_turn 排队展示一致。
      const queuedIds = new Set(items.map((item) => item?.id))
      // 排队 id 列表只保留 host 现在真正持有的条目：消息投递（dequeue）之后
      // 残留的 id 会误判「已有一条排队消息」，把下一次 Enter 挡在本地。
      queuedMessageIdsRef.current = queuedMessageIdsRef.current.filter((queuedId) =>
        queuedIds.has(queuedId)
      )
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
    const offRunStarted = window.mica.chat.onRunStarted((payload) => {
      if (payload.id !== currentRunKey()) return
      // 恢复过程中先丢弃：restore() 自己会按 chat:is-running 的 prompt 补这一行，
      // 而且它要等磁盘历史读完才能确定位置（定时任务每轮文本相同，末尾那条用户行
      // 未必是本轮的）。
      if (restoringRef.current) return
      updateMessages((previous) => appendRunStartedMessage(previous, payload))
    })
    return () => {
      offEvent?.()
      offExit?.()
      offQueueState?.()
      offQueueError?.()
      offRunStarted?.()
    }
  }, [appendNotice, applyEventRef, nodeId, nodeIdRef, processExitRef, updateMessages])

  // 组件卸载（切过的会话超过保留上限、或页签被关掉）时，把最后的渲染结果留给下次进入
  // 这个会话时复用：磁盘历史里没有思考与 TODO，而 host 的事件缓冲本身也有上限。
  useEffect(() => {
    if (!nodeId) return undefined
    return () => {
      writeCachedTranscript(nodeId, messagesRef.current)
    }
  }, [nodeId])

  // 输入框内容变了就写进共享草稿表（本地立刻生效，别的窗口稍后收到广播）。发送、清空、
  // 撤回排队消息这些路径都经由 setInput，所以在这里统一同步，不必逐个调用点去改。
  //
  // 必须在下面那个切换 effect 已经为**本节点**定过稿之后才写：effect 按声明顺序执行，
  // 挂载（或切到新节点）那一帧 input 还是空的/上一个会话的，此时按 nodeId 写下去会把
  // 这个节点已存的草稿抹成空串（第二个窗口一打开就把第一个窗口没发出去的文本清掉）。
  useEffect(() => {
    if (!nodeId || draftReportRef.current.nodeId !== nodeId) return
    const text = input || ''
    const reported = draftReportRef.current
    if (reported.nodeId === nodeId && reported.text === text) return
    draftReportRef.current = { nodeId, text }
    draftsRef.current.set(nodeId, text)
  }, [input, nodeId])

  // 别的窗口改了本会话的草稿：跟它走（单一实例下两边是同一个界面）。自己的回声由 ui-state
  // 的广播入口统一认领（见 applyRemote），不会走到这里。
  //
  // 只订阅**本节点**那一条草稿，而不是整张表：整表每次按键都会换新对象，按表订阅会让同时
  // 挂着的每个 ChatView（最多 5 个）跟着重渲染各自整段消息列表。getSnapshot 返回字符串，
  // 值没变时 React 直接跳过重渲染。
  const remoteDraft = useSyncExternalStore(
    subscribeUiState,
    () => {
      const drafts = uiStateKeys().drafts
      const text = drafts && typeof drafts === 'object' ? drafts[nodeId] : undefined
      return typeof text === 'string' ? text : ''
    },
    () => ''
  )
  useEffect(() => {
    if (!nodeId) return
    if (remoteDraft === (inputRef.current || '')) return
    // 正在翻输入历史时输入框里的内容不是草稿，别覆盖它。
    if (historyCursorRef.current >= 0) return
    draftReportRef.current = { nodeId, text: remoteDraft }
    setInput(remoteDraft)
  }, [nodeId, remoteDraft])

  useEffect(() => {
    if (!nodeId) return undefined
    const previousNodeId = loadedNodeRef.current
    if (previousNodeId && previousNodeId !== nodeId && messagesRef.current.length > 0) {
      // 这一份渲染结果（含只存在于事件流里的思考/工具/TODO）留给下次回到这个会话时用
      writeCachedTranscript(previousNodeId, messagesRef.current)
    }
    if (previousNodeId && previousNodeId !== nodeId) {
      // 旧节点此刻已经隐藏，scrollTop 读出来是 0，只能用滚动时记下的那份
      writeScrollEntry(scrollCache, previousNodeId, scrollStateRef.current)
    }
    const nextInput = switchChatDraft(draftsRef.current, previousNodeId, nodeId, inputRef.current)
    draftReportRef.current = { nodeId, text: nextInput || '' }
    loadedNodeRef.current = nodeId
    const cachedTranscript = readCachedTranscript(nodeId)
    const generation = ++restoreGenerationRef.current
    restoringRef.current = true
    pendingEventsRef.current = []
    pendingExitRef.current = null
    const scrollRestore = resolveScrollRestore(readScrollEntry(scrollCache, nodeId))
    stickToBottomRef.current = scrollRestore.stick
    scrollStateRef.current = { top: scrollRestore.top, stick: scrollRestore.stick }
    pendingScrollRestoreRef.current = scrollRestore.stick
      ? null
      : { nodeId, top: scrollRestore.top }
    setShowJump(!scrollRestore.stick)
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
    // btw 线程属于「这个会话的 host」，切节点必须换一份；半句话的草稿按
    // `节点:线程` 存下来（切走再回来不丢），与主输入框的 drafts 同一套心智。
    // 这里只清表并等 host 推回（恢复走 `chat:btw-threads` 的重放，见下面的 effect）：
    // 立刻按旧节点残留的 id 去猜会打到别的会话的线程上。
    btwThreadsRef.current = {}
    setBtwThreads({})
    btwActiveIdRef.current = ''
    setBtwActiveId('')
    setBtwDraft(btwDraftsRef.current.get(btwDraftKey(nodeId, '')) || '')
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
      // host 的任务快照（后台 shell 任务 / 运行中 subagent）刻意不进事件缓冲，而是随
      // is-running 单独回传：重放前先补上，中途附着上来的窗口才不会漏掉这一轮已经推过
      // 的那次快照（dock 一直空着）。
      const replayEventsOf = (events, pending) => [
        ...(Array.isArray(state?.snapshots) ? state.snapshots : []),
        ...mergeReplayEvents(events, pending)
      ]
      const stateSessionId = state?.sessionId || sessionIdRef.current
      if (state?.running && stateSessionId && hasPersistedTurn(restored, state.prompt)) {
        const latestMeta = await window.mica.chat.meta(stateSessionId).catch(() => null)
        if (generation !== restoreGenerationRef.current || nodeIdRef.current !== nodeId) return
        if (isPersistedRunComplete(latestMeta, state.startedAt)) {
          updateMessages(historyBeforeRunReplay(restored, state.prompt))
          for (const event of replayEventsOf(state.events, pendingEventsRef.current)) {
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
        const replay = replayEventsOf(state.events, pendingEventsRef.current)
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
        for (const event of replayEventsOf(state?.events, pendingEventsRef.current)) {
          applyEventRef.current(event)
        }
        pendingEventsRef.current = []
        await restoreFinalSession(finalSessionId, rows)
        return
      }
      const replayEvents = replayEventsOf(state?.events, pendingEventsRef.current)
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
        // 事件缓冲里只有「整体替换」语义的快照事件时，重放不会与本轮已渲染的内容
        // 冲突，可以直接接在上次留下的 transcript 上——它含磁盘历史没有的思考与
        // TODO，比从 conversationMessages 重建完整。有累积型事件（文本/工具）时
        // 必须从磁盘重建，否则那段内容会被追加第二遍。
        const needsRebuild = replayEvents.some((event) => ACCUMULATING_EVENT_TYPES.has(event?.type))
        const reusable = !needsRebuild && canReuseVisualTranscript(cachedTranscript, restored)
        updateMessages(reusable ? cachedTranscript : trimActiveTurn(restored))
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

  // 同一运行时的另一个页面跑着这个会话时，事件流本来就广播到所有页面，本页照常实时渲染；
  // 只有「另一个进程（终端里的 TUI / mica exec / 另一个运行时实例）持着 turn lease」这一种
  // 情况本页完全没有事件流，只能隔几秒问一次，等它跑完再把会话文件读回来。
  useEffect(() => {
    if (!remoteRunning) return undefined
    const timer = window.setInterval(async () => {
      const state = await window.mica.chat
        .isRunning(nodeIdRef.current, sessionIdRef.current || null)
        .catch(() => null)
      if (!state) return
      if (state.running) return
      if (state.remoteRunning) return
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
    const list = listRef.current
    if (!list) return undefined
    if (stickToBottomRef.current) {
      list.scrollTop = list.scrollHeight
      return undefined
    }
    // 恢复上次的偏移：必须等这一轮历史真的到位，否则会被夹到当时还很矮的内容里
    const pending = pendingScrollRestoreRef.current
    if (!pending || pending.nodeId !== nodeId || !historyLoaded) return undefined
    list.scrollTop = pending.top
    pendingScrollRestoreRef.current = null
    return undefined
  }, [messages, running, historyLoaded, nodeId])

  /**
   * 切走/切回时的滚动位置。
   *
   * 缓存住的实例切走时只是被加上 `hidden`（display:none），而 display:none 会把
   * `scrollTop` 清成 0，再显示回来也不会自己恢复。所以位置得自己记、自己放回去；同时
   * 切走还会让浏览器派发一次 clientHeight 为 0 的滚动事件，onScroll 里已经把它滤掉了。
   */
  useLayoutEffect(() => {
    const list = listRef.current
    const wasVisible = previousVisibleRef.current
    previousVisibleRef.current = visible
    if (!list || visible === wasVisible) return undefined
    if (!visible) {
      writeScrollEntry(scrollCache, nodeId, scrollStateRef.current)
      return undefined
    }
    const restore = resolveScrollRestore(readScrollEntry(scrollCache, nodeId))
    stickToBottomRef.current = restore.stick
    scrollStateRef.current = { top: restore.top, stick: restore.stick }
    // 重新显示时内容已经在 DOM 里（缓存实例不重放历史），直接落位置即可
    pendingScrollRestoreRef.current = null
    list.scrollTop = restore.stick ? list.scrollHeight : restore.top
    setShowJump(!restore.stick)
    return undefined
  }, [visible, nodeId])

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
    const timer = window.setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 40)
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
      // 选择面板与输入框补全不会同时用
      setCompletion(null)
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
        onOpenSettingsRef.current?.()
        if (isCurrentNode()) appendCommandResult(parsed.raw, '已打开 Mica 配置')
        return
      }

      if (parsed.name === 'rename') {
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
        const result = await window.mica.chat.renameSession(targetSessionId, parsed.args)
        if (!isCurrentNode()) return
        if (!result?.ok) {
          appendCommandResult(parsed.raw, '重命名失败', result?.error || '', { variant: 'error' })
          return
        }
        appendCommandResult(parsed.raw, `会话已重命名为 ${result.title}`)
        onSessionRenamedRef.current?.()
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
            // 与交互式 /compact 同源：只替换工具结果与媒体，消息条数不变。
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
                    ...(Number(result.mediaItemsReplaced) > 0
                      ? [`- Media items replaced: ${Number(result.mediaItemsReplaced)}`]
                      : []),
                    ...(Number(result.toolArgumentsTrimmed) > 0
                      ? [`- Tool arguments trimmed: ${Number(result.toolArgumentsTrimmed)}`]
                      : []),
                    ...(Number(result.reasoningItemsDropped) > 0
                      ? [`- Stale reasoning items dropped: ${Number(result.reasoningItemsDropped)}`]
                      : []),
                    Number(result.afterCount) === Number(result.beforeCount)
                      ? `- Messages: ${Number(result.beforeCount) || 0} (unchanged)`
                      : `- Messages: ${Number(result.beforeCount) || 0} → ${Number(result.afterCount) || 0}`
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
              ? '\n提示：工具结果、图片与工具参数都已清理过，剩下的主要是对话文本与轮次，本地压缩无法缩减；如需摘要压缩请使用「模型压缩」。'
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
      onOpenSettingsRef,
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
        appendNotice('该会话正在另一个进程里运行（终端或另一个运行时），请等待完成后再发送', 'warn')
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
      // 中止打到持有这个 run 的节点上：附着在别的页签的 run 时是本节点不能直接停的，
      // 但用户看到的就是同一轮，允许他在这里停。
      .abort(runKey)
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
  }, [nodeId, nodeIdRef, runKey, stopping])

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
        variant: overrides.variant || null,
        role: overrides.role || null
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
  // remoteRunning（尤其是附着在别的窗口那一轮上）时不能排队：单槽队列属于那个 run 的
  // 所有者，这里只能看。输入框不再提示「可排队」，避免点下去只换来一条警告。
  const queueReady = running && !remoteRunning && input.trim().length > 0
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

  // 恢复滚动位置（切回会话、历史到位后补位）不走 onScroll，这里按消息条数补量一次，
  // 免得「上一个对话」停在不该灰的时候。
  useEffect(() => {
    if (!showJump) return
    const list = listRef.current
    if (!list) return
    const canPrev = hasPreviousConversation(list)
    if (canPrev === canPrevConversationRef.current) return
    canPrevConversationRef.current = canPrev
    setCanPrevConversation(canPrev)
  }, [transcriptMessages.length, showJump, nodeId])

  const recallQueued = useCallback(
    async (requestedId) => {
      if (!nodeId || recallingQueueRef.current) return
      const item = requestedId
        ? queuedDisplayItems.find((candidate) => candidate.id === requestedId)
        : queuedDisplayItems[queuedDisplayItems.length - 1]
      if (!item) return
      const targetNodeId = nodeId
      recallingQueueRef.current = item.id
      setRecallingQueueId(item.id)
      const restoreDraft = (text) => {
        const recalledText = String(text || '')
        if (!recalledText) return
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
      }
      try {
        // 先冻结这条排队消息，再把它撤回输入框：host 的 after_iteration 注入
        // 就在迭代边界上，不冻结的话用户点开「重新编辑」的同一瞬间文本可能已经
        // 发给模型了——这正是「编辑到一半被发出去」。hold 与 recall 都走 host 的
        // stdin，顺序有保证，所以冻结一定先于撤回生效。
        await window.mica.chat.holdQueued(runKey, item.id).catch(() => null)
        const result = await window.mica.chat.recallQueued(runKey, item.id)
        if (nodeIdRef.current !== targetNodeId) return
        const queuedItems = Array.isArray(result?.queuedItems) ? result.queuedItems : []
        const outcome = resolveQueueRecall({
          id: item.id,
          pending: item.pending === true,
          ok: Boolean(result?.ok),
          queuedItems: Array.isArray(result?.queuedItems) ? result.queuedItems : null,
          runActive: !finishedRef.current
        })
        // 撤回没成功（消息已经在跑）时必须解冻，否则它会在队列里一直等着。
        if (outcome !== 'restore') {
          await window.mica.chat.holdQueued(runKey, item.id, false).catch(() => null)
        }
        queuedMessageIdsRef.current = queuedMessageIdsRef.current.filter((id) => id !== item.id)
        if (outcome === 'keep') {
          setQueuedItems(queuedItems)
          appendNotice(result?.error || '排队消息撤回失败', 'error')
          return
        }
        setQueuedItems(
          outcome === 'restore'
            ? queuedItems.filter((candidate) => candidate.id !== item.id)
            : queuedItems
        )
        if (outcome === 'sent') {
          // 这条消息已经开始发送了：行留在对话里，只是不再排队，不能停在一个
          // 既排着队、又撤不回来的状态。
          updateMessages((previous) =>
            previous.map((message) =>
              message.id === item.id ? { ...message, queued: false } : message
            )
          )
          appendNotice(result?.error || '该消息已开始发送，无法撤回', 'warn')
          return
        }
        updateMessages((previous) => previous.filter((message) => message.id !== item.id))
        restoreDraft(result?.text || item.text)
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
    [appendNotice, nodeId, nodeIdRef, queuedDisplayItems, runKey, updateMessages]
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
  // 点开详情时按 id 取当下的那条消息：工具还在跑的时候，输出是流式长出来的。
  const activityDetailMessage = activityDetailId
    ? messages.find((message) => message.id === activityDetailId) || null
    : null
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
  // 状态文本与阶段计时都按换算后的 displayPhase（理由见 statusLinePhase）：工具结果回来后
  // 它是 waiting_model 而不是 calling_tool，计时也从那一刻重新起算。
  const displayPhase = statusLinePhase(phase, runningToolNames)
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

  // 阶段起点：displayPhase 每次变化都重新计时，同一阶段内连续累计。
  useEffect(() => {
    if (displayPhase === 'idle' || !running) return undefined
    phaseStartedAtRef.current = Date.now()
    return undefined
  }, [displayPhase, running])

  // 阶段耗时交给 PhaseElapsedLabel 自己计时：它每 250ms 变一次，留在 ChatView 里
  // 会让整个会话面板每秒多出 4 次全树重渲染。
  const phaseElapsedStartedAt = running
    ? displayPhase === 'working'
      ? activeToolStartedAt
      : phaseStartedAtRef.current
    : 0
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
  // 选中对话里的文字时浮出「引用 / 复制」条；选区清空、滚动或点到别处就收起
  useEffect(() => {
    let timer = null
    const update = () => {
      const selection = readTranscriptSelection()
      if (!selection) {
        setSelectionBar(null)
        return
      }
      const range = window.getSelection?.()?.getRangeAt?.(0)
      const rect = range?.getBoundingClientRect?.()
      if (!rect || (!rect.width && !rect.height)) {
        setSelectionBar(null)
        return
      }
      setSelectionCopied(false)
      setSelectionBar({ ...selection, x: rect.left + rect.width / 2, y: rect.top })
    }
    const scheduleUpdate = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(update, 60)
    }
    const hide = (event) => {
      if (event?.target?.closest?.('.chat-selection-bar')) return
      setSelectionBar(null)
    }
    document.addEventListener('selectionchange', scheduleUpdate)
    document.addEventListener('pointerdown', hide, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      if (timer) window.clearTimeout(timer)
      document.removeEventListener('selectionchange', scheduleUpdate)
      document.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [])
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
      .commit({ commitId, cwd, sessionId: nodeIdRef.current })
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
      if (action === 'share') {
        const sessionId = sessionIdRef.current
        if (!sessionId) {
          appendNotice('发送第一条消息后才能分享会话', 'error')
          return
        }
        onShareSessionRef.current?.(sessionId)
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
    [
      appendNotice,
      onResumeSessionRef,
      onSessionRenamedRef,
      onShareSessionRef,
      runSlashCommand,
      startCommitTask
    ]
  )

  const focusComposerFromShell = useCallback((event) => {
    if (event.button != null && event.button !== 0) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (
      target.closest(
        'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="listbox"], [role="option"], .chat-command-palette, .chat-popover, [data-no-chat-focus]'
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
      textareaRef.current?.focus({ preventScroll: true })
      return
    }

    const pointer = shellPointerRef.current
    shellPointerRef.current = null
    if (pointer?.inTranscript) {
      requestAnimationFrame(() => {
        const selection = window.getSelection?.()
        if (pointer.moved || (selection && !selection.isCollapsed)) return
        textareaRef.current?.focus({ preventScroll: true })
      })
      return
    }

    const selection = window.getSelection?.()
    if (selection && !selection.isCollapsed) return
    textareaRef.current?.focus({ preventScroll: true })
  }, [])

  const trackShellPointerMove = useCallback((event) => {
    const pointer = shellPointerRef.current
    if (!pointer) return
    if (Math.abs(event.clientX - pointer.x) > 3 || Math.abs(event.clientY - pointer.y) > 3) {
      pointer.moved = true
    }
  }, [])

  // 这条对话的定时循环：按 nodeId 认领（草稿会话还没有 sessionId，而循环在草稿上也能启动，
  // 启动即触发第一轮、那一轮才创建会话）。
  const activeLoop = useMemo(() => loopForNode(loops, nodeId), [loops, nodeId])
  // 定时任务的两个状态：这一轮正在跑（徽标与侧栏都显示「运行中」），或在等下一次触发。
  const loopRunning = Boolean(activeLoop) && running
  // 挂着定时任务时输入框整体走提示色（与 CLI 的 loop prompt 同款），一眼看出这条会话在
  // 按间隔自动发送；颜色只跟「有没有循环」有关，不随倒计时每秒变化。
  const loopTone = activeLoop ? 'chat-composer-loop' : ''
  // By The Way（btw）：入口在输入条动作区，线程状态是 host 的快照投影。
  // 有会话才有 host、才有「主流程记录」可作背景（草稿会话还没有 sessionId）。
  const hasSession = Boolean(node?.sessionId || sessionIdRef.current)
  // 任一 tab 在回答都算「在跑」：入口按钮的呼吸态说的是「这个抽屉里有活」，不是某个 tab。
  const btwTabList = Object.values(btwThreads).filter((item) => item?.id)
  const btwRunning = btwTabList.some((item) =>
    (item.entries || []).some((entry) => entry.status === 'running')
  )
  // 抽屉宽度是界面状态（所有窗口一致、重启还在）；拖动期间只改 DOM，松手才写回。
  const [btwWidth, setBtwWidth] = useSharedState('btwWidth', null)
  // 切到别的对话时收起定时任务与 btw 面板：两者描述的都是上一个会话。
  useEffect(() => {
    setSettingsSection(null)
    setBtwOpen(false)
  }, [nodeId])

  // 输入框行首标记（与 CLI 的 prompt 同款）：非默认角色时在标记前显示角色名。
  // 内容与 tooltip 在「可点 / 只读」两种形态之间共用，只有外层元素不同——分享范围里
  // 角色是分享者的会话配置（服务端也锁着），所以只留展示、不给切换入口。
  const promptMarkText = `当前角色：${activeRole}${
    activeLoop ? ` · 定时任务：每 ${formatLoopInterval(activeLoop.intervalMs)}` : ''
  }`
  const promptMarkContent = (
    <>
      {activeRole !== 'default' && <span className="chat-prompt-role">{activeRole}</span>}
      <span className="chat-prompt-caret" aria-hidden="true">
        {queueReady ? '↳' : activeLoop ? '⏰' : '›'}
      </span>
    </>
  )

  const statusLine = (
    <div className="chat-status-line">
      <div className="chat-status-primary">
        {running ? (
          <>
            <IconLoader2 size={11} className="animate-spin" />
            {retryInfo ? (
              <span className="chat-status-retry">{retryStatusLabel(retryInfo)}</span>
            ) : (
              <span>{statusLabel(displayPhase, runningToolNames)}</span>
            )}
            <PhaseElapsedLabel startedAt={phaseElapsedStartedAt} />
            {activeStreamTokenEstimate > 0 && (
              <span className="chat-status-token-delta">↓{activeStreamTokenEstimate} tokens</span>
            )}
          </>
        ) : remoteRunning ? (
          <>
            <IconLoader2 size={11} className="animate-spin" />
            <span>正在另一个进程里运行</span>
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
              data-popover-trigger="picker"
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
              data-popover-trigger="picker"
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
        {running && <RunElapsedLabel runStartedAt={runStartedAt} />}
      </div>
    </div>
  )

  // 打开文件 / 预览图片的回调要跨渲染保持同一引用：Markdown 的 memo 与它内部的
  // components useMemo 都按引用比较，换新会每次都让 react-markdown 重新解析整篇
  // markdown（运行中 ChatView 每 250ms 重渲染一次）。
  const transcriptOpenFile = useCallback(
    (path, position) => onOpenFileRef.current?.(resolveChatPath(path, cwdRef.current), position),
    []
  )
  // 工具详情里的「在编辑器中打开」：内容在内存里，不需要按 cwd 解析路径。
  const openToolDocument = useCallback((document) => onOpenDocumentRef.current?.(document), [])
  // 必须稳定：内联箭头每次渲染都换新引用，会让 MessageRow 的 memo 全部失效。
  const handleCommandAction = useCallback((item) => {
    if (item.action !== 'terminal') return
    void copyText(item.command)
    onOpenTerminalRef.current?.()
  }, [])
  // 聊天文本、notice、回合日志里的路径统一走这里：cwd 只在 ChatView 里解析一次
  // （cwdRef 是 ref，所以这个对象可以稳定），子组件（PathToken）只负责决定
  // 「单击 / ⌘ 单击 / 图片」分别触发哪个动作。
  // 必须 useMemo：context 值每次渲染都换新会强制所有 PathToken 重渲染，把
  // Markdown / TurnLogItem 的 memo 一起废掉。
  const pathActions = useMemo(
    () => ({
      resolvePath: (raw) => resolveChatPath(raw, cwdRef.current),
      openFile: transcriptOpenFile,
      preview: (path, text) =>
        setImagePreview({
          source: resolveChatPath(path, cwdRef.current),
          alt: String(path).split(/[\\/]/).filter(Boolean).pop() || text || '图片'
        }),
      reveal: (path) => revealPathInFinder(resolveChatPath(path, cwdRef.current))
    }),
    [revealPathInFinder, transcriptOpenFile]
  )
  // btw 的回答同样过 Markdown（代码块、路径可点）：由 ChatView 传下去，面板自己不去
  // import ChatView（那会形成循环依赖），引用保持稳定以免废掉 Markdown 的 memo。
  const renderBtwAnswer = useCallback(
    (text) => <Markdown text={text || ''} onOpenFile={transcriptOpenFile} />,
    [transcriptOpenFile]
  )
  // btw 的问题按对话区「你说的话」渲染（同一个 MessageText：图片引用降级成链接、路径
  // 可点）——抽屉里原样显示 `[Image](~/.mica/images/x.png)` 会和主对话分叉。
  const renderBtwQuestion = useCallback((text) => <MessageText text={text || ''} />, [])

  // 悬浮 tip 的两个按钮：在相邻的两轮对话（用户消息）之间跳转，下方没有对话时回落到最新消息。
  const jumpConversation = useCallback((direction) => {
    const list = listRef.current
    if (!list) return
    const target = conversationNavTarget(conversationTops(list), list.scrollTop, direction)
    if (target.kind === 'none') return
    if (target.kind === 'bottom') {
      stickToBottomRef.current = true
      setShowJump(false)
      scrollStateRef.current = { top: list.scrollHeight, stick: true }
      list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
      return
    }
    // 回头看旧消息时不能再贴着底部，否则流式回答一到就把视野拽回末尾
    stickToBottomRef.current = false
    scrollStateRef.current = { top: target.top, stick: false }
    list.scrollTo({ top: target.top, behavior: 'smooth' })
  }, [])

  return (
    <ChatPathContext.Provider value={pathActions}>
      <div
        // 抽屉打开时让自己让出右侧那一条（内边距会把对话区与输入条一起收窄），
        // 所以它是「并排」而不是「盖住」——主流程照常看得见、发得出。
        className={`chat-view no-drag ${visible ? 'flex' : 'hidden'} ${btwOpen ? 'chat-btw-open' : ''}`}
        // 宽度是共享界面状态（拖动后写回，所有窗口一致）。变量挂在根上，抽屉与它让出的
        // 右侧内边距读的是同一个值——两边不会对不上。
        style={
          btwOpen && btwWidth
            ? {
                // 拖过的宽度也要被视口夹住：把窗口拖窄后不能让它盖住整块对话区
                '--chat-btw-width': `${Math.min(
                  Math.max(btwWidth, 240),
                  Math.round((typeof window === 'undefined' ? 1200 : window.innerWidth) * 0.85)
                )}px`
              }
            : undefined
        }
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
            // 隐藏时浏览器会把 scrollTop 清成 0 并派发一次滚动事件（clientHeight 也是 0），
            // 那不是用户滚的，别拿它覆盖记下来的位置。
            if (element.clientHeight === 0) return
            stickToBottomRef.current = atBottom
            scrollStateRef.current = { top: element.scrollTop, stick: atBottom }
            setShowJump(!atBottom)
            // 同一个值再设一次会让这个巨型组件重渲染一轮（React 的 bailout 之前要先渲染），
            // 所以先比对上一次的结果再决定要不要落到 state。
            const canPrev = atBottom ? false : hasPreviousConversation(element)
            if (canPrev !== canPrevConversationRef.current) {
              canPrevConversationRef.current = canPrev
              setCanPrevConversation(canPrev)
            }
          }}
        >
          <div ref={transcriptRef} className="chat-transcript">
            {!historyLoaded && <div className="chat-loading">正在加载会话…</div>}
            {showEmpty && <WelcomeHint cwd={cwd} />}
            {transcriptMessages.map((message) => {
              return (
                <MessageRow
                  key={message.id}
                  message={message}
                  onOpenFile={transcriptOpenFile}
                  onCommandAction={handleCommandAction}
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
                  onQuote={quoteMessage}
                />
              )
            })}
            <TurnLogDock
              messages={visibleTurnLogMessages}
              now={Date.now()}
              onOpenActivity={openActivityDetail}
            />
          </div>
        </div>

        <ChatFind
          open={findOpen}
          focusSignal={findFocusSignal}
          targetRef={transcriptRef}
          onClose={closeFind}
        />

        <div ref={composerDockRef} className="chat-composer-dock">
          {showJump && (
            <div className="chat-jump">
              <button
                type="button"
                onClick={() => jumpConversation('previous')}
                disabled={!canPrevConversation}
                title="跳到上一轮对话"
                aria-label="上一个对话"
              >
                <IconArrowUp size={13} /> 上一个对话
              </button>
              <button
                type="button"
                onClick={() => jumpConversation('next')}
                title="跳到下一轮对话，已经在最后一轮时回到最新消息"
                aria-label="下一个对话"
              >
                <IconArrowDown size={13} /> 下一个对话
              </button>
            </div>
          )}
          {picker && (
            <SelectPalette
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
              onClose={closePicker}
            />
          )}
          {completion && !picker && (
            <ComposerCompletionPalette
              title={completion.kind === 'skill' ? '选择 skill / MCP' : '引用文件'}
              options={completionItems}
              activeIndex={Math.min(completionIndex, Math.max(0, completionItems.length - 1))}
              onActiveIndex={setCompletionIndex}
              onSelect={selectCompletion}
              emptyText={completionEmptyText(completion.kind, completionLoading, completionFailed)}
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
          <WaitTasksDock
            tasks={waitTasks}
            now={taskNow}
            onOpen={(task) => openTaskDetail('wait', task)}
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
          <ComposerQuoteStrip text={input} onRemove={removeQuoteFromComposer} />
          {settingsSection && (
            <SessionSettingsDialog
              nodeId={nodeId}
              sessionId={sessionIdRef.current}
              cwd={cwd}
              running={running || remoteRunning}
              section={settingsSection}
              loopProps={{
                loop: activeLoop,
                running: loopRunning,
                draft: input,
                onStart: handleLoopStart,
                onSetInterval: (intervalMs) =>
                  activeLoop && window.mica.loops.setInterval(nodeId, intervalMs).catch(() => {}),
                onSetTask: (task) =>
                  activeLoop && window.mica.loops.setTask(nodeId, task).catch(() => {}),
                onPause: () => window.mica.loops.setStatus(nodeId, 'paused').catch(() => {}),
                onResume: () => window.mica.loops.setStatus(nodeId, 'active').catch(() => {}),
                onFireNow: () => window.mica.loops.fireNow(nodeId).catch(() => {}),
                onStop: () => window.mica.loops.stop(nodeId).catch(() => {})
              }}
              onClose={() => setSettingsSection(null)}
            />
          )}
          <div
            className={`chat-composer ${running ? 'chat-composer-running' : ''} ${queueReady ? 'chat-composer-queue' : ''} ${loopTone}`}
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
            {/* 边框右上角只留一条标签：定时循环徽标优先（它描述的是常驻状态，与 CLI 一致），
                排队提示只在没有循环时出现。 */}
            {activeLoop ? (
              <LoopBadge loop={activeLoop} running={loopRunning} />
            ) : queueReady ? (
              <span className="chat-composer-frame-label">
                Enter/Tab 在下一个工具调用迭代后发送
              </span>
            ) : null}
            <button
              type="button"
              className={`chat-prompt-mark ${activeLoop ? 'is-loop' : ''}`}
              title={`${promptMarkText}（点击切换）`}
              aria-label="切换角色"
              data-popover-trigger="picker"
              onClick={() => openPicker('role')}
            >
              {promptMarkContent}
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
                running ? '消息会在下一个工具调用迭代后发送' : 'Type something and press Enter...'
              }
              textareaRef={textareaRef}
              onChange={(nextValue) => {
                draftsRef.current.set(nodeId, nextValue)
                historyCursorRef.current = -1
                setInput(nextValue)
              }}
              onPaste={(event) => {
                // 图片转 `[Image](路径)`，文件（文件夹 / Excel…）转成它的绝对路径
                void pasteIntoComposer(event, {
                  insertText: insertComposerText,
                  notify: appendNotice
                })
              }}
              onKeyDown={(event) => {
                // 补全打开时优先吃掉方向键/Enter/Tab/Esc，避免直接发送或移动光标
                if (completion && completionItems.length > 0) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setCompletionIndex((value) => (value + 1) % completionItems.length)
                    return
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setCompletionIndex(
                      (value) => (value - 1 + completionItems.length) % completionItems.length
                    )
                    return
                  }
                  if (
                    (event.key === 'Enter' || event.key === 'Tab') &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault()
                    selectCompletion(
                      completionItems[Math.min(completionIndex, completionItems.length - 1)]
                    )
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setCompletion(null)
                    return
                  }
                }
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
                  // 与 CLI 的 TerminalInput 同一条规则：输入框为空时 shift + ← 才是
                  // 「撤回排队消息」，非空时留给 textarea 自己扩展选区。
                  input.length === 0 &&
                  queuedDisplayItems.length > 0 &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  void recallQueued()
                  return
                }
                // 输入历史只由 Alt+↑/↓ 触发；单独的 ↑/↓ 交给 textarea 自己移动光标
                // （多行输入里逐行上下移动，不做「到首/末行就翻历史」的隐式切换）。
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
                if (event.key === 'Tab' && !event.nativeEvent.isComposing) {
                  const tabAction = resolveComposerTabAction({
                    shiftKey: event.shiftKey,
                    queueReady
                  })
                  if (tabAction === 'queue') {
                    event.preventDefault()
                    send(null, { queueMode: 'after_iteration' })
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
                  // 忙时排队只有一种时机：after_iteration（在下一个工具调用迭代
                  // 边界注入当前 turn）。与 Tab/Shift+Tab 排队同一条路径，不再等
                  // 整个 turn 结束才作为下一条消息发出。
                  send(null, running ? { queueMode: 'after_iteration' } : undefined)
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
              {/* 超长输入才显示字数。空 span 也会占一个 gap，留着会把上传按钮和时钟拉开
                  两倍的行距（动作区靠 gap 排布，没有 margin 可以抵消）。 */}
              {input.length > 4000 && <span>{input.length.toLocaleString()}</span>}
              {/* By The Way（CLI 的 /btw）：主流程运行中也照常可点——它正是为
                  「顺手问一句、不影响当前任务」而存在的。没有会话时没有 host，
                  也就没有主流程记录可当背景，所以那时禁用。 */}
              <button
                type="button"
                className={`chat-composer-btw ${btwRunning ? 'is-active' : ''}`}
                title={
                  !hasSession
                    ? 'By The Way 需要先有一条会话'
                    : remoteRunning
                      ? '该会话正在另一个进程里运行'
                      : btwRunning
                        ? 'By The Way：正在回答…（点击查看）'
                        : 'By The Way：不打扰主流程地问一句（回答不进入本会话上下文）'
                }
                aria-label="By The Way"
                // 抽屉不是浮层：没有「点外面就关」需要它自己认领这次点击，所以不带
                // data-popover-trigger，改用 aria-expanded 描述它控制着一个可展开区域。
                aria-expanded={btwOpen}
                disabled={!hasSession || remoteRunning}
                onClick={() => setBtwOpen((open) => !open)}
              >
                {btwRunning ? (
                  <IconLoader2 size={13} className="animate-spin" />
                ) : (
                  <IconMessageChatbot size={13} />
                )}
              </button>
              {/* 电脑上用 Enter 发送，发送/排队按钮只在移动端保留（触屏没有回车键）。
                  「停止生成」与运行态无关，两端都要有。 */}
              {running ? (
                <>
                  {isMobile && queueReady && (
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
              ) : isMobile && input.trim() ? (
                <button
                  type="button"
                  title={remoteRunning ? '该会话正在另一个进程里运行' : '发送'}
                  aria-label="发送"
                  disabled={!input.trim() || remoteRunning}
                  onClick={send}
                >
                  <IconSend size={13} />
                </button>
              ) : null}
              {/* 会话设置固定排在动作区最右：它是常驻入口，不该跟着运行态（停止/发送）
                  在两端浮动。 */}
              <button
                type="button"
                className={`chat-composer-capabilities${settingsSection ? ' is-active' : ''}`}
                title="会话设置：能力、自动压缩、定时任务（只影响当前会话）"
                aria-label="会话设置"
                aria-haspopup="dialog"
                aria-expanded={Boolean(settingsSection)}
                onClick={() => setSettingsSection((current) => (current ? null : 'capabilities'))}
              >
                <IconAdjustments size={13} />
              </button>
            </div>
          </div>
          {imagePreview && (
            <ImagePreviewModal
              source={imagePreview.source}
              alt={imagePreview.alt}
              onClose={() => setImagePreview(null)}
              onReveal={pathActions.reveal}
              onOpenFile={(path) => pathActions.openFile(path, {})}
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
            runKey={runKey}
            task={taskDetail.task}
            onClose={closeTaskDetail}
            onStop={stopSubagent}
          />
        )}
        {taskDetail?.kind === 'background' && (
          <BackgroundTaskModal
            runKey={runKey}
            task={taskDetail.task}
            onClose={closeTaskDetail}
            onKill={killBackgroundTask}
          />
        )}
        {taskDetail?.kind === 'wait' && (
          <WaitTaskModal
            // 等待记录每秒重推一次：能查到就用最新的那份，查不到（刚结束/被回收）
            // 就用点开时的快照，弹窗不会突然空白。
            task={waitTasks.find((item) => item.id === taskDetail.task.id) || taskDetail.task}
            now={taskNow}
            onClose={closeTaskDetail}
          />
        )}
        {activityDetailMessage?.kind === 'tool' && (
          <ToolDetailDialog
            tool={activityDetailMessage.tool}
            onOpenInEditor={openToolDocument}
            onClose={() => setActivityDetailId(null)}
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
        {selectionBar && (
          <ChatSelectionBar
            bar={selectionBar}
            copied={selectionCopied}
            onQuote={() => {
              quoteMessage(selectionBar)
              window.getSelection?.()?.removeAllRanges?.()
              setSelectionBar(null)
            }}
            onCopy={() => {
              navigator.clipboard?.writeText?.(selectionBar.text)?.then?.(
                () => setSelectionCopied(true),
                () => undefined
              )
            }}
          />
        )}
        {/* By The Way 的抽屉：挂在 `.chat-view` 直属子节点上（不是输入条里），这样它
            能占满对话区的高度，而不是像浮层那样被输入条那一条盒子限住。 */}
        {btwOpen && (
          <BtwDrawer
            thread={btwThread}
            tabs={btwTabList}
            width={btwWidth}
            onResizeWidth={setBtwWidth}
            draft={btwDraft}
            sending={btwSending}
            compacting={btwCompacting}
            onDraftChange={changeBtwDraft}
            onAsk={askBtw}
            onStop={stopBtw}
            onRecall={recallBtw}
            onNewThread={addBtwThread}
            onSelectThread={selectBtwThread}
            onCloseThread={closeBtwThread}
            onCompact={compactBtw}
            // 把 btw 的这段字引用进主输入框（署名「By The Way」：它不在主对话历史里，
            // 标成「模型」会让人以为是从对话里引的）。发不发由用户决定。
            onQuoteToMain={(text) => quoteMessage({ role: 'assistant', text, label: 'By The Way' })}
            renderAnswer={renderBtwAnswer}
            renderQuestion={renderBtwQuestion}
            onPreviewImage={pathActions.preview}
            onOpenDocument={openToolDocument}
            onNotice={appendNotice}
            onClose={() => setBtwOpen(false)}
          />
        )}
      </div>
    </ChatPathContext.Provider>
  )
}
