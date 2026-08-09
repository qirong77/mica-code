import { createHash } from 'node:crypto'

// 详情弹窗的投影上限：避免把超大消息（图片 base64、超长工具输出）整包传给渲染进程。
export const DETAIL_CONTENT_LIMIT = 2000
export const DETAIL_TOOL_LIMIT = 1000

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

export function projectMessages(messages) {
  return messages.map((message) => {
    const out = { role: message.role }
    if (message.role === 'user' || message.role === 'assistant') {
      const content = projectContent(message.content, DETAIL_CONTENT_LIMIT)
      if (content) out.content = content
      if (Array.isArray(message.tool_calls)) {
        out.toolCalls = message.tool_calls.map((tc) => ({
          id: tc.id || null,
          name: tc.function?.name || tc.name || null,
          arguments:
            typeof tc.function?.arguments === 'string'
              ? tc.function.arguments.slice(0, DETAIL_TOOL_LIMIT)
              : tc.arguments || null
        }))
      }
    } else if (message.role === 'tool') {
      out.toolCallId = message.tool_call_id || null
      const content = projectContent(message.content, DETAIL_TOOL_LIMIT)
      if (content) out.content = content
    }
    return out
  })
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
