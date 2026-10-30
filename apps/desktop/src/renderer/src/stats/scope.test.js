import { describe, expect, test } from 'bun:test'
import { localDayKey } from '@packages/mica-web-shared/stats-day.js'
import { bucketByDay, scopeSession } from './scope.js'

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime()
const day = (y, m, d) => localDayKey(at(y, m, d))

function dayRow(overrides = {}) {
  return {
    day: day(2026, 8, 2),
    at: at(2026, 8, 2),
    requests: 2,
    turns: 2,
    legacy: 0,
    inputTokens: 100,
    cachedInputTokens: 40,
    uncachedInputTokens: 60,
    outputTokens: 10,
    totalTokens: 110,
    models: [
      {
        model: 'm',
        requests: 2,
        inputTokens: 100,
        cachedInputTokens: 40,
        uncachedInputTokens: 60,
        outputTokens: 10,
        totalTokens: 110
      }
    ],
    subagents: [],
    plugins: [],
    ...overrides
  }
}

function session(overrides = {}) {
  return {
    id: 's1',
    title: 'session',
    cwd: '/proj',
    createdAtMs: at(2026, 8, 1),
    updatedAtMs: at(2026, 8, 3),
    turnState: 'completed',
    model: 'config-model',
    turns: 5,
    durationMs: 1000,
    subagentTasks: 0,
    pluginRequests: 0,
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    legacyUsageRecords: 0,
    days: [
      dayRow(),
      dayRow({
        day: day(2026, 8, 3),
        at: at(2026, 8, 3),
        requests: 1,
        turns: 1,
        totalTokens: 55,
        inputTokens: 50,
        outputTokens: 5,
        cachedInputTokens: 0,
        uncachedInputTokens: 50
      }),
      dayRow({
        day: day(2026, 7, 20),
        at: at(2026, 7, 20),
        requests: 9,
        turns: 9,
        totalTokens: 999
      })
    ],
    ...overrides
  }
}

describe('Stats range scoping', () => {
  test('sums only the day rows inside the range', () => {
    const scoped = scopeSession(session(), 'all')
    expect(scoped.requests).toBe(12)
    expect(scoped.totalTokens).toBe(110 + 55 + 999)
    expect(scoped.updatedAtMs).toBe(at(2026, 8, 3))
    expect(scoped.turns).toBe(12)

    const today = scopeSession(session(), { day: day(2026, 8, 2) })
    expect(today.requests).toBe(2)
    expect(today.totalTokens).toBe(110)
    expect(today.updatedAtMs).toBe(at(2026, 8, 2))
  })

  test('keeps the configured model, and summarizes model usage by range', () => {
    const scoped = scopeSession(session(), { day: day(2026, 8, 3) })
    expect(scoped.model).toBe('m')
    expect(scoped.modelUsage).toHaveLength(1)
  })

  test('merges subagent tasks and plugin purposes across days', () => {
    const scoped = scopeSession(
      session({
        days: [
          dayRow({
            subagents: [
              {
                type: 'Explore',
                tasks: ['t1'],
                requests: 1,
                inputTokens: 10,
                outputTokens: 1,
                totalTokens: 11
              }
            ],
            plugins: [
              {
                pluginId: 'p',
                purposes: ['title'],
                requests: 1,
                inputTokens: 10,
                outputTokens: 1,
                totalTokens: 11
              }
            ]
          }),
          dayRow({
            day: day(2026, 8, 3),
            subagents: [
              {
                type: 'Explore',
                tasks: ['t1', 't2'],
                requests: 2,
                inputTokens: 20,
                outputTokens: 2,
                totalTokens: 22
              }
            ],
            plugins: [
              {
                pluginId: 'p',
                purposes: ['title', 'review'],
                requests: 2,
                inputTokens: 20,
                outputTokens: 2,
                totalTokens: 22
              }
            ]
          })
        ]
      }),
      'all'
    )
    expect(scoped.subagentUsage).toHaveLength(1)
    expect([...scoped.subagentUsage[0].tasks].sort()).toEqual(['t1', 't2'])
    expect(scoped.subagentUsage[0].requests).toBe(3)
    expect([...scoped.pluginUsage[0].purposes].sort()).toEqual(['review', 'title'])
    expect(scoped.pluginUsage[0].requests).toBe(3)
  })

  test('drops sessions without usage in the range', () => {
    expect(scopeSession(session(), { day: day(2026, 1, 1) })).toBeNull()
  })
})

describe('Stats day buckets', () => {
  test('counts sessions, requests and turns per day', () => {
    const buckets = bucketByDay([
      session(),
      session({ id: 's2', days: [dayRow({ requests: 3, turns: 1, totalTokens: 30 })] })
    ])
    const first = buckets.get(day(2026, 8, 2))
    expect(first.sessions).toBe(2)
    expect(first.requests).toBe(5)
    expect(first.turns).toBe(3)
    expect(first.tokens).toBe(140)
  })
})
