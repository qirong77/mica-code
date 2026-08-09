import { describe, expect, it } from 'vitest';
import { buildConfigWebContextAnalysis, estimateTextTokens } from './sessionAnalysis.js';

const SOURCE = {
  providerId: 'openai',
  protocol: 'openai_chat_completions' as const,
  model: 'gpt-5',
  systemPrompt: 'system instructions',
};

describe('estimateTextTokens', () => {
  it('counts CJK chars as one token and other chars as a quarter token', () => {
    expect(estimateTextTokens('abcdefgh')).toBe(2);
    expect(estimateTextTokens('中文测试')).toBe(4);
    expect(estimateTextTokens('a中文b')).toBe(3);
    expect(estimateTextTokens('')).toBe(0);
  });
});

describe('buildConfigWebContextAnalysis', () => {
  it('groups items into turns and totals conversation, tool, and thinking tokens', () => {
    const analysis = buildConfigWebContextAnalysis({
      ...SOURCE,
      messages: [
        { role: 'user', content: 'inspect the project' },
        {
          role: 'assistant',
          content: 'I will read it.',
          tool_calls: [
            { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"README.md"}' } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call-1',
          content: 'a very long tool output that goes on and on for many characters',
        },
        { role: 'assistant', content: 'Done.' },
        { role: 'user', content: '谢谢' },
        { role: 'assistant', content: '不客气' },
      ],
    });

    expect(analysis.turnCount).toBe(2);
    expect(analysis.imageCount).toBe(0);

    const [first, second] = analysis.turns;
    expect(first.index).toBe(1);
    expect(first.userPreview).toBe('inspect the project');
    expect(first.toolTokens).toBeGreaterThan(0);
    expect(first.conversationTokens).toBeGreaterThan(0);
    expect(first.thinkingTokens).toBe(0);
    expect(first.entries.map((entry) => entry.type)).toEqual([
      'system',
      'user',
      'assistant',
      'tool_call',
      'tool_result',
      'assistant',
    ]);
    expect(first.entries.find((entry) => entry.type === 'tool_call')?.label).toBe('read_file');

    expect(second.userPreview).toBe('谢谢');
    expect(second.conversationTokens).toBeGreaterThan(0);
    expect(second.toolTokens).toBe(0);

    expect(analysis.totals.totalTokens).toBe(first.totalTokens + second.totalTokens);
    expect(analysis.totals.conversationTokens).toBeGreaterThan(0);
    expect(analysis.totals.toolTokens).toBeGreaterThan(0);
  });

  it('aligns real usage history with turns by turn id', () => {
    const analysis = buildConfigWebContextAnalysis(
      {
        ...SOURCE,
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'answer one' },
          { role: 'user', content: 'second' },
          { role: 'assistant', content: 'answer two' },
        ],
      },
      [
        {
          provider: 'openai',
          turnId: 1,
          requestIndex: 0,
          messageCount: 2,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          paidTokenRate: 1,
        },
        {
          provider: 'openai',
          turnId: 1,
          requestIndex: 1,
          messageCount: 3,
          inputTokens: 140,
          cachedInputTokens: 40,
          outputTokens: 30,
          totalTokens: 170,
          paidTokenRate: 0.7,
        },
        {
          provider: 'openai',
          turnId: 2,
          requestIndex: 0,
          messageCount: 4,
          inputTokens: 210,
          outputTokens: 10,
          totalTokens: 220,
          paidTokenRate: 1,
        },
      ],
    );

    expect(analysis.turns[0].contextTokens).toBe(140);
    expect(analysis.turns[0].cachedInputTokens).toBe(40);
    expect(analysis.turns[0].usageRequests).toBe(2);
    expect(analysis.turns[1].contextTokens).toBe(210);
    expect(analysis.turns[1].usageRequests).toBe(1);
  });

  it('attaches the system prompt to the first turn and counts reasoning sizes from the size hint', () => {
    const analysis = buildConfigWebContextAnalysis({
      providerId: 'responses',
      protocol: 'openai_responses',
      model: 'gpt-5',
      systemPrompt: 'a fairly long system prompt that tells the agent how to behave',
      messages: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'summary' }],
          encrypted_content: 'x'.repeat(400),
        },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      ],
    });

    expect(analysis.turnCount).toBe(1);
    expect(analysis.turns[0].thinkingTokens).toBeGreaterThan(0);
    expect(analysis.turns[0].conversationTokens).toBeGreaterThan(estimateTextTokens('go ok'));
    expect(analysis.turns[0].entries[0].type).toBe('system');
  });

  it('creates a single empty turn for a session with only a system prompt', () => {
    const analysis = buildConfigWebContextAnalysis({
      ...SOURCE,
      messages: [],
    });

    expect(analysis.turnCount).toBe(1);
    expect(analysis.turns[0].index).toBe(0);
    expect(analysis.turns[0].userPreview).toBe('(无用户消息)');
    expect(analysis.turns[0].conversationTokens).toBeGreaterThan(0);
  });
});
