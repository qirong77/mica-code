import { bucketByDay, isDayRange, rangeStart, TOKEN_KEYS } from './scope'
import { addDays, localDayKey } from './geometry'
import { USAGE_KIND_ORDER } from './usage-series'

export function buildOverview(scoped, range, today = localDayKey(Date.now())) {
  const totals = { activeSessions: 0, requests: 0 }
  for (const key of TOKEN_KEYS) totals[key] = 0
  const models = new Map()
  const projects = new Map()
  for (const session of scoped) {
    if (session.requests > 0 && session.id && !session.ledger) totals.activeSessions++
    totals.requests += session.requests
    for (const key of TOKEN_KEYS) totals[key] += session[key]
    for (const usage of session.modelUsage || []) {
      const row = models.get(usage.model) || {
        id: usage.model,
        label: usage.model,
        sessionIds: new Set(),
        requests: 0,
        tokens: 0
      }
      if (session.id && !session.ledger && usage.requests > 0) row.sessionIds.add(session.id)
      row.requests += usage.requests
      row.tokens += usage.totalTokens
      models.set(row.id, row)
    }
    const cwd = session.cwd || ''
    const project = projects.get(cwd) || {
      id: cwd,
      cwd,
      label: cwd.split('/').filter(Boolean).at(-1) || '未指定项目',
      sessions: 0,
      requests: 0,
      tokens: 0,
      values: USAGE_KIND_ORDER.map(() => 0)
    }
    if (session.id && !session.ledger && session.requests > 0) project.sessions++
    project.requests += session.requests
    project.tokens += session.totalTokens
    for (const usage of session.sourceUsage || []) {
      const index = USAGE_KIND_ORDER.indexOf(usage.kind)
      if (index >= 0) project.values[index] += usage.totalTokens
    }
    projects.set(cwd, project)
  }
  totals.cacheRate = totals.inputTokens > 0 ? totals.cachedInputTokens / totals.inputTokens : null
  const daily = bucketByDay(scoped)
  const firstDay = [...daily.keys()].sort()[0]
  const start = isDayRange(range)
    ? range.day
    : range === 'all'
      ? firstDay
      : localDayKey(rangeStart(range))
  const end = isDayRange(range) ? range.day : today
  const days = []
  if (start) {
    for (let day = start; day <= end; day = addDays(day, 1)) {
      days.push(daily.get(day) || { day, requests: 0, tokens: 0, sessions: 0 })
    }
  }
  return {
    totals,
    days,
    models: [...models.values()]
      .map(({ sessionIds, ...row }) => ({ ...row, sessions: sessionIds.size }))
      .sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id)),
    projects: [...projects.values()]
      .map((row) => {
        // 历史记录未细分的用量沿用原项目图的主对话归属，不重复补差额。
        const classified = row.values.reduce((sum, value) => sum + value, 0)
        const values = [...row.values]
        values[USAGE_KIND_ORDER.indexOf('main')] += Math.max(0, row.tokens - classified)
        return { ...row, values }
      })
      .sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id))
  }
}
