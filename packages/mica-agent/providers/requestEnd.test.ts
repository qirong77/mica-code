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

  it.each(['chat', 'responses'] as const)('%s records paired generation timing for attributable body output', async (protocol) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const create = protocol === 'chat' ? openaiMocks.chatCreate : openaiMocks.responsesCreate;
    const first = 'body text '.repeat(20);
    const last = 'more body text '.repeat(20);
    for (const output of [64, 0]) {
      create.mockResolvedValueOnce((async function* () {
        advanceClock(20);
        yield bodyDelta(protocol, first);
        advanceClock(600);
        yield bodyDelta(protocol, last);
        advanceClock(200);
        yield* completion(protocol, output, 0);
      })());
      const client = timingClient(protocol);
      await expect(client.query('hello')).resolves.toBe(first + last);
      expect(client.lastUsage).toMatchObject({ responseWaitMs: 20, firstTokenMs: 20, durationMs: 820 });
      expect(client.lastUsage?.generationDurationMs).toBe(output ? 600 : undefined);
      expect(client.lastUsage?.generationOutputTokens).toBe(output ? 63 : undefined);
    }
  });

  it.each(['chat', 'responses'] as const)('%s subtracts hidden reasoning and times body independently of reasoning', async (protocol) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const create = protocol === 'chat' ? openaiMocks.chatCreate : openaiMocks.responsesCreate;
    const first = 'body text '.repeat(20);
    const last = 'more body text '.repeat(20);
    for (const visibleReasoning of [false, true]) {
      create.mockResolvedValueOnce((async function* () {
        advanceClock(20);
        if (visibleReasoning) yield reasoningDelta(protocol, 'thinking');
        advanceClock(1000);
        yield bodyDelta(protocol, first);
        advanceClock(100);
        yield bodyDelta(protocol, '');
        advanceClock(500);
        yield bodyDelta(protocol, last);
        advanceClock(900);
        if (visibleReasoning) yield reasoningDelta(protocol, 'more thinking');
        advanceClock(100);
        yield* completion(protocol, 104, 40);
      })());
      const client = timingClient(protocol);
      const onText = vi.fn();
      const onThinking = vi.fn();
      client.onText = onText;
      client.onThinking = onThinking;
      const ended = vi.fn();
      await expect(client.query('hello', { onRequestEnd: ended })).resolves.toBe(first + last);
      expect(client.lastUsage).toMatchObject({
        responseWaitMs: visibleReasoning ? 20 : 1020,
        firstTokenMs: visibleReasoning ? 20 : 1020,
        durationMs: 2620,
        outputTokens: 104,
        generationDurationMs: 600,
        generationOutputTokens: 63,
      });
      expect(ended).toHaveBeenCalledWith(expect.objectContaining({ firstTokenMs: visibleReasoning ? 20 : 1020 }));
      expect(onText.mock.calls.map(([text]) => text)).toEqual(protocol === 'chat' ? [first, last] : [first, '', last]);
      expect(onThinking.mock.calls.map(([text]) => text)).toEqual(visibleReasoning ? ['thinking', 'more thinking'] : []);
    }
  });

  it.each(['chat', 'responses'] as const)('%s resets body timing and other-output flags for a retried attempt', async (protocol) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const create = protocol === 'chat' ? openaiMocks.chatCreate : openaiMocks.responsesCreate;
    const first = 'body text '.repeat(20);
    const last = 'more body text '.repeat(20);
    create.mockResolvedValueOnce((async function* () {
      advanceClock(20);
      yield bodyDelta(protocol, 'discarded text');
      advanceClock(1000);
      yield protocol === 'chat'
        ? { model: 'test-model', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] }
        : { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' };
      throw Object.assign(new Error('overloaded'), { status: 503 });
    })()).mockResolvedValueOnce((async function* () {
      advanceClock(70);
      yield bodyDelta(protocol, first);
      advanceClock(600);
      yield bodyDelta(protocol, last);
      yield* completion(protocol, 64, 0);
    })());
    const client = timingClient(protocol);
    client.onTextAttemptStart = vi.fn();
    const rollback = vi.fn();
    client.onTextRollback = rollback;
    const promise = client.query('hello');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBe(first + last);
    expect(rollback).toHaveBeenCalledOnce();
    expect(client.usageHistory).toHaveLength(1);
    expect(client.lastUsage).toMatchObject({ firstTokenMs: 70, generationDurationMs: 600, generationOutputTokens: 63 });
  });

  describe.each(['chat', 'responses'] as const)('%s generation sampling exclusions', (protocol) => {
    it.each([
      { name: 'short body', output: 31, reasoning: 0, interval: 600, deltas: 2 },
      { name: 'short time window', output: 64, reasoning: 0, interval: 499, deltas: 2 },
      { name: 'one body delta plus reasoning', output: 104, reasoning: 40, interval: 600, deltas: 1, visibleReasoning: true },
      { name: 'unknown hidden reasoning', output: 64, reasoning: undefined, interval: 600, deltas: 2 },
      { name: 'unknown visible reasoning', output: 64, reasoning: undefined, interval: 600, deltas: 2, visibleReasoning: true },
      { name: 'reproduced reasoning spike', output: 27, reasoning: 15, interval: 11, deltas: 2 },
    ])('excludes $name', async ({ output, reasoning, interval, deltas, visibleReasoning }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const create = protocol === 'chat' ? openaiMocks.chatCreate : openaiMocks.responsesCreate;
      create.mockResolvedValueOnce((async function* () {
        advanceClock(20);
        if (visibleReasoning) yield reasoningDelta(protocol, 'thinking');
        advanceClock(1000);
        yield bodyDelta(protocol, 'body text '.repeat(20));
        advanceClock(interval);
        if (deltas > 1) yield bodyDelta(protocol, 'more body text '.repeat(20));
        yield* completion(protocol, output, reasoning);
      })());
      const client = timingClient(protocol);
      await client.query('hello');
      expect(client.lastUsage?.generationDurationMs).toBeUndefined();
      expect(client.lastUsage?.generationOutputTokens).toBeUndefined();
    });

    it.each(['tool', 'refusal', 'audio'] as const)('excludes %s deltas even with valid body timing', async (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const create = protocol === 'chat' ? openaiMocks.chatCreate : openaiMocks.responsesCreate;
      create.mockResolvedValueOnce((async function* () {
        advanceClock(20);
        yield bodyDelta(protocol, 'body text '.repeat(20));
        advanceClock(600);
        yield bodyDelta(protocol, 'more body text '.repeat(20));
        if (protocol === 'chat') {
          const delta = kind === 'tool' ? { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }
            : kind === 'refusal' ? { refusal: 'not allowed' } : { audio: { data: 'base64' } };
          yield { model: 'test-model', choices: [{ delta }] };
        } else {
          yield kind === 'tool' ? { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' }
            : kind === 'refusal' ? { type: 'response.refusal.delta', delta: 'not allowed' }
              : { type: 'response.output_audio.delta', delta: 'base64' };
        }
        yield* completion(protocol, 64, 0);
      })());
      const client = timingClient(protocol);
      await client.query('hello');
      expect(client.lastUsage?.generationDurationMs).toBeUndefined();
      expect(client.lastUsage?.generationOutputTokens).toBeUndefined();
    });
  });

  it.each(['added', 'done', 'completed'] as const)('Responses excludes built-in tool output in %s items', async (boundary) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const item = { type: 'web_search_call', id: 'search', status: 'completed' };
    openaiMocks.responsesCreate.mockResolvedValueOnce((async function* () {
      advanceClock(20);
      yield bodyDelta('responses', 'body text '.repeat(20));
      advanceClock(600);
      yield bodyDelta('responses', 'more body text '.repeat(20));
      if (boundary === 'completed') {
        yield { type: 'response.completed', response: { model: 'test-model', output: [item], usage: {
          input_tokens: 2, output_tokens: 64, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 66,
        } } };
      } else {
        yield { type: `response.output_item.${boundary}`, item, output_index: 1 };
        yield* completion('responses', 64, 0);
      }
    })());
    const client = timingClient('responses');
    await client.query('hello');
    expect(client.lastUsage?.generationDurationMs).toBeUndefined();
    expect(client.lastUsage?.generationOutputTokens).toBeUndefined();
  });

  it.each(['refusal', 'output_audio'] as const)('Responses excludes message %s in final output even without deltas', async (type) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    openaiMocks.responsesCreate.mockResolvedValueOnce((async function* () {
      advanceClock(20);
      yield bodyDelta('responses', 'body text '.repeat(20));
      advanceClock(600);
      yield bodyDelta('responses', 'more body text '.repeat(20));
      yield { type: 'response.completed', response: { model: 'test-model', output: [{
        type: 'message', role: 'assistant', content: [{ type, refusal: 'not allowed' }],
      }], usage: { input_tokens: 2, output_tokens: 64, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 66 } } };
    })());
    const client = timingClient('responses');
    await client.query('hello');
    expect(client.lastUsage?.generationDurationMs).toBeUndefined();
    expect(client.lastUsage?.generationOutputTokens).toBeUndefined();
  });

  it('does not associate ambiguous chat usage chunks with a duration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    openaiMocks.chatCreate.mockResolvedValueOnce((async function* () {
      advanceClock(20);
      yield bodyDelta('chat', 'body text '.repeat(20));
      advanceClock(600);
      yield bodyDelta('chat', 'more body text '.repeat(20));
      yield* completion('chat', 64, 0);
      yield { model: 'test-model', choices: [], usage: {
        prompt_tokens: 2, completion_tokens: 64, completion_tokens_details: { reasoning_tokens: 0 }, total_tokens: 66,
      } };
    })());
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    await client.query('hello');
    expect(client.usageHistory).toHaveLength(2);
    expect(client.usageHistory.every((usage) =>
      usage.durationMs === undefined && usage.firstTokenMs === undefined && usage.responseWaitMs === undefined &&
      usage.generationDurationMs === undefined && usage.generationOutputTokens === undefined,
    )).toBe(true);
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

type TimingProtocol = 'chat' | 'responses';

function timingClient(protocol: TimingProtocol) {
  return protocol === 'chat'
    ? new ChatCompletionsClient(options('openai_chat_completions'))
    : new ResponsesClient(options('openai_responses'));
}

function advanceClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

function bodyDelta(protocol: TimingProtocol, text: string) {
  return protocol === 'chat'
    ? { model: 'test-model', choices: [{ delta: { content: text } }] }
    : { type: 'response.output_text.delta', delta: text };
}

function reasoningDelta(protocol: TimingProtocol, text: string) {
  return protocol === 'chat'
    ? { model: 'test-model', choices: [{ delta: { reasoning_content: text } }] }
    : { type: 'response.reasoning_summary_text.delta', delta: text, item_id: 'r', output_index: 0, summary_index: 0 };
}

function* completion(protocol: TimingProtocol, output: number, reasoning: number | undefined) {
  if (protocol === 'chat') {
    yield { model: 'test-model', choices: [{ delta: {}, finish_reason: 'stop' }] };
    yield { model: 'test-model', choices: [], usage: {
      prompt_tokens: 2, completion_tokens: output, total_tokens: 2 + output,
      ...(reasoning === undefined ? {} : { completion_tokens_details: { reasoning_tokens: reasoning } }),
    } };
  } else {
    yield { type: 'response.completed', response: { model: 'test-model', usage: {
      input_tokens: 2, output_tokens: output, total_tokens: 2 + output,
      ...(reasoning === undefined ? {} : { output_tokens_details: { reasoning_tokens: reasoning } }),
    } } };
  }
}

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
