import { describe, expect, it } from 'bun:test'
import { groupRecentRows, recentBucketOf, RECENT_BUCKET_LABELS } from './recent-buckets'

// 固定「现在」= 2026-03-15 15:30 本地时间
const NOW = new Date(2026, 2, 15, 15, 30).getTime()
const at = (day, hour = 12) => new Date(2026, 2, day, hour).getTime()

describe('recentBucketOf', () => {
  it('按本地日切今天 / 昨天 / 近七天 / 更早', () => {
    expect(recentBucketOf(at(15, 9), NOW)).toBe(0)
    expect(recentBucketOf(at(15, 0), NOW)).toBe(0)
    expect(recentBucketOf(at(14, 23), NOW)).toBe(1)
    expect(recentBucketOf(at(14, 0), NOW)).toBe(1)
    expect(recentBucketOf(at(13, 23), NOW)).toBe(2)
    // 近七天含今天：今天 + 前 6 天
    expect(recentBucketOf(at(9, 1), NOW)).toBe(2)
    expect(recentBucketOf(at(8, 23), NOW)).toBe(3)
  })

  it('未来时间也算今天（时钟漂移不该让会话消失）', () => {
    expect(recentBucketOf(at(16, 9), NOW)).toBe(0)
  })

  it('缺失或非法时间戳算更早', () => {
    expect(recentBucketOf(undefined, NOW)).toBe(3)
    expect(recentBucketOf(null, NOW)).toBe(3)
    expect(recentBucketOf(Number.NaN, NOW)).toBe(3)
    expect(recentBucketOf('yesterday', NOW)).toBe(3)
  })

  it('标签顺序与桶号一致', () => {
    expect(RECENT_BUCKET_LABELS).toHaveLength(4)
    expect(RECENT_BUCKET_LABELS[0]).toBe('今天')
  })
})

describe('groupRecentRows', () => {
  const row = (id, updatedAtMs, depth = 0) => ({ session: { id, updatedAtMs }, depth })

  it('每个桶只插一次标题，且插在该桶第一行之前', () => {
    const rows = [row('a', at(15, 9)), row('b', at(15, 8)), row('c', at(14, 20)), row('d', at(1))]
    const blocks = groupRecentRows(rows, NOW)
    expect(blocks.map((block) => (block.kind === 'label' ? `#${block.label}` : block.row.session.id))).toEqual([
      '#今天',
      'a',
      'b',
      '#昨天',
      'c',
      '#更早',
      'd'
    ])
  })

  it('派生会话跟着父会话，不单独切桶', () => {
    const rows = [
      row('parent', at(14, 20)),
      row('child', at(15, 9), 1),
      row('grandchild', at(1), 2),
      row('next', at(15, 1))
    ]
    const blocks = groupRecentRows(rows, NOW)
    const labels = blocks.filter((block) => block.kind === 'label').map((block) => block.label)
    // 子会话的「今天」与「更早」不该造出新标题：它们属于父会话那一桶
    expect(labels).toEqual(['昨天', '今天'])
  })

  it('空列表不给标题', () => {
    expect(groupRecentRows([], NOW)).toEqual([])
  })
})
