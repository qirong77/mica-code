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
 * 总量、模型占比、子代理类型、插件后台请求都在这一步合并出来。
 */
export function scopeSession(session, range) {
  const days = (session.days || []).filter((day) => dayInRange(day.day, range))
  if (days.length === 0) return null
  const totals = emptyTotals()
  const modelMap = new Map()
  const subagentMap = new Map()
  const pluginMap = new Map()
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
    for (const usage of day.subagents) {
      const row = subagentMap.get(usage.type) || {
        type: usage.type,
        tasks: new Set(),
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      }
      for (const task of usage.tasks) row.tasks.add(task)
      row.requests += usage.requests
      row.inputTokens += usage.inputTokens
      row.outputTokens += usage.outputTokens
      row.totalTokens += usage.totalTokens
      subagentMap.set(usage.type, row)
    }
    for (const usage of day.plugins) {
      const row = pluginMap.get(usage.pluginId) || {
        pluginId: usage.pluginId,
        purposes: new Set(),
        ...emptyTotals()
      }
      for (const purpose of usage.purposes) row.purposes.add(purpose)
      row.requests += usage.requests
      for (const key of TOKEN_KEYS) row[key] += usage[key]
      pluginMap.set(usage.pluginId, row)
    }
  }
  const modelUsage = [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  return {
    ...session,
    ...totals,
    days,
    modelUsage,
    subagentUsage: [...subagentMap.values()],
    pluginUsage: [...pluginMap.values()],
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
      row.sessionIds.add(s.id)
      row.requests += day.requests
      row.turns += day.turns
      row.tokens += day.totalTokens
      map.set(day.day, row)
    }
  }
  return new Map([...map].map(([day, row]) => [day, { ...row, sessions: row.sessionIds.size }]))
}
