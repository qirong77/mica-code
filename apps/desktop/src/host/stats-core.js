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

function isImageBlock(block) {
  if (!block || typeof block !== 'object') return false
  return block.type === 'image_url' || block.type === 'input_image' || block.type === 'image'
}

function hasImageBlock(content) {
  return Array.isArray(content) && content.some(isImageBlock)
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
    if (isImageBlock(block)) continue
    total += charLength(block)
  }
  return total
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
    out.hasImage = hasImageBlock(raw.content)
    out.imageCount = Array.isArray(raw.content) ? raw.content.filter(isImageBlock).length : 0
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
    const output =
      typeof raw.output === 'string'
        ? raw.output
        : charLength(raw.output)
          ? JSON.stringify(raw.output)
          : ''
    out.cleared = output.startsWith(CLEARED_TOOL_RESULT)
    if (output) {
      out.content = truncate(output, DETAIL_TOOL_LIMIT)
      out.truncated = output.length > DETAIL_TOOL_LIMIT
    }
    parts[CONTEXT_KINDS.toolResult] = output.length
    out.chars = output.length
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
    out.cleared = typeof content === 'string' && content.startsWith(CLEARED_TOOL_RESULT)
    const full = projectContent(content, Number.MAX_SAFE_INTEGER)
    if (full) out.content = truncate(full, DETAIL_TOOL_LIMIT)
    out.truncated = full.length > DETAIL_TOOL_LIMIT
    parts[CONTEXT_KINDS.toolResult] = charLength(content)
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
    out.hasImage = hasImageBlock(raw.content)
    out.imageCount = Array.isArray(raw.content) ? raw.content.filter(isImageBlock).length : 0
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
 * system prompt、工具 schema、非持久化的 provider 项（加密推理链），以及已被
 * compact 清掉的内容都在这里面，所以只作为参考值并需在界面上说明。
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
  return {
    items: items.length,
    messageChars,
    messageTokens,
    categories: list.sort((a, b) => b.tokens - a.tokens),
    clearedResults,
    images: items.filter((item) => item.hasImage).length,
    lastInputTokens,
    overheadTokens: lastInputTokens > messageTokens ? lastInputTokens - messageTokens : 0,
    contextWindowSize: Number(options.contextWindowSize) || null
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

export function normalizeUsageEvent(usage, fallbackTime, fallbackModel) {
  const inputTokens = tokenNumber(usage.inputTokens)
  const outputTokens = tokenNumber(usage.outputTokens)
  const cachedInputTokens = Math.min(inputTokens, tokenNumber(usage.cachedInputTokens))
  const occurredAtMs = validTime(usage.occurredAt)
  return {
    usageId:
      typeof usage.usageId === 'string' && usage.usageId.trim() ? usage.usageId.trim() : null,
    // Old fork snapshots contain byte-for-byte copies. Keep only a digest, never raw usage.
    legacyFingerprint: usage.usageId
      ? null
      : createHash('sha256').update(JSON.stringify(usage)).digest('hex'),
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
 * A fork carries its source usage history. New records have stable IDs, so assign each event to
 * the oldest surviving session and count it once. Legacy records deliberately remain untouched:
 * without an ID, identical token values are not sufficient proof that two requests are the same.
 */
export function dedupeStatsSessions(sessions) {
  const ordered = sessions
    .slice()
    .sort((a, b) => a.createdAtMs - b.createdAtMs || String(a.id).localeCompare(String(b.id)))
  const seen = new Set()
  const deduped = ordered.map((session) => {
    const usageEvents = session.usageEvents.filter((usage) => {
      const identity = usage.usageId || `legacy:${usage.legacyFingerprint}`
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
    return summarizeEvents(session, usageEvents)
  })
  return deduped.sort((a, b) => a.createdAtMs - b.createdAtMs)
}
