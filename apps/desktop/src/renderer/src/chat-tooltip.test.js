import { describe, expect, it } from 'bun:test'

import { shouldShowTooltip, tooltipLayout } from './chat-tooltip.js'

const viewport = { viewportWidth: 1200, viewportHeight: 800 }

describe('shouldShowTooltip', () => {
  it('鼠标悬停且文本非空时弹', () => {
    expect(shouldShowTooltip({ pointerType: 'mouse', text: '第一行\n第二行' })).toBe(true)
  })

  it('触屏不弹：没有悬停，浮层只会挡住消息', () => {
    expect(shouldShowTooltip({ pointerType: 'touch', text: '文本' })).toBe(false)
  })

  it('空文本或未启用时不弹', () => {
    expect(shouldShowTooltip({ pointerType: 'mouse', text: '   ' })).toBe(false)
    expect(shouldShowTooltip({ enabled: false, pointerType: 'mouse', text: '文本' })).toBe(false)
  })
})

describe('tooltipLayout', () => {
  it('下方有空间时摆在下方，左缘与锚点对齐', () => {
    const layout = tooltipLayout({
      anchorRect: { left: 120, top: 100, bottom: 240, width: 500 },
      ...viewport
    })

    expect(layout).toMatchObject({ placement: 'below', left: 120, top: 246, width: 500 })
  })

  it('下方放不下时改用 bottom 锚定到上方，避免量高度', () => {
    const layout = tooltipLayout({
      anchorRect: { left: 120, top: 700, bottom: 780, width: 400 },
      ...viewport
    })

    expect(layout.placement).toBe('above')
    expect(layout.bottom).toBe(106)
    expect(layout.top).toBeUndefined()
  })

  it('贴右边时不越出视口', () => {
    const layout = tooltipLayout({
      anchorRect: { left: 1000, top: 100, bottom: 240, width: 500 },
      ...viewport
    })

    expect(layout.left + layout.width).toBeLessThanOrEqual(1200)
  })

  it('宽度跟随锚点但不超过上限', () => {
    const layout = tooltipLayout({
      anchorRect: { left: 0, top: 100, bottom: 240, width: 2400 },
      ...viewport
    })

    expect(layout.width).toBe(640)
  })

  it('拿不到锚点或视口尺寸时返回 null，调用方不渲染浮层', () => {
    expect(tooltipLayout({ anchorRect: null, ...viewport })).toBeNull()
    expect(tooltipLayout({ anchorRect: { left: 0, top: 0, bottom: 10, width: 10 }, viewportWidth: 0 })).toBeNull()
  })
})
