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

describe('aborted provider streams', () => {
  it('Chat Completions aborted while waiting for the next chunk throws AbortError without polluting history', async () => {
    const controller = new AbortController();
    // The OpenAI SDK swallows the AbortError raised while waiting for the next
    // chunk and ends the stream normally. The abort only surfaces through the
    // signal, so the stream yields one chunk and then simply returns.
    openaiMocks.chatCreate.mockResolvedValueOnce(
      (async function* () {
        yield { model: 'test-model', choices: [{ delta: { reasoning_content: 'thinking...' } }] };
        controller.abort();
      })(),
    );
    const client = new ChatCompletionsClient(options('openai_chat_completions'));

    await expect(client.query('hello', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(client.messages).toEqual([]);
  });

  it('Responses aborted while waiting for the next event throws AbortError without polluting history', async () => {
    const controller = new AbortController();
    openaiMocks.responsesCreate.mockResolvedValueOnce(
      (async function* () {
        yield { type: 'response.reasoning_summary_text.delta', delta: 'thinking...' };
        controller.abort();
      })(),
    );
    const client = new ResponsesClient(options('openai_responses'));

    await expect(client.query('hello', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(client.messages).toEqual([]);
  });

  it('Chat Completions response with reasoning but no text does not commit an empty assistant message', async () => {
    openaiMocks.chatCreate.mockResolvedValueOnce(
      streamOf({ model: 'test-model', choices: [{ delta: { reasoning_content: 'deep thinking' } }] }),
    );
    const client = new ChatCompletionsClient(options('openai_chat_completions'));

    await expect(client.query('hello')).resolves.toBe('');
    expect(client.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('Responses empty assistant output item is filtered out of history', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(
      streamOf({
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', role: 'assistant', status: 'completed', content: [], id: 'msg-empty' },
      }),
    );
    const client = new ResponsesClient(options('openai_responses'));

    await expect(client.query('hello')).resolves.toBe('');
    expect(client.messages).toHaveLength(1);
    expect(client.messages[0]?.type).toBe('message');
    expect(client.messages[0]?.type === 'message' ? client.messages[0]?.role : '').toBe('user');
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
