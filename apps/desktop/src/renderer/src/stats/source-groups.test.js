import { describe, expect, test } from 'bun:test'
import {
  SOURCE_KIND_HINTS,
  SOURCE_KIND_LABELS,
  flattenSourceRows,
  sourceDetail,
  sourceGroupOf,
  sourceRowKey,
  sourceTitle
} from './source-groups.js'

function row(overrides = {}) {
  return {
    key: 'main:main',
    kind: 'main',
    id: 'main',
    pluginId: null,
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

const pluginNames = new Map([
  ['session-rename', 'Auto Session Rename'],
  ['subagent', 'Subagent'],
  ['btw', 'By The Way'],
  ['memory', 'Memory']
])
const pluginDescriptions = new Map([
  ['session-rename', '每轮开始前把最近的对话交给另一个模型起标题。'],
  ['session-compact', '右键会话手动压缩：工具结果换占位符，或把对话交给模型写摘要。']
])

describe('sourceTitle', () => {
  test('插件用清单里的名字，主对话用类别名', () => {
    expect(sourceTitle(row(), pluginNames)).toBe('主对话')
    expect(sourceTitle(row({ kind: 'plugin', id: 'session-rename' }), pluginNames)).toBe(
      'Auto Session Rename'
    )
  })

  test('子代理类型与后台功能名原样显示，不翻译', () => {
    expect(sourceTitle(row({ kind: 'delegation', id: 'Implementer' }), pluginNames)).toBe(
      'Implementer'
    )
    expect(sourceTitle(row({ kind: 'delegation', id: 'general-purpose' }), pluginNames)).toBe(
      'general-purpose'
    )
    expect(sourceTitle(row({ kind: 'helper', id: 'btw' }), pluginNames)).toBe('By The Way')
    expect(sourceTitle(row({ kind: 'helper', id: 'compact' }), pluginNames)).toBe('compact')
  })

  test('插件已卸载时退回 id', () => {
    expect(sourceTitle(row({ kind: 'plugin', id: 'gone' }), pluginNames)).toBe('gone')
  })
})

describe('sourceDetail', () => {
  test('插件行给出 id、会话数与清单描述', () => {
    expect(
      sourceDetail(row({ kind: 'plugin', id: 'session-rename', sessions: 3, purposes: [] }))
    ).toBe('3 sessions')
  })

  test('主对话只报会话数；子代理说明是 agent 工具派的', () => {
    expect(sourceDetail(row({ sessions: 2 }))).toBe('2 sessions')
    expect(
      sourceDetail(row({ kind: 'delegation', id: 'Implementer', sessions: 1, tasks: 4 }))
    ).toBe('经 agent 工具派出 · 4 tasks')
  })

  test('后台行给出会话数与用途，多个用途收尾成 +n', () => {
    expect(sourceDetail(row({ kind: 'helper', id: 'compact', sessions: 2, purposes: ['压缩摘要'] }))).toBe(
      '2 sessions · 压缩摘要'
    )
    expect(sourceDetail(row({ kind: 'helper', id: 'btw', purposes: ['a', 'b', 'c'] }))).toBe('a +2')
  })
})

describe('sourceRowKey', () => {
  test('不同来源按自己的 id 分行', () => {
    expect(sourceRowKey({ kind: 'plugin', id: 'session-compact' })).toBe('plugin:session-compact')
    expect(sourceRowKey({ kind: 'delegation', id: 'Explore' })).toBe('delegation:Explore')
    expect(sourceRowKey({ kind: 'delegation', id: 'Implementer' })).toBe('delegation:Implementer')
    expect(sourceRowKey({ kind: 'helper', id: 'compact' })).toBe('helper:compact')
  })
})

describe('sourceGroupOf', () => {
  test('子代理与插件后台请求挂在发起它的插件下', () => {
    expect(
      sourceGroupOf(row({ kind: 'delegation', id: 'Explore', pluginId: 'subagent' }), pluginNames)
    ).toEqual({
      key: 'plugin:subagent',
      title: 'Subagent',
      pluginId: 'subagent',
      kind: 'plugin',
      selfId: 'subagent'
    })
    expect(sourceGroupOf(row({ kind: 'plugin', id: 'session-rename' }), pluginNames).key).toBe(
      'plugin:session-rename'
    )
  })

  test('插件的后台功能挂到自己名下（btw → By The Way）', () => {
    expect(sourceGroupOf(row({ kind: 'helper', id: 'btw', pluginId: 'btw' }), pluginNames)).toEqual({
      key: 'plugin:btw',
      title: 'By The Way',
      pluginId: 'btw',
      kind: 'plugin',
      selfId: 'btw'
    })
  })

  test('主对话自成一组；内核命令按功能 id 成组', () => {
    expect(sourceGroupOf(row(), pluginNames).key).toBe('main')
    expect(sourceGroupOf(row({ kind: 'helper', id: 'compact' }), pluginNames)).toEqual({
      key: 'core:compact',
      title: 'compact',
      pluginId: null,
      kind: 'helper',
      selfId: 'compact'
    })
  })
})

describe('flattenSourceRows', () => {
  const rows = [
    row({ kind: 'main', id: 'main', totalTokens: 600, sessions: 2 }),
    row({ kind: 'plugin', id: 'session-rename', totalTokens: 200, sessions: 2 }),
    row({
      kind: 'delegation',
      id: 'Implementer',
      pluginId: 'subagent',
      totalTokens: 150,
      tasks: 3
    }),
    row({ kind: 'delegation', id: 'Explore', pluginId: 'subagent', totalTokens: 50, tasks: 1 }),
    row({ kind: 'helper', id: 'btw', pluginId: 'btw', totalTokens: 80, sessions: 1 }),
    row({ kind: 'helper', id: 'compact', totalTokens: 100 })
  ]

  test('父行是插件，子项缩进挂在它后面', () => {
    const { rows: flat } = flattenSourceRows(rows, { pluginNames, pluginDescriptions })
    expect(flat.map((r) => `${r.depth}:${r.title}`)).toEqual([
      '0:主对话',
      // 插件的自身请求与同名后台功能并进父行，不再单列。
      '0:Auto Session Rename',
      '0:Subagent',
      '1:Implementer',
      '1:Explore',
      '0:By The Way',
      '0:compact'
    ])
    expect(flat[2].childCount).toBe(2)
    expect(flat[3].isGroup).toBe(false)
    expect(flat[5].title).toBe('By The Way')
    // btw 只有一条自身请求，不占子行。
    expect(flat[5].childCount).toBe(0)
    expect(flat[6].isGroup).toBe(true)
  })

  test('父行数字是整组合计，总量不重复计数', () => {
    const { total, rows: flat, groups } = flattenSourceRows(rows, {
      pluginNames,
      pluginDescriptions
    })
    expect(total).toBe(1180)
    expect(groups).toBe(5)
    const parents = flat.filter((r) => r.isGroup)
    // 父行相加就是总量：子项已经并进父行，展开时不重复。
    expect(parents.reduce((sum, r) => sum + r.totalTokens, 0)).toBe(total)
    const subagent = parents.find((r) => r.title === 'Subagent')
    expect(subagent.totalTokens).toBe(200)
    expect(subagent.detail).toContain('2 个子项')
  })

  test('组间顺序是主对话 → 插件按总量 → 内核', () => {
    const { rows: flat } = flattenSourceRows(rows, { pluginNames, pluginDescriptions })
    const parents = flat.filter((r) => r.isGroup)
    expect(parents.map((r) => r.title)).toEqual([
      '主对话',
      'Auto Session Rename',
      'Subagent',
      'By The Way',
      'compact'
    ])
    // 内核组的类型标签不叫「内核后台」，避免和标题重复。
    expect(parents[parents.length - 1].kindLabel).toBe('内核')
    expect(parents[parents.length - 1].detail).toBe('内建命令')
  })

  test('指标排序只影响组内子项', () => {
    const { rows: flat } = flattenSourceRows(rows, {
      pluginNames,
      pluginDescriptions,
      sort: { key: 'requests', desc: false }
    })
    const children = flat.filter((r) => r.depth === 1)
    expect(children.map((r) => r.title)).toEqual(['Explore', 'Implementer'])
  })

  test('插件自身没有请求时（只有子代理）父行仍从清单取名字', () => {
    const { rows: flat } = flattenSourceRows(
      [row({ kind: 'delegation', id: 'Explore', pluginId: 'subagent', totalTokens: 10 })],
      { pluginNames }
    )
    expect(flat[0].title).toBe('Subagent')
    expect(flat[0].kindLabel).toBe('插件')
    // 清单里的显示名与记账 id 不同时副标题带上 id，两者才对得上。
    expect(flat[0].detail).toBe('subagent · 1 个子项')
  })

  test('四类来源都有标签与说明，未知来源原样显示', () => {
    for (const kind of ['main', 'delegation', 'plugin', 'helper']) {
      expect(SOURCE_KIND_LABELS[kind]).toBeTruthy()
      expect(SOURCE_KIND_HINTS[kind]).toBeTruthy()
    }
    const { rows: flat } = flattenSourceRows([row({ kind: 'mystery', id: 'y' })])
    // 未知来源没有插件可归属，按功能 id 自成一组；它自己并进父行，只有头顶那一行。
    expect(flat[0].title).toBe('y')
    expect(flat[0].kindLabel).toBe('内核')
    expect(flat).toHaveLength(1)
  })

  test('没有任何行时给出空结果', () => {
    expect(flattenSourceRows([])).toEqual({ total: 0, rows: [], groups: 0 })
  })
})
