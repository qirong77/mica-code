import { describe, expect, it } from 'bun:test'
import { buildSessionQuickOpenItems, SESSION_QUICK_OPEN_LIMIT } from './session-quick-open-rows'

const sessions = [
  { id: 'a', title: '钱包改版', cwd: '/work/wallet', updatedAtMs: 100 },
  { id: 'b', title: '联调记录', cwd: '/work/order', updatedAtMs: 300 },
  { id: 'c', title: '另一个联调', cwd: '/work/wallet', updatedAtMs: 200 }
]

describe('buildSessionQuickOpenItems', () => {
  it('lists recent sessions when the query is empty', () => {
    const result = buildSessionQuickOpenItems({ sessions, query: '' })
    expect(result.items.map((item) => item.id)).toEqual(['b', 'c', 'a'])
    expect(result.total).toBe(3)
    expect(result.items[0].title).toBe('联调记录')
    expect(result.items[0].titleRanges).toEqual([])
  })

  it('matches titles before directories', () => {
    const result = buildSessionQuickOpenItems({ sessions, query: '联调' })
    expect(result.items.map((item) => item.id)).toEqual(['b', 'c'])
  })

  it('matches the directory and highlights the hit', () => {
    const result = buildSessionQuickOpenItems({ sessions, query: 'wallet' })
    expect(result.items.map((item) => item.id)).toEqual(['c', 'a'])
    const wallet = result.items[0]
    expect(wallet.cwdRanges.length).toBeGreaterThan(0)
    const [start, end] = wallet.cwdRanges[0]
    expect(wallet.cwd.slice(start, end).toLowerCase()).toBe('wallet')
  })

  it('searches the group name of a session', () => {
    const result = buildSessionQuickOpenItems({
      sessions,
      query: '需求',
      groupNameOf: (id) => (id === 'c' ? '需求' : '')
    })
    expect(result.items.map((item) => item.id)).toEqual(['c'])
    expect(result.items[0].groupName).toBe('需求')
  })

  it('drops sessions that do not match every token', () => {
    expect(buildSessionQuickOpenItems({ sessions, query: '钱包 不存在' }).items).toEqual([])
    expect(buildSessionQuickOpenItems({ sessions, query: '钱包' }).total).toBe(1)
  })

  it('caps the list but reports the full hit count', () => {
    const many = Array.from({ length: SESSION_QUICK_OPEN_LIMIT + 7 }, (_, index) => ({
      id: `s${index}`,
      title: `会话 ${index}`,
      cwd: '/work/many',
      updatedAtMs: index
    }))
    const result = buildSessionQuickOpenItems({ sessions: many, query: '' })
    expect(result.items).toHaveLength(SESSION_QUICK_OPEN_LIMIT)
    expect(result.total).toBe(SESSION_QUICK_OPEN_LIMIT + 7)
    expect(result.items[0].id).toBe(`s${SESSION_QUICK_OPEN_LIMIT + 6}`)
  })

  it('ignores entries without an id', () => {
    const result = buildSessionQuickOpenItems({
      sessions: [{ title: '没有 id' }, ...sessions],
      query: '联调'
    })
    expect(result.total).toBe(2)
  })
})
