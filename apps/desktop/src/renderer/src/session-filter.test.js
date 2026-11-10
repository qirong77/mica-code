import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  SESSION_FILTER_HOUR_MS,
  SESSION_FILTER_MODES,
  filterDrafts,
  filterSessions,
  matchesSessionFilter,
  sessionFilterMode
} from './session-filter'

const NOW = new Date(2026, 2, 15, 15, 30).getTime()
const ago = (hours) => NOW - hours * 60 * 60 * 1000
const session = (id, hours, extra = {}) => ({ id, updatedAtMs: ago(hours), ...extra })

describe('会话筛选按钮', () => {
  const source = readFileSync(new URL('./SessionTree.jsx', import.meta.url), 'utf8')
  const buttons = source.slice(
    source.indexOf('aria-label="会话筛选"'),
    source.indexOf('{searching && (', source.indexOf('aria-label="会话筛选"'))
  )

  it('显式伸展以覆盖共享按钮的 flex: none，窄时保持文字完整并横向滚动', () => {
    expect(buttons).toContain("flex: '1 0 auto'")
    expect(buttons).toContain('min-w-fit whitespace-nowrap')
    expect(buttons).toContain('overflow-x-auto')
  })

  it('当前档位使用强调色主按钮，其余档位保留普通灰底', () => {
    expect(buttons).toContain('aria-pressed={filterMode === mode.id}')
    expect(buttons).toContain("tone={filterMode === mode.id ? 'accent' : undefined}")
    expect(buttons).toContain("appearance={filterMode === mode.id ? 'primary' : 'secondary'}")
  })
})

describe('sessionFilterMode', () => {
  it('档位是全部 + 4/8/12/24 小时，按时间从短到长排', () => {
    expect(SESSION_FILTER_MODES.map((mode) => mode.id)).toEqual(['all', '4h', '8h', '12h', '24h'])
    expect(SESSION_FILTER_MODES.map((mode) => mode.label)).toEqual([
      '全部',
      '4 小时',
      '8 小时',
      '12 小时',
      '24 小时'
    ])
    expect(sessionFilterMode('nope').id).toBe('all')
  })
})

describe('matchesSessionFilter', () => {
  it('4 小时是滚动窗口，跨过日界的昨天也算', () => {
    expect(matchesSessionFilter(session('a', 1), '4h', { now: NOW })).toBe(true)
    expect(matchesSessionFilter(session('b', 3.5), '4h', { now: NOW })).toBe(true)
    expect(matchesSessionFilter(session('c', 4.5), '4h', { now: NOW })).toBe(false)
  })

  it('每一档只看自己那个窗口', () => {
    expect(matchesSessionFilter(session('a', 5), '4h', { now: NOW })).toBe(false)
    expect(matchesSessionFilter(session('a', 5), '8h', { now: NOW })).toBe(true)
    expect(matchesSessionFilter(session('a', 10), '8h', { now: NOW })).toBe(false)
    expect(matchesSessionFilter(session('a', 10), '12h', { now: NOW })).toBe(true)
    expect(matchesSessionFilter(session('a', 20), '12h', { now: NOW })).toBe(false)
    expect(matchesSessionFilter(session('a', 20), '24h', { now: NOW })).toBe(true)
  })

  it('时间戳缺失或非法一律不算最近', () => {
    expect(matchesSessionFilter({ id: 'x' }, '24h', { now: NOW })).toBe(false)
    expect(matchesSessionFilter({ id: 'x', updatedAtMs: 0 }, '24h', { now: NOW })).toBe(false)
  })

  it('全部不过滤任何一条', () => {
    expect(matchesSessionFilter({ id: 'x' }, 'all', { now: NOW })).toBe(true)
  })

  it('窗口的边界取 ≤', () => {
    expect(
      matchesSessionFilter({ id: 'x', updatedAtMs: NOW - 4 * SESSION_FILTER_HOUR_MS }, '4h', {
        now: NOW
      })
    ).toBe(true)
    expect(
      matchesSessionFilter({ id: 'x', updatedAtMs: NOW - 24 * SESSION_FILTER_HOUR_MS }, '24h', {
        now: NOW
      })
    ).toBe(true)
  })
})

describe('filterSessions', () => {
  const list = [
    session('recent', 2, { state: 'running' }),
    session('morning', 6),
    session('afternoon', 10),
    session('yesterday', 23.5),
    session('old', 30)
  ]

  it('全部原样返回同一个数组', () => {
    expect(filterSessions(list, 'all', { now: NOW })).toBe(list)
  })

  it('每一档只留窗口内的会话', () => {
    const ids = (modeId) => filterSessions(list, modeId, { now: NOW }).map((item) => item.id)
    expect(ids('4h')).toEqual(['recent'])
    expect(ids('8h')).toEqual(['recent', 'morning'])
    expect(ids('12h')).toEqual(['recent', 'morning', 'afternoon'])
    expect(ids('24h')).toEqual(['recent', 'morning', 'afternoon', 'yesterday'])
  })

  it('不是数组时交出空数组', () => {
    expect(filterSessions(null, '24h', { now: NOW })).toEqual([])
  })
})

describe('filterDrafts', () => {
  const drafts = [{ id: 'd1', text: '新对话' }, { id: 'd2', text: '新对话 2' }]

  it('新对话没有时间戳，任何时间窗口里都留着', () => {
    for (const modeId of ['4h', '8h', '12h', '24h']) {
      expect(filterDrafts(drafts, modeId).map((node) => node.id)).toEqual(['d1', 'd2'])
    }
  })

  it('「全部」档不重复交出来（那时列表是分区树，草稿在 Recent 里）', () => {
    expect(filterDrafts(drafts, 'all')).toEqual([])
  })

  it('不是数组时交出空数组', () => {
    expect(filterDrafts(null, '4h')).toEqual([])
  })
})
