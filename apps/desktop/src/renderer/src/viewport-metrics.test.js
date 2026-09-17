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

  it('falls back to the layout viewport when only it shrinks for the keyboard', () => {
    // iOS 26 的回归：键盘弹起时 visualViewport 的高度不变，innerHeight 反而矮了一截。
    expect(viewportMetrics({ height: 852, scale: 1, offsetTop: 0 }, { innerHeight: 420 })).toEqual({
      height: 420,
      top: 0
    })
  })

  it('ignores a layout viewport that is only a few pixels shorter', () => {
    expect(
      viewportMetrics({ height: 852, scale: 1, offsetTop: 0 }, { innerHeight: 828 }).height
    ).toBe(852)
  })

  it('takes the smallest of innerHeight and clientHeight', () => {
    const metrics = viewportMetrics(
      { height: 852, scale: 1, offsetTop: 0 },
      { innerHeight: 852, clientHeight: 420 }
    )
    expect(metrics.height).toBe(420)
  })

  it('skips the layout shift when the keyboard was never accounted for', () => {
    // 应用还是整屏高，说明可见区没跟着键盘缩；iOS 那次上移正是把输入条露出来的那一步，
    // 抵消它只会把输入条留在键盘底下。
    expect(
      viewportMetrics({ height: 852, scale: 1, offsetTop: 352 }, { innerHeight: 852 }).top
    ).toBe(0)
  })

  it('compensates the layout shift once the keyboard is part of the height', () => {
    expect(
      viewportMetrics({ height: 420, scale: 1, offsetTop: 352 }, { innerHeight: 852 }).top
    ).toBe(352)
  })

  it('has nothing to compute without a visual viewport', () => {
    expect(viewportMetrics(null)).toBeNull()
    expect(viewportMetrics(undefined)).toBeNull()
  })

  it('has nothing to compute without a usable height', () => {
    expect(viewportMetrics({ height: 0, scale: 1, offsetTop: 0 })).toBeNull()
  })
})
