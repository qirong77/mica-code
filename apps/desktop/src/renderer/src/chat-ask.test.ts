import { describe, expect, it } from 'vitest'
import { askRemainingMs, formatAskCountdown } from './chat-ask.js'

describe('ask countdown', () => {
  const updatedAt = '2026-01-01T00:00:00.000Z'

  it('counts down from the server-provided time base', () => {
    const ask = { timeoutMs: 300_000, timeoutRemainingMs: 300_000, timeoutUpdatedAt: updatedAt }
    expect(askRemainingMs(ask, Date.parse(updatedAt) + 12_345)).toBe(287_655)
  })

  it('stays still while the host has paused the timeout', () => {
    const ask = {
      timeoutMs: 300_000,
      timeoutRemainingMs: 287_655,
      timeoutPaused: true,
      timeoutUpdatedAt: updatedAt
    }
    expect(askRemainingMs(ask, Date.parse(updatedAt) + 60_000)).toBe(287_655)
  })

  it('formats minutes and hours without dropping leading zeroes', () => {
    expect(formatAskCountdown(300_000)).toBe('5:00')
    expect(formatAskCountdown(61_001)).toBe('1:02')
    expect(formatAskCountdown(3_662_000)).toBe('1:01:02')
    expect(formatAskCountdown(0)).toBe('0:00')
  })
})
