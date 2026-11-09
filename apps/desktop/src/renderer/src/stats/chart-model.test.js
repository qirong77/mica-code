import { describe, expect, test } from 'bun:test'
import {
  chartRowId,
  describeValues,
  makeDonutOption,
  makeProjectOption,
  makeTrendOption,
  projectRows,
  sanitizeRows,
  shares,
  trendRows
} from './chart-model.js'

describe('stats chart data', () => {
  test('sanitizes non-positive and non-finite values while preserving identity and input', () => {
    const valid = Object.freeze({
      id: 'cached',
      label: 'Cached input',
      value: 42_000_000,
      color: 'var(--color-fg-faint)'
    })
    const rows = Object.freeze([
      valid,
      ...[0, -2, NaN, Infinity, '3'].map((value) => Object.freeze({ value })),
      null
    ])
    const clean = sanitizeRows(rows)
    expect(clean).toEqual([valid])
    expect(clean[0]).not.toBe(valid)
    expect(rows).toHaveLength(7)
    expect(sanitizeRows(undefined)).toEqual([])
  })

  test('uses every valid value in the denominator and shares add up to one', () => {
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

  test('fills daily gaps across DST, sorting and combining duplicate dates without input mutation', () => {
    const rows = Object.freeze([
      Object.freeze({ day: '2026-03-10', tokens: 30, requests: 3 }),
      Object.freeze({ day: '2026-03-07', tokens: 10, requests: 1 }),
      Object.freeze({ day: '2026-03-10', tokens: 5, requests: 2 }),
      Object.freeze({ day: '2026-03-09', tokens: NaN, requests: -2 })
    ])
    expect(trendRows(rows)).toEqual([
      { day: '2026-03-07', tokens: 10, requests: 1 },
      { day: '2026-03-08', tokens: 0, requests: 0 },
      { day: '2026-03-09', tokens: 0, requests: 0 },
      { day: '2026-03-10', tokens: 35, requests: 5 }
    ])
    expect(rows[0].tokens).toBe(30)
    expect(rows[0].day).toBe('2026-03-10')
    expect(rows[3].tokens).toBeNaN()
  })

  test('supports inclusive ranges and leap days, rejecting invalid dates and reversed ranges', () => {
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

  test('draws a single category as a full ring and empty charts without invented values', () => {
    const single = makeDonutOption([{ id: 'one', label: 'Only category', value: 12 }])
    expect(single.series[0].data).toHaveLength(1)
    expect(single.series[0].data[0].share).toBe(1)
    expect(single.series[0].padAngle).toBe(0)
    const empty = makeDonutOption([{ value: 12 }], {
      empty: true,
      theme: { empty: 'neutral-token' }
    })
    expect(empty.series[0].data).toEqual([])
    expect(empty.series[0].showEmptyCircle).toBe(true)
    expect(empty.series[0].emptyCircleStyle.color).toBe('neutral-token')
    expect(empty.tooltip.show).toBe(false)
    expect(makeDonutOption([]).series[0].data).toEqual([])
    const trend = makeTrendOption([])
    expect(trend.xAxis.data).toEqual([])
    expect(trend.series[0].data).toEqual([])
    expect(trend.tooltip.show).toBe(false)
    expect(trend.tooltip.formatter([])).toBe('')
    const projects = makeProjectOption([], [{ key: 'main', label: 'Main' }])
    expect(projects.series[0].data).toEqual([])
    expect(projects.tooltip.show).toBe(false)
    expect(projects.tooltip.formatter([])).toBe('')
    expect(describeValues([], 'Tokens')).toBe('No Tokens data.')
  })

  test('confines rich-text tooltips with exact values, correct percentages and escaped markup', () => {
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
    expect(option.animationDuration).toBe(0)
    expect(option.animationDurationUpdate).toBe(0)
    expect(option.stateAnimation.duration).toBe(0)
    expect(option.series[0].data.map((row) => row.itemStyle.opacity)).toEqual([1, 0.35])
  })

  test('plots the selected daily metric, retaining zero days and exact tooltips', () => {
    const option = makeTrendOption(
      [
        { day: '2026-10-01', tokens: 2_000, requests: 2 },
        { day: '2026-10-03', tokens: 5_000, requests: 4 }
      ],
      { metric: 'requests', reducedMotion: true }
    )
    expect(option.xAxis.data).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    expect(option.series).toHaveLength(1)
    expect(option.series[0].id).toBe('requests')
    expect(option.series[0].data.map((row) => row.value)).toEqual([2, 0, 4])
    expect(option.tooltip.formatter([{ data: option.series[0].data[2] }])).toBe(
      '2026-10-03\n4 Requests'
    )
    expect(option.animation).toBe(false)
  })

  test('renders an actual single-day point without fabricating hourly data', () => {
    const option = makeTrendOption([{ day: '2026-10-01', tokens: 1_234_567, requests: 3 }], {
      formatValue: () => '1.23M'
    })
    expect(option.xAxis.data).toEqual(['2026-10-01'])
    expect(option.xAxis.boundaryGap).toBe(true)
    expect(option.xAxis.triggerEvent).toBe(true)
    expect(option.series[0].showSymbol).toBe(true)
    expect(option.series[0].data).toEqual([{ day: '2026-10-01', value: 1_234_567 }])
    expect(option.tooltip.formatter([{ data: option.series[0].data[0] }])).toBe(
      '2026-10-01\n1.23M (1,234,567) Tokens'
    )
  })

  test('project stacks preserve absolute totals and exact segment tooltips without input mutation', () => {
    const parts = Object.freeze([
      Object.freeze({ key: 'main', label: 'Main' }),
      Object.freeze({ key: 'helper', label: 'Helper' }),
      Object.freeze({ key: 'other', label: 'Other' })
    ])
    const rows = Object.freeze([
      Object.freeze({
        id: 'big',
        label: 'Large',
        cwd: '/work/large',
        values: Object.freeze([80_000, 20_001, 0])
      }),
      Object.freeze({ id: 'small', label: 'Small', values: Object.freeze([30, 5, NaN]) }),
      Object.freeze({ id: 'bad', label: 'Invalid', values: Object.freeze([-8, Infinity]) })
    ])
    const projected = projectRows(rows, parts)
    const option = makeProjectOption(rows, parts, {
      formatValue: (value) => (value >= 1_000 ? `${Math.round(value / 1_000)}K` : String(value)),
      reducedMotion: true
    })
    const totals = [0, 1, 2].map((index) =>
      option.series.reduce((sum, series) => sum + series.data[index].value, 0)
    )
    expect(totals).toEqual([100_001, 35, 0])
    expect(option.xAxis.type).toBe('value')
    expect(option.xAxis.max).toBeUndefined()
    expect(option.series.every((series) => series.stack === 'absolute-tokens')).toBe(true)
    expect(option.tooltip.formatter([{ dataIndex: 0 }])).toBe(
      'Large\n/work/large\n100K (100,001) Tokens\nMain: 80K (80,000)\nHelper: 20K (20,001)\nOther: 0'
    )
    expect(option.tooltip.renderMode).toBe('richText')
    expect(option.animation).toBe(false)
    expect(projected[0]).not.toBe(rows[0])
    expect(projected[0].values).not.toBe(rows[0].values)
    expect(rows[2].values).toEqual([-8, Infinity])
    expect(rows[1].values[2]).toBeNaN()
    expect(rows[0].total).toBeUndefined()
  })

  test('project selection uses the clicked data id, not its label, series or row index', () => {
    const option = makeProjectOption(
      [
        { id: 'project:/work/one', label: 'Same name', values: [8, 2] },
        { id: 'project:/work/two', label: 'Same name', values: [3, 5] }
      ],
      [
        { key: 'main', label: 'Main' },
        { key: 'helper', label: 'Helper' }
      ]
    )
    for (const series of option.series) {
      expect(chartRowId({ componentType: 'series', data: series.data[1], dataIndex: 1 })).toBe(
        'project:/work/two'
      )
    }
    expect(chartRowId({ componentType: 'series', data: { id: 0 } })).toBe(0)
    expect(chartRowId({ componentType: 'yAxis', value: 'Same name' })).toBeNull()
    expect(chartRowId({ componentType: 'series', data: { value: 1 } })).toBeNull()
    expect(chartRowId(undefined)).toBeNull()
  })
})
