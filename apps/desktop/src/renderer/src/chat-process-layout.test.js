import { describe, expect, it } from 'bun:test'
import { turnLogVisible } from './chat-process-layout'

describe('turn log visibility', () => {
  it('keeps interrupted activity available on narrow screens', () => {
    expect(turnLogVisible({ roundCount: 1, running: false, canSidebar: false, interrupted: true })).toBe(true)
    expect(turnLogVisible({ roundCount: 1, running: false, canSidebar: false, interrupted: false })).toBe(false)
    expect(turnLogVisible({ roundCount: 0, running: false, canSidebar: false, interrupted: true })).toBe(false)
  })

  it('keeps existing running and sidebar behavior', () => {
    expect(turnLogVisible({ roundCount: 0, running: true, canSidebar: false })).toBe(true)
    expect(turnLogVisible({ roundCount: 1, running: false, canSidebar: true })).toBe(true)
    expect(turnLogVisible({ roundCount: 0, running: false, canSidebar: true })).toBe(false)
  })
})
