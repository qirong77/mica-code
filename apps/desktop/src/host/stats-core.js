import { createHash } from 'node:crypto'

// 详情弹窗的投影上限：避免把超大消息（图片 base64、超长工具输出）整包传给渲染进程。
export const DETAIL_CONTENT_LIMIT = 2000
export const DETAIL_TOOL_LIMIT = 1000

/**
 * 上下文占用的类别。同一份 provider 历史可能是两种形态：
 * - Chat Completions：`{ role, content, tool_calls }` / `{ role: 'tool', tool_call_id }`
 * - Responses：扁平的 `{ type: 'message' | 'function_call' | 'function_call_output' | 'reasoning' }`
 * 弹窗按下面的类别聚合，具体形态在投影时归一。
 */
export const CONTEXT_KINDS = {
  user: 'user',
  assistant: 'assistant',
  reasoning: 'reasoning',
  toolCall: 'tool_call',
  toolResult: 'tool_result',
  envelope: 'envelope',
  other: 'other'
}

/** 与 CLI 的 `estimateTokens`（packages/mica-context）同口径，弹窗数字才能和 ctx 显示对上。 */
export function estimateTokens(chars) {
  return Math.ceil((Number(chars) || 0) / 4)
}

/** 工具结果被 compact 清理后留下的占位符（packages/mica-context 的 TOOL_RESULT_PLACEHOLDER）。 */
const CLEARED_TOOL_RESULT = '[Old tool result content cleared during compact]'

function charLength(value) {
  if (value == null) return 0
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

/** 把消息 content（string 或 blocks 数组）投影为纯文本，图片/特殊块用占位符。 */
export function projectContent(content, limit) {
  if (typeof content === 'string') {
    return content.length > limit ? `${content.slice(0, limit)}…` : content
  }
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'image_url' || block.type === 'input_image' || block.type === 'image')
      parts.push('[image]')
    else if (block.type === 'tool_use' || block.type === 'function_call') parts.push('[tool_call]')
    else if (block.type === 'tool_result' || block.type === 'function_call_output')
      parts.push('[tool_result]')
    else if (block.type === 'thinking' || block.type === 'reasoning') parts.push('[thinking]')
    else if (typeof block.text === 'string' && block.text) parts.push(block.text)
  }
  const joined = parts.join('\n')
  return joined.length > limit ? `${joined.slice(0, limit)}…` : joined
}

const IMAGE_BLOCK_TYPES = new Set(['image_url', 'input_image', 'image'])
// 媒体块（图片 + 文档/文件）的内联 payload 与 vision token 无关，一律不计字符。
const MEDIA_BLOCK_TYPES = new Set([...IMAGE_BLOCK_TYPES, 'document', 'input_file'])

function isImageBlock(block) {
  if (!block || typeof block !== 'object') return false
  return IMAGE_BLOCK_TYPES.has(block.type)
}

function isMediaBlock(block) {
  if (!block || typeof block !== 'object') return false
  return MEDIA_BLOCK_TYPES.has(block.type)
}

/**
 * 媒体块可以出现在三处：消息 `content`、工具结果的 `output`（Responses 的多模态
 * 工具结果就是 `[{type:'input_text'},{type:'input_image'}]`）、以及 Chat Completions
 * 的 `role: 'tool'` content。只认第一处会把内联截图整段 base64 算成正文——
 * 实测一条 `read_image` 结果就能估成 28 万 token（真实请求才 5.8 万）。
 */
function countMedia(value) {
  if (!Array.isArray(value)) return { images: 0, others: 0 }
  let images = 0
  let others = 0
  for (const block of value) {
    if (isImageBlock(block)) images++
    else if (isMediaBlock(block)) others++
  }
  return { images, others }
}

/**
 * 参与 token 估算的字符数。图片块按 0 计：base64 长度与 vision token 无关，
 * 直接算会把一条贴图消息估成几十万 token（实测一条内联截图 = 267k），
 * 图片只单独计数并在界面上标注。
 */
function contentChars(content) {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (isMediaBlock(block)) continue
    total += charLength(block)
  }
  return total
}

/**
 * 线上体积（近似）：provider 收到的其实是整条消息的 JSON，`role`/`type`/`call_id`/`name`
 * 这些结构字段同样占 input。只数正文会让「持久化消息体」明显小于真实上下文，多出来的
 * 差额会全部落进 system prompt / 工具 schema 的残差里（实测一个 1436 条消息的会话
 * 被多算了 34k tokens，界面显示成「未持久化项占 74%」）。这里按整条消息的 JSON 计，
 * 图片块仍只留占位标记，base64 不计。
 */
function wireChars(message) {
  try {
    return JSON.stringify(wireView(message))?.length ?? 0
  } catch {
    return 0
  }
}

function wireView(value, depth = 0) {
  if (depth > 8) return '[deep]'
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.map((item) => wireView(item, depth + 1))
  if (isMediaBlock(value)) return { type: value.type, media: `[${value.type}]` }
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = wireView(item, depth + 1)
  return out
}

/** 预览文本：媒体 payload 只留占位标记，base64 绝不进渲染进程。 */
function previewValue(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(wireView(value)) ?? ''
  } catch {
    return ''
  }
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * 把一条 provider 消息归一为：类别 + 是否带图 + 各类别的字符数（`parts`）。
 * `chars`/`tokens` 按**原始**消息算（不受渲染层截断影响），且等于各分支
 * `parts` 之和，所以逐条明细与分类汇总永远是同一口径。
 */
function describeMessage(message) {
  const out = describeMessageBody(message)
  // 结构字段（消息信封）单列一类，不混进正文——混进正文后它会在线性差额里
  // 伪装成 system prompt / 工具 schema。
  const envelope = Math.max(0, wireChars(message) - out.chars)
  if (envelope > 0) {
    out.parts[CONTEXT_KINDS.envelope] = envelope
    out.chars += envelope
    out.tokens = estimateTokens(out.chars)
  }
  return out
}

function describeMessageBody(message) {
  const raw = message && typeof message === 'object' ? message : {}
  const parts = {}
  const out = {
    kind: CONTEXT_KINDS.other,
    role: raw.role || null,
    name: null,
    toolCallId: null,
    chars: 0,
    tokens: 0,
    parts,
    hasImage: false,
    imageCount: 0,
    mediaCount: 0,
    cleared: false,
    truncated: false,
    content: null,
    toolCalls: null
  }

  const role = raw.role
  const type = raw.type

  // Responses 的 message item 只带文本；Chat Completions 的无 type assistant 可能同时
  // 带 tool_calls，留给下面的 assistant 分支处理。
  if (type === 'message' || (!type && role === 'user')) {
    out.kind = role === 'user' ? CONTEXT_KINDS.user : CONTEXT_KINDS.assistant
    out.role = role === 'user' ? 'user' : 'assistant'
    const full = projectContent(raw.content, Number.MAX_SAFE_INTEGER)
    if (full) out.content = truncate(full, DETAIL_CONTENT_LIMIT)
    out.truncated = full.length > DETAIL_CONTENT_LIMIT
    const media = countMedia(raw.content)
    out.hasImage = media.images > 0
    out.imageCount = media.images
    out.mediaCount = media.others
    parts[out.kind] = contentChars(raw.content)
    out.chars = parts[out.kind]
    out.tokens = estimateTokens(out.chars)
    return out
  }

  if (type === 'function_call') {
    out.kind = CONTEXT_KINDS.toolCall
    out.role = 'assistant'
    out.name = raw.name || null
    out.toolCallId = raw.call_id || null
    const args =
      typeof raw.arguments === 'string'
        ? raw.arguments
        : charLength(raw.arguments)
          ? JSON.stringify(raw.arguments)
          : ''
    if (args) {
      out.content = truncate(args, DETAIL_TOOL_LIMIT)
      out.truncated = args.length > DETAIL_TOOL_LIMIT
    }
    parts[CONTEXT_KINDS.toolCall] = args.length
    out.chars = args.length
    out.tokens = estimateTokens(out.chars)
    return out
  }

  if (type === 'function_call_output') {
    out.kind = CONTEXT_KINDS.toolResult
    out.role = 'tool'
    out.toolCallId = raw.call_id || null
    const full = projectContent(raw.output, Number.MAX_SAFE_INTEGER) || previewValue(raw.output)
    out.cleared = full.startsWith(CLEARED_TOOL_RESULT)
    if (full) {
      out.content = truncate(full, DETAIL_TOOL_LIMIT)
      out.truncated = full.length > DETAIL_TOOL_LIMIT
    }
    const media = countMedia(raw.output)
    out.hasImage = media.images > 0
    out.imageCount = media.images
    out.mediaCount = media.others
    parts[CONTEXT_KINDS.toolResult] = contentChars(raw.output)
    out.chars = parts[CONTEXT_KINDS.toolResult]
    out.tokens = estimateTokens(out.chars)
    return out
  }

  if (type === 'reasoning') {
    out.kind = CONTEXT_KINDS.reasoning
    out.role = 'assistant'
    const summary = Array.isArray(raw.summary)
      ? raw.summary
          .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('\n')
      : typeof raw.summary === 'string'
        ? raw.summary
        : ''
    const body = projectContent(raw.content, DETAIL_CONTENT_LIMIT)
    const text = [summary, body].filter(Boolean).join('\n')
    if (text) {
      out.content = truncate(text, DETAIL_CONTENT_LIMIT)
      out.truncated = text.length > DETAIL_CONTENT_LIMIT
    }
    // encrypted_content 是 provider 回传的加密推理链：内容不可读，但确实占 input。
    out.encryptedChars =
      typeof raw.encrypted_content === 'string' ? raw.encrypted_content.length : 0
    parts[CONTEXT_KINDS.reasoning] = summary.length + charLength(raw.content) + out.encryptedChars
    out.chars = parts[CONTEXT_KINDS.reasoning]
    out.tokens = estimateTokens(out.chars)
    return out
  }

  if (role === 'tool') {
    out.kind = CONTEXT_KINDS.toolResult
    out.toolCallId = raw.tool_call_id || null
    const content = raw.content
    const full = projectContent(content, Number.MAX_SAFE_INTEGER) || previewValue(content)
    out.cleared = full.startsWith(CLEARED_TOOL_RESULT)
    if (full) out.content = truncate(full, DETAIL_TOOL_LIMIT)
    out.truncated = full.length > DETAIL_TOOL_LIMIT
    const media = countMedia(content)
    out.hasImage = media.images > 0
    out.imageCount = media.images
    out.mediaCount = media.others
    parts[CONTEXT_KINDS.toolResult] = contentChars(content)
    out.chars = parts[CONTEXT_KINDS.toolResult]
    out.tokens = estimateTokens(out.chars)
    if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0)
      out.toolCalls = projectToolCalls(raw.tool_calls)
    return out
  }

  // Chat Completions 的 assistant 可以同时带文本与工具调用：分别计入各自类别。
  if (role === 'assistant') {
    out.kind = CONTEXT_KINDS.assistant
    const full = projectContent(raw.content, Number.MAX_SAFE_INTEGER)
    if (full) out.content = truncate(full, DETAIL_CONTENT_LIMIT)
    out.truncated = full.length > DETAIL_CONTENT_LIMIT
    const media = countMedia(raw.content)
    out.hasImage = media.images > 0
    out.imageCount = media.images
    out.mediaCount = media.others
    parts[CONTEXT_KINDS.assistant] = contentChars(raw.content)
    if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
      const calls = projectToolCalls(raw.tool_calls)
      out.toolCalls = calls
      parts[CONTEXT_KINDS.toolCall] = calls.reduce(
        (sum, call) => sum + charLength(call.arguments),
        0
      )
    }
    out.chars = Object.values(parts).reduce((sum, size) => sum + size, 0)
    out.tokens = estimateTokens(out.chars)
    return out
  }

  parts[CONTEXT_KINDS.other] = charLength(raw)
  out.chars = parts[CONTEXT_KINDS.other]
  out.tokens = estimateTokens(out.chars)
  return out
}

function projectToolCalls(toolCalls) {
  return toolCalls.map((tc) => ({
    id: tc.id || null,
    name: tc.function?.name || tc.name || null,
    arguments:
      typeof tc.function?.arguments === 'string'
        ? tc.function.arguments.slice(0, DETAIL_TOOL_LIMIT)
        : tc.arguments || null
  }))
}

export function projectMessages(messages) {
  return messages.map((message) => describeMessage(message))
}

/**
 * 上下文占用分解：按类别汇总各消息贡献的字符数（同一口径 chars/4 估 token）。
 * `overheadTokens` 是「最近一次真实请求的 input」与「持久化消息体估算」的差额——
 * system prompt、工具 schema、非持久化的 provider 项（加密推理链）都在这里面。
 *
 * 快照在最近一次请求之后被 compact/裁剪过时，那次请求的 input 描述的是另一份
 * 上下文：调用方要用 `resolveStaleRequestInput` 把它放进 `staleInput`、并把
 * `lastInputTokens` 留空，否则「已被清掉的历史」会被算成差额，界面上显示成
 * 「系统提示词 / 工具 schema 占了大部分上下文」。
 */
export function summarizeContext(messages, options = {}) {
  const items = projectMessages(messages)
  const categories = new Map()
  let messageChars = 0
  let clearedResults = 0
  for (const item of items) {
    messageChars += item.chars
    if (item.cleared) clearedResults++
    for (const [kind, size] of Object.entries(item.parts)) {
      if (!size) continue
      const row = categories.get(kind) || { kind, count: 0, chars: 0, tokens: 0 }
      row.count++
      row.chars += size
      categories.set(kind, row)
    }
  }
  const list = [...categories.values()].map((row) => ({
    ...row,
    tokens: estimateTokens(row.chars)
  }))
  const messageTokens = list.reduce((sum, row) => sum + row.tokens, 0)
  const lastInputTokens = Number(options.lastInputTokens) || 0
  const staleInput = normalizeStaleInput(options.staleInput)
  const fixedOverheadTokens = Number(options.fixedOverheadTokens) || 0
  return {
    items: items.length,
    messageChars,
    messageTokens,
    categories: list.sort((a, b) => b.tokens - a.tokens),
    clearedResults,
    images: items.filter((item) => item.hasImage).length,
    lastInputTokens,
    staleInput,
    // 本会话出现过的最小请求 input：固定开销（system prompt + 工具 schema）的上界。
    // 差额超过它就不可能全是固定开销，界面据此改用「其它差额」的说法。
    fixedOverheadTokens,
    overheadTokens: lastInputTokens > messageTokens ? lastInputTokens - messageTokens : 0,
    contextWindowSize: Number(options.contextWindowSize) || null
  }
}

/**
 * 最近一次请求的 input 还能代表当前快照吗？不能则返回作废原因：
 * - `compacted`：快照在那次请求之后被 compact 改写过（`displayUsage.compactedAt` 更晚）；
 * - `truncated`：那次请求看到的消息比快照现在多（prune / rewind 裁掉了轮次）。
 *
 * 两种情况里 `lastUsage.inputTokens` 描述的都是**另一份**上下文：拿它当分母/被减数会把
 * 「已经被清理掉的内容」显示成「系统提示词 / 工具 schema」（实测有会话因此显示成 74%）。
 * 时间戳缺失时宁可当作已作废，也不要拿压缩前的 input 冒充当前占用。
 */
export function resolveStaleRequestInput({ lastUsage, displayUsage, messageCount } = {}) {
  const inputTokens = Number(lastUsage?.inputTokens) || 0
  if (inputTokens <= 0) return null
  const compactedAtMs = Date.parse(displayUsage?.compactedAt)
  const usedAtMs = Date.parse(lastUsage?.occurredAt)
  if (Number.isFinite(compactedAtMs) && (!Number.isFinite(usedAtMs) || compactedAtMs > usedAtMs)) {
    return {
      inputTokens,
      reason: 'compacted',
      compactedAt: displayUsage.compactedAt,
      compactedTokens: Number(displayUsage.totalTokens) || 0
    }
  }
  const recordedMessages = Number(lastUsage?.messageCount)
  const currentMessages = Number(messageCount)
  if (
    Number.isFinite(recordedMessages) &&
    Number.isFinite(currentMessages) &&
    recordedMessages > currentMessages
  ) {
    return { inputTokens, reason: 'truncated', recordedMessages, currentMessages }
  }
  return null
}

function normalizeStaleInput(value) {
  if (!value || typeof value !== 'object') return null
  const inputTokens = Number(value.inputTokens) || 0
  if (inputTokens <= 0) return null
  return {
    inputTokens,
    reason: value.reason === 'compacted' || value.reason === 'truncated' ? value.reason : 'unknown',
    compactedAt:
      typeof value.compactedAt === 'string' && value.compactedAt ? value.compactedAt : null,
    compactedTokens: Number(value.compactedTokens) || 0,
    recordedMessages: Number(value.recordedMessages) || 0,
    currentMessages: Number(value.currentMessages) || 0
  }
}

export function projectUsage(usage) {
  return {
    usageId: usage.usageId || null,
    occurredAt: usage.occurredAt || null,
    turnId: usage.turnId ?? null,
    requestIndex: usage.requestIndex ?? null,
    model: usage.model || null,
    provider: usage.provider || null,
    inputTokens: usage.inputTokens || 0,
    cachedInputTokens: usage.cachedInputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    totalTokens: usage.totalTokens || 0,
    paidTokenRate: typeof usage.paidTokenRate === 'number' ? usage.paidTokenRate : null
  }
}

export function projectSubagentRecords(records) {
  return records.map((record) => ({
    taskId: record.taskId || null,
    parentTaskId: record.parentTaskId || null,
    initiatedByCallId: record.initiatedByCallId || null,
    subagentType: record.subagentType || null,
    description: record.description || null,
    status: record.status || null,
    model: record.model || null,
    effort: record.effort || null,
    startedAt: record.startedAt || null,
    finishedAt: record.finishedAt || null,
    requests: (Array.isArray(record.requests) ? record.requests : []).map(projectUsage),
    summary: record.summary || null
  }))
}

function tokenNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function validTime(value) {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

/**
 * 一条用量记录的跨会话身份。原始持久化记录与由它投影出的事件必须算出同一个值，
 * 会话列表和会话详情才能对「这条请求属于哪个会话」给出一致的答案。
 *
 * 没有 `usageId` 的老记录（该字段出现之前写入）退回整条记录的内容摘要：老的 fork
 * 快照是逐字节复制的，摘要相同是唯一能识别出这种副本的线索。
 */
export function usageIdentity(usage) {
  const usageId = typeof usage?.usageId === 'string' ? usage.usageId.trim() : ''
  if (usageId) return `id:${usageId}`
  return `content:${createHash('sha256').update(JSON.stringify(usage)).digest('hex')}`
}

/**
 * 该会话在去重后真正拥有的用量事件身份集合；会话不在去重结果里（老格式文件）时返回
 * null，调用方应保持原样。详情视图必须与列表共用同一个集合：fork 复制过来的记录归属
 * 来源会话，详情也不能把它们算成自己的。
 */
export function ownedUsageIdentities(sessions, sessionId) {
  const session = sessions.find((entry) => entry.id === sessionId)
  if (!session) return null
  return new Set(session.usageEvents.map((event) => event.identity))
}

/** 按 {@link ownedUsageIdentities} 过滤一份原始用量记录；identities 为 null 时原样返回。 */
export function filterOwnedUsage(usageHistory, identities) {
  if (!identities) return usageHistory
  const records = Array.isArray(usageHistory) ? usageHistory : []
  return records.filter((usage) => identities.has(usageIdentity(usage)))
}

/**
 * 详情视图里的 subagent 记录：只保留本会话拥有的请求，并按保留后的请求重算 summary
 * （与 mica-agent 的 `summarizeUsageHistory` 同口径）——不重算的话，老 fork 文件会在
 * 界面上显示成「0 req · 140 tokens」。identities 为 null 时原样返回。
 */
export function filterOwnedSubagentRecords(records, identities) {
  if (!identities) return records
  return records.map((record) => {
    const requests = filterOwnedUsage(record?.requests, identities)
    return { ...record, requests, summary: summarizeUsageRecords(requests) }
  })
}

export function summarizeUsageRecords(records) {
  const summary = {
    records: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0
  }
  for (const usage of Array.isArray(records) ? records : []) {
    summary.records++
    summary.inputTokens += tokenNumber(usage?.inputTokens)
    summary.outputTokens += tokenNumber(usage?.outputTokens)
    summary.cachedInputTokens += tokenNumber(usage?.cachedInputTokens)
    summary.totalTokens += tokenNumber(usage?.totalTokens)
  }
  return summary
}

export function normalizeUsageEvent(usage, fallbackTime, fallbackModel) {
  const inputTokens = tokenNumber(usage.inputTokens)
  const outputTokens = tokenNumber(usage.outputTokens)
  const cachedInputTokens = Math.min(inputTokens, tokenNumber(usage.cachedInputTokens))
  const occurredAtMs = validTime(usage.occurredAt)
  return {
    usageId:
      typeof usage.usageId === 'string' && usage.usageId.trim() ? usage.usageId.trim() : null,
    identity: usageIdentity(usage),
    occurredAtMs: occurredAtMs ?? fallbackTime,
    dateAccuracy: occurredAtMs == null ? 'session-created' : 'exact',
    model: usage.model || fallbackModel || 'Unknown',
    turnId: Number.isInteger(usage.turnId) ? usage.turnId : null,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: inputTokens - cachedInputTokens,
    outputTokens,
    // Derive this value so the four displayed categories always reconcile.
    totalTokens: inputTokens + outputTokens
  }
}

function summarizeEvents(session, usageEvents) {
  const modelMap = new Map()
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let uncachedInputTokens = 0
  let totalTokens = 0

  for (const usage of usageEvents) {
    const row = modelMap.get(usage.model) || {
      model: usage.model,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      totalTokens: 0
    }
    row.requests++
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cachedInputTokens',
      'uncachedInputTokens',
      'totalTokens'
    ]) {
      row[key] += usage[key]
    }
    modelMap.set(usage.model, row)
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    cachedInputTokens += usage.cachedInputTokens
    uncachedInputTokens += usage.uncachedInputTokens
    totalTokens += usage.totalTokens
  }

  const modelUsage = [...modelMap.values()].sort(
    (a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests
  )
  return {
    ...session,
    model: modelUsage[0]?.model || session.model,
    requests: usageEvents.length,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    totalTokens,
    modelUsage,
    usageEvents,
    legacyUsageRecords: usageEvents.filter((usage) => usage.dateAccuracy !== 'exact').length
  }
}

export function parseStatsSession(raw) {
  const createdAtMs = validTime(raw.createdAt)
  const updatedAtMs = validTime(raw.updatedAt)
  if (createdAtMs == null || updatedAtMs == null || createdAtMs <= 0) return null

  const snap = raw.snapshot || {}
  const messages = Array.isArray(snap.messages) ? snap.messages : []
  const usageHistory = Array.isArray(snap.usageHistory)
    ? snap.usageHistory.filter((usage) => usage && typeof usage === 'object')
    : []
  const subagentRecords = Array.isArray(snap.subagentUsageHistory)
    ? snap.subagentUsageHistory.filter((record) => record && typeof record === 'object')
    : []
  const session = {
    id: raw.id || null,
    title: raw.title || null,
    cwd: raw.cwd || null,
    createdAtMs,
    updatedAtMs,
    turnState: raw.turnState || 'completed',
    model: snap.model || null,
    providerId: snap.providerId || null,
    turns: messages.filter((message) => message?.role === 'assistant').length,
    durationMs: Math.max(0, updatedAtMs - createdAtMs)
  }
  const mainEvents = usageHistory.map((usage) =>
    normalizeUsageEvent(usage, createdAtMs, snap.model)
  )
  // Subagent requests are persisted per task under snapshot.subagentUsageHistory;
  // flatten them into the same usage-event stream, tagged with task lineage so
  // the UI can filter or group by subagent later.
  const subagentEvents = []
  for (const record of subagentRecords) {
    const recordModel = record.model || snap.model
    // Subagent requests rarely carry occurredAt on legacy records; the task's
    // startedAt is closer to the true request time than the session createdAt.
    const recordStartMs = validTime(record.startedAt) ?? createdAtMs
    const requests = Array.isArray(record.requests)
      ? record.requests.filter((usage) => usage && typeof usage === 'object')
      : []
    for (const usage of requests) {
      subagentEvents.push({
        ...normalizeUsageEvent(usage, recordStartMs, recordModel),
        isSubagent: true,
        subagentTaskId: record.taskId || null,
        subagentParentTaskId: record.parentTaskId || null,
        subagentType: record.subagentType || null,
        subagentStatus: record.status || null,
        subagentDescription:
          typeof record.description === 'string' && record.description.trim()
            ? record.description.trim()
            : null,
        initiatedByCallId: record.initiatedByCallId || null
      })
    }
  }
  const usageEvents = [...mainEvents, ...subagentEvents]
  const summary = summarizeEvents(session, usageEvents)
  return { ...summary, subagentTasks: subagentRecords.length }
}

/**
 * A fork used to carry its source's usage history verbatim. Records have stable IDs, so assign
 * each event to the oldest surviving session and count it once; records without an ID fall back
 * to a digest of their own content — the only trace a legacy fork copy leaves, and it also
 * merges two genuinely identical records (repeating the same short prompt looks exactly like a
 * copy and nothing in the file can tell them apart).
 *
 * New sessions no longer inherit usage (see forkSessionSnapshot / AgentRuntime.getForkSnapshot),
 * so this only repairs files written before that change. Attribution still follows the oldest
 * surviving session, which is what keeps the totals from dropping when the source is deleted.
 */
export function dedupeStatsSessions(sessions) {
  const ordered = sessions
    .slice()
    .sort((a, b) => a.createdAtMs - b.createdAtMs || String(a.id).localeCompare(String(b.id)))
  const seen = new Set()
  const deduped = ordered.map((session) => {
    const usageEvents = session.usageEvents.filter((usage) => {
      if (seen.has(usage.identity)) return false
      seen.add(usage.identity)
      return true
    })
    return summarizeEvents(session, usageEvents)
  })
  return deduped.sort((a, b) => a.createdAtMs - b.createdAtMs)
}
