import { describe, expect, it } from 'vitest';
import { mergeConversationPage } from './conversationMerge.js';
import type { ConfigWebConversationItem } from '../src/shared/types.js';

function item(sequence: number, content: string, type: ConfigWebConversationItem['type'] = 'assistant'): ConfigWebConversationItem {
  return { sequence, type, role: type, content } as ConfigWebConversationItem;
}

describe('mergeConversationPage', () => {
  it('returns the same array when the newest page did not change', () => {
    const loaded = [item(1, 'a'), item(2, 'b')];
    const next = mergeConversationPage(loaded, [item(1, 'a'), item(2, 'b')]);
    // 引用不变 = 调用方不 setState = 轮询不引起重渲染（会话在跑时每几秒一次）。
    expect(next).toBe(loaded);
  });

  it('keeps pages loaded above the newest page', () => {
    // 用户翻上去加载了 1..120，最新一页是 41..120 的一部分；快照再变一次不能把 1..40 丢掉。
    const loaded = Array.from({ length: 120 }, (_, index) => item(index + 1, `old ${index + 1}`));
    const latest = Array.from({ length: 80 }, (_, index) => item(index + 41, `old ${index + 41}`));
    const next = mergeConversationPage(loaded, latest);
    expect(next).toBe(loaded);
  });

  it('replaces the items the newest page changed and keeps the rest', () => {
    const first = item(1, 'keep me');
    const streaming = item(2, 'partial');
    const loaded = [first, streaming];
    const next = mergeConversationPage(loaded, [item(1, 'keep me'), item(2, 'complete')]);
    expect(next).not.toBe(loaded);
    expect(next.map((entry) => entry.content)).toEqual(['keep me', 'complete']);
    expect(next[0]).toBe(first);
  });

  it('appends new items in sequence order', () => {
    const loaded = [item(1, 'a')];
    const next = mergeConversationPage(loaded, [item(1, 'a'), item(2, 'b'), item(3, 'c')]);
    expect(next.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  });
});
