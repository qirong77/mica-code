import { describe, expect, it } from 'bun:test'
import { orderRecentDrafts } from './recent-drafts'

const draft = (id, lastActiveAt) => ({ id, text: id, lastActiveAt })

describe('orderRecentDrafts', () => {
  it('保持工作区里的创建顺序，不按活动时间重排', () => {
    const drafts = [draft('a', 10), draft('b', 30), draft('c', 20)]
    expect(orderRecentDrafts(drafts).map((node) => node.id)).toEqual(['a', 'b', 'c'])
  })

  it('活动时间变化不改变顺序', () => {
    const before = [draft('新建 1', 1), draft('新建 2', 2)]
    const after = [draft('新建 1', 99), draft('新建 2', 2)]
    expect(orderRecentDrafts(after).map((node) => node.id)).toEqual(
      orderRecentDrafts(before).map((node) => node.id)
    )
  })

  it('丢掉没有 id 的条目，不丢有效条目', () => {
    const drafts = [{ id: 'a' }, { text: 'x' }, null, { id: 'b' }]
    expect(orderRecentDrafts(drafts).map((node) => node.id)).toEqual(['a', 'b'])
  })

  it('空输入返回空数组', () => {
    expect(orderRecentDrafts()).toEqual([])
    expect(orderRecentDrafts([])).toEqual([])
  })
})
