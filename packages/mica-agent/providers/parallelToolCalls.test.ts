import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { MicaTool, micaTools, type ToolInput } from '@packages/mica-tools/index.js';
import { ChatCompletionsClient } from './ChatCompletionsClient.js';
import { ResponsesClient } from './ResponsesClient.js';
import type { ModelClientOptions } from './types.js';
import { executeProviderToolCalls } from './providerHelpers.js';

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

    expect(events).toEqual(['start:probe_write', 'finish:probe_write', 'start:probe_read', 'finish:probe_read']);
    const toolMessages = (secondRequest?.messages ?? []).filter((message) => message.role === 'tool');
    expect(toolMessages.map((message) => [message.tool_call_id, message.content])).toEqual([
      ['call-write', 'written'],
      ['call-read', 'read'],
    ]);
  });

  it('overlaps an overlappable wait with the calls that follow it', async () => {
    const events: string[] = [];
    // 两个调用都要等对方起来才放行：串行执行必然死锁，只有重叠才能跑完。
    const gate = createGate(2);
    registerTool(new ScriptedTool('probe_wait', false, { events, gate, overlappable: true, output: 'waited' }));
    registerTool(new ScriptedTool('probe_write', false, { events, gate, output: 'written' }));

    let secondRequest: { messages: Array<{ role: string; tool_call_id?: string; content?: unknown }> } | undefined;
    openaiMocks.chatCreate
      .mockResolvedValueOnce(
        streamOf({
          model: 'test-model',
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-wait', function: { name: 'probe_wait', arguments: '{}' } },
                  { index: 1, id: 'call-write', function: { name: 'probe_write', arguments: '{}' } },
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

    const query = new ChatCompletionsClient(options('openai_chat_completions')).query('wait while writing');
    const outcome = await Promise.race([query.then(() => 'completed'), delay(2_000).then(() => 'timeout')]);
    gate.release();
    expect(outcome).toBe('completed');
    await query;

    expect(events.slice(0, 2)).toEqual(['start:probe_wait', 'start:probe_write']);
    expect(events.slice(2).sort()).toEqual(['finish:probe_wait', 'finish:probe_write']);
    const toolMessages = (secondRequest?.messages ?? []).filter((message) => message.role === 'tool');
    expect(toolMessages.map((message) => [message.tool_call_id, message.content])).toEqual([
      ['call-wait', 'waited'],
      ['call-write', 'written'],
    ]);
  });

  it('runs Agent calls concurrently even though the tool is not read-only', async () => {
    const events: string[] = [];
    const gate = createGate(2);
    registerTool(new ScriptedTool('agent', false, { events, gate, output: 'task_id: probe' }));

    openaiMocks.chatCreate
      .mockResolvedValueOnce(
        streamOf({
          model: 'test-model',
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-agent-1', function: { name: 'agent', arguments: '{}' } },
                  { index: 1, id: 'call-agent-2', function: { name: 'agent', arguments: '{}' } },
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

    expect(events.slice(0, 2)).toEqual(['start:agent', 'start:agent']);
    expect(events).toHaveLength(4);
  });

  it.each([
    ['openai_chat_completions', 'await'],
    ['openai_chat_completions', 'join'],
    ['openai_responses', 'await'],
    ['openai_responses', 'join'],
  ] as const)('overlaps agent %s %s after a read batch with a following write', async (protocol, operation) => {
    const events: string[] = [];
    const gate = createGate(2);
    registerTool(new ScriptedTool('probe_read', true, { events, output: 'read' }));
    registerTool(
      new ScriptedTool('agent', false, { events, gate, overlapOperations: ['await', 'join'], output: 'joined' }),
    );
    registerTool(new ScriptedTool('probe_write', false, { events, gate, output: 'written' }));
    const calls = [
      { id: 'call-read', name: 'probe_read', args: '{}' },
      { id: 'call-agent', name: 'agent', args: JSON.stringify({ operation, task_ids: ['agent-task-test'] }) },
      { id: 'call-write', name: 'probe_write', args: '{}' },
    ];
    if (protocol === 'openai_chat_completions') {
      openaiMocks.chatCreate
        .mockResolvedValueOnce(
          streamOf({
            choices: [
              {
                delta: {
                  tool_calls: calls.map((call, index) => ({
                    index,
                    id: call.id,
                    function: { name: call.name, arguments: call.args },
                  })),
                },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(streamOf({ choices: [{ delta: { content: 'done' } }] }));
    } else {
      openaiMocks.responsesCreate
        .mockResolvedValueOnce(
          streamOf(...calls.map((call, index) => functionCallItem(index, call.id, call.name, call.args))),
        )
        .mockResolvedValueOnce(streamOf({ type: 'response.output_text.delta', delta: 'done' }));
    }
    const client =
      protocol === 'openai_chat_completions'
        ? new ChatCompletionsClient(options(protocol))
        : new ResponsesClient(options(protocol));
    const query = client.query('wait for subagent while writing');
    const outcome = await Promise.race([query.then(() => 'completed'), delay(2_000).then(() => 'timeout')]);
    gate.release();
    await query;
    expect(outcome).toBe('completed');
    expect(events.slice(0, 4)).toEqual(['start:probe_read', 'finish:probe_read', 'start:agent', 'start:probe_write']);
    if (protocol === 'openai_chat_completions') {
      const request = openaiMocks.chatCreate.mock.calls[1]![0];
      expect(
        request.messages
          .filter((m: { role: string }) => m.role === 'tool')
          .map((m: { tool_call_id: string; content: string }) => [m.tool_call_id, m.content]),
      ).toEqual([
        ['call-read', 'read'],
        ['call-agent', 'joined'],
        ['call-write', 'written'],
      ]);
    } else {
      const request = openaiMocks.responsesCreate.mock.calls[1]![0];
      expect(
        request.input
          .filter((m: { type: string }) => m.type === 'function_call_output')
          .map((m: { call_id: string; output: string }) => [m.call_id, m.output]),
      ).toEqual([
        ['call-read', 'read'],
        ['call-agent', 'joined'],
        ['call-write', 'written'],
      ]);
    }
  });

  it.each(['await', 'join'])('keeps foreground agent runs concurrent across %s', async (operation) => {
    const events: string[] = [];
    const gate = createGate(2);
    registerTool(
      new ScriptedTool('agent', false, {
        events,
        gate,
        gateOperations: ['run'],
        overlapOperations: ['await', 'join'],
      }),
    );
    registerTool(new ScriptedTool('probe_write', false, { events }));
    const execution = executeProviderToolCalls({
      calls: ['run', operation, 'run']
        .map((op) => ({
          name: 'agent',
          argsText: '{}',
          parseArgs: () => ({ operation: op }),
        }))
        .concat([{ name: 'probe_write', argsText: '{}', parseArgs: () => ({ operation: '' }) }]),
      context: undefined,
      toolFilter: undefined,
    });
    const outcome = await Promise.race([execution.then(() => 'completed'), delay(2_000).then(() => 'timeout')]);
    gate.release();
    await execution;
    expect(outcome).toBe('completed');
    expect(events.slice(-2)).toEqual(['start:probe_write', 'finish:probe_write']);
    expect(events.filter((event) => event === 'finish:agent')).toHaveLength(3);
  });

  it('keeps a foreground agent run as a barrier before a following write', async () => {
    const events: string[] = [];
    registerTool(new ScriptedTool('agent', false, { events, overlapOperations: ['await', 'join'] }));
    registerTool(new ScriptedTool('probe_write', false, { events }));
    await executeProviderToolCalls({
      calls: ['agent', 'probe_write'].map((name) => ({ name, argsText: '{}', parseArgs: () => ({}) })),
      context: undefined,
      toolFilter: undefined,
    });
    expect(events).toEqual(['start:agent', 'finish:agent', 'start:probe_write', 'finish:probe_write']);
  });

  it('parses inputs once and reports malformed input without preventing later calls', async () => {
    const events: string[] = [];
    registerTool(new ScriptedTool('agent', false, { events, overlapOperations: ['await', 'join'] }));
    registerTool(new ScriptedTool('probe_write', false, { events }));
    const badArgs = vi.fn(() => {
      throw new SyntaxError('bad arguments');
    });
    const writeArgs = vi.fn(() => ({}));
    const outcomes = await executeProviderToolCalls({
      calls: [
        { name: 'agent', argsText: '{', parseArgs: badArgs },
        { name: 'probe_write', argsText: '{}', parseArgs: writeArgs },
      ],
      context: undefined,
      toolFilter: undefined,
    });
    expect(badArgs).toHaveBeenCalledTimes(1);
    expect(writeArgs).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toMatchObject({ isError: true, result: expect.stringContaining('bad arguments') });
    expect(outcomes[1]).toMatchObject({ isError: false });
    expect(events).toEqual(['start:probe_write', 'finish:probe_write']);
  });

  it('runs consecutive read-only Responses calls concurrently and keeps output order', async () => {
    const events: string[] = [];
    const gate = createGate(2);
    registerTool(new ScriptedTool('probe_read_a', true, { events, gate, output: 'output-a' }));
    registerTool(new ScriptedTool('probe_read_b', true, { events, gate, output: 'output-b' }));

    openaiMocks.responsesCreate
      .mockResolvedValueOnce(
        streamOf(functionCallItem(0, 'call-a', 'probe_read_a'), functionCallItem(1, 'call-b', 'probe_read_b')),
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
  overlappable?: boolean;
  overlapOperations?: string[];
  gateOperations?: string[];
};

class ScriptedTool extends MicaTool {
  constructor(
    name: string,
    readOnly: boolean,
    private readonly script: ScriptedToolOptions,
  ) {
    super(
      name,
      'scripted test tool',
      { type: 'object', properties: {} },
      { readOnly, overlappable: script.overlappable },
    );
  }

  async execute(input: ToolInput): Promise<string> {
    this.script.events.push(`start:${this.name}`);
    if (
      this.script.gate &&
      (!this.script.gateOperations || this.script.gateOperations.includes(String(input.operation)))
    ) {
      await this.script.gate.wait();
    }
    this.script.events.push(`finish:${this.name}`);
    return this.script.output ?? `${this.name} output`;
  }

  override canOverlap(input: ToolInput): boolean {
    return this.script.overlapOperations?.includes(String(input.operation)) ?? super.canOverlap(input);
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

function functionCallItem(outputIndex: number, callId: string, name: string, args = '{}') {
  return {
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: { type: 'function_call', id: `fc-${callId}`, call_id: callId, name, arguments: args, status: 'completed' },
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
