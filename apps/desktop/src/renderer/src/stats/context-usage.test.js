import { describe, expect, test } from 'bun:test'
import {
  bodyOverInputNote,
  contentPreview,
  contextBarSegments,
  contextItemSubtitle,
  contextItemTitle,
  contextTotalTokens,
  filterContextItems,
  formatShare,
  formatTimestamp,
  formatTokens,
  indexContextItems,
  kindMeta,
  overheadNote,
  sharePct,
  staleReferenceNote,
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
        label: '系统提示词 / 工具 schema / 其它差额',
        tokens: 287_020,
        bar: 'bg-fg-ghost'
      }
    ])
    expect(contextBarSegments(null)).toEqual([])
  })

  test('shows the message envelope as its own segment, not as request overhead', () => {
    const segments = contextBarSegments({
      messageTokens: 3_000,
      lastInputTokens: 0,
      overheadTokens: 0,
      categories: [
        { kind: 'tool_call', count: 4, tokens: 2_000 },
        { kind: 'envelope', count: 9, tokens: 1_000 }
      ]
    })
    expect(segments).toEqual([
      { key: 'tool_call', label: '工具调用参数', tokens: 2_000, bar: 'bg-warn' },
      { key: 'envelope', label: '消息结构（信封）', tokens: 1_000, bar: 'bg-fg-faint' }
    ])
  })

  test('falls back to the message estimate when no real request exists yet', () => {
    expect(contextTotalTokens(context)).toBe(305_020)
    expect(contextTotalTokens({ messageTokens: 1_200, lastInputTokens: 0 })).toBe(1_200)
    expect(contextTotalTokens(null)).toBe(0)
  })

  test('explains a compact-invalidated request input instead of showing it as a share', () => {
    // 快照被压缩过：lastInputTokens 归零，占比退回消息体口径。
    const compacted = {
      messageTokens: 79_318,
      lastInputTokens: 0,
      staleInput: {
        inputTokens: 178_444,
        reason: 'compacted',
        compactedAt: '2026-09-21T03:46:16.382Z',
        compactedTokens: 91_464
      },
      overheadTokens: 0,
      categories: [{ kind: 'tool_call', count: 627, tokens: 26_783 }]
    }
    expect(contextTotalTokens(compacted)).toBe(79_318)
    expect(contextBarSegments(compacted)).toEqual([
      { key: 'tool_call', label: '工具调用参数', tokens: 26_783, bar: 'bg-warn' }
    ])
    expect(staleReferenceNote(compacted)).toContain('178,444')
    expect(staleReferenceNote(compacted)).toContain(formatTimestamp('2026-09-21T03:46:16.382Z'))
    // 请求之后被裁剪过的会话：说明里要写清「请求时 N 条 → 现在 M 条」。
    const truncated = {
      messageTokens: 12_152,
      lastInputTokens: 0,
      staleInput: {
        inputTokens: 187_896,
        reason: 'truncated',
        recordedMessages: 389,
        currentMessages: 298
      },
      overheadTokens: 0,
      categories: []
    }
    expect(staleReferenceNote(truncated)).toContain('389 条消息，现在 298 条')
    expect(staleReferenceNote(truncated)).toContain('187,896')
    // 没有作废值时不插话，界面保持干净。
    expect(staleReferenceNote(context)).toBe('')
    expect(staleReferenceNote(null)).toBe('')
    expect(formatTimestamp('not-a-date')).toBe('')
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
    expect(contextItemSubtitle({ kind: 'tool_result', hasImage: true, mediaCount: 1 })).toBe(
      '含图片 · 含 1 个文档/文件（未计入估算）'
    )
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

  test('never lets the shares exceed 100% when the body outgrows the request input', () => {
    // 请求之后又追加了消息（或 chars/4 与真实 tokenize 有差）：input 不能再当分母。
    const grew = { messageTokens: 60_000, lastInputTokens: 58_407, categories: [] }
    expect(contextTotalTokens(grew)).toBe(60_000)
    expect(bodyOverInputNote(grew)).toContain('58,407')
    expect(bodyOverInputNote(grew)).toContain('60.0k')
    // 正常情况（input 仍然更大）不插话。
    expect(contextTotalTokens(context)).toBe(305_020)
    expect(bodyOverInputNote(context)).toBe('')
    expect(bodyOverInputNote({ messageTokens: 60_000, lastInputTokens: 0 })).toBe('')
    expect(bodyOverInputNote(null)).toBe('')
  })

  test('flags an overhead gap that outgrows the session fixed-overhead bound', () => {
    // 差额 103k > 消息体 23.3k + 最小请求 input 31.9k：固定开销 + 估算差都解释不了。
    const big = { overheadTokens: 103_211, messageTokens: 23_322, fixedOverheadTokens: 31_939 }
    expect(overheadNote(big)).toContain('103.2k')
    expect(overheadNote(big)).toContain('31,939')
    // 差额还在「固定开销 + 消息体口径差」能解释的范围内：不加解释。
    expect(
      overheadNote({ overheadTokens: 7_386, messageTokens: 447, fixedOverheadTokens: 12_000 })
    ).toBe('')
    expect(
      overheadNote({ overheadTokens: 0, messageTokens: 1_000, fixedOverheadTokens: 12_000 })
    ).toBe('')
    expect(
      overheadNote({ overheadTokens: 5_000, messageTokens: 1_000, fixedOverheadTokens: 0 })
    ).toBe('')
    expect(overheadNote(null)).toBe('')
  })
})
