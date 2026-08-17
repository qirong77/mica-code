import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import type { AgentContentBlockParam } from '../core/Agent.js';
import { ChatCompletionsClient } from './ChatCompletionsClient.js';
import { ResponsesClient } from './ResponsesClient.js';
import { imageOmittedPlaceholder } from './imagePlaceholder.js';
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

let tempDir: string;
let imagePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mica-provider-no-vision-'));
  imagePath = join(tempDir, 'sample.png');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgEpH7D8IMMAYAJowE7bwlVOYAAAAASUVORK5CYII=',
    'base64',
  );
  writeFileSync(imagePath, png);
});

afterEach(() => {
  openaiMocks.chatCreate.mockReset();
  openaiMocks.responsesCreate.mockReset();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('imageOmittedPlaceholder', () => {
  it('explains the omission to the user and instructs the model to state it', () => {
    const text = imageOmittedPlaceholder('text-model');
    expect(text).toContain('text-model');
    expect(text).toContain('不支持图片输入');
    expect(text).toContain('告知用户');
    expect(text).not.toContain('data:image');
  });
});

describe('text-only models omit images on the wire', () => {
  it('Chat Completions: user image blocks become a placeholder, history keeps the original', async () => {
    openaiMocks.chatCreate.mockResolvedValueOnce(
      streamOf({ model: 'test-model', choices: [{ delta: { content: 'ok' } }] }),
    );
    const client = new ChatCompletionsClient(options('openai_chat_completions', { supportsVision: false }));

    await client.query([{ type: 'text', text: '看图' }, imageBlock()]);

    const request = openaiMocks.chatCreate.mock.calls[0]![0] as { messages: unknown[] };
    expect(JSON.stringify(request.messages)).not.toContain('data:image');
    expect(JSON.stringify(request.messages)).toContain('图片已省略');
    // The persisted conversation keeps the original base64 image for a later
    // switch back to a vision-capable model.
    expect(JSON.stringify(client.messages[0])).toContain('data:image/png;base64,');
  });

  it('Chat Completions: read_image tool results are stripped before the next request', async () => {
    let secondRequestSnapshot: unknown;
    openaiMocks.chatCreate
      .mockResolvedValueOnce(
        streamOf({
          model: 'test-model',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-image',
                    function: { name: 'read_image', arguments: JSON.stringify({ source: imagePath }) },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockImplementationOnce((request: unknown) => {
        secondRequestSnapshot = structuredClone(request);
        return Promise.resolve(streamOf({ model: 'test-model', choices: [{ delta: { content: 'done' } }] }));
      });
    const client = new ChatCompletionsClient(options('openai_chat_completions', { supportsVision: false }));
    const displayedResults: string[] = [];
    client.onToolResult = (_name, result) => displayedResults.push(result);

    await expect(client.query(`Inspect ${imagePath}`)).resolves.toBe('done');

    const secondRequest = secondRequestSnapshot as {
      messages: Array<{ role: string; content?: unknown }>;
    };
    expect(secondRequest.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(JSON.stringify(secondRequest.messages)).not.toContain('data:image');
    expect(JSON.stringify(secondRequest.messages[4])).toContain('图片已省略');
    expect(displayedResults).toHaveLength(1);
    expect(displayedResults[0]).not.toContain('data:image');
  });

  it('Responses: user image blocks become a placeholder, history keeps the original', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf({ type: 'response.output_text.delta', delta: 'ok' }));
    const client = new ResponsesClient(options('openai_responses', { supportsVision: false }));

    await client.query([{ type: 'text', text: '看图' }, imageBlock()]);

    const request = openaiMocks.responsesCreate.mock.calls[0]![0] as { input: unknown[] };
    expect(JSON.stringify(request.input)).not.toContain('"type":"input_image"');
    expect(JSON.stringify(request.input)).not.toContain('data:image');
    expect(JSON.stringify(request.input)).toContain('图片已省略');
    expect(JSON.stringify(client.messages[0])).toContain('"type":"input_image"');
  });

  it('Responses: images in restored history are stripped on the wire but kept in memory', async () => {
    const client = new ResponsesClient(options('openai_responses', { supportsVision: false }));
    client.loadSnapshot({
      model: 'test-model',
      messages: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '请看旧图' },
            { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,c2VjcmV0LWltYWdl' },
          ],
        },
      ],
      usageHistory: [],
      lastUsage: undefined,
      conversationMessages: [],
    });
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf({ type: 'response.output_text.delta', delta: 'ok' }));

    await client.query('继续');

    const request = openaiMocks.responsesCreate.mock.calls[0]![0] as { input: unknown[] };
    expect(JSON.stringify(request.input)).not.toContain('"type":"input_image"');
    expect(JSON.stringify(request.input)).toContain('图片已省略');
    expect(JSON.stringify(client.messages[0])).toContain('data:image/png;base64,c2VjcmV0');
  });

  it('defaults to vision-capable and keeps images on the wire', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf({ type: 'response.output_text.delta', delta: 'ok' }));
    const client = new ResponsesClient(options('openai_responses'));

    await client.query([{ type: 'text', text: '看图' }, imageBlock()]);

    const request = openaiMocks.responsesCreate.mock.calls[0]![0] as { input: unknown[] };
    expect(JSON.stringify(request.input)).toContain('"type":"input_image"');
  });
});

function imageBlock(): AgentContentBlockParam {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'c2VjcmV0LWltYWdl' },
  };
}

async function* streamOf(...events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) yield event;
}

function options(protocol: ProviderProtocol, extra: Partial<ModelClientOptions> = {}): ModelClientOptions {
  return {
    model: 'test-model',
    apiKey: 'test-key',
    baseURL: 'https://example.com/v1',
    provider: {
      id: 'test',
      api_base: 'https://example.com/v1',
      protocol,
    },
    ...extra,
  };
}
