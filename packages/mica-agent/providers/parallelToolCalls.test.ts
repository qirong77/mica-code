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

describe('parallel provider tool calls', () => {
  it('runs consecutive read-only Chat Completions calls concurrently and keeps result order', async () => {
    const events: string[] = [];
    const gate = createGate(2);
    registerTool(new ScriptedTool('probe_read_a', true, { events, gate, output: 'output-a' }));
    registerTool(new ScriptedTool('probe_read_b', true, { events, gate, output: 'output-b' }));

    let secondRequest: { messages: Array<{ role: string; tool_call_id?: string; content?: unknown }> } | undefined;
    openaiMocks.chatCreate
      .mockResolvedValueOnce(
        streamOf({
          model: 'test-model',
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-a', function: { name: 'probe_read_a', arguments: '{}' } },
                  { index: 1, id: 'call-b', function: { name: 'probe_read_b', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
      )
      .mockImplementationOnce((request: unknown) => {
        secondRequest = structuredClone(request) as never;
        return Promise.resolve(streamOf({ model: 'test-model', choices: [{ delta: { content: 'done' } }] }));
      });

    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    const callbacks: string[] = [];
    client.onToolCall = (_name, _args, id) => callbacks.push(`call:${id}`);
    client.onToolResult = (_name, _result, id) => callbacks.push(`result:${id}`);

    const query = client.query('probe both');
    const outcome = await Promise.race([query.then(() => 'completed'), delay(2_000).then(() => 'timeout')]);
    gate.release();
    expect(outcome).toBe('completed');
    await query;

    expect(events.slice(0, 2)).toEqual(['start:probe_read_a', 'start:probe_read_b']);
    expect(events.slice(2).sort()).toEqual(['finish:probe_read_a', 'finish:probe_read_b']);
    expect(callbacks.slice(0, 2).sort()).toEqual(['call:call-a', 'call:call-b']);
    expect(callbacks.slice(2).sort()).toEqual(['result:call-a', 'result:call-b']);

    const toolMessages = (secondRequest?.messages ?? []).filter((message) => message.role === 'tool');
    expect(toolMessages.map((message) => [message.tool_call_id, message.content])).toEqual([
      ['call-a', 'output-a'],
      ['call-b', 'output-b'],
    ]);
  });

  it('keeps non-read-only Chat Completions calls as serial barriers', async () => {
    const events: string[] = [];
    registerTool(new ScriptedTool('probe_write', false, { events, output: 'written' }));
    registerTool(new ScriptedTool('probe_read', true, { events, output: 'read' }));

    let secondRequest: { messages: Array<{ role: string; tool_call_id?: string; content?: unknown }> } | undefined;
    openaiMocks.chatCreate
      .mockResolvedValueOnce(
        streamOf({
          model: 'test-model',
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-write', function: { name: 'probe_write', arguments: '{}' } },
                  { index: 1, id: 'call-read', function: { name: 'probe_read', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
      )
      .mockImplementationOnce((request: unknown) => {
        secondRequest = structuredClone(request) as never;
        return Promise.resolve(streamOf({ model: 'test-model', choices: [{ delta: { content: 'done' } }] }));
      });

    await new ChatCompletionsClient(options('openai_chat_completions')).query('write then read');

    expect(events).toEqual([
      'start:probe_write',
      'finish:probe_write',
      'start:probe_read',
      'finish:probe_read',
    ]);
    const toolMessages = (secondRequest?.messages ?? []).filter((message) => message.role === 'tool');
    expect(toolMessages.map((message) => [message.tool_call_id, message.content])).toEqual([
      ['call-write', 'written'],
      ['call-read', 'read'],
    ]);
  });

  it('runs Agent calls concurrently even though the tool is not read-only', async () => {
    const events: string[] = [];
    const gate = createGate(2);
    registerTool(new ScriptedTool('Agent', false, { events, gate, output: 'task_id: probe' }));

    openaiMocks.chatCreate
      .mockResolvedValueOnce(
        streamOf({
          model: 'test-model',
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-agent-1', function: { name: 'Agent', arguments: '{}' } },
                  { index: 1, id: 'call-agent-2', function: { name: 'Agent', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(streamOf({ model: 'test-model', choices: [{ delta: { content: 'done' } }] }));

    const query = new ChatCompletionsClient(options('openai_chat_completions')).query('delegate twice');
    const outcome = await Promise.race([query.then(() => 'completed'), delay(2_000).then(() => 'timeout')]);
    gate.release();
    expect(outcome).toBe('completed');
    await query;

    expect(events.slice(0, 2)).toEqual(['start:Agent', 'start:Agent']);
    expect(events).toHaveLength(4);
  });

  it('runs consecutive read-only Responses calls concurrently and keeps output order', async () => {
    const events: string[] = [];
    const gate = createGate(2);
    registerTool(new ScriptedTool('probe_read_a', true, { events, gate, output: 'output-a' }));
    registerTool(new ScriptedTool('probe_read_b', true, { events, gate, output: 'output-b' }));

    openaiMocks.responsesCreate
      .mockResolvedValueOnce(
        streamOf(
          functionCallItem(0, 'call-a', 'probe_read_a'),
          functionCallItem(1, 'call-b', 'probe_read_b'),
        ),
      )
      .mockResolvedValueOnce(streamOf({ type: 'response.output_text.delta', delta: 'done' }));

    const client = new ResponsesClient(options('openai_responses'));
    const query = client.query('probe both');
    const outcome = await Promise.race([query.then(() => 'completed'), delay(2_000).then(() => 'timeout')]);
    gate.release();
    expect(outcome).toBe('completed');
    await query;

    expect(events.slice(0, 2)).toEqual(['start:probe_read_a', 'start:probe_read_b']);
    expect(events.slice(2).sort()).toEqual(['finish:probe_read_a', 'finish:probe_read_b']);

    const secondRequest = openaiMocks.responsesCreate.mock.calls[1]![0] as {
      input: Array<{ type: string; call_id?: string; output?: unknown }>;
    };
    const outputs = secondRequest.input.filter((item) => item.type === 'function_call_output');
    expect(outputs.map((item) => [item.call_id, item.output])).toEqual([
      ['call-a', 'output-a'],
      ['call-b', 'output-b'],
    ]);
  });
});

type ScriptedToolOptions = {
  events: string[];
  output?: string;
  gate?: Gate;
};

class ScriptedTool extends MicaTool {
  constructor(
    name: string,
    readOnly: boolean,
    private readonly script: ScriptedToolOptions,
  ) {
    super(name, 'scripted test tool', { type: 'object', properties: {} }, { readOnly });
  }

  async execute(): Promise<string> {
    this.script.events.push(`start:${this.name}`);
    if (this.script.gate) await this.script.gate.wait();
    this.script.events.push(`finish:${this.name}`);
    return this.script.output ?? `${this.name} output`;
  }

  onToolUseDisplayText(): string {
    return this.name;
  }
}

type Gate = {
  wait(): Promise<void>;
  release(): void;
};

/** Blocks every call until `expected` calls have started, so serial execution deadlocks. */
function createGate(expected: number): Gate {
  const resolvers: Array<() => void> = [];
  let started = 0;
  const release = () => {
    for (const resolve of resolvers.splice(0)) resolve();
  };
  return {
    async wait() {
      started++;
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
        if (started >= expected) release();
      });
    },
    release,
  };
}

function registerTool(tool: MicaTool): void {
  registeredTools.push(tool);
  micaTools.registerRuntime(tool);
}

function functionCallItem(outputIndex: number, callId: string, name: string) {
  return {
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: { type: 'function_call', id: `fc-${callId}`, call_id: callId, name, arguments: '{}', status: 'completed' },
  };
}

function delay(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
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
