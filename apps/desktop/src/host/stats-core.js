import { createHash } from 'node:crypto'
import { localDayKey } from '@packages/mica-web-shared/stats-day.js'
import { MAIN_USAGE_SOURCE, usageSourceOf } from '@packages/mica-web-shared/usage-source.js'

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
    // 原样保留 `origin`（delegation / plugin / helper）：详情弹窗靠它加 `initiatedByCallId`
    // 走 `usageSourceOf`，和统计总表同一个口径。
    origin: typeof record.origin === 'string' ? record.origin : null,
    pluginId: record.pluginId || null,
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
 * 按「本会话真正拥有的用量事件身份」过滤一份原始记录；identities 为 null 时原样返回。
 *
 * 身份集合来自扫描器的归属判定（fork 复制过来的记录归来源会话），详情视图与列表因此
 * 共用同一个口径。
 */
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

/**
 * 一条用量事件归哪一类来源（主对话 / 委派 / 插件 / 内核后台），见
 * `mica-web-shared/usage-source` 的判定。事件只要能进同一套聚合，就必须先带上它。
 */
function withSource(event, source, extra = {}) {
  return { ...event, source, ...extra }
}

/**
 * 把一个会话文件解析成「元信息 + 用量事件」。事件仍带完整字段（子代理/插件来源、请求
 * 时间、身份），调用方决定怎么聚合：扫描器按本地日压缩，详情视图按原始记录展示。
 *
 * 结构不完整的文件返回 null（没有可用的创建/更新时间）。
 */
export function parseSessionEvents(raw) {
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
    ...(typeof raw.parentSessionId === 'string' && raw.parentSessionId.trim()
      ? { parentSessionId: raw.parentSessionId.trim() }
      : {}),
    createdAtMs,
    updatedAtMs,
    turnState: raw.turnState || 'completed',
    model: snap.model || null,
    providerId: snap.providerId || null,
    turns: messages.filter((message) => message?.role === 'assistant').length,
    durationMs: Math.max(0, updatedAtMs - createdAtMs)
  }
  const mainEvents = usageHistory.map((usage) =>
    withSource(normalizeUsageEvent(usage, createdAtMs, snap.model), MAIN_USAGE_SOURCE)
  )
  // Subagent requests are persisted per task under snapshot.subagentUsageHistory;
  // flatten them into the same usage-event stream, tagged with task lineage and
  // the source they belong to (delegation / plugin / built-in helper).
  //
  // 同一份数组里还躺着插件自己的模型请求（`origin: 'plugin'`，例如自动起标题、写
  // commit message）与插件注册的子代理类型（memory-curator 整理、旁问线程）：它们
  // 同样是本会话的开销，但发起者不同，统计页要按来源分开呈现。
  const subagentEvents = []
  for (const record of subagentRecords) {
    const recordModel = record.model || snap.model
    // Subagent requests rarely carry occurredAt on legacy records; the task's
    // startedAt is closer to the true request time than the session createdAt.
    const recordStartMs = validTime(record.startedAt) ?? createdAtMs
    const source = usageSourceOf(record)
    const requests = Array.isArray(record.requests)
      ? record.requests.filter((usage) => usage && typeof usage === 'object')
      : []
    for (const usage of requests) {
      subagentEvents.push(
        withSource(normalizeUsageEvent(usage, recordStartMs, recordModel), source, {
          taskId: record.taskId || null,
          purpose:
            typeof record.description === 'string' && record.description.trim()
              ? record.description.trim()
              : null
        })
      )
    }
  }
  const usageEvents = [...mainEvents, ...subagentEvents]
  return {
    session,
    events: usageEvents,
    identities: usageEvents.map((usage) => usage.identity)
  }
}

const TOKEN_KEYS = [
  'inputTokens',
  'cachedInputTokens',
  'uncachedInputTokens',
  'outputTokens',
  'totalTokens'
]

function emptyTokenTotals() {
  return {
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  }
}

function addTokens(row, usage) {
  row.requests += 1
  for (const key of TOKEN_KEYS) row[key] += usage[key]
}

function dayRow(day) {
  return {
    day,
    at: 0,
    ...emptyTokenTotals(),
    turns: new Set(),
    legacy: 0,
    models: new Map(),
    sources: new Map()
  }
}

/**
 * 把用量事件聚合成「本地日」行。统计页的所有范围都是整天边界（今天 / 近 N 天 / 单日 /
 * 全部），日粒度足够表达，所以逐条事件没有传出去的必要。
 *
 * 每个维度行保留自己的 requests 与 token，renderer 只做加法就能得到任一范围的结果：
 * 模型占比、来源占比（主对话 / 委派 / 插件 / 内核后台）、每日柱状图都从这几层聚出来。
 */
export function summarizeStatsDays(usageEvents) {
  const days = new Map()
  for (const usage of usageEvents) {
    const day = localDayKey(usage.occurredAtMs)
    let row = days.get(day)
    if (!row) {
      row = dayRow(day)
      days.set(day, row)
    }
    if (usage.occurredAtMs > row.at) row.at = usage.occurredAtMs
    addTokens(row, usage)
    if (Number.isInteger(usage.turnId)) row.turns.add(usage.turnId)
    if (usage.dateAccuracy !== 'exact') row.legacy += 1

    let model = row.models.get(usage.model)
    if (!model) {
      model = { model: usage.model, ...emptyTokenTotals() }
      row.models.set(usage.model, model)
    }
    addTokens(model, usage)

    const source = usage.source || MAIN_USAGE_SOURCE
    const sourceKey = `${source.kind}:${source.id}`
    let sourceRow = row.sources.get(sourceKey)
    if (!sourceRow) {
      sourceRow = {
        kind: source.kind,
        id: source.id,
        tasks: new Set(),
        purposes: new Set(),
        ...emptyTokenTotals()
      }
      row.sources.set(sourceKey, sourceRow)
    }
    if (usage.taskId) sourceRow.tasks.add(usage.taskId)
    if (usage.purpose) sourceRow.purposes.add(usage.purpose)
    addTokens(sourceRow, usage)
  }

  return [...days.values()]
    .map((row) => ({
      ...row,
      turns: row.turns.size,
      models: [...row.models.values()],
      sources: [...row.sources.values()].map((source) => ({
        ...source,
        tasks: [...source.tasks],
        purposes: [...source.purposes]
      }))
    }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
}

/**
 * 统计页拿到的会话行：元信息 + 任取范围的加法底座（日行） + 全量合计。
 *
 * 顶层合计让「全部」范围不必再滚动求和；其它范围由 renderer 按日行相加（见 StatsView
 * 的 scopeSession）。逐条用量事件不离开 host —— 上千个会话是几十 MB。
 */
export function summarizeStatsSession(session, usageEvents) {
  const days = summarizeStatsDays(usageEvents)
  const totals = emptyTokenTotals()
  let legacyUsageRecords = 0
  for (const day of days) {
    totals.requests += day.requests
    for (const key of TOKEN_KEYS) totals[key] += day[key]
    legacyUsageRecords += day.legacy
  }
  return { ...session, ...totals, legacyUsageRecords, days }
}

/**
 * 统计投影的压缩形态：会话行 + 该会话文件里的用量事件身份。
 *
 * `identities` 有两个用途，都不能省：扫描器靠它把老 fork 文件复制来的记录判给源会话，
 * 会话详情靠它判断某条原始记录归谁。
 */
export function compressSessionStats(raw) {
  const parsed = parseSessionEvents(raw)
  if (!parsed) return null
  return {
    session: summarizeStatsSession(parsed.session, parsed.events),
    identities: parsed.identities
  }
}

/** 无会话用量的伪会话标题：它出现在项目卡片里，不能再假装成一条对话。 */
export const LEDGER_SESSION_TITLE = '一次性命令'

/**
 * 把「无会话请求账本」聚成会话形状的行，一个工作目录一行。
 *
 * `mica commit` 这类一次性命令没有会话可写，用量只能记进账本（见 mica-web-shared 的
 * usage-ledger）。统计页把它当成一批来源为插件的用量：`ledger: true` 让它在「活跃会话」
 * 与「按会话」里都不计为一条会话，但 token / 请求数照常进总量、模型与来源占比——否则
 * 「所有模型使用都在一个页面里」这句话就不成立。
 */
export function summarizeLedgerEntries(entries) {
  const groups = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue
    const occurredAtMs = validTime(entry.occurredAt)
    const pluginId = typeof entry.pluginId === 'string' ? entry.pluginId.trim() : ''
    if (occurredAtMs == null || !pluginId) continue
    const cwd = typeof entry.cwd === 'string' && entry.cwd.trim() ? entry.cwd.trim() : null
    const key = cwd || ''
    let group = groups.get(key)
    if (!group) {
      group = { cwd, events: [], createdAtMs: occurredAtMs, updatedAtMs: occurredAtMs }
      groups.set(key, group)
    }
    group.createdAtMs = Math.min(group.createdAtMs, occurredAtMs)
    group.updatedAtMs = Math.max(group.updatedAtMs, occurredAtMs)
    group.events.push(
      withSource(
        normalizeUsageEvent(
          {
            usageId: entry.id,
            occurredAt: entry.occurredAt,
            model: entry.model,
            inputTokens: entry.inputTokens,
            cachedInputTokens: entry.cachedInputTokens,
            outputTokens: entry.outputTokens
          },
          occurredAtMs,
          entry.model
        ),
        { kind: 'plugin', id: pluginId, pluginId },
        { purpose: typeof entry.purpose === 'string' && entry.purpose ? entry.purpose : null }
      )
    )
  }
  return [...groups.values()]
    .map((group) =>
      summarizeStatsSession(
        {
          id: null,
          ledger: true,
          title: LEDGER_SESSION_TITLE,
          cwd: group.cwd,
          createdAtMs: group.createdAtMs,
          updatedAtMs: group.updatedAtMs,
          turnState: 'completed',
          model: group.events[group.events.length - 1]?.model || null,
          providerId: null,
          turns: 0,
          durationMs: Math.max(0, group.updatedAtMs - group.createdAtMs)
        },
        group.events
      )
    )
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
}

/** 内容搜索的正文上限（每个会话）：够长到能查到上下文，又不至于把几百个会话全留在内存里。 */
export const SESSION_SEARCH_TEXT_LIMIT = 20000

/** compact 元数据消息的前缀（packages/mica-context 的 COMPACT_BOUNDARY_PREFIX）。 */
const COMPACT_BOUNDARY_PREFIX = '[Mica compact boundary]'

/** compact 摘要消息的前缀（packages/mica-context 的 COMPACT_SUMMARY_PREFIX）。 */
const COMPACT_SUMMARY_PREFIX = '[Mica compact checkpoint]'

/** 超长会话中间被丢掉时留下的标记。 */
const OMITTED_MARKER = '\n…\n'

/**
 * 内容搜索用的正文投影。
 *
 * 只取 user / assistant 的文本，notice（错误、压缩、配置提示）与工具结果都不算——那些
 * 是噪声，搜出来的「命中」多半不是用户在找的东西。插件注入的消息（定时任务等）正文放在
 * `displayContent` 里，与 `content` 不同时一并收录，否则按任务内容搜不到它。
 *
 * compact 的 boundary 消息整段是内部状态 JSON（含历史提示词清单），既不是用户说的话又很
 * 长，一律跳过——不跳的话它会挤掉正文的预算，命中结果也全是它（`checkpoint` 摘要消息是
 * 压缩后的对话本身，照常收录）。
 *
 * 超长会话取「开头 + 结尾」两段（开头是任务本身、结尾是最后在做的事）并标记 `truncated`；
 * 没有正文的会话返回 null，扫描器会把「这个文件没有可搜正文」缓存下来，不必反复解析。
 */
export function parseSessionText(raw, { maxChars = SESSION_SEARCH_TEXT_LIMIT } = {}) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null
  const messages = raw.snapshot?.conversationMessages
  if (!Array.isArray(messages)) return null
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : SESSION_SEARCH_TEXT_LIMIT

  const parts = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const content = projectContent(message.content, Number.MAX_SAFE_INTEGER)
    if (message.role === 'user' && content.startsWith(COMPACT_BOUNDARY_PREFIX)) continue
    // 摘要消息保留正文（它是压缩后的对话本身），只去掉标记行，免得「checkpoint」成了搜索热词。
    const body = content.startsWith(COMPACT_SUMMARY_PREFIX)
      ? content.slice(COMPACT_SUMMARY_PREFIX.length).trimStart()
      : content
    if (body) parts.push(body)
    const display = projectContent(message.displayContent, Number.MAX_SAFE_INTEGER)
    if (display && display !== content) parts.push(display)
  }
  if (!parts.length) return null
  const text = parts.join('\n')
  if (text.length <= limit) return { id: raw.id, text, truncated: false }
  // 中间那段丢掉，长度算上省略标记也仍在上限内（界面按这个上限说明能搜到多少）。
  const budget = Math.max(0, limit - OMITTED_MARKER.length)
  const head = Math.round(budget * 0.6)
  const tail = budget - head
  return {
    id: raw.id,
    text: `${text.slice(0, head)}${OMITTED_MARKER}${text.slice(text.length - tail)}`,
    truncated: true
  }
}
