import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { barRatio, SpeedBars } from './SpeedBars.jsx'

const render = (rows, metric = 'responseWait') =>
  renderToStaticMarkup(
    createElement(SpeedBars, { rows, metric, formatValue: (value) => `${value}`, unit: '秒' })
  )

describe('SpeedBars', () => {
  it('maps values onto a 0–1 ratio against the largest value', () => {
    expect(barRatio(500, 1000)).toBe(0.5)
    expect(barRatio(2000, 1000)).toBe(1)
    expect(barRatio(Number.NaN, 1000)).toBe(0)
    expect(barRatio(500, 0)).toBe(0)
  })

  it('renders one bar row per provider and model with the average value', () => {
    const html = render([
      { provider: 'deepseek', model: 'flash', value: 400, samples: 12 },
      { provider: 'deepseek', model: 'pro', value: 800, samples: 4 }
    ])
    expect(html).toContain('deepseek / flash')
    expect(html).toContain('deepseek / pro')
    expect(html).toContain('width:100%')
    expect(html).toContain('width:50%')
    expect(html).toContain('16 个样本')
    expect(html).toContain('最快')
    expect(html).not.toContain('data-chart=')
  })

  it('labels the top row by metric and falls back for a missing provider', () => {
    const html = render([{ provider: null, model: 'flash', value: 62, samples: 1 }], 'generation')
    expect(html).toContain('未记录供应商 / flash')
    expect(html).not.toContain('最高')
  })
})
