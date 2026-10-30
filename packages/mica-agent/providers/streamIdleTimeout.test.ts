import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
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
