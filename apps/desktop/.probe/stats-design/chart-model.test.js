import { describe, expect, test } from 'bun:test'
import {
  makeDonutOption,
  makeProjectOption,
  makeTreemapOption,
  makeTrendOption,
  sanitizeRows,
  shares,
  trendRows
} from './chart-model.js'

describe('stats chart data', () => {
  test('sanitizes non-positive and non-finite values without losing row identity or mutating input', () => {
    const valid = {
      id: 'cached',
      label: 'Cached input',
      value: 42_000_000,
      color: 'var(--color-fg-faint)'
    }
    const rows = [valid, ...[0, -2, NaN, Infinity, '3'].map((value) => ({ value })), null]
    const clean = sanitizeRows(rows)
    expect(clean).toEqual([valid])
    expect(clean[0]).not.toBe(valid)
    expect(rows).toHaveLength(7)
  })

  test('uses all valid values as the denominator and shares add up to one', () => {
    const result = shares([
      { id: 'cached', value: 42_000_000 },
      { id: 'uncached', value: 3_950_000 },
      { id: 'output', value: 2_650_000 },
      { id: 'invalid', value: NaN },
      { id: 'zero', value: 0 }
    ])
    expect(result.reduce((sum, row) => sum + row.value, 0)).toBe(48_600_000)
    expect(result[0].share).toBeCloseTo(42_000_000 / 48_600_000, 12)
    expect(result.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 12)
    expect(shares([{ value: 0 }])).toEqual([])
  })

  test('fills daily gaps across the DST boundary, sorts and aggregates duplicate days', () => {
    const result = trendRows([
      { day: '2026-03-10', tokens: 30, requests: 3 },
      { day: '2026-03-07', tokens: 10, requests: 1 },
      { day: '2026-03-10', tokens: 5, requests: 2 },
      { day: '2026-03-09', tokens: NaN, requests: -2 }
    ])
    expect(result).toEqual([
      { day: '2026-03-07', tokens: 10, requests: 1 },
      { day: '2026-03-08', tokens: 0, requests: 0 },
      { day: '2026-03-09', tokens: 0, requests: 0 },
      { day: '2026-03-10', tokens: 35, requests: 5 }
    ])
    expect(result.reduce((sum, row) => sum + row.tokens, 0)).toBe(45)
    expect(result.reduce((sum, row) => sum + row.requests, 0)).toBe(6)
  })

  test('supports inclusive explicit ranges, leap days and empty ranges without accepting invalid dates', () => {
    expect(trendRows([], '2024-02-28', '2024-03-01').map((row) => row.day)).toEqual([
      '2024-02-28',
      '2024-02-29',
      '2024-03-01'
    ])
    expect(
      trendRows([
        { day: '2026-02-29', tokens: 20 },
        { day: '2026-01-01T12:00Z', tokens: 5 }
      ])
    ).toEqual([])
    expect(trendRows([], '2026-03-02', '2026-03-01')).toEqual([])
    expect(trendRows([{ day: '2026-03-01', tokens: 9 }], '2026-03-02', '2026-03-02')).toEqual([
      { day: '2026-03-02', tokens: 0, requests: 0 }
    ])
    expect(trendRows([], 'not-a-date', '2026-03-01')).toEqual([])
  })

  test('draws a single category as a full ring and emptiness without placeholder values', () => {
    const single = makeDonutOption([{ id: 'one', label: 'Only category', value: 12 }])
    expect(single.series[0].data).toHaveLength(1)
    expect(single.series[0].data[0].share).toBe(1)
    expect(single.series[0].padAngle).toBe(0)
    expect(single.series[0].label.show).toBe(false)
    const empty = makeDonutOption([{ value: 12 }], {
      empty: true,
      theme: { empty: 'neutral-token' }
    })
    expect(empty.series[0].data).toEqual([])
    expect(empty.series[0].showEmptyCircle).toBe(true)
    expect(empty.series[0].emptyCircleStyle.color).toBe('neutral-token')
    expect(empty.tooltip.show).toBe(false)
  })

  test('keeps tooltips as confined SVG rich text and includes exact values plus correct percentages', () => {
    const label = '<img src=x onerror=alert(1)> {value|label}'
    const option = makeDonutOption(
      [
        { id: 'a', label, value: 3_000_000 },
        { id: 'b', label: 'B', value: 1_000_000 }
      ],
      {
        formatValue: (value) => `${value / 1_000_000}M`,
        reducedMotion: true,
        selectedKey: 'a'
      }
    )
    expect(option.tooltip.renderMode).toBe('richText')
    expect(option.tooltip.confine).toBe(true)
    const text = option.tooltip.formatter({ data: option.series[0].data[0] })
    expect(text).toContain('3M (3,000,000)')
    expect(text).toContain('75.00%')
    expect(text).not.toContain('{value|label}')
    expect(option.animation).toBe(false)
    expect(option.series[0].data.map((row) => row.itemStyle.opacity)).toEqual([1, 0.35])
  })

  test('trend plots only the chosen daily metric and retains zero days rather than fabricating hours', () => {
    const option = makeTrendOption(
      [
        { day: '2026-10-01', tokens: 2_000, requests: 2 },
        { day: '2026-10-03', tokens: 5_000, requests: 4 }
      ],
      { metric: 'requests' }
    )
    expect(option.xAxis.data).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    expect(option.series).toHaveLength(1)
    expect(option.series[0].id).toBe('requests')
    expect(option.series[0].data.map((row) => row.value)).toEqual([2, 0, 4])
    expect(option.tooltip.formatter([{ data: option.series[0].data[2] }])).toBe(
      '2026-10-03\n4 Requests'
    )
  })

  test('project stacks preserve absolute totals and normalize only invalid segments, not to 100 percent', () => {
    const parts = [
      { key: 'main', label: 'Main' },
      { key: 'helper', label: 'Helper' },
      { key: 'other', label: 'Other' }
    ]
    const option = makeProjectOption(
      [
        { id: 'big', label: 'Large', values: [80, 20, 0] },
        { id: 'small', label: 'Small', values: [30, 5, NaN] },
        { id: 'bad', label: 'Invalid', values: [-8, Infinity] }
      ],
      parts
    )
    const totals = [0, 1, 2].map((index) =>
      option.series.reduce((sum, series) => sum + series.data[index].value, 0)
    )
    expect(totals).toEqual([100, 35, 0])
    expect(option.xAxis.type).toBe('value')
    expect(option.xAxis.max).toBeUndefined()
    expect(option.series.every((series) => series.stack === 'absolute-tokens')).toBe(true)
    expect(option.tooltip.formatter([{ dataIndex: 1 }])).toContain('35 Tokens')
  })

  test('treemap areas use the same valid values and denominator as the composition chart', () => {
    const option = makeTreemapOption([
      { id: 'a', label: 'A', value: 30 },
      { id: 'b', label: 'B', value: 10 },
      { id: 'c', value: 0 }
    ])
    expect(option.series[0].data.map(({ value, share }) => [value, share])).toEqual([
      [30, 0.75],
      [10, 0.25]
    ])
    expect(option.series[0].roam).toBe(false)
    expect(option.series[0].nodeClick).toBe(false)
    expect(option.aria.enabled).toBe(true)
  })
})
