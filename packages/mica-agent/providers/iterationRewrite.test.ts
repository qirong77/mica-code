import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { MicaTool, micaTools } from '@packages/mica-tools/index.js';
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

const registeredTools: MicaTool[] = [];

afterEach(() => {
  openaiMocks.chatCreate.mockReset();
  openaiMocks.responsesCreate.mockReset();
  for (const tool of registeredTools.splice(0)) micaTools.unregisterRuntime(tool);
});

/**
 * `rewriteIterationMessages` is the only point where a context reduction
 * (automatic compaction) can reach the rest of the turn: the query loop keeps
 * its own message array and never rebuilds it from `client.messages`.
 */
describe('iteration boundary message rewrite', () => {
  it('Chat Completions continues with the rewritten messages and keeps the system prompt first', async () => {
    registerTool(new ProbeTool('probe_rewrite'));
    let secondRequest: { messages: Array<{ role: string; content?: unknown; tool_call_id?: string }> } | undefined;
    openaiMocks.chatCreate
      .mockResolvedValueOnce(
        streamOf({
          model: 'test-model',
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call-x', function: { name: 'probe_rewrite', arguments: '{}' } }],
              },
            },
          ],
        }),
      )
      .mockImplementationOnce((request: unknown) => {
        secondRequest = structuredClone(request) as never;
        return Promise.resolve(streamOf({ model: 'test-model', choices: [{ delta: { content: 'done' } }] }));
      });

    const seen: Array<Array<{ role: string }>> = [];
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    await client.query('rewrite my history', {
      rewriteIterationMessages: (messages) => {
        const cast = messages as Array<{ role: string; content?: unknown }>;
        seen.push(cast.map((message) => ({ role: message.role })));
        return cast.map((message) => (message.role === 'tool' ? { ...message, content: '[cleared]' } : message));
      },
    });

    // The hook sees session messages only; the system prompt is assembled
    // separately so a rewrite can never drop it.
    expect(seen[0]).toEqual([{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }]);
    expect(secondRequest?.messages[0]?.role).toBe('system');
    const toolMessages = (secondRequest?.messages ?? []).filter((message) => message.role === 'tool');
    expect(toolMessages.map((message) => message.content)).toEqual(['[cleared]']);
    // The committed snapshot follows the rewrite, so the compaction is persisted.
    expect(client.messages.filter((message) => message.role === 'tool').map((message) => message.content)).toEqual([
      '[cleared]',
    ]);
  });

  it('Chat Completions leaves the messages untouched when the hook returns null', async () => {
    registerTool(new ProbeTool('probe_null'));
    let secondRequest: { messages: Array<{ role: string; content?: unknown }> } | undefined;
    openaiMocks.chatCreate
      .mockResolvedValueOnce(
        streamOf({
          model: 'test-model',
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call-n', function: { name: 'probe_null', arguments: '{}' } }],
              },
            },
          ],
        }),
      )
      .mockImplementationOnce((request: unknown) => {
        secondRequest = structuredClone(request) as never;
        return Promise.resolve(streamOf({ model: 'test-model', choices: [{ delta: { content: 'done' } }] }));
      });

    await new ChatCompletionsClient(options('openai_chat_completions')).query('keep everything', {
      rewriteIterationMessages: () => null,
    });

    const toolMessages = (secondRequest?.messages ?? []).filter((message) => message.role === 'tool');
    expect(toolMessages.map((message) => message.content)).toEqual(['probe_null output']);
  });

  it('Responses continues with the rewritten input items (system prompt stays in instructions)', async () => {
    registerTool(new ProbeTool('probe_responses'));
    openaiMocks.responsesCreate
      .mockResolvedValueOnce(
        streamOf({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc-1',
            call_id: 'call-r',
            name: 'probe_responses',
            arguments: '{}',
            status: 'completed',
          },
        }),
      )
      .mockResolvedValueOnce(streamOf({ type: 'response.output_text.delta', delta: 'done' }));

    const seen: Array<Array<{ type?: string }>> = [];
    const client = new ResponsesClient(options('openai_responses'));
    await client.query('rewrite my history', {
      rewriteIterationMessages: (messages) => {
        const cast = messages as Array<{ type?: string }>;
        seen.push(cast.map((item) => ({ type: item.type })));
        return cast.map((item) =>
          item.type === 'function_call_output' ? { ...item, output: '[cleared]' } : item,
        );
      },
    });

    expect(seen[0]).toEqual([{ type: 'message' }, { type: 'function_call' }, { type: 'function_call_output' }]);
    const secondRequest = openaiMocks.responsesCreate.mock.calls[1]![0] as {
      instructions?: string;
      input: Array<{ type: string; output?: unknown }>;
    };
    const outputs = secondRequest.input.filter((item) => item.type === 'function_call_output');
    expect(outputs.map((item) => item.output)).toEqual(['[cleared]']);
    expect(typeof secondRequest.instructions).toBe('string');
  });
});

class ProbeTool extends MicaTool {
  constructor(name: string) {
    super(name, 'scripted test tool', { type: 'object', properties: {} }, { readOnly: true });
  }

  async execute(): Promise<string> {
    return `${this.name} output`;
  }

  onToolUseDisplayText(): string {
    return this.name;
  }
}

function registerTool(tool: MicaTool): void {
  registeredTools.push(tool);
  micaTools.registerRuntime(tool);
}

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
