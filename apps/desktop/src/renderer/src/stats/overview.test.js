import { describe, expect, test } from 'bun:test'
import { buildOverview } from './overview'
import { scopeSession } from './scope'

function session(id, cwd, date, tokens, extra = {}) {
  const usage = {
    requests: 2,
    inputTokens: tokens - 10,
    cachedInputTokens: tokens - 30,
    uncachedInputTokens: 20,
    outputTokens: 10,
    totalTokens: tokens
  }
  return {
    id,
    cwd,
    ...extra,
    days: [
      {
        day: date,
        at: new Date(`${date}T12:00:00`).getTime(),
        turns: 1,
        ...usage,
        models: [{ model: 'same-model', ...usage }],
        sources: [{ id: 'main', kind: 'main', ...usage, tasks: [], purposes: [] }]
      }
    ]
  }
}

describe('Stats overview projection', () => {
  test('shares one range total across KPI, models, projects, daily values and token components', () => {
    const scoped = [
      session('a', '/one/shared', '2026-11-07', 100),
      session('b', '/two/shared', '2026-11-09', 200)
    ].map((row) => scopeSession(row, 'all'))
    const before = JSON.stringify(scoped)
    const overview = buildOverview(scoped, 'all', '2026-11-09')
    expect(overview.totals).toMatchObject({
      activeSessions: 2,
      requests: 4,
      totalTokens: 300,
      cachedInputTokens: 240,
      uncachedInputTokens: 40,
      outputTokens: 20,
      cacheRate: 240 / 280
    })
    expect(overview.days.map((row) => [row.day, row.tokens])).toEqual([
      ['2026-11-07', 100],
      ['2026-11-08', 0],
      ['2026-11-09', 200]
    ])
    expect(overview.models).toEqual([
      { id: 'same-model', label: 'same-model', sessions: 2, tokens: 300, requests: 4 }
    ])
    expect(overview.projects.map((row) => row.id)).toEqual(['/two/shared', '/one/shared'])
    expect(
      overview.projects.reduce((sum, row) => sum + row.values.reduce((a, b) => a + b, 0), 0)
    ).toBe(300)
    expect(JSON.stringify(scoped)).toBe(before)
  })

  test('counts ledger tokens and requests without inventing an active session', () => {
    const ledger = scopeSession(session(null, '', '2026-11-09', 100, { ledger: true }), 'all')
    const overview = buildOverview([ledger], { day: '2026-11-09' })
    expect(overview.totals).toMatchObject({ activeSessions: 0, requests: 2, totalTokens: 100 })
    expect(overview.models[0].sessions).toBe(0)
    expect(overview.projects[0]).toMatchObject({
      id: '',
      label: '未指定项目',
      sessions: 0,
      tokens: 100
    })
    expect(overview.days).toHaveLength(1)
  })

  test('fills both edges of a selected preset and keeps empty cache rate unknown', () => {
    const today = '2026-11-09'
    const empty = buildOverview([], { day: today }, today)
    expect(empty.totals.cacheRate).toBeNull()
    expect(empty.days).toEqual([{ day: today, requests: 0, tokens: 0, sessions: 0 }])
    expect(buildOverview([], 'all', today).days).toEqual([])
    const all = buildOverview(
      [scopeSession(session('a', '/p', '2026-11-07', 100), 'all')],
      'all',
      today
    )
    expect(all.days.at(-1)).toMatchObject({ day: today, tokens: 0 })
  })

  test('adds unclassified historical tokens to project main once, not per session', () => {
    const a = scopeSession(session('a', '/p', '2026-11-09', 100), 'all')
    const b = scopeSession(session('b', '/p', '2026-11-09', 200), 'all')
    a.sourceUsage[0].totalTokens = 80
    b.sourceUsage = []
    expect(buildOverview([a, b], 'all', '2026-11-09').projects[0].values).toEqual([300, 0, 0, 0])
  })
})
