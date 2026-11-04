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

    expect(layout).toMatchObject({ placement: 'below', left: 120, top: 248 })
    expect(layout.bottom).toBeUndefined()
  })

  it('宽度只给上限、不跟锚点走：一行短说明不该被撑成整行宽的横板', () => {
    const wide = tooltipLayout({
      anchorRect: { left: 0, top: 100, bottom: 240, width: 2400 },
      ...viewport
    })
    const narrow = tooltipLayout({
      anchorRect: { left: 0, top: 100, bottom: 240, width: 120 },
      ...viewport
    })

    expect(wide.width).toBeUndefined()
    expect(wide.maxWidth).toBe(560)
    expect(narrow.maxWidth).toBe(560)
  })

  it('下方太矮但上方宽裕时摆上方，并改用 bottom 锚定避免量高度', () => {
    const layout = tooltipLayout({
      anchorRect: { left: 120, top: 700, bottom: 780, width: 400 },
      ...viewport
    })

    expect(layout.placement).toBe('above')
    expect(layout.bottom).toBe(108)
    expect(layout.top).toBeUndefined()
    expect(layout.maxHeight).toBe(440)
  })

  it('贴右边时不越出视口', () => {
    const layout = tooltipLayout({
      anchorRect: { left: 1000, top: 100, bottom: 240, width: 500 },
      ...viewport
    })

    expect(layout.left + layout.maxWidth).toBeLessThanOrEqual(1200)
  })

  it('窗口很窄时宽度收到视口内，但不再窄于 200', () => {
    expect(
      tooltipLayout({
        anchorRect: { left: 24, top: 100, bottom: 240, width: 260 },
        viewportWidth: 300,
        viewportHeight: 800
      })
    ).toMatchObject({ left: 12, maxWidth: 276 })

    expect(
      tooltipLayout({
        anchorRect: { left: 0, top: 100, bottom: 240, width: 180 },
        viewportWidth: 210,
        viewportHeight: 800
      }).maxWidth
    ).toBe(200)
  })

  it('高度受剩余空间限制，放不下时浮层自己滚动', () => {
    const layout = tooltipLayout({
      anchorRect: { left: 24, top: 300, bottom: 380, width: 500 },
      viewportWidth: 1200,
      viewportHeight: 700
    })

    expect(layout).toMatchObject({ placement: 'below', maxHeight: 300 })
  })

  it('拿不到锚点或视口尺寸时返回 null，调用方不渲染浮层', () => {
    expect(tooltipLayout({ anchorRect: null, ...viewport })).toBeNull()
    expect(
      tooltipLayout({ anchorRect: { left: 0, top: 0, bottom: 10, width: 10 }, viewportWidth: 0 })
    ).toBeNull()
  })
})
