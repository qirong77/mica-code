import { describe, expect, it } from 'bun:test'
import { formatGitCount, gitChangeBadge } from './git-badge'

describe('formatGitCount', () => {
  it('千位以下保持精确', () => {
    expect(formatGitCount(0)).toBe('0')
    expect(formatGitCount(999)).toBe('999')
  })

  it('千位以上缩写，且向下取整（不虚报变更量）', () => {
    expect(formatGitCount(1000)).toBe('1k')
    expect(formatGitCount(1250)).toBe('1.2k')
    expect(formatGitCount(9999)).toBe('9.9k')
    expect(formatGitCount(12345)).toBe('12k')
    expect(formatGitCount(999999)).toBe('999k')
  })

  it('百万进位到 M，再大也不超过 5 个字符', () => {
    expect(formatGitCount(1_000_000)).toBe('1M')
    expect(formatGitCount(1_250_000)).toBe('1.2M')
    expect(formatGitCount(12_345_678)).toBe('12M')
    expect(formatGitCount(1_234_567_890).length).toBeLessThanOrEqual(6)
  })

  it('脏输入按 0 处理', () => {
    expect(formatGitCount(undefined)).toBe('0')
    expect(formatGitCount(null)).toBe('0')
    expect(formatGitCount(Number.NaN)).toBe('0')
    expect(formatGitCount(-12)).toBe('0')
  })
})

describe('gitChangeBadge', () => {
  it('工作区干净时不画', () => {
    expect(gitChangeBadge(null)).toBeNull()
    expect(gitChangeBadge({ files: 0, additions: 0, deletions: 0 })).toBeNull()
  })

  it('两侧都有变更时给一对红绿数字', () => {
    expect(gitChangeBadge({ files: 3, additions: 1250, deletions: 840 })).toEqual({
      additions: '+1.2k',
      deletions: '−840',
      fallback: null,
      title: '3 个文件已更改 · +1,250 −840 行'
    })
  })

  it('为 0 的一侧不画', () => {
    const onlyAdded = gitChangeBadge({ files: 1, additions: 12, deletions: 0 })
    expect(onlyAdded.additions).toBe('+12')
    expect(onlyAdded.deletions).toBeNull()
    expect(onlyAdded.title).toBe('1 个文件已更改 · +12 行')

    const onlyDeleted = gitChangeBadge({ files: 1, additions: 0, deletions: 30 })
    expect(onlyDeleted.additions).toBeNull()
    expect(onlyDeleted.deletions).toBe('−30')
    expect(onlyDeleted.title).toBe('1 个文件已更改 · −30 行')
  })

  it('有文件但没行数变更时退回落成文件数', () => {
    const badge = gitChangeBadge({ files: 2, additions: 0, deletions: 0 })
    expect(badge.additions).toBeNull()
    expect(badge.deletions).toBeNull()
    expect(badge.fallback).toBe('2 个文件')
    expect(badge.title).toBe('2 个文件已更改')
  })

  it('只有删除也算有变更', () => {
    expect(gitChangeBadge({ files: 0, additions: 0, deletions: 5 })).not.toBeNull()
  })
})
