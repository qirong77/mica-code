import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { ChatCompletionsClient } from './ChatCompletionsClient.js';
import { ResponsesClient } from './ResponsesClient.js';
import type { ModelClientOptions } from './types.js';

const openaiMocks = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  responsesCreate: vi.fn(),
}));

vi.mock('openai', () => ({
  OpenAI: class MockOpenAI {
    chat = { completions: { create: openaiMocks.chatCreate } };
    responses = { create: openaiMocks.responsesCreate };
  },
}));

afterEach(() => {
  openaiMocks.chatCreate.mockReset();
  openaiMocks.responsesCreate.mockReset();
  vi.useRealTimers();
});

/**
 * `request:start` 必须总能等到一条 `request:end`：只留 start 的话，失败请求的耗时
 * 直接丢失，而「开了没结束」又分不清是被中断还是崩了。
 */
describe('request end outcome', () => {
  it('Chat Completions reports outcome error when the request fails', async () => {
    openaiMocks.chatCreate.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    const ended: Array<Record<string, unknown>> = [];

    await expect(
      client.query('hello', { onRequestEnd: (info) => ended.push(info as Record<string, unknown>) }),
    ).rejects.toThrow('bad request');

    expect(ended).toHaveLength(1);
    expect(ended[0]?.outcome).toBe('error');
    expect(ended[0]?.error).toBe('bad request');
  });

  it('Responses reports outcome error when the request fails', async () => {
    openaiMocks.responsesCreate.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));
    const client = new ResponsesClient(options('openai_responses'));
    const ended: Array<Record<string, unknown>> = [];

    await expect(
      client.query('hello', { onRequestEnd: (info) => ended.push(info as Record<string, unknown>) }),
    ).rejects.toThrow('bad request');

    expect(ended).toHaveLength(1);
    expect(ended[0]?.outcome).toBe('error');
  });

  it('Chat Completions reports outcome aborted when the signal fires', async () => {
    const controller = new AbortController();
    openaiMocks.chatCreate.mockResolvedValueOnce(
      (async function* () {
        yield { model: 'test-model', choices: [{ delta: { reasoning_content: 'thinking...' } }] };
        controller.abort();
      })(),
    );
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    const ended: Array<Record<string, unknown>> = [];

    await expect(
      client.query('hello', {
        signal: controller.signal,
        onRequestEnd: (info) => ended.push(info as Record<string, unknown>),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(ended).toHaveLength(1);
    expect(ended[0]?.outcome).toBe('aborted');
  });
});

describe('first token timing', () => {
  it.each(['chat', 'responses'] as const)('%s associates final-attempt first token and total retry duration with usage', async (protocol) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const advanceClock = (ms: number) => vi.setSystemTime(Date.now() + ms);
    const create = protocol === 'chat' ? openaiMocks.chatCreate : openaiMocks.responsesCreate;
    create.mockResolvedValueOnce((async function* () {
      advanceClock(100);
      throw Object.assign(new Error('overloaded'), { status: 503 });
    })()).mockResolvedValueOnce((async function* () {
      advanceClock(70);
      if (protocol === 'chat') {
        yield { model: 'test-model', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        advanceClock(30);
        yield { model: 'test-model', choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
      } else {
        yield { type: 'response.output_text.delta', delta: 'ok' };
        advanceClock(30);
        yield { type: 'response.completed', response: { model: 'test-model', usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
      }
    })());
    const client = protocol === 'chat'
      ? new ChatCompletionsClient(options('openai_chat_completions'))
      : new ResponsesClient(options('openai_responses'));
    const promise = client.query('hello');
    await vi.advanceTimersByTimeAsync(2100);
    await expect(promise).resolves.toBe('ok');
    expect(client.usageHistory).toHaveLength(1);
    expect(client.usageHistory[0]).toMatchObject({
      provider: protocol === 'chat' ? 'openai_chat_completions' : 'openai_responses',
      providerId: 'test', firstTokenMs: 70, responseWaitMs: 2170, durationMs: 2200, outputTokens: 1,
    });
    expect(client.usageHistory[0]?.generationDurationMs).toBeUndefined();
  });

  it.each(['chat', 'responses'] as const)('%s records generation only for attributable positive output usage', async (protocol) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const create = protocol === 'chat' ? openaiMocks.chatCreate : openaiMocks.responsesCreate;
    for (const output of [2, 0]) {
      create.mockResolvedValueOnce((async function* () {
        vi.setSystemTime(Date.now() + 20);
        if (protocol === 'chat') {
          yield { model: 'test-model', choices: [{ delta: { reasoning_content: 'think' } }] };
          vi.setSystemTime(Date.now() + 50);
          yield { model: 'test-model', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
          yield { model: 'test-model', choices: [], usage: { prompt_tokens: 2, completion_tokens: output, total_tokens: 2 + output } };
        } else {
          yield { type: 'response.reasoning_text.delta', delta: 'think', item_id: 'r', output_index: 0, content_index: 0 };
          vi.setSystemTime(Date.now() + 50);
          yield { type: 'response.output_text.delta', delta: 'ok' };
          yield { type: 'response.completed', response: { model: 'test-model', usage: { input_tokens: 2, output_tokens: output, total_tokens: 2 + output } } };
        }
      })());
      const client = protocol === 'chat' ? new ChatCompletionsClient(options('openai_chat_completions')) : new ResponsesClient(options('openai_responses'));
      await client.query('hello');
      expect(client.usageHistory[0]?.responseWaitMs).toBe(20);
      expect(client.usageHistory[0]?.generationDurationMs).toBe(output ? 50 : undefined);
    }
  });

  it('does not associate ambiguous chat usage chunks with a duration', async () => {
    openaiMocks.chatCreate.mockResolvedValueOnce((async function* () {
      yield { model: 'test-model', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
      yield { model: 'test-model', choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
      yield { model: 'test-model', choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
    })());
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    await client.query('hello');
    expect(client.usageHistory).toHaveLength(2);
    expect(client.usageHistory.every((usage) => usage.durationMs === undefined && usage.firstTokenMs === undefined)).toBe(true);
  });

  it('Chat Completions does not count a role-only chunk as the first token', async () => {
    openaiMocks.chatCreate.mockResolvedValueOnce(
      (async function* () {
        yield { model: 'test-model', choices: [{ delta: { role: 'assistant' } }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      })(),
    );
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    const ended: Array<Record<string, unknown>> = [];

    await client.query('hello', { onRequestEnd: (info) => ended.push(info as Record<string, unknown>) });

    expect(ended[0]?.outcome).toBe('completed');
    expect(ended[0]?.firstTokenMs).toBeUndefined();
  });

  it('Responses does not count a non-content event as the first token', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(
      (async function* () {
        yield { type: 'response.created', response: { model: 'test-model' } };
        yield { type: 'response.completed', response: { model: 'test-model' } };
      })(),
    );
    const client = new ResponsesClient(options('openai_responses'));
    const ended: Array<Record<string, unknown>> = [];

    await client.query('hello', { onRequestEnd: (info) => ended.push(info as Record<string, unknown>) });

    expect(ended[0]?.outcome).toBe('completed');
    expect(ended[0]?.firstTokenMs).toBeUndefined();
  });
});

function options(protocol: ProviderProtocol): ModelClientOptions {
  return {
    model: 'test-model',
    apiKey: 'test-key',
    baseURL: 'https://example.com/v1',
    provider: {
      id: 'test',
      api_base: 'https://example.com/v1',
      protocol,
    },
  };
}
