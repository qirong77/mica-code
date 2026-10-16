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
 * `preserveAbortedTurn` writes the aborted turn back into the provider history.
 * Once a tool iteration committed, the tail of the history is a tool result —
 * checking "is the last item the question?" then appends the whole turn a second
 * time, which is how a session ends up with the same user/assistant pair twice.
 */
describe('preserveAbortedTurn after a committed iteration', () => {
  it('Responses appends only the partial answer, never the turn again', async () => {
    registerTool(new StubTool('probe_responses_stub'));
    const controller = new AbortController();
    openaiMocks.responsesCreate
      .mockResolvedValueOnce(streamOf(functionCallItem('call-1', 'probe_responses_stub')))
      .mockImplementationOnce(async function* () {
        yield { type: 'response.output_text.delta', delta: 'committed text' };
        controller.abort();
      });

    const client = new ResponsesClient(options('openai_responses'));
    await expect(client.query('fix the greyed out活动', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    // The tool iteration committed the turn; the tail is now a tool result.
    expect(client.messages.at(-1)).toMatchObject({ type: 'function_call_output' });

    expect(client.preserveAbortedTurn('fix the greyed out活动', 'tail text')).toBe(true);

    expect(userMessages(client.messages)).toHaveLength(1);
    expect(client.messages.at(-1)).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: 'tail text',
    });
  });

  it('Chat Completions appends only the partial answer, never the turn again', async () => {
    registerTool(new StubTool('probe_chat_stub'));
    const controller = new AbortController();
    openaiMocks.chatCreate
      .mockResolvedValueOnce(
        streamOf({
          model: 'test-model',
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call-1', function: { name: 'probe_chat_stub', arguments: '{}' } }],
              },
            },
          ],
        }),
      )
      .mockImplementationOnce(async function* () {
        yield { model: 'test-model', choices: [{ delta: { content: 'committed text' } }] };
        controller.abort();
      });

    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    await expect(client.query('fix the greyed out活动', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(client.messages.at(-1)).toMatchObject({ role: 'tool' });

    expect(client.preserveAbortedTurn('fix the greyed out活动', 'tail text')).toBe(true);

    expect(client.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(client.messages.at(-1)).toEqual({ role: 'assistant', content: 'tail text' });
  });

  it('does not re-append the question when the abort happens after the turn completed', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(
      streamOf({ type: 'response.output_text.delta', delta: 'answer' }),
    );
    const client = new ResponsesClient(options('openai_responses'));
    await client.query('hello');

    expect(client.preserveAbortedTurn('hello')).toBe(true);
    expect(userMessages(client.messages)).toHaveLength(1);
  });

  it('keeps recording the turn when the abort landed before any iteration committed', async () => {
    const controller = new AbortController();
    openaiMocks.responsesCreate.mockImplementationOnce(async function* () {
      yield { type: 'response.output_text.delta', delta: 'partial' };
      controller.abort();
    });
    const client = new ResponsesClient(options('openai_responses'));
    await expect(client.query('hello', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    // Nothing was committed, so the turn itself must be written back or the
    // question is lost from the history.
    expect(client.preserveAbortedTurn('hello', 'partial')).toBe(false);
    expect(userMessages(client.messages)).toHaveLength(1);
    expect(client.messages.map((item) => item.type)).toEqual(['message', 'message']);
  });

  it('clears the committed-turn marker when a snapshot is restored', async () => {
    registerTool(new StubTool('probe_restore_stub'));
    const controller = new AbortController();
    openaiMocks.responsesCreate
      .mockResolvedValueOnce(streamOf(functionCallItem('call-1', 'probe_restore_stub')))
      .mockImplementationOnce(async function* () {
        yield { type: 'response.output_text.delta', delta: 'committed text' };
        controller.abort();
      });
    const client = new ResponsesClient(options('openai_responses'));
    await expect(client.query('hello', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(client.preserveAbortedTurn('hello', 'tail text')).toBe(true);
    // A restored snapshot (turn-level retry, resume) belongs to no running turn,
    // so the marker must not survive it.
    client.loadSnapshot(client.getSnapshot());
    expect(client.preserveAbortedTurn('hello')).toBe(false);
  });
});

function userMessages(messages: unknown[]): unknown[] {
  return messages.filter((item) => {
    const candidate = item as { type?: string; role?: string };
    return candidate.type === 'message' && candidate.role === 'user';
  });
}

class StubTool extends MicaTool {
  constructor(name: string) {
    super(name, 'stub test tool', { type: 'object', properties: {} }, { readOnly: true });
  }

  async execute(): Promise<string> {
    return 'tool output';
  }

  onToolUseDisplayText(): string {
    return this.name;
  }
}

function registerTool(tool: MicaTool): void {
  registeredTools.push(tool);
  micaTools.registerRuntime(tool);
}

function functionCallItem(callId: string, name: string) {
  return {
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'function_call', id: `fc-${callId}`, call_id: callId, name, arguments: '{}', status: 'completed' },
  };
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
