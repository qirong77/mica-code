import { describe, expect, it } from 'bun:test'
import {
  absoluteTime,
  blameRequest,
  buildBlameHover,
  createBlameResolver,
  relativeTime
} from './git-blame'

const ENTRY = {
  line: 12,
  hash: 'abcdef1234567890abcdef1234567890abcdef12',
  shortHash: 'abcdef12',
  author: 'Ann',
  authorMail: 'ann@example.com',
  time: new Date(2024, 4, 6, 15, 4).getTime(),
  summary: 'fix: 修好一个 [bug]',
  filename: 'a.txt',
  uncommitted: false,
  source: 'worktree'
}

describe('blameRequest', () => {
  it('三种口径映射成 git:blame 的参数', () => {
    expect(blameRequest({ kind: 'worktree' }, 3)).toEqual({ line: 3 })
    expect(blameRequest({ kind: 'index' }, 3)).toEqual({ index: true, line: 3 })
    expect(blameRequest({ kind: 'commit', ref: 'abc' }, 3)).toEqual({ ref: 'abc', line: 3 })
    expect(blameRequest({ kind: 'none' }, 3)).toBeNull()
    expect(blameRequest(null, 3)).toBeNull()
  })
})

describe('时间格式', () => {
  const now = Date.parse('2024-05-06T16:00:00+08:00')

  it('相对时间取最大的单位', () => {
    expect(relativeTime(now - 30 * 1000, now)).toBe('刚刚')
    expect(relativeTime(now - 5 * 60 * 1000, now)).toBe('5 分钟前')
    expect(relativeTime(now - 3 * 3600 * 1000, now)).toBe('3 小时前')
    expect(relativeTime(now - 2 * 24 * 3600 * 1000, now)).toBe('2 天前')
    expect(relativeTime(now - 20 * 24 * 3600 * 1000, now)).toBe('2 周前')
    expect(relativeTime(0, now)).toBe('')
  })

  it('绝对时间按本地时区补零', () => {
    const time = new Date(2024, 4, 6, 9, 7).getTime()
    expect(absoluteTime(time)).toBe('2024-05-06 09:07')
    expect(absoluteTime(0)).toBe('')
  })
})

describe('buildBlameHover', () => {
  it('给出作者、时间、提交说明与位置', () => {
    const markdown = buildBlameHover(ENTRY, { path: 'src/a.txt', sourceLabel: '修改后 · 工作区' })
    expect(markdown).toContain('**Ann**')
    expect(markdown).toContain('2024-05-06 15:04')
    expect(markdown).toContain('`abcdef12`')
    expect(markdown).toContain('fix: 修好一个 \\[bug\\]')
    expect(markdown).toContain('`src/a.txt`')
    expect(markdown).toContain('第 12 行')
    expect(markdown).toContain('修改后 · 工作区')
  })

  it('未提交的行说清楚，并带上上一版提交', () => {
    const markdown = buildBlameHover({
      ...ENTRY,
      uncommitted: true,
      previous: { hash: 'fedcba9876543210', path: 'a.txt' }
    })
    expect(markdown).toContain('**未提交的更改**')
    expect(markdown).toContain('`fedcba98`')
  })

  it('读不到 blame 时不显示任何内容', () => {
    expect(buildBlameHover(null)).toBeNull()
    expect(buildBlameHover({ error: 'fatal: no such path' })).toBeNull()
  })
})

describe('createBlameResolver', () => {
  it('同一行只读一次，结果被缓存', async () => {
    let reads = 0
    const resolver = createBlameResolver(async () => {
      reads += 1
      return ENTRY
    })
    const meta = { cwd: '/repo', path: 'a.txt', blame: { kind: 'worktree' } }
    const first = await resolver.lookup(meta, 12)
    const second = await resolver.lookup(meta, 12)
    expect(first).toBe(second)
    expect(reads).toBe(1)
    await resolver.lookup(meta, 13)
    expect(reads).toBe(2)
  })

  it('并发查同一行共用一次请求', async () => {
    let reads = 0
    const resolver = createBlameResolver(async () => {
      reads += 1
      return ENTRY
    })
    const meta = { cwd: '/repo', path: 'a.txt', blame: { kind: 'commit', ref: 'HEAD' } }
    await Promise.all([resolver.lookup(meta, 4), resolver.lookup(meta, 4)])
    expect(reads).toBe(1)
  })

  it('没有可 blame 的一侧、读失败的都不显示', async () => {
    const resolver = createBlameResolver(async () => {
      throw new Error('boom')
    })
    expect(await resolver.lookup({ cwd: '/repo', path: 'a.txt', blame: { kind: 'none' } }, 1)).toBe(
      null
    )
    expect(await resolver.lookup({ path: 'a.txt', blame: { kind: 'worktree' } }, 1)).toBeNull()
    expect(
      await resolver.lookup({ cwd: '/repo', path: 'a.txt', blame: { kind: 'worktree' } }, 1)
    ).toBe(null)
  })

  it('结果里带上调用方给的侧别说明', async () => {
    const resolver = createBlameResolver(async () => ENTRY)
    const meta = {
      cwd: '/repo',
      path: 'a.txt',
      blame: { kind: 'worktree' },
      sourceLabel: '原始 · HEAD'
    }
    expect(await resolver.lookup(meta, 1)).toContain('原始 · HEAD')
  })
})
