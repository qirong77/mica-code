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
 * 模拟 krill 过载：HTTP 200 + {"error":{...},"type":"error"} 被 openai-node SDK
 * 反序列化后，在流迭代首帧抛出的 APIError（无 status、type=service_unavailable_error、
 * code=server_is_overloaded）。
 */
function overloadError(): Error {
  return Object.assign(new Error('Our servers are currently overloaded. Please try again later.'), {
    type: 'service_unavailable_error',
    code: 'server_is_overloaded',
  });
}

describe('retryable provider streams', () => {
  it('Responses retries a zero-output overload error thrown on the first stream event', async () => {
    vi.useFakeTimers();
    openaiMocks.responsesCreate
      .mockResolvedValueOnce(
        (async function* () {
          throw overloadError();
        })(),
      )
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

    const promise = client.query('hello');
    await vi.advanceTimersByTimeAsync(3100);

    await expect(promise).resolves.toBe('ok');
    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(2);
    // 历史只保留 user 输入，未污染（响应没产生 output item）。
    expect(client.messages).toHaveLength(1);
    expect(client.messages[0]?.type).toBe('message');
    expect(client.messages[0]?.type === 'message' ? client.messages[0]?.role : '').toBe('user');
  });

  it('Responses does not retry when partial output already streamed before the error', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(
      (async function* () {
        yield { type: 'response.output_text.delta', delta: 'partial' };
        throw overloadError();
      })(),
    );
    const client = new ResponsesClient(options('openai_responses'));

    // 不重试路径没有 timer 参与；若实现错误地重试，第二次 create 会拿到 undefined
    // 并抛出非 overload 错误，最终断言失败。
    await expect(client.query('hello')).rejects.toMatchObject({ code: 'server_is_overloaded' });
    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(1);
  });

  it('Chat Completions retries a zero-output overload error thrown on the first chunk', async () => {
    vi.useFakeTimers();
    openaiMocks.chatCreate
      .mockResolvedValueOnce(
        (async function* () {
          throw overloadError();
        })(),
      )
      .mockResolvedValueOnce(
        streamOf({
          model: 'test-model',
          choices: [{ delta: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    const client = new ChatCompletionsClient(options('openai_chat_completions'));

    const promise = client.query('hello');
    await vi.advanceTimersByTimeAsync(3100);

    await expect(promise).resolves.toBe('ok');
    expect(openaiMocks.chatCreate).toHaveBeenCalledTimes(2);
    // Chat Completions 正常完成会把带 content 的 assistant message 写入历史。
    expect(client.messages).toHaveLength(2);
    expect(client.messages[0]?.role).toBe('user');
    expect(client.messages[1]?.role).toBe('assistant');
    expect(client.messages[1]?.role === 'assistant' ? client.messages[1]?.content : '').toBe('ok');
  });

  it('Chat Completions does not retry after partial output', async () => {
    openaiMocks.chatCreate.mockResolvedValueOnce(
      (async function* () {
        yield { model: 'test-model', choices: [{ delta: { content: 'partial' } }] };
        throw overloadError();
      })(),
    );
    const client = new ChatCompletionsClient(options('openai_chat_completions'));

    await expect(client.query('hello')).rejects.toMatchObject({ code: 'server_is_overloaded' });
    expect(openaiMocks.chatCreate).toHaveBeenCalledTimes(1);
  });

  it('Responses retries when only thinking streamed before the overload error (thinking is discardable)', async () => {
    vi.useFakeTimers();
    openaiMocks.responsesCreate
      .mockResolvedValueOnce(
        (async function* () {
          yield { type: 'response.reasoning_summary_text.delta', delta: 'thinking...' };
          throw overloadError();
        })(),
      )
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
    const onThinking = vi.fn();
    client.onThinking = onThinking;

    const promise = client.query('hello');
    await vi.advanceTimersByTimeAsync(2100);

    await expect(promise).resolves.toBe('ok');
    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(2);
    // 首次尝试的 thinking 已回调（UI 暂存），不因它而放弃重试。
    expect(onThinking).toHaveBeenCalledWith('thinking...');
  });

  it('Responses discards reasoning output items from a failed retry attempt', async () => {
    vi.useFakeTimers();
    openaiMocks.responsesCreate
      .mockResolvedValueOnce(
        (async function* () {
          yield {
            type: 'response.output_item.done',
            output_index: 0,
            item: { id: 'reasoning_1', type: 'reasoning', summary: [], encrypted_content: 'stale' },
          };
          throw overloadError();
        })(),
      )
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

    const promise = client.query('hello');
    await vi.advanceTimersByTimeAsync(2100);

    await expect(promise).resolves.toBe('ok');
    expect(client.messages.some((message) => message.type === 'reasoning')).toBe(false);
  });

  it('Responses does not retry after a function-call argument delta', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(
      (async function* () {
        yield { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' };
        throw overloadError();
      })(),
    );
    const client = new ResponsesClient(options('openai_responses'));

    await expect(client.query('hello')).rejects.toMatchObject({ code: 'server_is_overloaded' });
    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(1);
  });

  it('Chat Completions retries when only thinking streamed before the overload error (thinking is discardable)', async () => {
    vi.useFakeTimers();
    openaiMocks.chatCreate
      .mockResolvedValueOnce(
        (async function* () {
          yield { model: 'test-model', choices: [{ delta: { reasoning_content: 'thinking...' } }] };
          throw overloadError();
        })(),
      )
      .mockResolvedValueOnce(
        streamOf({
          model: 'test-model',
          choices: [{ delta: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    const onThinking = vi.fn();
    client.onThinking = onThinking;

    const promise = client.query('hello');
    await vi.advanceTimersByTimeAsync(2100);

    await expect(promise).resolves.toBe('ok');
    expect(openaiMocks.chatCreate).toHaveBeenCalledTimes(2);
    expect(onThinking).toHaveBeenCalledWith('thinking...');
  });
});

async function* streamOf(...events: unknown[]): AsyncGenerator<unknown> {
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
