import { describe, expect, it } from 'bun:test'
import { buildShareRows, shareRowTime } from './share-index'

const NOW = 1_700_000_000_000

describe('buildShareRows', () => {
  const sessions = [
    { id: 'a', title: '重构分享链接', cwd: '/work/mica-code', updatedAtMs: NOW },
    { id: 'b', title: null, cwd: null, updatedAtMs: null }
  ]

  it('joins the share registry with the session list, newest share first', () => {
    const rows = buildShareRows(
      [
        { sessionId: 'a', sharedAt: NOW - 3000 },
        { sessionId: 'b', sharedAt: NOW }
      ],
      sessions,
      { baseUrl: 'http://192.168.1.23:8788' }
    )
    expect(rows.map((row) => row.sessionId)).toEqual(['b', 'a'])
    expect(rows[1]).toEqual({
      sessionId: 'a',
      title: '重构分享链接',
      cwd: '/work/mica-code',
      updatedAtMs: NOW,
      sharedAt: NOW - 3000,
      exists: true,
      url: 'http://192.168.1.23:8788/?session=a'
    })
  })

  it('falls back to the session id as the title when the session has none', () => {
    const rows = buildShareRows([{ sessionId: 'b', sharedAt: NOW }], sessions)
    expect(rows[0].title).toBe('b')
    // 拿不到可达地址时不给链接（页面据此禁用复制），而不是拼一条坏链接
    expect(rows[0].url).toBeNull()
  })

  it('keeps a share whose session is gone, flagged as missing', () => {
    const rows = buildShareRows([{ sessionId: 'gone', sharedAt: NOW }], sessions, {
      baseUrl: 'http://box:8788'
    })
    expect(rows[0]).toMatchObject({ sessionId: 'gone', exists: false, title: '会话已不存在' })
    expect(rows[0].url).toBe('http://box:8788/?session=gone')
  })

  it('ignores garbage entries and tolerates a missing session list', () => {
    expect(buildShareRows([{ sessionId: '' }, null, { sessionId: 'a' }], null)).toHaveLength(1)
    expect(buildShareRows(null, sessions)).toEqual([])
  })
})

describe('shareRowTime', () => {
  it('renders a short relative time and nothing for unknown timestamps', () => {
    expect(shareRowTime({ updatedAtMs: NOW - 30_000 }, NOW)).toBe('刚刚')
    expect(shareRowTime({ updatedAtMs: NOW - 5 * 60_000 }, NOW)).toBe('5 分钟前')
    expect(shareRowTime({ updatedAtMs: NOW - 3 * 3_600_000 }, NOW)).toBe('3 小时前')
    expect(shareRowTime({ updatedAtMs: NOW - 2 * 86_400_000 }, NOW)).toBe('2 天前')
    expect(shareRowTime({ updatedAtMs: 0 }, NOW)).toBe('')
  })
})
