import { describe, expect, it } from 'vitest'
import { formatTracking, relativeDateZh } from './git-refs'

describe('relativeDateZh', () => {
  it('translates git relative dates', () => {
    expect(relativeDateZh('22 hours ago')).toBe('22 小时前')
    expect(relativeDateZh('6 weeks ago')).toBe('6 周前')
    expect(relativeDateZh('13 minutes ago')).toBe('13 分钟前')
  })

  it('keeps only the largest unit', () => {
    expect(relativeDateZh('1 year, 2 months ago')).toBe('1 年前')
  })

  it('passes through unknown or empty values', () => {
    expect(relativeDateZh('')).toBe('')
    expect(relativeDateZh('5 小时前')).toBe('5 小时前')
    expect(relativeDateZh('now')).toBe('刚刚')
  })
})

describe('formatTracking', () => {
  it('renders ahead/behind as VS Code style arrows', () => {
    expect(formatTracking('[behind 1]')).toBe('1↓')
    expect(formatTracking('[ahead 2]')).toBe('2↑')
    expect(formatTracking('[ahead 1, behind 2]')).toBe('2↓ 1↑')
  })

  it('passes through unknown or empty values', () => {
    expect(formatTracking('')).toBe('')
    expect(formatTracking(null)).toBe('')
    expect(formatTracking('[gone]')).toBe('[gone]')
  })
})
