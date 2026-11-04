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
