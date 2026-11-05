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
  let updatedAtMs = 0
  for (const day of days) {
    totals.requests += day.requests
    for (const key of TOKEN_KEYS) totals[key] += day[key]
    turns += day.turns
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
        pluginId: source.pluginId || null,
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
    updatedAtMs
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

/**
 * 同一批日行，但按「日 × 来源」摊开：每天的柱要能拆成主对话 / 委派 / 插件 / 内核后台。
 * 只累 token，其它 kind 直接忽略（来源判定收窄在 `usage-source.ts`）。
 */
export function bucketByDaySource(sessions) {
  const map = new Map()
  for (const s of sessions) {
    for (const day of s.days || []) {
      const row = map.get(day.day) || { main: 0, delegation: 0, plugin: 0, helper: 0 }
      for (const source of day.sources || []) {
        if (!(source.kind in row)) continue
        row[source.kind] += Number(source.totalTokens) || 0
      }
      map.set(day.day, row)
    }
  }
  return map
}

export function modelPerformance(sessions, metric = 'throughput') {
  const models = new Map()
  for (const session of sessions) {
    for (const day of session.days || []) {
      for (const sample of day.speedModels || []) {
        const key = JSON.stringify([sample.provider, sample.model])
        const row = models.get(key) || {
          provider: sample.provider,
          model: sample.model,
          outputTokens: 0,
          durationMs: 0,
          throughputSamples: 0,
          firstTokenMs: 0,
          firstTokenSamples: 0
        }
        for (const field of [
          'outputTokens',
          'durationMs',
          'throughputSamples',
          'firstTokenMs',
          'firstTokenSamples'
        ]) {
          row[field] += sample[field]
        }
        models.set(key, row)
      }
    }
  }
  return [...models.values()]
    .filter((row) => row.throughputSamples || row.firstTokenSamples)
    .map((row) => ({
      ...row,
      tokensPerSecond: row.throughputSamples ? (row.outputTokens * 1000) / row.durationMs : null,
      averageFirstTokenMs: row.firstTokenSamples ? row.firstTokenMs / row.firstTokenSamples : null
    }))
    .sort((a, b) => {
      const field = metric === 'firstToken' ? 'averageFirstTokenMs' : 'tokensPerSecond'
      const av = a[field]
      const bv = b[field]
      if (av == null || bv == null)
        return (av == null ? 1 : 0) - (bv == null ? 1 : 0) || a.model.localeCompare(b.model)
      return (metric === 'firstToken' ? av - bv : bv - av) || a.model.localeCompare(b.model)
    })
}

function aggregateSpeedModels(sessions) {
  const models = new Map()
  for (const session of sessions) {
    for (const day of session.days || []) {
      for (const sample of day.speedModels || []) {
        const key = JSON.stringify([sample.provider, sample.model])
        const row = models.get(key) || {
          provider: sample.provider,
          model: sample.model,
          generationOutputTokens: 0,
          generationDurationMs: 0,
          generationSamples: 0,
          responseWaitMs: 0,
          responseWaitSamples: 0
        }
        for (const field of [
          'generationOutputTokens',
          'generationDurationMs',
          'generationSamples',
          'responseWaitMs',
          'responseWaitSamples'
        ]) {
          row[field] += sample[field] || 0
        }
        models.set(key, row)
      }
    }
  }
  return [...models.values()]
    .filter((row) => row.generationSamples || row.responseWaitSamples)
    .map((row) => ({
      ...row,
      estimatedTokensPerSecond: row.generationSamples
        ? (row.generationOutputTokens * 1000) / row.generationDurationMs
        : null,
      averageResponseWaitMs: row.responseWaitSamples
        ? row.responseWaitMs / row.responseWaitSamples
        : null
    }))
}

export function modelSpeedPerformance(sessions, metric = 'generation') {
  const field = metric === 'responseWait' ? 'averageResponseWaitMs' : 'estimatedTokensPerSecond'
  return aggregateSpeedModels(sessions).sort((a, b) => {
    const av = a[field]
    const bv = b[field]
    if (av == null || bv == null)
      return (av == null ? 1 : 0) - (bv == null ? 1 : 0) || a.model.localeCompare(b.model)
    return (metric === 'responseWait' ? av - bv : bv - av) || a.model.localeCompare(b.model)
  })
}

export function speedTrendByDay(sessions) {
  const days = new Map()
  for (const session of sessions) {
    for (const day of session.days || []) {
      const rows = days.get(day.day) || []
      rows.push({ days: [day] })
      days.set(day.day, rows)
    }
  }
  return new Map(
    [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, rows]) => [day, aggregateSpeedModels(rows)])
  )
}

export function speedTrendByMinute(sessions) {
  const minutes = new Map()
  for (const session of sessions) {
    for (const day of session.days || []) {
      for (const bucket of day.speedMinutes || []) {
        const rows = minutes.get(bucket.at) || []
        rows.push({ days: [{ speedModels: bucket.models }] })
        minutes.set(bucket.at, rows)
      }
    }
  }
  return new Map(
    [...minutes].sort(([a], [b]) => a - b).map(([at, rows]) => [at, aggregateSpeedModels(rows)])
  )
}

export function modelSpeed(sessions, metric) {
  return modelSpeedPerformance(sessions, metric)
    .map((row) => ({
      provider: row.provider,
      model: row.model,
      value: metric === 'responseWait' ? row.averageResponseWaitMs : row.estimatedTokensPerSecond,
      samples: metric === 'responseWait' ? row.responseWaitSamples : row.generationSamples
    }))
    .filter((row) => row.samples > 0)
}

export function modelSpeedTrend(sessions, provider, model, metric) {
  return [...speedTrendByDay(sessions)].flatMap(([day, rows]) => {
    const row = rows.find((item) => item.provider === provider && item.model === model)
    const samples = metric === 'responseWait' ? row?.responseWaitSamples : row?.generationSamples
    const value =
      metric === 'responseWait' ? row?.averageResponseWaitMs : row?.estimatedTokensPerSecond
    return samples > 0 && value != null ? [{ day, value, samples }] : []
  })
}
