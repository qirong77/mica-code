import { describe, expect, test } from 'bun:test'
import {
  contentPreview,
  contextBarSegments,
  contextItemSubtitle,
  contextItemTitle,
  contextTotalTokens,
  filterContextItems,
  formatShare,
  formatTokens,
  indexContextItems,
  kindMeta,
  sharePct,
  sortContextItems
} from './context-usage'

const context = {
  messageTokens: 18_000,
  lastInputTokens: 305_020,
  overheadTokens: 287_020,
  categories: [
    { kind: 'tool_result', count: 2, tokens: 900 },
    { kind: 'tool_call', count: 3, tokens: 17_000 },
    { kind: 'user', count: 1, tokens: 100 }
  ]
}

describe('context usage presentation', () => {
  test('keeps a fixed category order and appends the invisible overhead last', () => {
    expect(contextBarSegments(context)).toEqual([
      { key: 'user', label: '用户消息', tokens: 100, bar: 'bg-info' },
      { key: 'tool_call', label: '工具调用参数', tokens: 17_000, bar: 'bg-warn' },
      { key: 'tool_result', label: '工具结果', tokens: 900, bar: 'bg-success' },
      {
        key: 'overhead',
        label: '系统提示词 / 工具 schema / 未持久化项',
        tokens: 287_020,
        bar: 'bg-fg-ghost'
      }
    ])
    expect(contextBarSegments(null)).toEqual([])
  })

  test('falls back to the message estimate when no real request exists yet', () => {
    expect(contextTotalTokens(context)).toBe(305_020)
    expect(contextTotalTokens({ messageTokens: 1_200, lastInputTokens: 0 })).toBe(1_200)
    expect(contextTotalTokens(null)).toBe(0)
  })

  test('shares percentages against the same total the ctx badge uses', () => {
    expect(sharePct(17_000, 305_020)).toBe(5.6)
    expect(sharePct(1, 0)).toBe(0)
    expect(sharePct(500, 100)).toBe(100)
  })

  test('filters by kind and sorts by size without losing the original position', () => {
    const items = indexContextItems([
      { kind: 'tool_call', name: 'read_file', tokens: 10 },
      { kind: 'tool_result', name: null, tokens: 900 },
      { kind: 'tool_call', name: 'write_file', tokens: 1_900 }
    ])
    expect(items.map((item) => item.index)).toEqual([0, 1, 2])
    expect(sortContextItems(items, 'size').map((item) => item.name)).toEqual([
      'write_file',
      null,
      'read_file'
    ])
    expect(sortContextItems(items, 'order').map((item) => item.index)).toEqual([0, 1, 2])
    expect(filterContextItems(items, 'tool_call')).toHaveLength(2)
    expect(filterContextItems(items, 'all')).toHaveLength(3)
  })

  test('labels rows so the biggest consumer is readable at a glance', () => {
    expect(contextItemTitle({ kind: 'tool_call', name: 'write_file' })).toBe('write_file')
    expect(
      contextItemTitle({
        kind: 'tool_result',
        content: './packages/mica-context/CompactionService.ts:695\n  function …'
      })
    ).toBe('./packages/mica-context/CompactionService.ts:695 function …')
    expect(contextItemTitle({ kind: 'user' })).toBe('用户消息')
    expect(contextItemTitle(null)).toBe('—')
    expect(
      contextItemSubtitle({
        kind: 'tool_result',
        cleared: true,
        hasImage: true,
        toolCallId: 'call_00_NFO2H074qRFDaMTCNuxt3912'
      })
    ).toBe('已清理为占位符 · 含图片 · call_00_NFO2H074')
    expect(contextItemSubtitle({ kind: 'user', imageCount: 2 })).toBe('含 2 张图片（未计入估算）')
    expect(
      contextItemSubtitle({
        kind: 'tool_call',
        content: '{"command":"node scripts/build.mjs","cwd":"/tmp"}',
        toolCallId: 'call_00_abcdefghijklmnop'
      })
    ).toBe('{"command":"node scripts/build.mjs","cwd":"/tmp"… · call_00_abcdefgh')
  })

  test('formats token counts and unknown kinds with defaults', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(18_791)).toBe('18.8k')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    // 非零但极小：显示成 0% 会让人以为「没占」，所以给下限写法。
    expect(formatShare(21, 49_454)).toBe('<0.1%')
    expect(formatShare(7_548, 49_454)).toBe('15.3%')
    expect(formatShare(0, 49_454)).toBe('0%')
    expect(formatShare(10, 0)).toBe('0%')
    expect(contentPreview('a\n\n  b   c  ', 40)).toBe('a b c')
    expect(kindMeta('nope')).toBe(kindMeta('other'))
    expect(kindMeta('reasoning').bar).toBe('bg-purple')
  })
})
