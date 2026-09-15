import { describe, expect, it } from 'bun:test'
import { viewportMetrics } from './viewport-metrics'

describe('viewportMetrics', () => {
  it('reports the visible height when the keyboard is closed', () => {
    expect(viewportMetrics({ height: 852, scale: 1, offsetTop: 0 })).toEqual({
      height: 852,
      top: 0
    })
  })

  it('keeps the layout height under pinch zoom', () => {
    expect(viewportMetrics({ height: 426, scale: 2, offsetTop: 0 })).toEqual({
      height: 852,
      top: 0
    })
  })

  it('reports the layout viewport shift iOS applies for the keyboard', () => {
    expect(viewportMetrics({ height: 420, scale: 1, offsetTop: 352 })).toEqual({
      height: 420,
      top: 352
    })
  })

  it('ignores the offset while zoomed: there it comes from panning, not the keyboard', () => {
    expect(viewportMetrics({ height: 426, scale: 2, offsetTop: 380 }).top).toBe(0)
  })

  it('rounds sub-pixel values so the terminal does not reflow', () => {
    expect(viewportMetrics({ height: 419.6, scale: 1, offsetTop: 351.5 })).toEqual({
      height: 420,
      top: 352
    })
  })

  it('never reports a negative offset', () => {
    expect(viewportMetrics({ height: 420, scale: 1, offsetTop: -12 }).top).toBe(0)
  })

  it('has nothing to compute without a visual viewport', () => {
    expect(viewportMetrics(null)).toBeNull()
    expect(viewportMetrics(undefined)).toBeNull()
  })
})
