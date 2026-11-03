import { describe, expect, test } from 'bun:test'
import { buildUsageSeries, projectRequest } from './usage-series.js'

function usage(overrides = {}) {
  return {
    usageId: 'u1',
    occurredAt: '2026-11-01T10:00:00.000Z',
    model: 'm',
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 10,
    totalTokens: 110,
    ...overrides
  }
}

function record(overrides = {}) {
  return {
    origin: 'delegation',
    subagentType: 'Explore',
    summary: { totalTokens: 30 },
    requests: [
      usage({
        usageId: 'd1',
        occurredAt: '2026-11-01T10:05:00.000Z',
        inputTokens: 20,
        cachedInputTokens: 0,
        outputTokens: 10,
        totalTokens: 30
      })
    ],
    ...overrides
  }
}

describe('projectRequest', () => {
  test('缺字段按 0，totalTokens 缺省时退回 in + out', () => {
    const row = projectRequest({ inputTokens: 7, outputTokens: 3 }, 'main', 'main')
    expect(row.input).toBe(7)
    expect(row.cached).toBe(0)
    expect(row.output).toBe(3)
    expect(row.total).toBe(10)
    expect(row.sourceLabel).toBe('主对话')
  })

  test('缓存命中比输入还多时夹到输入以内', () => {
    const row = projectRequest(usage({ inputTokens: 5, cachedInputTokens: 900 }), 'main', 'main')
    expect(row.cached).toBe(5)
    expect(row.input - row.cached).toBe(0)
  })
})

describe('buildUsageSeries', () => {
  test('主对话与子代理记录按时间合并，序号与累计跟时间顺序', () => {
    const series = buildUsageSeries(
      [
        usage({ usageId: 'u1', occurredAt: '2026-11-01T10:00:00.000Z' }),
        usage({
          usageId: 'u2',
          occurredAt: '2026-11-01T10:10:00.000Z',
          inputTokens: 200,
          cachedInputTokens: 100,
          totalTokens: 210
        })
      ],
      [record()]
    )
    expect(series.requests.map((r) => r.key)).toEqual(['u1', 'd1', 'u2'])
    expect(series.requests.map((r) => r.index)).toEqual([0, 1, 2])
    expect(series.requests.map((r) => r.cumulative)).toEqual([110, 140, 350])
    expect(series.totals).toEqual({
      requests: 3,
      input: 320,
      cached: 140,
      output: 30,
      total: 350,
      cacheRate: 140 / 320
    })
  })

  test('按来源聚合，只保留出现过的种类，顺序固定', () => {
    const series = buildUsageSeries(
      [usage()],
      [
        record(),
        {
          origin: 'plugin',
          pluginId: 'commit',
          requests: [
            usage({
              usageId: 'p1',
              occurredAt: '2026-11-01T10:06:00.000Z',
              inputTokens: 10,
              outputTokens: 5,
              cachedInputTokens: 0,
              totalTokens: 15
            })
          ]
        }
      ]
    )
    expect(series.byKind.map((row) => row.kind)).toEqual(['main', 'delegation', 'plugin'])
    expect(series.byKind[2]).toMatchObject({ requests: 1, input: 10, output: 5, total: 15 })
    expect(series.composition).toEqual({ cached: 40, uncached: 90, output: 25 })
  })

  test('空会话不抛出，也没有缓存率', () => {
    const series = buildUsageSeries([], [])
    expect(series.requests).toEqual([])
    expect(series.byKind).toEqual([])
    expect(series.totals.requests).toBe(0)
    expect(series.totals.cacheRate).toBe(null)
  })

  test('记录里没有 requests 的条目直接跳过', () => {
    const series = buildUsageSeries([usage()], [{ origin: 'plugin', pluginId: 'x' }])
    expect(series.requests).toHaveLength(1)
    expect(series.byKind.map((row) => row.kind)).toEqual(['main'])
  })
})
