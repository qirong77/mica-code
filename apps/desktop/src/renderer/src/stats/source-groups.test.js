import { describe, expect, test } from 'bun:test'
import { groupSourceRows, sourceDetail, sourceTitle } from './source-groups.js'

function row(overrides = {}) {
  return {
    key: 'main:main',
    kind: 'main',
    id: 'main',
    sessions: 0,
    tasks: 0,
    purposes: [],
    requests: 1,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    ...overrides
  }
}

const pluginNames = new Map([['session-rename', 'Auto Session Rename']])

describe('sourceTitle', () => {
  test('主对话与插件清单里的名字', () => {
    expect(sourceTitle(row(), pluginNames)).toBe('主对话')
    expect(
      sourceTitle(
        row({ kind: 'plugin', id: 'session-rename', key: 'plugin:session-rename' }),
        pluginNames
      )
    ).toBe('Auto Session Rename')
  })

  test('插件已卸载时退回 id，内核 helper 用中文名', () => {
    expect(sourceTitle(row({ kind: 'plugin', id: 'gone', key: 'plugin:gone' }), pluginNames)).toBe(
      'gone'
    )
    expect(
      sourceTitle(row({ kind: 'helper', id: 'auto-compact', key: 'helper:auto-compact' }))
    ).toBe('上下文压缩')
    expect(sourceTitle(row({ kind: 'helper', id: 'unknown-helper' }))).toBe('unknown-helper')
    expect(sourceTitle(row({ kind: 'delegation', id: 'Implementer' }))).toBe('Implementer')
  })
})

describe('sourceDetail', () => {
  test('名称是别名时带上原始 id 与会话数', () => {
    const plugin = row({ kind: 'plugin', id: 'session-rename', sessions: 3, purposes: ['起标题'] })
    expect(sourceDetail(plugin, 'Auto Session Rename')).toBe('session-rename · 3 sessions · 起标题')
  })

  test('主对话不重复报 id；委派只报任务数', () => {
    expect(sourceDetail(row({ sessions: 2 }), '主对话')).toBe('2 sessions')
    expect(
      sourceDetail(
        row({ kind: 'delegation', id: 'Implementer', sessions: 1, tasks: 4, purposes: ['a'] }),
        'Implementer'
      )
    ).toBe('1 session · 4 tasks')
  })

  test('用途超过两条时收尾成 +n', () => {
    const plugin = row({ kind: 'plugin', id: 'p', purposes: ['a', 'b', 'c'] })
    expect(sourceDetail(plugin, 'p')).toBe('a / b +1')
  })
})

describe('groupSourceRows', () => {
  test('按主 APP / 插件 / 委派分组，组内按 token 排、组占比相对全体', () => {
    const { total, groups } = groupSourceRows(
      [
        row({ kind: 'main', id: 'main', key: 'main:main', totalTokens: 600 }),
        row({ kind: 'helper', id: 'compact', key: 'helper:compact', totalTokens: 100 }),
        row({
          kind: 'plugin',
          id: 'session-rename',
          key: 'plugin:session-rename',
          totalTokens: 200,
          sessions: 2
        }),
        row({ kind: 'plugin', id: 'memory', key: 'plugin:memory', totalTokens: 50 }),
        row({
          kind: 'delegation',
          id: 'Implementer',
          key: 'delegation:Implementer',
          totalTokens: 50
        })
      ],
      { pluginNames }
    )

    expect(total).toBe(1000)
    expect(groups.map((group) => group.label)).toEqual(['主 APP', '插件', '委派子代理'])
    expect(groups.map((group) => group.rows.length)).toEqual([2, 2, 1])
    expect(groups.map((group) => group.tokens)).toEqual([700, 250, 50])
    expect(groups[1].rows.map((r) => r.title)).toEqual(['Auto Session Rename', 'memory'])
    expect(groups[0].rows.map((r) => r.title)).toEqual(['主对话', '上下文压缩'])
    expect(groups[0].share).toBeCloseTo(0.7)
    expect(groups[0].rows[1].color).toBeTruthy()
  })

  test('空组与未知来源', () => {
    const { groups } = groupSourceRows([row({ kind: 'plugin', id: 'x', key: 'plugin:x' })])
    expect(groups.map((group) => group.key)).toEqual(['plugin'])
    const unknown = groupSourceRows([row({ kind: 'mystery', id: 'y', key: 'mystery:y' })])
    expect(unknown.groups.map((group) => group.key)).toEqual(['other'])
    expect(unknown.groups[0].rows[0].title).toBe('y')
  })

  test('没有任何行时给出空结果', () => {
    expect(groupSourceRows([])).toEqual({ total: 0, groups: [] })
  })
})
