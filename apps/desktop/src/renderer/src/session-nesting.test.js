import { describe, expect, it } from 'bun:test'
import { nestSessions } from './session-nesting'

const session = (id, parentSessionId = null) => ({ id, parentSessionId })

const ids = (rows) => rows.map((row) => [row.session.id, row.depth])

describe('nestSessions', () => {
  it('keeps a flat list untouched when nothing is derived', () => {
    const rows = nestSessions([session('a'), session('b')])
    expect(ids(rows)).toEqual([
      ['a', 0],
      ['b', 0]
    ])
  })

  it('puts derived sessions right below their parent and indents one level', () => {
    // 输入顺序 = Recent 的时间序：子会话比父会话新，所以它本来排在前面。
    const rows = nestSessions([session('child', 'parent'), session('parent')])
    expect(ids(rows)).toEqual([
      ['parent', 0],
      ['child', 1]
    ])
  })

  it('nests a whole chain and reports the child count on the root', () => {
    const rows = nestSessions([session('r'), session('c1', 'r'), session('c2', 'c1')])
    expect(ids(rows)).toEqual([
      ['r', 0],
      ['c1', 1],
      ['c2', 2]
    ])
    expect(rows[0].childCount).toBe(1)
    expect(rows[1].childCount).toBe(1)
  })

  it('treats a session whose parent is missing from this list as top level', () => {
    // 父会话被删了、落在别的分区、或被 Recent 分页截掉，子会话都不能消失。
    const rows = nestSessions([session('child', 'gone'), session('other')])
    expect(ids(rows)).toEqual([
      ['child', 0],
      ['other', 0]
    ])
  })

  it('ignores a self-parent instead of looping', () => {
    const rows = nestSessions([session('a', 'a')])
    expect(ids(rows)).toEqual([['a', 0]])
  })

  it('renders every row exactly once even when parents form a cycle', () => {
    const rows = nestSessions([session('a', 'b'), session('b', 'a')])
    expect(rows.map((row) => row.session.id).sort()).toEqual(['a', 'b'])
  })

  it('hides the subtree of a collapsed session and reports it for the parent state', () => {
    const rows = nestSessions([session('r'), session('c', 'r'), session('g', 'c')], {
      collapsed: new Set(['r'])
    })
    expect(ids(rows)).toEqual([['r', 0]])
    expect(rows[0].collapsed).toBe(true)
    expect(rows[0].hidden.map((item) => item.id)).toEqual(['c', 'g'])
  })

  it('does not collapse a session that has no derived sessions', () => {
    const rows = nestSessions([session('lonely')], { collapsed: new Set(['lonely']) })
    expect(rows[0].collapsed).toBe(false)
  })
})
