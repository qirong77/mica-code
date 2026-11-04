import { describe, expect, it } from 'bun:test'
import {
  SESSION_FILTER_DAY_MS,
  SESSION_FILTER_MODES,
  filterSessions,
  matchesSessionFilter,
  sessionFilterMode
} from './session-filter'

const NOW = new Date(2026, 2, 15, 15, 30).getTime()
const ago = (hours) => NOW - hours * 60 * 60 * 1000
const session = (id, hours, extra = {}) => ({ id, updatedAtMs: ago(hours), ...extra })
const stateOf = (session) => session.state ?? null

describe('sessionFilterMode', () => {
  it('只有三档，默认是全部', () => {
    expect(SESSION_FILTER_MODES.map((mode) => mode.id)).toEqual(['all', '24h', 'active'])
    expect(sessionFilterMode('nope').id).toBe('all')
  })
})

describe('matchesSessionFilter', () => {
  it('24 小时是滚动窗口，跨过日界的昨天也算', () => {
    expect(matchesSessionFilter(session('a', 1), '24h', { now: NOW })).toBe(true)
    expect(matchesSessionFilter(session('b', 23.5), '24h', { now: NOW })).toBe(true)
    expect(matchesSessionFilter(session('c', 24.5), '24h', { now: NOW })).toBe(false)
  })

  it('时间戳缺失或非法一律不算最近', () => {
    expect(matchesSessionFilter({ id: 'x' }, '24h', { now: NOW })).toBe(false)
    expect(matchesSessionFilter({ id: 'x', updatedAtMs: 0 }, '24h', { now: NOW })).toBe(false)
  })

  it('进行中 = 正在跑 + 等你选，两种都算', () => {
    const running = { id: 'a', state: 'running' }
    const awaiting = { id: 'b', state: 'awaiting' }
    const unread = { id: 'c', state: 'unread' }
    const idle = { id: 'd', state: null }
    for (const item of [running, awaiting]) {
      expect(matchesSessionFilter(item, 'active', { stateOf })).toBe(true)
    }
    for (const item of [unread, idle]) {
      expect(matchesSessionFilter(item, 'active', { stateOf })).toBe(false)
    }
  })

  it('状态判定必须走传入的 stateOf，而不是另读一份字段', () => {
    const item = { id: 'a', state: null }
    expect(matchesSessionFilter(item, 'active', { stateOf: () => 'running' })).toBe(true)
  })

  it('全部不过滤任何一条', () => {
    expect(matchesSessionFilter({ id: 'x' }, 'all', { now: NOW })).toBe(true)
  })

  it('24 小时的边界取 ≤ 一天', () => {
    expect(
      matchesSessionFilter({ id: 'x', updatedAtMs: NOW - SESSION_FILTER_DAY_MS }, '24h', {
        now: NOW
      })
    ).toBe(true)
  })
})

describe('filterSessions', () => {
  const list = [
    session('recent', 2, { state: 'running' }),
    session('yesterday', 23.5),
    session('old', 30),
    session('awaiting', 4, { state: 'awaiting' })
  ]

  it('全部原样返回同一个数组', () => {
    expect(filterSessions(list, 'all', { now: NOW, stateOf })).toBe(list)
  })

  it('24 小时只留一天内的', () => {
    expect(filterSessions(list, '24h', { now: NOW, stateOf }).map((item) => item.id)).toEqual([
      'recent',
      'yesterday',
      'awaiting'
    ])
  })

  it('进行中只留 running / awaiting', () => {
    expect(filterSessions(list, 'active', { now: NOW, stateOf }).map((item) => item.id)).toEqual([
      'recent',
      'awaiting'
    ])
  })

  it('不是数组时交出空数组', () => {
    expect(filterSessions(null, '24h', { now: NOW })).toEqual([])
  })
})
