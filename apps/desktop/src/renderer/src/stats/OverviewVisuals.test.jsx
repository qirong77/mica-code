import { describe, expect, it, mock } from 'bun:test'
import * as rootReact from '../../../../../../node_modules/react/index.js'
mock.module(import.meta.dir + '/../../../../node_modules/react/index.js', () => rootReact)
import { createElement } from '../../../../../../node_modules/react/index.js'
import { renderToStaticMarkup } from '../../../../../../node_modules/react-dom/server.node.js'
const { OverviewVisuals } = await import('./OverviewVisuals.jsx')
const { StatsPanel } = await import('./StatsPanel.jsx')

const overview = {
  totals: {
    activeSessions: 12,
    requests: 3456,
    inputTokens: 1000000,
    outputTokens: 100000,
    cachedInputTokens: 800000,
    uncachedInputTokens: 200000,
    totalTokens: 1100000,
    cacheRate: 0.8
  },
  days: [{ day: '2026-11-05', tokens: 1100000, requests: 3456 }],
  models: [
    { id: 'large', label: 'Large model', sessions: 7, requests: 1000, tokens: 800000 },
    { id: 'fast', label: 'Fast model', sessions: 5, requests: 2456, tokens: 300000 }
  ],
  projects: [
    {
      id: 'mica',
      label: 'Mica project',
      cwd: '/work/mica',
      sessions: 12,
      requests: 3456,
      tokens: 1100000,
      values: [700000, 200000, 150000, 50000]
    }
  ]
}
const noop = () => {}
const render = (data = overview, metric = 'tokens', extra = {}) =>
  renderToStaticMarkup(
    createElement(OverviewVisuals, {
      overview: data,
      metric,
      onMetricChange: noop,
      onSelectModel: noop,
      ...extra
    })
  )

describe('OverviewVisuals', () => {
  it('renders exact KPI values with real Arco Card and Statistic components', () => {
    const html = render()
    expect(html.match(/arco-statistic-title/g)).toHaveLength(4)
    expect(html).toMatch(/data-metric="totalTokens" data-value="1100000"/)
    expect(html).toContain('1,100,000')
    expect(html).toContain('3,456')
    expect(html).toContain('data-metric="activeSessions" data-value="12"')
    expect(html).toMatch(/arco-statistic-value-int">80<\/span>/)
    expect(html).toContain('.0')
    expect(html).toContain('arco-statistic-value-suffix">%')
    expect(html).toContain('stats-metrics-panel')
    expect(html).toContain('arco-card arco-card-size-small arco-card-bordered stats-panel')
  })

  it('uses all tokens for the ring shares, not the input denominator of the cache rate', () => {
    const html = render()
    expect(html).toContain('Token 构成数值')
    expect(html).toContain('缓存输入 · 800,000 Tokens · 占全部 72.7%')
    expect(html).toContain('未缓存输入 · 200,000 Tokens · 占全部 18.2%')
    expect(html).toContain('输出 · 100,000 Tokens · 占全部 9.1%')
    expect(html).toContain('缓存占总量 72.7%；缓存命中率 80.0% 仅以输入为分母。')
    expect(html).toContain('background:var(--color-fg-faint)')
    expect(html).toContain('background:var(--color-info)')
    expect(html).toContain('background:var(--color-accent)')
  })

  it('shows exact real single-day totals without inventing hourly changes', () => {
    const html = render()
    expect(html).toContain('stats-chart-trend')
    expect(html).toContain('2026-11-05 · 3,456 请求 · 1,100,000 Tokens')
    expect(html).toContain('单日汇总，不推测小时变化')
    expect(html).not.toContain('清除选日')
  })

  it('uses the parent metric for both trend and model order without mutating its data', () => {
    const tokens = render()
    const requests = render(overview, 'requests')
    const rankTitles = (html) =>
      [...html.matchAll(/class="stats-rank-line"><strong title="([^"]+)"/g)].map(
        (match) => match[1]
      )
    expect(rankTitles(tokens)).toEqual(['Large model', 'Fast model'])
    expect(rankTitles(requests)).toEqual(['Fast model', 'Large model'])
    expect(requests).toContain('Daily requests')
    expect(requests).toContain('按请求')
    expect(overview.models.map((row) => row.id)).toEqual(['large', 'fast'])
  })

  it('limits the model ranking to six rows and leaves projects to the detail module', () => {
    const data = {
      ...overview,
      models: Array.from({ length: 8 }, (_, index) => ({
        id: `model-${index}`,
        label: `Model ${index}`,
        tokens: 8 - index,
        requests: 1,
        sessions: 1
      })),
      projects: Array.from({ length: 9 }, (_, index) => ({
        id: `project-${index}`,
        label: `Project ${index}`,
        cwd: `/work/${index}`,
        tokens: 9 - index,
        requests: 1,
        sessions: 1,
        values: [9 - index, 0, 0, 0]
      }))
    }
    const html = render(data)
    expect(html.match(/stats-rank-action/g)).toHaveLength(6)
    expect(html).toContain('展示 6 / 8 个模型')
    expect(html).toContain('查看全部模型')
    expect(html).not.toContain('Model 6')
    expect(data.models).toHaveLength(8)
    expect(data.projects).toHaveLength(9)
    // banner 里只有 KPI、趋势、Token 构成与模型排行；项目堆叠图下沉成独立的「项目明细」
    // 模块，这里再画一遍就等于同一份数据在页面上出现两次。
    expect(html).not.toContain('项目贡献')
    expect(html).not.toContain('Project 0')
  })

  it('keeps date selection local and describes the multi-day range', () => {
    const html = render({
      ...overview,
      days: [
        { day: '2026-11-03', tokens: 100000, requests: 1 },
        { day: '2026-11-05', tokens: 1000000, requests: 3455 }
      ]
    })
    expect(html).toContain('2026-11-03 — 2026-11-05')
    expect(html).toContain('选日仅查看，不改变区间总量')
    expect(html).not.toContain('单日汇总')
    expect(html).toContain('data-metric="totalTokens" data-value="1100000"')
  })

  it('uses Arco empty states and no invented rate for zero data', () => {
    const html = render({
      totals: {
        activeSessions: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        totalTokens: 0,
        cacheRate: null
      },
      days: [],
      models: [],
      projects: []
    })
    // banner 里剩三块会空的地方：每日用量、Token 构成、模型分布。
    expect(html.match(/class="arco-empty ui-empty"/g)).toHaveLength(3)
    expect(html).toContain('所选区间没有每日用量')
    expect(html).toContain('所选区间没有 Token 用量')
    expect(html).toContain('所选区间没有模型用量')
    expect(html).toContain('缓存占总量 —；缓存命中率 —')
    expect(html).toContain('缓存占总量 —；缓存命中率 —')
    expect(html).not.toContain('%')
    expect(html).not.toContain('stats-chart-donut')
    expect(html).not.toContain('NaN')
  })

  it('does not invent a cache hit rate when output exists but no input was measured', () => {
    const html = render({
      ...overview,
      totals: {
        ...overview.totals,
        inputTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 100000,
        totalTokens: 100000,
        cacheRate: null
      }
    })
    expect(html).toContain('缓存占总量 0.0%；缓存命中率 —')
    expect(html).toContain('输出 · 100,000 Tokens · 占全部 100.0%')
  })

  it('slots extra content directly under the KPI strip, before trend and token charts', () => {
    const html = render(overview, 'tokens', { afterMetrics: 'AFTER_METRICS_SLOT' })
    const kpi = html.indexOf('stats-metrics-panel')
    const slot = html.indexOf('AFTER_METRICS_SLOT')
    const trend = html.indexOf('stats-chart-trend')
    expect(kpi).toBeGreaterThan(-1)
    expect(slot).toBeGreaterThan(kpi)
    expect(trend).toBeGreaterThan(slot)
  })

  it('exports the reusable Arco panel with title, extra, content and stats scope', () => {
    const html = renderToStaticMarkup(
      createElement(
        StatsPanel,
        { title: '精确明细', extra: '全部记录', className: 'stats-details' },
        '记录内容'
      )
    )
    expect(html).toContain(
      'arco-card arco-card-size-small arco-card-bordered stats-panel stats-details'
    )
    expect(html).toContain('arco-card-header-title">精确明细')
    expect(html).toContain('class="stats-meta">全部记录')
    expect(html).toContain('arco-card-body">记录内容')
  })
})
