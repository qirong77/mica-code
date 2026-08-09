import { describe, expect, test } from 'bun:test'
import { relativeTimeShort } from './relative-time'

const NOW = new Date(2026, 2, 15, 12).getTime()

describe('relativeTimeShort', () => {
  test('formats recent timestamps with compact relative units', () => {
    expect(relativeTimeShort(NOW - 20_000, NOW)).toBe('刚刚')
    expect(relativeTimeShort(NOW - 12 * 60_000, NOW)).toBe('12m')
    expect(relativeTimeShort(NOW - 3 * 3_600_000, NOW)).toBe('3h')
    expect(relativeTimeShort(NOW - 5 * 86_400_000, NOW)).toBe('5d')
  })

  test('uses a date for older timestamps', () => {
    expect(relativeTimeShort(new Date(2026, 0, 2).getTime(), NOW)).toBe('1/2')
    expect(relativeTimeShort(new Date(2025, 11, 31).getTime(), NOW)).toBe('2025/12/31')
  })

  test('does not show a misleading value for a missing timestamp', () => {
    expect(relativeTimeShort(0, NOW)).toBe('')
  })
})
