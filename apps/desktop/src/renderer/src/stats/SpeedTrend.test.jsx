import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SpeedTrend } from './SpeedTrend.jsx'

const render = (series) =>
  renderToStaticMarkup(createElement(SpeedTrend, { series, formatValue: String, unit: '秒' }))

describe('SpeedTrend', () => {
  it('renders the chart for a single day of samples', () => {
    const html = render([
      { id: 'model', points: [{ day: '2026-11-05', value: 1, samples: 1 }] }
    ])
    expect(html).toContain('data-chart="model-speed"')
    expect(html).not.toContain('仅有一天数据')
  })

  it('shows the selection hint when no model has a valid sample', () => {
    expect(render([])).toContain('选择上方图例里的模型')
    expect(render([{ id: 'model', points: [] }])).not.toContain('data-chart="model-speed"')
  })
})
