import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { MicaTool, micaTools } from '@packages/mica-tools/index.js';
import { isRetryableError } from '../core/retry.js';
import { STREAM_IDLE_TIMEOUT_MS, withIdleTimeout } from '../core/streamIdleTimeout.js';
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

/** 上游握手成功后一个事件都不再发：迭代器永远卡在 next()。 */
function stalledStream(): AsyncGenerator<unknown> {
  return (async function* () {
    await new Promise(() => {});
  })();
}

describe('withIdleTimeout', () => {
  it('passes every event through and completes normally', async () => {
    const events: number[] = [];
    for await (const event of withIdleTimeout(streamOf<number>(1, 2, 3))) events.push(event);
    expect(events).toEqual([1, 2, 3]);
  });

  it('throws a retryable timeout error when the stream goes silent', async () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    const silent = (async function* () {
      yield 'first';
      await new Promise(() => {});
    })();
    const promise = (async () => {
      for await (const event of withIdleTimeout(silent)) seen.push(event);
    })();
    // 先接管拒绝：超时发生在 advanceTimersByTimeAsync 内部，等推进完再断言会
    // 让 Node 在两者之间先报一次 unhandledRejection。
    const settled = promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1);
    expect(seen).toEqual(['first']);

    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toMatchObject({ name: 'TimeoutError' });
    expect(String((await settled as Error).message)).toMatch(/No stream data from provider for 60s/);
    expect(isRetryableError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
  });
});

describe('provider streams idle timeout', () => {
  it('Responses retries when the provider stops sending events', async () => {
    vi.useFakeTimers();
    openaiMocks.responsesCreate
      .mockResolvedValueOnce(stalledStream())
      .mockResolvedValueOnce(
        streamOf(
          { type: 'response.output_text.delta', delta: 'ok' },
          {
            type: 'response.completed',
            response: { model: 'test-model', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
          },
        ),
      );
    const client = new ResponsesClient(options('openai_responses'));
    const onRetry = vi.fn();
    const promise = client.query('hello', { onRetry });

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 2000);

    await expect(promise).resolves.toBe('ok');
    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1 });
  });

  it('Responses discards interrupted text and retries the original input', async () => {
    vi.useFakeTimers();
    openaiMocks.responsesCreate
      .mockResolvedValueOnce((async function* () {
        yield { type: 'response.output_text.delta', delta: 'partial' };
        await new Promise(() => {});
      })())
      .mockResolvedValueOnce(streamOf(
        { type: 'response.output_text.delta', delta: 'recovered' },
        { type: 'response.completed', response: { model: 'test-model' } },
      ));
    const client = new ResponsesClient(options('openai_responses'));
    let displayed = '';
    let checkpoint = '';
    client.onTextAttemptStart = () => { checkpoint = displayed; };
    client.onTextRollback = () => { displayed = checkpoint; };
    client.onText = (text) => { displayed += text; };
    const onRetry = vi.fn();
    const query = client.query('hello', { onRetry });

    await vi.advanceTimersByTimeAsync(0);
    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(1);
    const originalInput = structuredClone(openaiMocks.responsesCreate.mock.calls[0]![0].input);
    expect(displayed).toBe('partial');

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 2000);

    expect(await query).toBe('recovered');
    expect(displayed).toBe('recovered');
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(2);
    expect(openaiMocks.responsesCreate.mock.calls[1]?.[0].input).toEqual(originalInput);
    expect(client.messages).toEqual(originalInput);
  });

  it('Responses discards an interrupted tool call without executing it', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => 'written');
    const tool = new class extends MicaTool {
      constructor() {
        super('stream_retry_partial_tool_probe', 'test write', { type: 'object', properties: {} }, { readOnly: false });
      }
      async execute(): Promise<string> { return execute(); }
      onToolUseDisplayText(): string { return this.name; }
    }();
    micaTools.registerRuntime(tool);
    try {
      openaiMocks.responsesCreate
        .mockResolvedValueOnce((async function* () {
          yield { type: 'response.output_item.added', output_index: 0, item: {
            type: 'function_call', id: 'fc-partial', call_id: 'call-partial', name: tool.name, arguments: '',
          } };
          yield { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{' };
          await new Promise(() => {});
        })())
        .mockResolvedValueOnce(streamOf({ type: 'response.output_text.delta', delta: 'recovered' }));
      const client = new ResponsesClient(options('openai_responses'));
      client.onTextAttemptStart = () => {};
      client.onTextRollback = () => {};
      const onRetry = vi.fn();
      const onToolCall = vi.fn();
      client.onToolCall = onToolCall;
      const query = client.query('write', { onRetry });

      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 2000);

      expect(await query).toBe('recovered');
      expect(execute).not.toHaveBeenCalled();
      expect(onToolCall).not.toHaveBeenCalled();
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(2);
      const requests = openaiMocks.responsesCreate.mock.calls;
      expect(requests[1]?.[0].input).toEqual(requests[0]?.[0].input);
      expect(client.messages.some((item) => item.type === 'function_call' || item.type === 'function_call_output')).toBe(false);
    } finally {
      micaTools.unregisterRuntime(tool);
    }
  });

  it('Chat Completions retries when the provider stops sending chunks', async () => {
    vi.useFakeTimers();
    openaiMocks.chatCreate
      .mockResolvedValueOnce(stalledStream())
      .mockResolvedValueOnce(
        streamOf({
          model: 'test-model',
          choices: [{ delta: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    const promise = client.query('hello');

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 2000);

    await expect(promise).resolves.toBe('ok');
    expect(openaiMocks.chatCreate).toHaveBeenCalledTimes(2);
  });

  it('does not retry the idle timeout once text has streamed', async () => {
    vi.useFakeTimers();
    openaiMocks.chatCreate.mockResolvedValueOnce(
      (async function* () {
        yield { model: 'test-model', choices: [{ delta: { content: 'partial' } }] };
        await new Promise(() => {});
      })(),
    );
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    const promise = client.query('hello');
    const settled = promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS);

    expect(await settled).toMatchObject({ name: 'TimeoutError' });
    expect(openaiMocks.chatCreate).toHaveBeenCalledTimes(1);
  });
});

async function* streamOf<T = unknown>(...events: T[]): AsyncGenerator<T> {
  for (const event of events) yield event;
  // Successful chat fixtures include a terminal choice.
  if (events.some((event) => typeof event === 'object' && event !== null && 'choices' in event)) {
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] } as T;
  }
  // Successful Responses fixtures include the protocol's terminal event.
  if (events.some((event) => typeof event === 'object' && event !== null &&
    'type' in event && typeof event.type === 'string' && event.type.startsWith('response.')) &&
    !events.some((event) => typeof event === 'object' && event !== null &&
      'type' in event && event.type === 'response.completed')) {
    yield { type: 'response.completed', response: { model: 'test-model' } } as T;
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


describe('Responses retry after a completed tool iteration', () => {
  it('retries a later stalled request without repeating prior text or a write tool', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => 'written');
    const tool = new class extends MicaTool {
      constructor() {
        super('stream_retry_write_probe', 'test write', { type: 'object', properties: {} }, { readOnly: false });
      }
      async execute(): Promise<string> { return execute(); }
      onToolUseDisplayText(): string { return this.name; }
    }();
    micaTools.registerRuntime(tool);
    try {
      openaiMocks.responsesCreate
        .mockResolvedValueOnce(streamOf(
          { type: 'response.output_text.delta', delta: 'before' },
          { type: 'response.output_item.done', output_index: 0, item: {
            type: 'function_call', id: 'fc-1', call_id: 'call-1', name: tool.name,
            arguments: '{}', status: 'completed',
          } },
        ))
        .mockResolvedValueOnce((async function* () {
          yield { type: 'response.output_text.delta', delta: 'discarded' };
          await new Promise(() => {});
        })())
        .mockResolvedValueOnce(streamOf({ type: 'response.output_text.delta', delta: 'after' }));
      const client = new ResponsesClient(options('openai_responses'));
      let displayed = '';
      let checkpoint = '';
      client.onTextAttemptStart = () => { checkpoint = displayed; };
      client.onTextRollback = () => { displayed = checkpoint; };
      client.onText = (text) => { displayed += text; };
      const onRetry = vi.fn();
      const query = client.query('write once', { onRetry });

      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 2000);

      expect(await query).toBe('before\n\nafter');
      expect(displayed).toBe('before\n\nafter');
      expect(JSON.stringify(client.messages)).not.toContain('discarded');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(3);
      const requests = openaiMocks.responsesCreate.mock.calls;
      expect(requests[2]?.[0].input).toEqual(requests[1]?.[0].input);
      expect(requests[2]?.[0].input.filter((item: { type: string }) => item.type === 'function_call_output'))
        .toHaveLength(1);
    } finally {
      micaTools.unregisterRuntime(tool);
    }
  });
});
