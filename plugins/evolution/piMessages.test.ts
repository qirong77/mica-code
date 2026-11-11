import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { MIGRATIONS, piMessagesV1 } from './migrations.js';

const createdAt = '2026-05-01T10:00:00.000Z';
const usage = {
  provider: 'openai_responses',
  model: 'usage-must-not-override-snapshot',
  inputTokens: 100,
  cachedInputTokens: 20,
  outputTokens: 40,
  totalTokens: 140,
  occurredAt: createdAt,
};

function document(protocol: string, messages: unknown[], usageHistory: unknown[] = []) {
  return {
    version: 1,
    createdAt,
    updatedAt: createdAt,
    snapshot: {
      providerId: 'my-gateway',
      protocol,
      model: 'original-model',
      messages,
      usageHistory,
      lastUsage: usageHistory.at(-1),
      conversationMessages: [{ role: 'notice', content: 'keep display records' }],
      pluginState: { todo: { completedTurnId: 'turn-1' } },
    },
  };
}

function migratedMessages(value: ReturnType<typeof document>): Message[] {
  return value.snapshot.messages as Message[];
}

function expectComplete(messages: Message[]) {
  for (const message of messages) {
    expect(Number.isFinite(message.timestamp)).toBe(true);
    if (message.role === 'assistant') {
      expect(message).toMatchObject({
        api: expect.any(String),
        provider: 'my-gateway',
        model: 'original-model',
        usage: {
          input: expect.any(Number),
          output: expect.any(Number),
          cacheRead: expect.any(Number),
          cacheWrite: expect.any(Number),
          totalTokens: expect.any(Number),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: expect.any(String),
      });
    }
    if (message.role === 'toolResult')
      expect(message).toMatchObject({
        toolCallId: expect.any(String),
        toolName: expect.any(String),
        isError: expect.any(Boolean),
        content: expect.any(Array),
      });
  }
}

describe('pi-messages-v1', () => {
  it('is registered and preserves Responses signatures, tool pairing, multimodal output and accounting', () => {
    const reasoning = {
      type: 'reasoning',
      id: 'rs_1',
      status: 'completed',
      encrypted_content: 'opaque-signed-reasoning',
      summary: [{ type: 'summary_text', text: 'plan first' }],
    };
    const value = document(
      'openai_responses',
      [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'inspect [Image](/tmp/screen.png)' },
            { type: 'input_image', image_url: 'data:image/png;base64,USER_IMAGE' },
          ],
        },
        reasoning,
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'checking' }],
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'read_image',
          arguments: '{"source":"/tmp/screen.png"}',
        },
        { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'read_file', arguments: '{"file_path":"a.ts"}' },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [
            { type: 'input_text', text: 'image found' },
            { type: 'input_image', image_url: 'data:image/jpeg;base64,TOOL_IMAGE' },
          ],
        },
        { type: 'function_call_output', call_id: 'call_2', output: 'source found' },
        {
          type: 'message',
          id: 'msg_2',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'done' }],
        },
      ],
      [usage, { ...usage, inputTokens: 150, totalTokens: 190 }],
    );
    const preserved = {
      history: value.snapshot.usageHistory,
      lastUsage: value.snapshot.lastUsage,
      conversation: value.snapshot.conversationMessages,
      state: value.snapshot.pluginState,
    };
    expect(MIGRATIONS).toContain(piMessagesV1);
    expect(piMessagesV1.apply(value)).toBe(1);
    expect(value.snapshot).toHaveProperty('messageFormat', 'pi-ai-v1');
    expect(value.snapshot.usageHistory).toBe(preserved.history);
    expect(value.snapshot.lastUsage).toBe(preserved.lastUsage);
    expect(value.snapshot.conversationMessages).toBe(preserved.conversation);
    expect(value.snapshot.pluginState).toBe(preserved.state);
    const messages = migratedMessages(value);
    expect(messages).toHaveLength(5);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'inspect [Image](/tmp/screen.png)' },
        { type: 'image', mimeType: 'image/png', data: 'USER_IMAGE' },
      ],
    });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      api: 'openai-responses',
      stopReason: 'toolUse',
      content: [
        { type: 'thinking', thinking: 'plan first', thinkingSignature: JSON.stringify(reasoning) },
        { type: 'text', text: 'checking', textSignature: JSON.stringify({ v: 1, id: 'msg_1', phase: 'commentary' }) },
        { type: 'toolCall', id: 'call_1|fc_1', name: 'read_image', arguments: { source: '/tmp/screen.png' } },
        { type: 'toolCall', id: 'call_2|fc_2', name: 'read_file', arguments: { file_path: 'a.ts' } },
      ],
      usage: { input: 80, cacheRead: 20, output: 40, totalTokens: 140 },
    });
    expect(messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_1|fc_1',
      toolName: 'read_image',
      content: [
        { type: 'text', text: 'image found' },
        { type: 'image', mimeType: 'image/jpeg', data: 'TOOL_IMAGE' },
      ],
    });
    expect(messages[4]).toMatchObject({
      role: 'assistant',
      stopReason: 'stop',
      content: [
        { type: 'text', text: 'done', textSignature: JSON.stringify({ v: 1, id: 'msg_2', phase: 'final_answer' }) },
      ],
      usage: { input: 130, cacheRead: 20, totalTokens: 190 },
    });
    expectComplete(messages);
    const once = JSON.stringify(value);
    expect(piMessagesV1.apply(value)).toBe(0);
    expect(JSON.stringify(value)).toBe(once);
  });

  it('converts Chat body, reasoning details, signed thinking and multiple tool iterations without changing identity', () => {
    const details = [
      { type: 'reasoning.text', text: 'private plan', signature: 'chat-signature', format: 'anthropic-claude-v1' },
    ];
    const value = document('openai_chat_completions', [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/webp;base64,CHAT_IMAGE' } },
        ],
      },
      {
        role: 'assistant',
        model: 'wrong-model',
        content: 'I will read',
        reasoning_content: 'private plan',
        reasoning_details: details,
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"x"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'x contents' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'signed follow-up', signature: 'opaque-signature' },
          { type: 'redacted_thinking', data: 'redacted-signature' },
          { type: 'text', text: 'second call' },
        ],
        tool_calls: [{ id: 'call-2', function: { name: 'run_shell', arguments: '{"command":"pwd"}' } }],
      },
      { role: 'tool', tool_call_id: 'call-2', content: 'permission denied', is_error: true },
      { role: 'assistant', content: 'done' },
    ]);
    expect(piMessagesV1.apply(value)).toBe(1);
    const messages = migratedMessages(value);
    expect(messages).toHaveLength(6);
    expect(messages[0]).toMatchObject({
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', mimeType: 'image/webp', data: 'CHAT_IMAGE' },
      ],
    });
    expect(messages[1]).toMatchObject({
      api: 'openai-completions',
      content: [
        { type: 'thinking', thinking: 'private plan', thinkingSignature: JSON.stringify(details) },
        { type: 'text', text: 'I will read' },
        { type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { file_path: 'x' } },
      ],
    });
    expect(messages[3]).toMatchObject({
      content: [
        { type: 'thinking', thinking: 'signed follow-up', thinkingSignature: 'opaque-signature' },
        { type: 'thinking', thinking: '', thinkingSignature: 'redacted-signature', redacted: true },
        { type: 'text', text: 'second call' },
        { type: 'toolCall', id: 'call-2' },
      ],
    });
    expect(messages[4]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-2',
      toolName: 'run_shell',
      isError: true,
    });
    expectComplete(messages);
    expect(piMessagesV1.apply(value)).toBe(0);
  });

  it('preserves invalid tool arguments for diagnosis and uses stable fallback timestamps', () => {
    const value = document('openai_chat_completions', [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'broken', function: { name: 'run_shell', arguments: '{broken input' } }],
      },
    ]);
    piMessagesV1.apply(value);
    const assistant = migratedMessages(value)[1] as AssistantMessage;
    expect(assistant.content[0]).toMatchObject({
      type: 'toolCall',
      arguments: {},
      argumentsError: expect.stringContaining('{broken input'),
    });
    expect(assistant.timestamp).toBe(Date.parse(createdAt));
    expectComplete(migratedMessages(value));
  });

  it('marks empty snapshots and infers a missing protocol from saved usage without config or IO', () => {
    const value = document('openai_chat_completions', [], [usage]);
    delete (value.snapshot as Partial<typeof value.snapshot>).protocol;
    expect(piMessagesV1.apply(value)).toBe(1);
    expect(value.snapshot).toMatchObject({ messageFormat: 'pi-ai-v1', protocol: 'openai_responses', messages: [] });
    expect(piMessagesV1.apply(value)).toBe(0);
    const current = { snapshot: { messageFormat: 'pi-ai-v1', protocol: 'google_generative_ai', messages: [] } };
    expect(piMessagesV1.apply(current)).toBe(0);
  });

  it('pairs surviving assistant usage with the latest matching native boundary after compact', () => {
    const value = document(
      'openai_chat_completions',
      [
        { role: 'user', content: 'compacted conversation' },
        { role: 'assistant', content: 'old summary' },
        { role: 'user', content: 'latest task' },
        { role: 'assistant', content: 'latest answer' },
      ],
      [
        { ...usage, messageCount: 2, inputTokens: 10, totalTokens: 50 },
        { ...usage, messageCount: 100, inputTokens: 1000, totalTokens: 1040 },
        { ...usage, messageCount: 4, inputTokens: 200, totalTokens: 240 },
      ],
    );
    const accounting = JSON.stringify(value.snapshot.usageHistory);
    piMessagesV1.apply(value);
    const messages = migratedMessages(value);
    expect(messages[3]).toMatchObject({ usage: { input: 180, cacheRead: 20, totalTokens: 240 } });
    expect(JSON.stringify(value.snapshot.usageHistory)).toBe(accounting);
    expect(piMessagesV1.apply(value)).toBe(0);
  });

  it('preserves native usage and URL references while filling required message fields', () => {
    const value = document('openai_responses', [
      { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/screen.png' }] },
      {
        role: 'assistant',
        content: 'text',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
          output_tokens_details: { reasoning_tokens: 5 },
          total_tokens: 120,
        },
      },
    ]);
    piMessagesV1.apply(value);
    expect(migratedMessages(value)[0]).toMatchObject({
      content: [{ type: 'text', text: '[Image](https://example.com/screen.png)' }],
    });
    expect(migratedMessages(value)[1]).toMatchObject({
      usage: { input: 60, cacheRead: 30, cacheWrite: 10, output: 20, reasoning: 5, totalTokens: 120 },
    });
    expectComplete(migratedMessages(value));
  });

  it('does not partially rewrite or mark unsupported native history', () => {
    const value = document('openai_responses', [
      { role: 'user', content: 'keep me' },
      { type: 'unknown_native_item', value: 'opaque' },
    ]);
    const original = JSON.stringify(value);
    expect(() => piMessagesV1.apply(value)).toThrow('Unsupported legacy message');
    expect(JSON.stringify(value)).toBe(original);
    const unmarked = document('anthropic_messages', []);
    expect(() => piMessagesV1.apply(unmarked)).toThrow('Unsupported legacy session protocol');
  });
});
