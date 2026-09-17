// 上下文占用弹窗（SessionDetailModal / ChatView 的 Context 弹窗）共用的展示逻辑。
// 数据来自 host 的 `stats:session-detail`：`context` 是按类别聚合的估算，
// `messages` 是逐条投影（含 kind/chars/tokens/parts）。这里只做纯展示换算。

export const CONTEXT_KIND_META = {
  user: {
    label: '用户消息',
    badge: 'bg-info/15 text-info-soft',
    bar: 'bg-info'
  },
  assistant: {
    label: '助手回复',
    badge: 'bg-panel-hi text-fg-strong',
    bar: 'bg-fg-dim'
  },
  reasoning: {
    label: '思考（reasoning）',
    badge: 'bg-purple/15 text-purple',
    bar: 'bg-purple'
  },
  tool_call: {
    label: '工具调用参数',
    badge: 'bg-warn/15 text-warn',
    bar: 'bg-warn'
  },
  tool_result: {
    label: '工具结果',
    badge: 'bg-success/15 text-success-soft',
    bar: 'bg-success'
  },
  other: {
    label: '其它',
    badge: 'bg-panel-hi text-fg-muted',
    bar: 'bg-fg-ghost'
  }
}

// 界面上固定按这个顺序分组，避免类别顺序随体积跳动、每次打开都要重新找。
export const CONTEXT_KIND_ORDER = [
  'user',
  'assistant',
  'reasoning',
  'tool_call',
  'tool_result',
  'other'
]

// 真实请求 input 与消息体估算的差额：system prompt、工具 schema、非持久化项等。
export const OVERHEAD_META = {
  label: '系统提示词 / 工具 schema / 未持久化项',
  badge: 'bg-panel-hi text-fg-muted',
  bar: 'bg-fg-ghost'
}

export function kindMeta(kind) {
  return CONTEXT_KIND_META[kind] || CONTEXT_KIND_META.other
}

export function formatTokens(value) {
  const n = Number(value) || 0
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

export function sharePct(tokens, total) {
  const sum = Number(total) || 0
  if (sum <= 0) return 0
  return Math.min(100, Math.round(((Number(tokens) || 0) / sum) * 1000) / 10)
}

/** 占比文字：极小但非零的值不显示成 0%，否则看起来像没占。 */
export function formatShare(tokens, total) {
  if (!(Number(tokens) > 0) || !(Number(total) > 0)) return '0%'
  const pct = sharePct(tokens, total)
  return pct === 0 ? '<0.1%' : `${pct}%`
}

/**
 * 堆叠条的分段：先按固定顺序放持久化消息的类别，最后是「不可见」的 overhead。
 * 段落按 chars 计算时会失真，所以这里统一用 host 给的 tokens。
 */
export function contextBarSegments(context) {
  if (!context) return []
  const categories = Array.isArray(context.categories) ? context.categories : []
  const byKind = new Map(categories.map((row) => [row.kind, row]))
  const segments = []
  for (const kind of CONTEXT_KIND_ORDER) {
    const row = byKind.get(kind)
    if (!row || !row.tokens) continue
    const meta = kindMeta(kind)
    segments.push({ key: kind, label: meta.label, tokens: row.tokens, bar: meta.bar })
  }
  if (context.overheadTokens > 0) {
    segments.push({
      key: 'overhead',
      label: OVERHEAD_META.label,
      tokens: context.overheadTokens,
      bar: OVERHEAD_META.bar
    })
  }
  return segments
}

/** 用真实 input（有则用）作为总量，让占比与状态栏的 ctx 百分比同源。 */
export function contextTotalTokens(context) {
  if (!context) return 0
  if (context.lastInputTokens > 0) return context.lastInputTokens
  return Number(context.messageTokens) || 0
}

export function filterContextItems(items, kind) {
  const list = Array.isArray(items) ? items : []
  if (!kind || kind === 'all') return list
  return list.filter((item) => item.kind === kind)
}

/** `size` 用于「谁占了上下文」，`order` 用于顺着对话看。 */
export function sortContextItems(items, mode = 'size') {
  const list = [...(Array.isArray(items) ? items : [])]
  if (mode === 'order') return list
  return list.sort((a, b) => b.tokens - a.tokens || a.index - b.index)
}

/** 给每条消息编上稳定序号（排序后仍能指回原始位置）。 */
export function indexContextItems(items) {
  return (Array.isArray(items) ? items : []).map((item, index) => ({ ...item, index }))
}

/** 单行摘要：折叠空白后截断，用来在列表里直接认出这条是什么。 */
export function contentPreview(text, max = 60) {
  if (!text) return ''
  const line = String(text).replace(/\s+/g, ' ').trim()
  if (!line) return ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/**
 * 每行的主标题。行首徽章已经写明类别，所以标题给最能认出内容的东西：
 * 工具名 > 正文摘要 > 类别兜底。
 */
export function contextItemTitle(item) {
  if (!item) return '—'
  if (item.name) return item.name
  const preview = contentPreview(item.content)
  if (preview) return preview
  return kindMeta(item.kind).label
}

/** 每行的副标题：标记 + 调用 id，工具调用额外带上参数摘要。 */
export function contextItemSubtitle(item) {
  if (!item) return ''
  const bits = []
  if (item.kind === 'tool_call' && item.content) bits.push(contentPreview(item.content, 48))
  if (item.cleared) bits.push('已清理为占位符')
  if (item.imageCount > 0) bits.push(`含 ${item.imageCount} 张图片（未计入估算）`)
  else if (item.hasImage) bits.push('含图片')
  if (item.encryptedChars > 0) bits.push('含加密推理链')
  if (item.truncated && item.kind !== 'tool_call') bits.push('正文已截断')
  if (item.toolCallId) bits.push(item.toolCallId.slice(0, 16))
  return bits.join(' · ')
}
