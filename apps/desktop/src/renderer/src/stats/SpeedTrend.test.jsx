import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { shouldUseLogScale, SpeedTrend } from './SpeedTrend.jsx'

const render = (series, intraday = false) =>
  renderToStaticMarkup(
    createElement(SpeedTrend, { series, formatValue: String, unit: '秒', intraday })
  )

describe('SpeedTrend', () => {
  it('uses a logarithmic scale when samples span several orders of magnitude', () => {
    expect(
      shouldUseLogScale([
        { points: [{ value: 0.8 }, { value: 2 }] },
        { points: [{ value: 210 }] }
      ])
    ).toBe(true)
    expect(shouldUseLogScale([{ points: [{ value: 1 }, { value: 10 }] }])).toBe(false)
  })

  it('renders a timeline for minute samples', () => {
    const html = render(
      [
        {
          id: 'model',
          label: 'provider / model',
          color: 'red',
          points: [{ at: 1793880000000, value: 1, samples: 3 }]
        },
        {
          id: 'other',
          label: 'provider / other',
          color: 'blue',
          points: [{ at: 1793880060000, value: 2, samples: 4 }]
        }
      ],
      true
    )
    expect(html).toContain('data-chart="model-speed"')
    expect(html).not.toContain('data-chart="model-speed-day"')
  })

  it('keeps the trend chart for multiple sampled days', () => {
    const html = render([
      {
        id: 'model',
        points: [
          { day: '2026-11-05', value: 1, samples: 1 },
          { day: '2026-11-06', value: 2, samples: 1 }
        ]
      }
    ])
    expect(html).toContain('data-chart="model-speed"')
    expect(html).not.toContain('data-chart="model-speed-day"')
  })

  it('shows the selection hint when no model has a valid sample', () => {
    expect(render([])).toContain('选择上方图例里的模型')
    expect(render([{ id: 'model', points: [] }])).not.toContain('data-chart="model-speed"')
  })
})
