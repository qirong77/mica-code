// 统计页的区间聚合：host 给的是「会话 × 本地日」行（见 host/stats-core），这里只做
// 按范围的加法。切范围不再重扫逐条用量事件，纯函数，便于单测。
import { addDays, dayStartMs, localDayKey } from '@packages/mica-web-shared/stats-day.js'

export const TOKEN_KEYS = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'uncachedInputTokens',
  'totalTokens'
]

export function isDayRange(range) {
  return typeof range === 'object'
}

/** 范围起点（毫秒）：preset 为区间起点，day 为当天零点，all 为 0 */
export function rangeStart(range) {
  if (isDayRange(range)) return dayStartMs(range.day)
  if (range === 'all') return 0
  const today = localDayKey(Date.now())
  if (range === 'today') return dayStartMs(today)
  return dayStartMs(addDays(today, -(Number.parseInt(range, 10) - 1)))
}

/** 本地日键是否落在范围内。区间都是整天边界，字符串比较即可。 */
export function dayInRange(day, range) {
  if (isDayRange(range)) return day === range.day
  return range === 'all' || day >= localDayKey(rangeStart(range))
}

function emptyTotals() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    totalTokens: 0
  }
}

/**
 * 只保留落在范围内的日行，并把它们加成一份「像单个会话」的视图：
 * 总量、模型占比与来源占比（主对话 / 委派 / 插件 / 内核后台）都在这一步合并出来。
 */
export function scopeSession(session, range) {
  const days = (session.days || []).filter((day) => dayInRange(day.day, range))
  if (days.length === 0) return null
  const totals = emptyTotals()
  const modelMap = new Map()
  const sourceMap = new Map()
  let turns = 0
  let legacyUsageRecords = 0
  let updatedAtMs = 0
  for (const day of days) {
    totals.requests += day.requests
    for (const key of TOKEN_KEYS) totals[key] += day[key]
    turns += day.turns
    legacyUsageRecords += day.legacy
    if (day.at > updatedAtMs) updatedAtMs = day.at
    for (const model of day.models) {
      const row = modelMap.get(model.model) || { model: model.model, ...emptyTotals() }
      row.requests += model.requests
      for (const key of TOKEN_KEYS) row[key] += model[key]
      modelMap.set(model.model, row)
    }
    for (const source of day.sources || []) {
      const key = `${source.kind}:${source.id}`
      const row = sourceMap.get(key) || {
        kind: source.kind,
        id: source.id,
        tasks: new Set(),
        purposes: new Set(),
        ...emptyTotals()
      }
      for (const task of source.tasks) row.tasks.add(task)
      for (const purpose of source.purposes) row.purposes.add(purpose)
      row.requests += source.requests
      for (const tokenKey of TOKEN_KEYS) row[tokenKey] += source[tokenKey]
      sourceMap.set(key, row)
    }
  }
  const modelUsage = [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  const sourceUsage = [...sourceMap.values()].sort(
    (a, b) => b.totalTokens - a.totalTokens || a.id.localeCompare(b.id)
  )
  const sumBy = (predicate) =>
    sourceUsage.reduce((total, row) => (predicate(row) ? total + row.requests : total), 0)
  return {
    ...session,
    ...totals,
    days,
    modelUsage,
    sourceUsage,
    // 会话行上的两个来源标记（委派了几次 / 插件后台发了多少请求）从同一份来源聚合里来，
    // 不再单独记账：两边各算一套必然漂移。
    delegationTasks: sourceUsage.reduce(
      (total, row) => (row.kind === 'delegation' ? total + row.tasks.size : total),
      0
    ),
    pluginRequests: sumBy((row) => row.kind === 'plugin' || row.kind === 'helper'),
    model: modelUsage[0]?.model || session.model,
    // 范围里没有带 turnId 的请求时退回会话总轮数（老记录没有 turnId）。
    turns: turns || session.turns,
    updatedAtMs,
    legacyUsageRecords
  }
}

/** 日行按日历日汇总（host 已按「会话 × 日」聚好，这里只做加法）。 */
export function bucketByDay(sessions) {
  const map = new Map()
  for (const s of sessions) {
    for (const day of s.days || []) {
      const row = map.get(day.day) || {
        day: day.day,
        sessionIds: new Set(),
        requests: 0,
        turns: 0,
        tokens: 0
      }
      // 无会话的账本用量（一次性命令）不是一条会话，别把「活跃会话数」算多。
      if (!s.ledger) row.sessionIds.add(s.id)
      row.requests += day.requests
      row.turns += day.turns
      row.tokens += day.totalTokens
      map.set(day.day, row)
    }
  }
  return new Map([...map].map(([day, row]) => [day, { ...row, sessions: row.sessionIds.size }]))
}
