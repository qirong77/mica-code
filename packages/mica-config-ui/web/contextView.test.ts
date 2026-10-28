import { describe, expect, it } from 'vitest';
import {
  contextBarSegments,
  contextItemSubtitle,
  contextItemTitle,
  contextTotalTokens,
  filterContextItems,
  formatShare,
  formatTokens,
  sortContextItems,
  staleReferenceNote,
} from './contextView.js';
import type { ConfigWebContextAnalysis, ConfigWebContextItem } from '../src/shared/types.js';

function analysis(overrides: Partial<ConfigWebContextAnalysis> = {}): ConfigWebContextAnalysis {
  return {
    providerId: 'openai',
    model: 'gpt-5',
    imageCount: 0,
    turnCount: 1,
    totals: { conversationTokens: 0, toolTokens: 0, thinkingTokens: 0, totalTokens: 0 },
    turns: [],
    messageChars: 400,
    messageTokens: 100,
    clearedResults: 0,
    categories: [
      { kind: 'tool_result', count: 2, chars: 240, tokens: 60 },
      { kind: 'user', count: 1, chars: 160, tokens: 40 },
    ],
    items: [],
    lastInputTokens: 0,
    staleInput: null,
    fixedOverheadTokens: 0,
    overheadTokens: 0,
    ...overrides,
  };
}

function item(overrides: Partial<ConfigWebContextItem> = {}): ConfigWebContextItem {
  return {
    sequence: 1,
    kind: 'user',
    chars: 40,
    tokens: 10,
    parts: { user: 40 },
    content: 'hello there',
    ...overrides,
  };
}

describe('contextTotalTokens', () => {
  it('uses the real request input as the denominator when it is still valid', () => {
    expect(contextTotalTokens(analysis({ lastInputTokens: 400 }))).toBe(400);
  });

  it('falls back to the message estimate when the snapshot is bigger than that request', () => {
    expect(contextTotalTokens(analysis({ lastInputTokens: 80 }))).toBe(100);
  });

  it('ignores a stale request input', () => {
    expect(contextTotalTokens(analysis({ lastInputTokens: 0, staleInput: { inputTokens: 76_525, reason: 'compacted' } }))).toBe(100);
  });
});

describe('contextBarSegments', () => {
  it('orders kinds by the fixed kind order and appends overhead last', () => {
    const segments = contextBarSegments(
      analysis({ overheadTokens: 30, categories: [
        { kind: 'tool_result', count: 1, chars: 240, tokens: 60 },
        { kind: 'user', count: 1, chars: 160, tokens: 40 },
      ] }),
    );

    expect(segments.map((segment) => segment.kind)).toEqual(['user', 'tool_result', 'overhead']);
  });
});

describe('formatShare / formatTokens', () => {
  it('never shows a non-zero share as 0%', () => {
    expect(formatShare(1, 100_000)).toBe('<0.1%');
    expect(formatShare(0, 100)).toBe('0%');
    expect(formatShare(50, 200)).toBe('25%');
  });

  it('shortens large token counts', () => {
    expect(formatTokens(1_500)).toBe('1.5K');
    expect(formatTokens(2_400_000)).toBe('2.4M');
    expect(formatTokens(42)).toBe('42');
  });
});

describe('filter / sort', () => {
  const items = [
    item({ sequence: 1, kind: 'user', tokens: 10 }),
    item({ sequence: 2, kind: 'tool_result', tokens: 90 }),
    item({ sequence: 3, kind: 'user', tokens: 30 }),
  ];

  it('filters by kind', () => {
    expect(filterContextItems(items, 'user').map((entry) => entry.sequence)).toEqual([1, 3]);
    expect(filterContextItems(items, 'all')).toHaveLength(3);
  });

  it('sorts by volume without losing the original position', () => {
    expect(sortContextItems(items, 'size').map((entry) => entry.sequence)).toEqual([2, 3, 1]);
    expect(sortContextItems(items, 'order').map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  });
});

describe('item copy', () => {
  it('prefers the tool name as the row title and keeps metadata in the subtitle', () => {
    const tool = item({
      kind: 'tool_call',
      name: 'read_file',
      content: '{"file_path":"apps/desktop/src/a.js"}',
      toolCallId: 'call_00_ET_1234567890',
      truncated: true,
    });

    expect(contextItemTitle(tool)).toBe('read_file');
    expect(contextItemSubtitle(tool)).toContain('call_00_ET_12345');
  });

  it('falls back to the content preview', () => {
    expect(contextItemTitle(item({ content: 'hello   there' }))).toBe('hello there');
  });
});

describe('staleReferenceNote', () => {
  it('explains a compacted request input', () => {
    const note = staleReferenceNote(
      analysis({
        staleInput: {
          inputTokens: 76_525,
          reason: 'compacted',
          compactedAt: '2026-10-28T08:46:11.000Z',
        },
      }),
    );

    expect(note).toContain('被压缩过');
    expect(note).toContain('76,525');
  });

  it('says nothing when the request input is still valid', () => {
    expect(staleReferenceNote(analysis())).toBe('');
  });
});
