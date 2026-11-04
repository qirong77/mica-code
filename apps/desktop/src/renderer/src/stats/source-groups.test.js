import { describe, expect, test } from 'bun:test'
import {
  SOURCE_KIND_HINTS,
  SOURCE_KIND_LABELS,
  flattenSourceRows,
  normalizeSourceId,
  sourceDetail,
  sourceRowKey,
  sourceTitle
} from './source-groups.js'

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
const pluginDescriptions = new Map([
  ['session-rename', '每轮开始前把最近的对话交给另一个模型起标题。'],
  ['auto-compact', '历史超过阈值时先本地清理、再模型摘要。']
])

describe('sourceTitle', () => {
  test('主对话用中文名，插件用清单里的名字', () => {
    expect(sourceTitle(row(), pluginNames)).toBe('主对话')
    expect(
      sourceTitle(
        row({ kind: 'plugin', id: 'session-rename', key: 'plugin:session-rename' }),
        pluginNames
      )
    ).toBe('Auto Session Rename')
  })

  test('子代理行写明是子代理，并翻译已登记的类型', () => {
    expect(sourceTitle(row({ kind: 'delegation', id: 'Implementer' }))).toBe('子代理 · 实现')
    expect(sourceTitle(row({ kind: 'delegation', id: 'Explore' }))).toBe('子代理 · 探索')
    // 没登记的类型原样显示，不猜归属。
    expect(sourceTitle(row({ kind: 'delegation', id: 'custom-type' }))).toBe('子代理 · custom-type')
    expect(sourceTitle(row({ kind: 'delegation', id: 'delegation' }))).toBe('子代理')
  })

  test('插件已卸载时退回 id；内核兜底用中文功能名并标出兜底', () => {
    expect(sourceTitle(row({ kind: 'plugin', id: 'gone', key: 'plugin:gone' }), pluginNames)).toBe(
      'gone'
    )
    expect(
      sourceTitle(row({ kind: 'helper', id: 'auto-compact', key: 'helper:auto-compact' }))
    ).toBe('上下文压缩（内核兜底）')
    expect(sourceTitle(row({ kind: 'helper', id: 'memory-curator' }))).toBe('记忆整理（内核兜底）')
    expect(sourceTitle(row({ kind: 'helper', id: 'unknown-helper' }))).toBe('unknown-helper')
  })
})

describe('sourceDetail', () => {
  test('插件行给出 id、会话数与清单描述', () => {
    const plugin = row({ kind: 'plugin', id: 'session-rename', sessions: 3 })
    expect(sourceDetail(plugin, 'Auto Session Rename', pluginDescriptions)).toBe(
      'session-rename · 3 sessions · 每轮开始前把最近的对话交给另一个模型起标题。'
    )
  })

  test('插件描述过长时截断', () => {
    const long = new Map([['p', 'x'.repeat(80)]])
    const detail = sourceDetail(row({ kind: 'plugin', id: 'p' }), 'p', long)
    expect(detail.endsWith('…')).toBe(true)
    expect(detail.length).toBeLessThan(50)
  })

  test('主对话只报会话数；子代理说明是 agent 工具派的', () => {
    expect(sourceDetail(row({ sessions: 2 }), '主对话')).toBe('2 sessions')
    expect(
      sourceDetail(
        row({ kind: 'delegation', id: 'Implementer', sessions: 1, tasks: 4, purposes: ['a'] }),
        '子代理 · 实现'
      )
    ).toBe('经 agent 工具派出 · 4 tasks')
  })

  test('内核兜底行给出原始 id 与用途', () => {
    expect(
      sourceDetail(
        row({ kind: 'helper', id: 'compact', sessions: 2, purposes: ['压缩摘要'] }),
        '上下文压缩（内核兜底）'
      )
    ).toBe('2 sessions · 压缩摘要')
  })

  test('多个用途收尾成 +n', () => {
    expect(
      sourceDetail(
        row({ kind: 'helper', id: 'btw', purposes: ['a', 'b', 'c'] }),
        '旁问（内核兜底）'
      )
    ).toBe('a +2')
  })
})

describe('sourceRowKey', () => {
  test('内核压缩的两种历史写法归到同一功能键', () => {
    expect(sourceRowKey({ kind: 'helper', id: 'compact' })).toBe('helper:compaction')
    expect(sourceRowKey({ kind: 'helper', id: 'auto-compact' })).toBe('helper:compaction')
    expect(sourceRowKey({ kind: 'helper', id: 'memory-curator' })).toBe('helper:memory')
    expect(normalizeSourceId('helper', 'auto-compact')).toBe('compaction')
  })

  test('其它来源按自己的 id 分行，不同子代理类型不合并', () => {
    expect(sourceRowKey({ kind: 'plugin', id: 'auto-compact' })).toBe('plugin:auto-compact')
    expect(sourceRowKey({ kind: 'delegation', id: 'Explore' })).toBe('delegation:Explore')
    expect(sourceRowKey({ kind: 'delegation', id: 'Implementer' })).toBe('delegation:Implementer')
    expect(normalizeSourceId('plugin', 'auto-compact')).toBe('auto-compact')
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
      { pluginNames, pluginDescriptions }
    )

    expect(total).toBe(1000)
    // 同额（50 tokens）时按 id 兜底排序，顺序稳定：Implementer 在 memory 之前。
    expect(rows.map((r) => r.title)).toEqual([
      '主对话',
      'Auto Session Rename',
      '上下文压缩（内核兜底）',
      '子代理 · 实现',
      'memory'
    ])
    expect(rows[0].share).toBeCloseTo(0.6)
    expect(rows[1].kindLabel).toBe('插件')
    expect(rows[2].kindLabel).toBe('内核后台')
    expect(rows[3].kindLabel).toBe('子代理')
    expect(rows[0].color).toBeTruthy()
    expect(rows[0].kindHint).toBe(SOURCE_KIND_HINTS.main)
  })

  test('同一个功能的插件与内核两条紧挨着，名称能对上', () => {
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
      {
        pluginNames: new Map([['auto-compact', 'Auto Compact']]),
        pluginDescriptions
      }
    )
    expect(rows.map((r) => r.title)).toEqual(['主对话', 'Auto Compact', '上下文压缩（内核兜底）'])
    expect(rows.map((r) => r.kindLabel)).toEqual(['主对话', '插件', '内核后台'])
  })

  test('四类来源都有标签与说明，未知来源原样显示', () => {
    for (const kind of ['main', 'delegation', 'plugin', 'helper']) {
      expect(SOURCE_KIND_LABELS[kind]).toBeTruthy()
      expect(SOURCE_KIND_HINTS[kind]).toBeTruthy()
    }
    const { rows } = flattenSourceRows([row({ kind: 'mystery', id: 'y', key: 'mystery:y' })])
    expect(rows[0].title).toBe('y')
    expect(rows[0].kindLabel).toBe('mystery')
  })

  test('没有任何行时给出空结果', () => {
    expect(flattenSourceRows([])).toEqual({ total: 0, rows: [] })
  })
})
