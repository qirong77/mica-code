import { describe, expect, it } from 'bun:test'
import { draftMenuItems, sessionMenuItems } from './session-menu'

describe('sessionMenuItems', () => {
  it('always offers 删除对话 as a danger action', () => {
    const items = sessionMenuItems({ pinned: false, inProject: false })
    expect(items.at(-1)).toEqual(['delete', '删除对话', true])
    expect(items.map((item) => (item === 'separator' ? item : item[0]))).toEqual([
      'pin',
      'detail',
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
