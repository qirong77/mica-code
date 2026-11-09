import { describe, expect, test } from 'bun:test'
import { localDayKey } from '@packages/mica-web-shared/stats-day.js'
import {
  bucketByDay,
  modelPerformance,
  modelSpeed,
  modelSpeedPerformance,
  scopeSession
} from './scope.js'

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime()
const day = (y, m, d) => localDayKey(at(y, m, d))

function dayRow(overrides = {}) {
  return {
    day: day(2026, 8, 2),
    at: at(2026, 8, 2),
    requests: 2,
    turns: 2,
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
    sources: [],
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
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
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
  test('keeps identical model names from different providers separate', () => {
    const speed = (provider, wait) => ({
      provider,
      model: 'shared-model',
      responseWaitMs: wait,
      responseWaitSamples: 1
    })
    const input = [
      session({ days: [dayRow({ speedModels: [speed('krill', 100)] })] }),
      session({ days: [dayRow({ speedModels: [speed('us-relay', 600)] })] })
    ]
    expect(modelSpeed(input, 'responseWait')).toEqual([
      { provider: 'krill', model: 'shared-model', value: 100, samples: 1 },
      { provider: 'us-relay', model: 'shared-model', value: 600, samples: 1 }
    ])
  })

  test('aggregates new speed samples into one row per provider and model', () => {
    const sample = (tokens, duration, wait) => ({
      provider: 'p',
      model: 'm',
      generationOutputTokens: tokens,
      generationDurationMs: duration,
      generationSamples: 1,
      responseWaitMs: wait,
      responseWaitSamples: 1
    })
    const input = [
      session({
        days: [
          dayRow({ day: day(2026, 8, 2), speedModels: [sample(100, 1000, 0)] }),
          dayRow({ day: day(2026, 8, 3), speedModels: [sample(100, 3000, 400)] }),
          dayRow({
            day: day(2026, 8, 4),
            speedModels: [
              {
                provider: 'p',
                model: 'm',
                outputTokens: 100,
                durationMs: 500,
                throughputSamples: 1
              }
            ]
          })
        ]
      })
    ]
    expect(modelSpeedPerformance(input)[0]).toMatchObject({
      estimatedTokensPerSecond: 50,
      averageResponseWaitMs: 200,
      generationSamples: 2
    })
    expect(modelSpeed(input, 'generation')).toEqual([
      { provider: 'p', model: 'm', value: 50, samples: 2 }
    ])
    expect(modelSpeed(input, 'responseWait')).toEqual([
      { provider: 'p', model: 'm', value: 200, samples: 2 }
    ])
    expect(modelSpeedPerformance([scopeSession(input[0], { day: day(2026, 8, 4) })])).toEqual([])
  })

  test('weights generation by duration and response wait by sample count across sessions', () => {
    const speed = (tokens, duration, wait, samples) => ({
      provider: 'p', model: 'm', generationOutputTokens: tokens,
      generationDurationMs: duration, generationSamples: samples,
      responseWaitMs: wait, responseWaitSamples: samples
    })
    const input = [
      session({ days: [dayRow({ day: day(2026, 8, 2), speedModels: [speed(200, 2000, 200, 2)] })] }),
      session({ days: [dayRow({ day: day(2026, 8, 3), speedModels: [speed(100, 4000, 700, 1)] })] })
    ]
    expect(modelSpeed(input, 'generation')[0]).toMatchObject({ value: 50, samples: 3 })
    expect(modelSpeed(input, 'responseWait')[0]).toMatchObject({ value: 300, samples: 3 })
    const scoped = input.map((row) => scopeSession(row, { day: day(2026, 8, 3) })).filter(Boolean)
    expect(modelSpeed(scoped, 'generation')[0]).toMatchObject({ value: 25, samples: 1 })
    expect(modelSpeed(scoped, 'responseWait')[0]).toMatchObject({ value: 700, samples: 1 })
  })

  test('compares weighted performance only for selected days and separates providers', () => {
    const sample = (provider, outputTokens, durationMs, firstTokenMs) => ({
      provider,
      model: 'm',
      outputTokens,
      durationMs,
      throughputSamples: 1,
      firstTokenMs,
      firstTokenSamples: 1
    })
    const input = session({
      days: [
        dayRow({
          day: day(2026, 8, 2),
          speedModels: [sample('a', 100, 1000, 200), sample('b', 10, 1000, 400)]
        }),
        dayRow({ day: day(2026, 8, 3), speedModels: [sample('a', 100, 3000, 600)] })
      ]
    })
    const all = modelPerformance([scopeSession(input, 'all')])
    expect(
      all.map((row) => [
        row.provider,
        row.tokensPerSecond,
        row.averageFirstTokenMs,
        row.throughputSamples
      ])
    ).toEqual([
      ['a', 50, 400, 2],
      ['b', 10, 400, 1]
    ])
    expect(
      modelPerformance([scopeSession(input, { day: day(2026, 8, 3) })])[0].tokensPerSecond
    ).toBeCloseTo(100 / 3)
    expect(modelPerformance([session()])).toEqual([])
  })

  test('sorts each metric independently and keeps missing samples last', () => {
    const samples = [
      {
        provider: 'a',
        model: 'a',
        outputTokens: 100,
        durationMs: 1000,
        throughputSamples: 1,
        firstTokenMs: 900,
        firstTokenSamples: 1
      },
      {
        provider: 'b',
        model: 'b',
        outputTokens: 10,
        durationMs: 1000,
        throughputSamples: 1,
        firstTokenMs: 100,
        firstTokenSamples: 1
      },
      {
        provider: 'c',
        model: 'c',
        outputTokens: 0,
        durationMs: 0,
        throughputSamples: 0,
        firstTokenMs: 200,
        firstTokenSamples: 1
      }
    ]
    const scoped = [session({ days: [dayRow({ speedModels: samples })] })]
    expect(modelPerformance(scoped, 'throughput').map((row) => row.model)).toEqual(['a', 'b', 'c'])
    expect(modelPerformance(scoped, 'firstToken').map((row) => row.model)).toEqual(['b', 'c', 'a'])
  })

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

  test('merges usage sources across days', () => {
    const scoped = scopeSession(
      session({
        days: [
          dayRow({
            sources: [
              {
                kind: 'delegation',
                id: 'Explore',
                tasks: ['t1'],
                purposes: [],
                requests: 1,
                inputTokens: 10,
                cachedInputTokens: 0,
                uncachedInputTokens: 10,
                outputTokens: 1,
                totalTokens: 11
              },
              {
                kind: 'plugin',
                id: 'p',
                tasks: [],
                purposes: ['title'],
                requests: 1,
                inputTokens: 10,
                cachedInputTokens: 0,
                uncachedInputTokens: 10,
                outputTokens: 1,
                totalTokens: 11
              }
            ]
          }),
          dayRow({
            day: day(2026, 8, 3),
            sources: [
              {
                kind: 'delegation',
                id: 'Explore',
                tasks: ['t1', 't2'],
                purposes: [],
                requests: 2,
                inputTokens: 20,
                cachedInputTokens: 0,
                uncachedInputTokens: 20,
                outputTokens: 2,
                totalTokens: 22
              },
              {
                kind: 'plugin',
                id: 'p',
                tasks: [],
                purposes: ['title', 'review'],
                requests: 2,
                inputTokens: 20,
                cachedInputTokens: 0,
                uncachedInputTokens: 20,
                outputTokens: 2,
                totalTokens: 22
              }
            ]
          })
        ]
      }),
      'all'
    )
    expect(scoped.sourceUsage).toHaveLength(2)
    const delegated = scoped.sourceUsage.find((row) => row.kind === 'delegation')
    const plugin = scoped.sourceUsage.find((row) => row.kind === 'plugin')
    expect([...delegated.tasks].sort()).toEqual(['t1', 't2'])
    expect(delegated.requests).toBe(3)
    expect([...plugin.purposes].sort()).toEqual(['review', 'title'])
    expect(plugin.requests).toBe(3)
    // 会话行上的两个来源标记来自同一份聚合。
    expect(scoped.delegationTasks).toBe(2)
    expect(scoped.pluginRequests).toBe(3)
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
