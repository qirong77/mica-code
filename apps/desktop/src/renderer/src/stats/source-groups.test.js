import { describe, expect, test } from 'bun:test'
import { flattenSourceRows, sourceDetail, sourceTitle } from './source-groups.js'

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
  test('名称是别名时带上来源类型、原始 id 与会话数', () => {
    const plugin = row({ kind: 'plugin', id: 'session-rename', sessions: 3, purposes: ['起标题'] })
    expect(sourceDetail(plugin, 'Auto Session Rename')).toBe(
      '插件 · session-rename · 3 sessions · 起标题'
    )
  })

  test('主对话不重复报 id；委派只报任务数', () => {
    expect(sourceDetail(row({ sessions: 2 }), '主对话')).toBe('2 sessions')
    expect(
      sourceDetail(
        row({ kind: 'delegation', id: 'Implementer', sessions: 1, tasks: 4, purposes: ['a'] }),
        'Implementer'
      )
    ).toBe('委派 · 1 session · 4 tasks')
  })

  test('用途超过两条时收尾成 +n', () => {
    const plugin = row({ kind: 'plugin', id: 'p', purposes: ['a', 'b', 'c'] })
    expect(sourceDetail(plugin, 'p')).toBe('插件 · a / b +1')
  })
})

describe('flattenSourceRows', () => {
  test('摊平成一张表，按 token 降序，占比相对全体', () => {
    const { total, rows } = flattenSourceRows(
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
    // 同额（50 tokens）时按 id 兜底排序，顺序稳定：Implementer 在 memory 之前。
    expect(rows.map((r) => r.title)).toEqual([
      '主对话',
      'Auto Session Rename',
      '上下文压缩',
      'Implementer',
      'memory'
    ])
    expect(rows[0].share).toBeCloseTo(0.6)
    expect(rows[1].kindLabel).toBe('插件')
    expect(rows[2].kindLabel).toBe('内核')
    expect(rows[3].kindLabel).toBe('委派')
    expect(rows[0].color).toBeTruthy()
  })

  test('同一个功能的插件与内核两条紧挨着，不会被分组拆开', () => {
    const { rows } = flattenSourceRows(
      [
        row({ kind: 'main', id: 'main', key: 'main:main', totalTokens: 5000 }),
        row({
          kind: 'plugin',
          id: 'auto-compact',
          key: 'plugin:auto-compact',
          totalTokens: 300
        }),
        row({ kind: 'helper', id: 'auto-compact', key: 'helper:auto-compact', totalTokens: 290 })
      ],
      { pluginNames: new Map([['auto-compact', 'Auto Compact']]) }
    )
    expect(rows.map((r) => r.title)).toEqual(['主对话', 'Auto Compact', '上下文压缩'])
    expect(rows.map((r) => r.kindLabel)).toEqual(['主对话', '插件', '内核'])
  })

  test('未知来源原样显示，不会被丢掉', () => {
    const { rows } = flattenSourceRows([row({ kind: 'mystery', id: 'y', key: 'mystery:y' })])
    expect(rows[0].title).toBe('y')
    expect(rows[0].kindLabel).toBe('mystery')
  })

  test('没有任何行时给出空结果', () => {
    expect(flattenSourceRows([])).toEqual({ total: 0, rows: [] })
  })
})
