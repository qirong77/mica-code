import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
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

  it('streams immediately and does not retry partial output without rollback support', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    openaiMocks.responsesCreate.mockResolvedValueOnce((async function* () {
      yield { type: 'response.output_text.delta', delta: 'partial' };
      await gate;
      throw overloadError();
    })());
    const client = new ResponsesClient(options('openai_responses'));
    const onText = vi.fn();
    client.onText = onText;
    const onRetry = vi.fn();
    const promise = client.query('hello', { onRetry });
    const rejected = expect(promise).rejects.toMatchObject({ code: 'server_is_overloaded' });
    await vi.waitFor(() => expect(onText).toHaveBeenCalledWith('partial'));
    release();
    await rejected;
    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onText.mock.calls).toEqual([['partial']]);
  });

  it('streams each delta and rolls back only the failed attempt before retrying', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    openaiMocks.responsesCreate
      .mockResolvedValueOnce((async function* () {
        yield { type: 'response.output_text.delta', delta: 'partial' };
        await gate;
        throw overloadError();
      })())
      .mockResolvedValueOnce(streamOf(
        { type: 'response.output_text.delta', delta: 'com' },
        { type: 'response.output_text.delta', delta: 'plete' },
        { type: 'response.completed', response: { model: 'test-model' } },
      ));
    const client = new ResponsesClient(options('openai_responses'));
    let visible = 'previous';
    let checkpoint = '';
    client.onTextAttemptStart = () => { checkpoint = visible; };
    client.onTextRollback = () => { visible = checkpoint; };
    client.onText = (delta) => { visible += delta; };
    const promise = client.query('hello');
    await vi.waitFor(() => expect(visible).toBe('previouspartial'));
    release();
    await vi.advanceTimersByTimeAsync(2100);
    await expect(promise).resolves.toBe('complete');
    expect(visible).toBe('previouscomplete');
    expect(JSON.stringify(client.messages)).not.toContain('partial');
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

  it('rejects a chat stream that ends without a finish reason', async () => {
    openaiMocks.chatCreate.mockResolvedValueOnce((async function* () {
      yield { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
      yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    })());
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    await expect(client.query('hello')).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(client.messages).toEqual([]);
    expect(client.usageHistory).toEqual([]);
    expect(openaiMocks.chatCreate).toHaveBeenCalledTimes(1);
  });

  it('rolls back truncated chat text and retries through a terminal choice without delta', async () => {
    vi.useFakeTimers();
    openaiMocks.chatCreate.mockResolvedValueOnce((async function* () {
      yield { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
    })()).mockResolvedValueOnce((async function* () {
      yield { choices: [{ delta: { content: 'complete' }, finish_reason: null }] };
      yield { choices: [{ finish_reason: 'stop' }] };
      yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    })());
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    let visible = '';
    client.onTextAttemptStart = () => {};
    client.onTextRollback = () => { visible = ''; };
    client.onText = (text) => { visible += text; };
    const promise = client.query('hello');
    await vi.advanceTimersByTimeAsync(2100);
    await expect(promise).resolves.toBe('complete');
    expect(visible).toBe('complete');
    expect(client.usageHistory).toHaveLength(1);
    expect(openaiMocks.chatCreate).toHaveBeenCalledTimes(2);
  });

  it.each([null, 'length'])('retries an incomplete chat tool call (finish reason %s) without executing it', async (finishReason) => {
    vi.useFakeTimers();
    const execute = vi.spyOn(micaTools, 'execute');
    try {
      openaiMocks.chatCreate.mockResolvedValueOnce((async function* () {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'partial', function: { name: 'test_tool', arguments: '{"path":' } }] }, finish_reason: finishReason }] };
      })()).mockResolvedValueOnce(streamOf({ choices: [{ delta: { content: 'recovered' } }] }));
      const client = new ChatCompletionsClient(options('openai_chat_completions'));
      client.onTextAttemptStart = () => {};
      client.onTextRollback = () => {};
      const onToolCall = vi.fn();
      client.onToolCall = onToolCall;
      const promise = client.query('hello');
      await vi.advanceTimersByTimeAsync(2100);
      await expect(promise).resolves.toBe('recovered');
      expect(openaiMocks.chatCreate).toHaveBeenCalledTimes(2);
      expect(execute).not.toHaveBeenCalled();
      expect(onToolCall).not.toHaveBeenCalled();
      expect(JSON.stringify(client.messages)).not.toContain('partial');
    } finally {
      execute.mockRestore();
    }
  });

  it.each([false, true])('Responses does not retry after thinking, rollback=%s', async (rollback) => {
    openaiMocks.responsesCreate.mockResolvedValueOnce((async function* () {
      yield { type: 'response.reasoning_summary_text.delta', delta: 'thinking...' };
      throw overloadError();
    })());
    const client = new ResponsesClient(options('openai_responses'));
    const onThinking = vi.fn();
    client.onThinking = onThinking;
    if (rollback) {
      client.onTextAttemptStart = () => {};
      client.onTextRollback = () => {};
    }
    await expect(client.query('hello')).rejects.toMatchObject({ code: 'server_is_overloaded' });
    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(1);
    expect(onThinking.mock.calls).toEqual([['thinking...']]);
  });

  it.each(['responses', 'chat'] as const)('%s restores thinking and text before retry', async (protocol) => {
    vi.useFakeTimers();
    const create = protocol === 'responses' ? openaiMocks.responsesCreate : openaiMocks.chatCreate;
    const reasoning = (text: string) => protocol === 'responses'
      ? { type: 'response.reasoning_summary_text.delta', delta: text }
      : { model: 'test-model', choices: [{ delta: { reasoning_content: text } }] };
    const text = (value: string) => protocol === 'responses'
      ? { type: 'response.output_text.delta', delta: value }
      : { model: 'test-model', choices: [{ delta: { content: value } }] };
    create.mockResolvedValueOnce((async function* () {
      yield reasoning('failed thought');
      yield text('failed text');
      throw overloadError();
    })()).mockResolvedValueOnce(streamOf(
      reasoning('new thought'), text('answer'),
      ...(protocol === 'responses' ? [{ type: 'response.completed', response: { model: 'test-model' } }] : []),
    ));
    const client = protocol === 'responses' ? new ResponsesClient(options('openai_responses')) : new ChatCompletionsClient(options('openai_chat_completions'));
    let visibleText = 'earlier';
    let visibleThought = 'earlier thought';
    let checkpoint = ['', ''];
    client.canRollbackThinking = true;
    client.onTextAttemptStart = () => { checkpoint = [visibleText, visibleThought]; };
    client.onTextRollback = () => { [visibleText, visibleThought] = checkpoint as [string, string]; };
    client.onText = (delta) => { visibleText += delta; };
    client.onThinking = (delta) => { visibleThought += delta; };
    const result = client.query('hello');
    await vi.advanceTimersByTimeAsync(3100);
    await expect(result).resolves.toBe('answer');
    expect(visibleText).toBe('earlieranswer');
    expect(visibleThought).toBe('earlier thoughtnew thought');
    expect(JSON.stringify(client.messages)).not.toContain('failed');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('rejects a truncated Responses stream even without lifecycle events', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf(
      { type: 'response.output_text.delta', delta: 'partial' },
    ));
    const client = new ResponsesClient(options('openai_responses'));
    await expect(client.query('hello')).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(1);
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

  it('Responses discards a failed tool call and retries before executing tools', async () => {
    vi.useFakeTimers();
    const execute = vi.spyOn(micaTools, 'execute').mockResolvedValue('tool result');
    try {
      openaiMocks.responsesCreate
        .mockResolvedValueOnce(
          (async function* () {
            yield {
              type: 'response.output_item.added', output_index: 0,
              item: { type: 'function_call', call_id: 'failed-call', name: 'test_tool', arguments: '' },
            };
            yield { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' };
            throw overloadError();
          })(),
        )
        .mockResolvedValueOnce(
          streamOf(
            { type: 'response.output_text.delta', delta: 'recovered' },
            { type: 'response.completed', response: { model: 'test-model' } },
          ),
        );
      const client = new ResponsesClient(options('openai_responses'));
      client.onTextAttemptStart = () => {};
      client.onTextRollback = () => {};
      const onToolCall = vi.fn();
      client.onToolCall = onToolCall;

      const promise = client.query('hello');
      await vi.advanceTimersByTimeAsync(2100);

      await expect(promise).resolves.toBe('recovered');
      expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(2);
      expect(onToolCall).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(client.messages.some((message) => message.type === 'function_call')).toBe(false);
    } finally {
      execute.mockRestore();
    }
  });

  it('Chat Completions does not retry after thinking', async () => {
    openaiMocks.chatCreate.mockResolvedValueOnce((async function* () {
      yield { model: 'test-model', choices: [{ delta: { reasoning_content: 'thinking...' } }] };
      throw overloadError();
    })());
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    const onThinking = vi.fn();
    client.onThinking = onThinking;
    await expect(client.query('hello')).rejects.toMatchObject({ code: 'server_is_overloaded' });
    expect(openaiMocks.chatCreate).toHaveBeenCalledTimes(1);
    expect(onThinking.mock.calls).toEqual([['thinking...']]);
  });

  it('Responses retries an HTTP 503 rejection from create() (server overloaded at request time)', async () => {
    vi.useFakeTimers();
    // 真实 HTTP 503：openai-node SDK 在 create() 阶段直接抛 InternalServerError，
    // 带 status=503、message 含 "503 " 前缀（不同于 krill 的 200+JSON 迭代抛错形态）。
    const http503 = Object.assign(new Error('503 Our servers are currently overloaded. Please try again later.'), {
      status: 503,
    });
    openaiMocks.responsesCreate
      .mockRejectedValueOnce(http503)
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
    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(2);
  });

  it('Chat Completions retries an HTTP 503 rejection from create()', async () => {
    vi.useFakeTimers();
    const http503 = Object.assign(new Error('503 Our servers are currently overloaded. Please try again later.'), {
      status: 503,
    });
    openaiMocks.chatCreate
      .mockRejectedValueOnce(http503)
      .mockResolvedValueOnce(
        streamOf({
          model: 'test-model',
          choices: [{ delta: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    const client = new ChatCompletionsClient(options('openai_chat_completions'));

    const promise = client.query('hello');
    await vi.advanceTimersByTimeAsync(2100);

    await expect(promise).resolves.toBe('ok');
    expect(openaiMocks.chatCreate).toHaveBeenCalledTimes(2);
  });
});

async function* streamOf(...events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) yield event;
  // Successful chat fixtures include a terminal choice.
  if (events.some((event) => typeof event === 'object' && event !== null && 'choices' in event)) {
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
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
