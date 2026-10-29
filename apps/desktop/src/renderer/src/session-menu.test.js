import { describe, expect, it } from 'bun:test'
import { draftMenuItems, sessionMenuItems, withExtraMenuItems } from './session-menu'

describe('sessionMenuItems', () => {
  it('always offers 删除对话 as a danger action', () => {
    const items = sessionMenuItems({ pinned: false, inProject: false })
    expect(items.at(-1)).toEqual(['delete', '删除对话', true])
    expect(items.map((item) => (item === 'separator' ? item : item[0]))).toEqual([
      'pin',
      'detail',
      'share',
      'rename',
      'separator',
      'delete'
    ])
  })

  it('reflects the pin state and the project assignment', () => {
    const items = sessionMenuItems({ pinned: true, inProject: true })
    expect(items.map((item) => (item === 'separator' ? item : item[0]))).toEqual([
      'unpin',
      'unassign',
      'detail',
      'share',
      'rename',
      'separator',
      'delete'
    ])
    expect(items[0]).toEqual(['unpin', '取消置顶'])
    expect(items[1]).toEqual(['unassign', '移出项目分组'])
  })

  it('offers 查看详情 for the real session', () => {
    const items = sessionMenuItems({ pinned: false, inProject: false })
    expect(items).toContainEqual(['detail', '查看详情'])
  })

  it('offers 分享链接 for the real session', () => {
    const items = sessionMenuItems({ pinned: false, inProject: false })
    expect(items).toContainEqual(['share', '分享链接'])
  })
})

describe('draftMenuItems', () => {
  it('keeps rename and delete only', () => {
    expect(draftMenuItems()).toEqual([
      ['rename', '重命名'],
      'separator',
      ['delete', '删除对话', true]
    ])
  })
})

describe('withExtraMenuItems', () => {
  // 数组项是 [action, label, danger?]；插件项是对象（和会话标记一样带 label）。
  const labels = (items) =>
    items.map((item) => (item === 'separator' ? '---' : Array.isArray(item) ? item[1] : item.label))

  it('puts plugin items right before the danger action, never after it', () => {
    const items = withExtraMenuItems(sessionMenuItems({ pinned: false, inProject: false }), [
      { action: 'session-menu:session-copy:copy', label: '复制会话 Markdown' }
    ])
    expect(labels(items)).toEqual([
      '置顶',
      '查看详情',
      '分享链接',
      '重命名',
      '---',
      '复制会话 Markdown',
      '---',
      '删除对话'
    ])
  })

  it('keeps the menu untouched when nothing extra is offered', () => {
    const base = sessionMenuItems({ pinned: false, inProject: false })
    expect(withExtraMenuItems(base, [])).toBe(base)
  })

  it('appends after a trailing separator when there is no danger action', () => {
    const items = withExtraMenuItems([['rename', '重命名'], 'separator'], [['x', '插件动作']])
    expect(labels(items)).toEqual(['重命名', '---', '插件动作'])
  })
})
