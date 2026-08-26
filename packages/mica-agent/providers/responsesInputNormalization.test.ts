import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { ResponsesClient } from './ResponsesClient.js';
import type { ModelClientOptions } from './types.js';

const openaiMocks = vi.hoisted(() => ({
  responsesCreate: vi.fn(),
}));

vi.mock('openai', () => ({
  OpenAI: class MockOpenAI {
    responses = { create: openaiMocks.responsesCreate };
  },
}));

afterEach(() => {
  openaiMocks.responsesCreate.mockReset();
});

describe('Responses input normalization', () => {
  it('strips server-side-only fields from output items replayed into the next request', async () => {
    openaiMocks.responsesCreate
      .mockResolvedValueOnce(
        streamOf(
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'reasoning',
              id: 'r-1',
              status: 'completed',
              summary: [],
              content: [{ type: 'reasoning_text', text: 'thinking' }],
              encrypted_content: 'enc-1',
            },
          },
          {
            type: 'response.output_item.done',
            output_index: 1,
            item: {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              phase: 'commentary',
              id: 'msg-1',
              content: [{ type: 'output_text', text: 'first reply', annotations: [] }],
            },
          },
        ),
      )
      .mockResolvedValueOnce(streamOf({ type: 'response.output_text.delta', delta: 'second reply' }));
    const client = new ResponsesClient(options('openai_responses'));

    await expect(client.query('first')).resolves.toBe('first reply');
    await expect(client.query('second')).resolves.toBe('second reply');

    const request = openaiMocks.responsesCreate.mock.calls[1]![0] as {
      input: Array<Record<string, unknown>>;
    };
    const input = request.input;
    expect(input.map((item) => item.type)).toEqual(['message', 'reasoning', 'message', 'message']);

    const reasoning = input[1]!;
    expect(reasoning.type).toBe('reasoning');
    expect(reasoning).not.toHaveProperty('status');
    expect(reasoning).not.toHaveProperty('id');
    expect(reasoning.encrypted_content).toBe('enc-1');

    const assistant = input[2]!;
    expect(assistant.type).toBe('message');
    expect(assistant.role).toBe('assistant');
    expect(assistant).not.toHaveProperty('status');
    expect(assistant).not.toHaveProperty('id');
    expect(assistant).not.toHaveProperty('phase');

    const user = input[3]!;
    expect(user).not.toHaveProperty('status');
    expect(JSON.stringify(input)).not.toContain('"status"');
  });

  it('normalizes legacy snapshots on resume before sending them on the wire', async () => {
    const client = new ResponsesClient(options('openai_responses'));
    client.loadSnapshot({
      model: 'test-model',
      messages: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] },
        {
          type: 'reasoning',
          id: 'r-9',
          status: 'completed',
          summary: [],
          content: [{ type: 'reasoning_text', text: 't' }],
          encrypted_content: 'enc-9',
        },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          phase: 'commentary',
          id: 'm-9',
          content: [{ type: 'output_text', text: 'reply', annotations: [] }],
        },
      ],
      usageHistory: [],
      lastUsage: undefined,
      conversationMessages: [],
    });

    let captured: unknown;
    openaiMocks.responsesCreate.mockImplementationOnce((request: unknown) => {
      captured = request;
      return Promise.resolve(streamOf({ type: 'response.output_text.delta', delta: 'ok' }));
    });

    await client.query('next');

    const input = (captured as { input: Array<Record<string, unknown>> }).input;
    expect(input.map((item) => item.type)).toEqual(['message', 'reasoning', 'message', 'message']);
    expect(input[1]).not.toHaveProperty('status');
    expect(input[1]).not.toHaveProperty('id');
    expect(input[1]!.encrypted_content).toBe('enc-9');
    expect(input[2]).not.toHaveProperty('status');
    expect(input[2]).not.toHaveProperty('id');
    expect(input[2]).not.toHaveProperty('phase');
    expect(JSON.stringify(input)).not.toContain('"status"');
  });

  it('keeps a valid rs_ prefixed reasoning id on the wire', async () => {
    openaiMocks.responsesCreate
      .mockResolvedValueOnce(
        streamOf({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'reasoning',
            id: 'rs_abcdef',
            status: 'completed',
            summary: [],
            content: [{ type: 'reasoning_text', text: 'thinking' }],
            encrypted_content: 'enc-2',
          },
        }),
      )
      .mockResolvedValueOnce(streamOf({ type: 'response.output_text.delta', delta: 'second reply' }));
    const client = new ResponsesClient(options('openai_responses'));

    await expect(client.query('first')).resolves.toBe('');
    await expect(client.query('second')).resolves.toBe('second reply');

    const request = openaiMocks.responsesCreate.mock.calls[1]![0] as {
      input: Array<Record<string, unknown>>;
    };
    const reasoning = request.input.find((item) => item.type === 'reasoning')!;
    expect(reasoning.id).toBe('rs_abcdef');
    expect(reasoning).not.toHaveProperty('status');
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
