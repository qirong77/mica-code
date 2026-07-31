import { describe, expect, it } from 'vitest';
import { applyEvent, mergeSessionMessages } from '../src/render';
import type { SyncEvent } from '../src/api';

let seq = 0;
function ev(type: string, fields: Record<string, unknown> = {}): SyncEvent {
  return { seq: ++seq, ts: Date.now(), type, ...fields } as SyncEvent;
}

describe('mica-sync-web thinking 渲染', () => {
  it('thinking 增量应追加而不是替换，跨工具后开新段', () => {
    let messages = applyEvent([], ev('user_input', { text: '帮我重构' }));
    messages = applyEvent(messages, ev('text_delta', { text: '好的。' }));

    // 第一段思考增量
    for (const d of ['让我先分析', '当前函数的', '复杂度较高']) {
      messages = applyEvent(messages, ev('thinking', { text: d }));
    }
    expect(messages.at(-1)).toMatchObject({ kind: 'thinking', text: '让我先分析当前函数的复杂度较高' });

    // 工具调用（段结束）
    messages = applyEvent(messages, ev('tool_call', { toolId: 'c1', name: 'read_file', args: '{}' }));
    messages = applyEvent(messages, ev('tool_result', { toolId: 'c1', name: 'read_file', ok: true, result: 'x' }));

    // 快照刷新 → merge 保留 thinking/tool
    const base = [
      { kind: 'user', id: 'u', text: '帮我重构', ts: 1 },
      { kind: 'assistant', id: 'a', text: '好的。', ts: 2 },
    ];
    messages = mergeSessionMessages(messages, base);
    expect(messages.map((m) => m.kind)).toEqual(['user', 'assistant', 'thinking', 'tool']);

    // 第二段思考增量（跨工具，应新开块）
    for (const d of ['接下来', '检查测试']) {
      messages = applyEvent(messages, ev('thinking', { text: d }));
    }
    const thinkingBlocks = messages.filter((m) => m.kind === 'thinking');
    expect(thinkingBlocks).toHaveLength(2);
    expect(thinkingBlocks[0].text).toBe('让我先分析当前函数的复杂度较高');
    expect(thinkingBlocks[1].text).toBe('接下来检查测试');
  });

  it('thinking 超长时尾部截断并带 marker', () => {
    const long = 'a'.repeat(50_000);
    const result = applyEvent([], ev('thinking', { text: long }));
    const thinking = result.at(-1);
    expect(thinking?.kind).toBe('thinking');
    if (thinking?.kind === 'thinking') {
      expect(thinking.text).toContain('[thinking display truncated]');
      expect(thinking.text.length).toBeLessThanOrEqual(40_000 + 28);
    }
  });

  it('空 delta 不产生消息', () => {
    const result = applyEvent([], ev('thinking', { text: '' }));
    expect(result).toHaveLength(0);
  });

  it('text_delta 追加到 assistant', () => {
    let messages = applyEvent([], ev('text_delta', { text: 'a' }));
    messages = applyEvent(messages, ev('text_delta', { text: 'b' }));
    expect(messages.at(-1)).toMatchObject({ kind: 'assistant', text: 'ab' });
  });
});
