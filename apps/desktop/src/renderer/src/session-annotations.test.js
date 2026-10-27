import { describe, expect, it } from 'vitest';
import {
  annotationBadges,
  annotationMenuItems,
  hiddenBadgeCount,
  parseAnnotationAction,
  toggleTarget,
  visibleBadges
} from './session-annotations'

const providers = [
  {
    pluginId: 'session-tags',
    name: 'Session Tags',
    options: [
      { id: 'red', label: '阻塞', color: '#FF3B30' },
      { id: 'blue', label: '参考', color: '#007AFF' },
      { id: 'gray', label: '', color: '#8E8E93' }
    ],
    assignments: { s1: ['red', 'blue'], s2: ['gray'] }
  },
  {
    pluginId: 'empty',
    name: 'Empty',
    options: [],
    assignments: { s1: ['x'] }
  }
]

describe('annotationBadges', () => {
  it('按插件与选项顺序摊平，跳过没有 options 的插件', () => {
    expect(annotationBadges(providers, 's1')).toEqual([
      { key: 'session-tags:red', label: '阻塞', color: '#FF3B30', providerName: 'Session Tags' },
      { key: 'session-tags:blue', label: '参考', color: '#007AFF', providerName: 'Session Tags' }
    ])
  })

  it('空名字退回 id；没有会话或没有归属时是空数组', () => {
    expect(annotationBadges(providers, 's2')[0]).toMatchObject({
      key: 'session-tags:gray',
      label: 'gray'
    })
    expect(annotationBadges(providers, 'nope')).toEqual([])
    expect(annotationBadges(providers, null)).toEqual([])
    expect(annotationBadges(undefined, 's1')).toEqual([])
  })

  it('行内最多显示 3 个点，其余折成计数', () => {
    const many = [
      {
        pluginId: 'p',
        options: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, label: id, color: '#111111' })),
        assignments: { s1: ['a', 'b', 'c', 'd', 'e'] }
      }
    ]
    const badges = annotationBadges(many, 's1')
    expect(visibleBadges(badges)).toHaveLength(3)
    expect(hiddenBadgeCount(badges)).toBe(2)
    expect(hiddenBadgeCount(annotationBadges(providers, 's1'))).toBe(0)
  })
})

describe('annotationMenuItems', () => {
  it('每个选项一项，带上颜色与是否已挂', () => {
    const items = annotationMenuItems(providers, 's1')
    expect(items).toHaveLength(3)
    expect(items[0]).toEqual({
      action: 'annotation:session-tags:red',
      label: '阻塞',
      dot: '#FF3B30',
      checked: true
    })
    expect(items[2]).toMatchObject({ label: 'gray', checked: false })
  })

  it('草稿（没有 sessionId）没有标记项', () => {
    expect(annotationMenuItems(providers, null)).toEqual([])
  })
})

describe('parseAnnotationAction', () => {
  it('拆出 pluginId 与 optionId，其它动作返回 null', () => {
    expect(parseAnnotationAction('annotation:session-tags:red')).toEqual({
      pluginId: 'session-tags',
      optionId: 'red'
    })
    expect(parseAnnotationAction('pin')).toBeNull()
    expect(parseAnnotationAction('annotation:only-plugin')).toBeNull()
    expect(parseAnnotationAction(undefined)).toBeNull()
  })
})

describe('toggleTarget', () => {
  it('已挂上的改成去掉，没挂的改成加上', () => {
    expect(toggleTarget(providers, 's1', { pluginId: 'session-tags', optionId: 'red' })).toEqual({
      pluginId: 'session-tags',
      optionId: 'red',
      on: false
    })
    expect(toggleTarget(providers, 's1', { pluginId: 'session-tags', optionId: 'gray' })).toEqual({
      pluginId: 'session-tags',
      optionId: 'gray',
      on: true
    })
    expect(toggleTarget(undefined, 's1', { pluginId: 'x', optionId: 'y' })).toEqual({
      pluginId: 'x',
      optionId: 'y',
      on: true
    })
  })
})
