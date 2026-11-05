import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverviewVisuals } from './OverviewVisuals.jsx'

const totals = { cachedInputTokens: 80, uncachedInputTokens: 20, outputTokens: 10, inputTokens: 100, cacheRate: 0.8 }
const day = (date, requests, totalTokens) => ({ day: date, requests, totalTokens, turns: 0 })
const render = (days, values = totals) => renderToStaticMarkup(createElement(OverviewVisuals, { scoped: days.length ? [{ id: 'a', days }] : [], totals: values }))

describe('OverviewVisuals', () => {
  it('renders real single-day values and token composition', () => {
    const html = render([day('2026-11-05', 3, 110)])
    expect(html).toContain('2026-11-05: 3')
    expect(html).toContain('2026-11-05: 110')
    expect(html).toContain('80.0%')
    expect(html).toContain('缓存输入: 80')
  })

  it('fills gaps with zero and does not invent a cache rate for empty data', () => {
    const html = render([day('2026-11-03', 1, 10), day('2026-11-05', 2, 20)])
    expect(html).toContain('2026-11-04: 0')
    const empty = render([], { cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, inputTokens: 0, cacheRate: 0 })
    expect(empty).toContain('暂无数据')
    expect(empty).toContain('缓存命中率 —')
  })
})
