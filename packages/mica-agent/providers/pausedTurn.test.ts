import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { MicaTool, micaTools } from '@packages/mica-tools/index.js';
import { AgentPausedError } from '../core/Agent.js';
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
 * `shouldPause` 是开发构建重载前的软停：只在两次模型请求之间生效，让它停在
 * 工具批次已经落定、下一次请求还没发出的位置上。那一处的历史是完整的，重启后
 * 不带用户消息再发一次请求就能接着跑，不会重做已经执行过的工具调用。
 */
describe('iteration-boundary pause', () => {
  it('Chat Completions 停在工具批次之后、下一次请求之前，历史尾部是工具结果', async () => {
    registerTool(new StubTool('probe_pause_chat'));
    openaiMocks.chatCreate.mockResolvedValueOnce(
      streamOf({
        model: 'test-model',
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call-1', function: { name: 'probe_pause_chat', arguments: '{}' } }],
            },
          },
        ],
      }),
    );

    let pauses = 0;
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    await expect(
      client.query('keep going', {
        // 第一次请求放行，工具批次跑完之后才请求暂停：这正是「下一次请求之前」。
        shouldPause: () => pauses++ > 0,
      }),
    ).rejects.toBeInstanceOf(AgentPausedError);

    // 只发出过一次请求：第二次在边界上被拦下，没有打到 provider。
    expect(openaiMocks.chatCreate).toHaveBeenCalledTimes(1);
    expect(client.messages.at(-1)).toMatchObject({ role: 'tool' });
    // 用户消息只有一条，工具结果的占位符说明这不是一次失败。
    expect(client.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('Responses 同样停在边界上', async () => {
    registerTool(new StubTool('probe_pause_responses'));
    openaiMocks.responsesCreate.mockResolvedValueOnce(
      streamOf(functionCallItem('call-1', 'probe_pause_responses')),
    );

    let pauses = 0;
    const client = new ResponsesClient(options('openai_responses'));
    await expect(
      client.query('keep going', { shouldPause: () => pauses++ > 0 }),
    ).rejects.toBeInstanceOf(AgentPausedError);

    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(1);
    expect(client.messages.at(-1)).toMatchObject({ type: 'function_call_output' });
  });

  it('一开始就要求暂停时一次请求都不发', async () => {
    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    await expect(client.query('hello', { shouldPause: () => true })).rejects.toBeInstanceOf(AgentPausedError);
    expect(openaiMocks.chatCreate).not.toHaveBeenCalled();
  });
});

/**
 * `resume` 是暂停的续跑：历史里已经有这一轮的正文和工具结果，再补一条用户消息
 * 就等于凭空多出一句话。
 */
describe('resume without appending a user message', () => {
  it('Chat Completions 不追加用户消息', async () => {
    openaiMocks.chatCreate
      .mockResolvedValueOnce(
        streamOf({ model: 'test-model', choices: [{ delta: { content: 'first answer' } }] }),
      )
      .mockResolvedValueOnce(
        streamOf({ model: 'test-model', choices: [{ delta: { content: 'continued' } }] }),
      );

    const client = new ChatCompletionsClient(options('openai_chat_completions'));
    await client.query('do the thing');
    const before = client.messages.length;

    await client.query('placeholder', { resume: true });

    expect(client.messages.length).toBe(before + 1);
    expect(client.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(client.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'continued' });
    // 第二次请求里也看不到占位文本。
    const secondRequest = openaiMocks.chatCreate.mock.calls[1][0];
    expect(JSON.stringify(secondRequest.messages)).not.toContain('placeholder');
  });

  it('Responses 不追加用户消息', async () => {
    openaiMocks.responsesCreate
      .mockResolvedValueOnce(streamOf({ type: 'response.output_text.delta', delta: 'first answer' }))
      .mockResolvedValueOnce(streamOf({ type: 'response.output_text.delta', delta: 'continued' }));

    const client = new ResponsesClient(options('openai_responses'));
    await client.query('do the thing');
    const usersBefore = client.messages.filter(
      (item) => item.type === 'message' && item.role === 'user',
    ).length;

    await client.query('placeholder', { resume: true });

    expect(
      client.messages.filter((item) => item.type === 'message' && item.role === 'user'),
    ).toHaveLength(usersBefore);
    const secondRequest = openaiMocks.responsesCreate.mock.calls[1][0];
    expect(JSON.stringify(secondRequest.input)).not.toContain('placeholder');
  });
});

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
  if (events.some((event) => typeof event === 'object' && event !== null && 'choices' in event)) {
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
  }
  if (
    events.some(
      (event) =>
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        typeof event.type === 'string' &&
        event.type.startsWith('response.'),
    ) &&
    !events.some((event) => typeof event === 'object' && event !== null && 'type' in event && event.type === 'response.completed')
  ) {
    yield { type: 'response.completed', response: { model: 'test-model' } };
  }
}

function options(protocol: ProviderProtocol): ModelClientOptions {
  return {
    model: 'test-model',
    apiKey: 'test-key',
    baseURL: 'https://example.com/v1',
    provider: {
      id: 'probe',
      protocol,
      api_base: 'https://example.com/v1',
      api_key: 'test-key',
      models: ['test-model'],
    },
    tools: true,
    toolFilter: undefined,
    toolContext: undefined,
    systemPrompt: 'test',
    supportsVision: false,
  } as ModelClientOptions;
}
