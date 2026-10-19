import { describe, expect, it } from 'vitest';
import type { AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';
import {
  findUserMessageCutIndex,
  truncateHistoryBeforeUserMessage,
  uncommittedResponseText,
  userMessageIndexes,
} from './conversationHistory.js';

type Snapshot = Pick<AgentRuntimeSnapshot, 'messages' | 'usageHistory' | 'protocol'>;

function makeSnapshot(
  messages: unknown[],
  usageHistory: Array<{ turnId: number; messageCount: number; inputTokens: number }> = [],
  protocol: 'openai_responses' | 'openai_chat_completions' = 'openai_responses',
): Snapshot {
  return {
    messages,
    usageHistory,
    protocol,
  } as unknown as Snapshot;
}

describe('conversationHistory', () => {
  it('indexes only real user messages, skipping compact metadata', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'user', content: '[Mica compact checkpoint] summary of earlier turns' },
      { role: 'user', content: '[Mica compact boundary]' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ];
    expect(userMessageIndexes(messages)).toEqual([0, 4]);
  });

  it('locates the edited message by normalized text, counting from the end', () => {
    const messages = [
      { role: 'user', content: 'same text' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'same   text\n' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'another request' },
    ];
    // 默认取最新一条同文本消息；occurrenceFromEnd 让客户端指定更早的那条。
    expect(findUserMessageCutIndex(messages, 'same text')).toBe(2);
    expect(findUserMessageCutIndex(messages, 'same text', 2)).toBe(0);
    expect(findUserMessageCutIndex(messages, 'never sent')).toBe(-1);
    expect(findUserMessageCutIndex(messages, '   ')).toBe(-1);
  });

  it('truncates the edited message and everything after it, with usage', () => {
    const snapshot = makeSnapshot(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer one' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'answer two' },
      ],
      [
        { turnId: 1, messageCount: 1, inputTokens: 10 },
        { turnId: 2, messageCount: 3, inputTokens: 20 },
      ],
    );

    const result = truncateHistoryBeforeUserMessage(snapshot, { prompt: 'second' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removedMessages).toBe(2);
    expect(result.snapshot.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer one' },
    ]);
    expect(result.snapshot.usageHistory).toEqual([{ turnId: 1, messageCount: 1, inputTokens: 10 }]);
    expect(result.snapshot.lastUsage).toEqual({ turnId: 1, messageCount: 1, inputTokens: 10 });
  });

  it('keeps the usage boundary protocol-specific (chat completions counts the message itself)', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'second' },
    ];
    const usageHistory = [
      { turnId: 1, messageCount: 1, inputTokens: 10 },
      { turnId: 2, messageCount: 3, inputTokens: 20 },
    ];

    const responses = truncateHistoryBeforeUserMessage(makeSnapshot(messages, usageHistory), {
      prompt: 'second',
    });
    const chat = truncateHistoryBeforeUserMessage(makeSnapshot(messages, usageHistory, 'openai_chat_completions'), {
      prompt: 'second',
    });
    expect(responses.ok && responses.snapshot.usageHistory).toHaveLength(1);
    expect(chat.ok && chat.snapshot.usageHistory).toHaveLength(2);
  });

  it('reports a miss instead of silently truncating nothing', () => {
    const result = truncateHistoryBeforeUserMessage(makeSnapshot([]), { prompt: 'anything' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('找不到');
  });

  it('truncates a multi-part (image) user message by its text projection', () => {
    const snapshot = makeSnapshot([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look at this' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'seen' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
    ]);

    const result = truncateHistoryBeforeUserMessage(snapshot, { prompt: 'look at this\n[Image]' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.messages).toHaveLength(0);
  });

  it('locates a message whose only image sits mid-sentence (Chat Completions projection)', () => {
    // provider history 侧图片在句子中间，桌面端拿到的文本投影会把占位符并到末尾。
    const snapshot = makeSnapshot([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at ' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'text', text: ' this' },
        ],
      },
      { role: 'assistant', content: 'seen' },
    ]);

    // 界面侧的写法：占位符在末尾、块之间没有分隔符。
    const result = truncateHistoryBeforeUserMessage(snapshot, { prompt: 'look at  this[图片]' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.messages).toHaveLength(0);
  });

  it('falls back to the single match when the client counted one occurrence too many', () => {
    const messages = [
      { role: 'user', content: 'only once' },
      { role: 'assistant', content: 'answer' },
    ];
    // 桌面端在 transcript 上数出 2 条（多了一条没进 provider history 的用户消息），
    // 而历史里只有一条：那一定就是它。
    expect(findUserMessageCutIndex(messages, 'only once', 2)).toBe(0);
    const result = truncateHistoryBeforeUserMessage(makeSnapshot(messages), {
      prompt: 'only once',
      occurrenceFromEnd: 2,
    });
    expect(result.ok).toBe(true);
  });

  it('does not guess between several same-text messages above the requested occurrence', () => {
    const messages = [
      { role: 'user', content: 'same' },
      { role: 'user', content: 'same' },
    ];
    expect(findUserMessageCutIndex(messages, 'same', 3)).toBe(-1);
  });

  it('explains that a media-only message cannot be located by text', () => {
    const result = truncateHistoryBeforeUserMessage(
      makeSnapshot([{ role: 'user', content: [{ type: 'image', source: {} }] }]),
      { prompt: '[图片]' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('只有图片');
  });

  it('keeps only the not-yet-committed tail of an aborted turn response', () => {
    expect(uncommittedResponseText('first partsecond part', 'first part')).toBe('second part');
    // A restarted retry attempt can no longer match the committed prefix.
    expect(uncommittedResponseText('different text', 'first part')).toBe('different text');
    expect(uncommittedResponseText('everything', '')).toBe('everything');
    expect(uncommittedResponseText('same', 'same')).toBe('');
  });
});
