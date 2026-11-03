import { describe, expect, it } from 'bun:test'
import { orderRecentDrafts } from './recent-drafts'

const draft = (id, lastActiveAt) => ({ id, lastActiveAt })

describe('orderRecentDrafts', () => {
  it('当前选中的草稿排第一，其余按最近活动时间倒序', () => {
    const drafts = [draft('a', 10), draft('b', 30), draft('c', 20)]
    expect(orderRecentDrafts(drafts, 'a').map((node) => node.id)).toEqual(['a', 'b', 'c'])
    expect(orderRecentDrafts(drafts, 'c').map((node) => node.id)).toEqual(['c', 'b', 'a'])
  })

  it('没有选中的草稿时纯按活动时间排', () => {
    expect(orderRecentDrafts([draft('a', 1), draft('b', 3)], null).map((node) => node.id)).toEqual([
      'b',
      'a'
    ])
  })

  it('活动时间缺失或非法按最旧处理，不丢条目', () => {
    const drafts = [draft('a', undefined), { id: 'b' }, draft('c', Number.NaN), draft('d', 5)]
    expect(orderRecentDrafts(drafts).map((node) => node.id)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('空输入返回空数组', () => {
    expect(orderRecentDrafts()).toEqual([])
    expect(orderRecentDrafts([])).toEqual([])
  })
})
