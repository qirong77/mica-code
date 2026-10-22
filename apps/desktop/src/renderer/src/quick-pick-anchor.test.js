import { describe, expect, it } from 'bun:test'
import { QUICK_PICK_GAP, QUICK_PICK_MARGIN, anchoredQuickPickStyle } from './quick-pick-anchor'

const viewport = { viewportWidth: 1440, viewportHeight: 900 }
// 底栏按钮：底部对齐，24px 高
const leftButton = { left: 12, right: 160, top: 876, bottom: 900 }
const rightButton = { left: 1100, right: 1420, top: 876, bottom: 900 }

describe('anchoredQuickPickStyle', () => {
  it('anchors a start-aligned panel above the button on the left', () => {
    const style = anchoredQuickPickStyle({ rect: leftButton, ...viewport, align: 'start' })
    expect(style.left).toBe(12)
    expect(style.right).toBeUndefined()
    // 面板底边落在按钮上方 GAP 处
    expect(style.bottom).toBe(900 - 876 + QUICK_PICK_GAP)
    expect(style.maxHeight).toBe(876 - QUICK_PICK_GAP - QUICK_PICK_MARGIN)
  })

  it('anchors an end-aligned panel above the button on the right', () => {
    const style = anchoredQuickPickStyle({ rect: rightButton, ...viewport, align: 'end' })
    expect(style.right).toBe(1440 - 1420)
    expect(style.left).toBeUndefined()
    expect(style.maxWidth).toBe(1420 - QUICK_PICK_MARGIN)
  })

  it('keeps the panel inside the viewport when the button hugs an edge', () => {
    const start = anchoredQuickPickStyle({
      rect: { left: 0, right: 80, top: 876, bottom: 900 },
      ...viewport,
      align: 'start'
    })
    expect(start.left).toBe(QUICK_PICK_MARGIN)
    const end = anchoredQuickPickStyle({
      rect: { left: 1360, right: 1440, top: 876, bottom: 900 },
      ...viewport,
      align: 'end'
    })
    expect(end.right).toBe(QUICK_PICK_MARGIN)
  })

  it('never collapses the panel on a short viewport', () => {
    const style = anchoredQuickPickStyle({
      rect: { left: 10, right: 120, top: 60, bottom: 84 },
      viewportWidth: 1440,
      viewportHeight: 90,
      align: 'start'
    })
    expect(style.maxHeight).toBeGreaterThanOrEqual(120)
    expect(style.maxWidth).toBeGreaterThanOrEqual(240)
  })

  it('returns null without a measurable anchor or viewport', () => {
    expect(anchoredQuickPickStyle({ rect: null, ...viewport })).toBeNull()
    expect(
      anchoredQuickPickStyle({ rect: leftButton, viewportWidth: 0, viewportHeight: 0 })
    ).toBeNull()
  })
})
