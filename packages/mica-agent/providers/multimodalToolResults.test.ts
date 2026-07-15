import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { ChatCompletionsClient } from './ChatCompletionsClient.js';
import { ResponsesClient } from './ResponsesClient.js';
import { ResponsesHistoryNormalizer } from './ResponsesHistoryNormalizer.js';
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

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'mica-provider-image-'));
  imagePath = join(tempDir, 'sample.png');
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer();
  writeFileSync(imagePath, png);
});

afterEach(() => {
  openaiMocks.chatCreate.mockReset();
  openaiMocks.responsesCreate.mockReset();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('multimodal tool results', () => {
  it('adds Chat Completions images after the text tool result in a user message', async () => {
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
        return Promise.resolve(
          streamOf({ model: 'test-model', choices: [{ delta: { content: 'I can see the image.' } }] }),
        );
      });
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    const displayedResults: string[] = [];
    client.onToolResult = (_name, result) => displayedResults.push(result);

    await expect(client.query(`Inspect ${imagePath}`)).resolves.toBe('I can see the image.');

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
    expect(JSON.stringify(secondRequest.messages[3])).not.toContain('data:image');
    expect(JSON.stringify(secondRequest.messages[4])).toContain('data:image/png;base64,');
    expect(displayedResults).toHaveLength(1);
    expect(displayedResults[0]).not.toContain('data:image');
  });

  it('uses a native multimodal function_call_output for Responses', async () => {
    const args = JSON.stringify({ source: imagePath });
    openaiMocks.responsesCreate
      .mockResolvedValueOnce(
        streamOf({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc-image',
            call_id: 'call-image',
            name: 'read_image',
            arguments: args,
            status: 'completed',
          },
        }),
      )
      .mockResolvedValueOnce(streamOf({ type: 'response.output_text.delta', delta: 'I can see the image.' }));
    const client = new ResponsesClient(options('openai_responses'));
    const displayedResults: string[] = [];
    client.onToolResult = (_name, result) => displayedResults.push(result);

    await expect(client.query(`Inspect ${imagePath}`)).resolves.toBe('I can see the image.');

    const secondRequest = openaiMocks.responsesCreate.mock.calls[1]![0] as {
      input: Array<{ type: string; output?: unknown }>;
    };
    expect(secondRequest.input.map((item) => item.type)).toEqual(['message', 'function_call', 'function_call_output']);
    const output = secondRequest.input[2]?.output;
    expect(Array.isArray(output)).toBe(true);
    expect(JSON.stringify(output)).toContain('"type":"input_image"');
    expect(JSON.stringify(output)).toContain('data:image/png;base64,');
    expect(displayedResults).toHaveLength(1);
    expect(displayedResults[0]).not.toContain('data:image');
  });

  it('keeps all Chat tool results before a synthetic image message for parallel calls', async () => {
    let secondRequestSnapshot: unknown;
    const toolCalls = ['call-image-1', 'call-image-2'].map((id, index) => ({
      index,
      id,
      function: { name: 'read_image', arguments: JSON.stringify({ source: imagePath }) },
    }));
    openaiMocks.chatCreate
      .mockResolvedValueOnce(
        streamOf({
          model: 'test-model',
          choices: [{ delta: { tool_calls: toolCalls } }],
        }),
      )
      .mockImplementationOnce((request: unknown) => {
        secondRequestSnapshot = structuredClone(request);
        return Promise.resolve(streamOf({ model: 'test-model', choices: [{ delta: { content: 'done' } }] }));
      });

    await new ChatCompletionsClient(options('openai_chat_completions')).query('Inspect both images');

    const secondRequest = secondRequestSnapshot as {
      messages: Array<{ role: string; content?: unknown }>;
    };
    expect(secondRequest.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    const imageMessage = JSON.stringify(secondRequest.messages[5]);
    expect(imageMessage.match(/data:image\/png;base64,/g)).toHaveLength(2);
  });

  it('normalizes Responses image outputs without copying base64 into display text', () => {
    const [item] = new ResponsesHistoryNormalizer().normalize([
      {
        type: 'function_call_output',
        call_id: 'call-image',
        output: [
          { type: 'input_text', text: 'Image loaded' },
          { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,secret-image-data' },
        ],
      },
    ]);

    expect(item?.type).toBe('tool_result');
    expect(item?.type === 'tool_result' ? item.content : '').toBe('Image loaded\n[Image]');
    expect(item?.type === 'tool_result' ? item.content : '').not.toContain('secret-image-data');
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
