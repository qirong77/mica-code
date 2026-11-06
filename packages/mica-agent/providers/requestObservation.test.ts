import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MicaTool, micaTools } from '@packages/mica-tools/index.js';
import { createRuntimeInput } from '@packages/mica-runtime/RuntimeInput.js';
import { MessageQueueService } from '@packages/mica-runtime/MessageQueueService.js';
import type { AgentQueryOptions } from '../core/Agent.js';
import { ChatCompletionsClient } from './ChatCompletionsClient.js';
import { ResponsesClient } from './ResponsesClient.js';
import type { ModelClientOptions } from './types.js';

const openaiMocks = vi.hoisted(() => ({ chatCreate: vi.fn(), responsesCreate: vi.fn() }));
vi.mock('openai', () => ({
  OpenAI: class MockOpenAI {
    chat = { completions: { create: openaiMocks.chatCreate } };
    responses = { create: openaiMocks.responsesCreate };
  },
}));

class ProbeTool extends MicaTool {
  constructor(name: string) {
    super(name, 'observation probe', { type: 'object', properties: {} }, { readOnly: true });
  }
  async execute() {
    return 'probe result';
  }
  onToolUseDisplayText() {
    return this.name;
  }
}
const allowedTool = new ProbeTool('observation_allowed');
const excludedTool = new ProbeTool('observation_excluded');
beforeEach(() => {
  micaTools.registerRuntime(allowedTool);
  micaTools.registerRuntime(excludedTool);
});
afterEach(() => {
  micaTools.unregisterRuntime(allowedTool);
  micaTools.unregisterRuntime(excludedTool);
  openaiMocks.chatCreate.mockReset();
  openaiMocks.responsesCreate.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function* streamOf(...events: unknown[]) {
  yield* events;
  // Successful chat fixtures include a terminal choice.
  if (events.some((event) => typeof event === 'object' && event !== null && 'choices' in event)) {
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
  }
  // Successful Responses fixtures include the protocol's terminal event.
  if (events.some((event) => typeof event === 'object' && event !== null &&
    'type' in event && typeof event.type === 'string' && event.type.startsWith('response.')) &&
    !events.some((event) => typeof event === 'object' && event !== null &&
      'type' in event && event.type === 'response.completed')) {
    yield { type: 'response.completed', response: { model: 'test-model' } };
  }
}
const protocols = ['openai_chat_completions', 'openai_responses'] as const;
type RequestInfo = Parameters<NonNullable<AgentQueryOptions['onRequestStart']>>[0];
type WireRequest = { messages?: unknown[]; input?: unknown[]; tools?: unknown };

for (const protocol of protocols) {
  const isChat = protocol === 'openai_chat_completions';
  const create = isChat ? openaiMocks.chatCreate : openaiMocks.responsesCreate;
  const initialMessageCount = isChat ? 2 : 1;
  function client(overrides: Partial<ModelClientOptions> = {}) {
    const options: ModelClientOptions = {
      model: 'test-model',
      apiKey: 'test-key',
      systemPrompt: 'test system',
      provider: { id: 'test', protocol, api_base: 'https://example.com/v1', supportsEffort: false },
      toolFilter: (name) => name === allowedTool.name,
      ...overrides,
    };
    return isChat ? new ChatCompletionsClient(options) : new ResponsesClient(options);
  }
  function textStream() {
    return streamOf(
      isChat ? { choices: [{ delta: { content: 'done' } }] } : { type: 'response.output_text.delta', delta: 'done' },
    );
  }
  function toolStream() {
    return toolStreamWithCount();
  }
  function toolStreamWithCount(count = 1) {
    return streamOf(
      ...(isChat
        ? [
            {
              choices: [
                {
                  delta: {
                    tool_calls: Array.from({ length: count }, (_, index) => ({
                      index,
                      id: `call-${index + 1}`,
                      function: { name: allowedTool.name, arguments: '{}' },
                    })),
                  },
                },
              ],
            },
          ]
        : Array.from({ length: count }, (_, index) => ({
            type: 'response.output_item.done',
            output_index: index,
            item: {
              type: 'function_call',
              id: `fc-${index + 1}`,
              call_id: `call-${index + 1}`,
              name: allowedTool.name,
              arguments: '{}',
            },
          }))),
    );
  }
  function expectedTools() {
    const definition = {
      name: allowedTool.name,
      description: 'observation probe',
      parameters: { type: 'object', properties: {} },
    };
    return isChat ? [{ type: 'function', function: definition }] : [{ type: 'function', ...definition, strict: false }];
  }

  describe(`${protocol} request observation`, () => {
    it('does not send a request when compaction is cancelled while awaiting its result', async () => {
      const controller = new AbortController();
      const start = vi.fn();
      await expect(client().query('hello', {
        signal: controller.signal,
        onRequestStart: start,
        rewriteIterationMessages: async (messages) => {
          controller.abort();
          return messages.slice();
        },
      })).rejects.toThrow();
      expect(create).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    });

    it('checks queued input before the next request and never rewrites after the final answer', async () => {
      create.mockImplementationOnce(toolStream).mockImplementationOnce(textStream);
      const seen: string[] = [];
      const queued = vi.fn(() => 'new requirement after the tool');
      await client().query('hello', {
        onIterationComplete: queued,
        rewriteIterationMessages: (messages) => {
          seen.push(JSON.stringify(messages));
          return null;
        },
      });
      expect(seen).toHaveLength(2);
      expect(seen[0]).not.toContain('new requirement');
      expect(seen[1]).toContain('new requirement after the tool');
      expect(seen[1]).toContain('probe result');
      expect(queued).toHaveBeenCalledTimes(1);
    });

    it('sends queued input after the current tool batch with the entire baseline wire prefix intact', async () => {
      const requests: WireRequest[] = [];
      for (let run = 0; run < 2; run++) {
        create
          .mockImplementationOnce((request: WireRequest) => {
            requests.push(structuredClone(request));
            return toolStreamWithCount(2);
          })
          .mockImplementationOnce((request: WireRequest) => {
            requests.push(structuredClone(request));
            return textStream();
          });
      }
      await client().query('hello');

      const queue = new MessageQueueService();
      const input = createRuntimeInput('follow up during tools', 'ui', { queueMode: 'after_iteration' });
      const agent = client();
      let completedTools = 0;
      agent.onToolCall = () => {
        if (!queue.count()) queue.enqueue(input);
      };
      agent.onToolResult = () => {
        completedTools++;
      };
      const boundary = vi.fn(() => {
        expect(completedTools).toBe(2);
        return queue.dequeueAfterCompletedIteration()?.text;
      });
      await agent.query('hello', { onIterationComplete: boundary });

      expect(boundary).toHaveBeenCalledTimes(1);
      expect(queue.count()).toBe(0);
      expect(requests[2]).toEqual(requests[0]);
      const baseline = requests[1]!;
      const sent = requests[3]!;
      const messageKey = isChat ? 'messages' : 'input';
      expect(sent).toEqual({
        ...baseline,
        [messageKey]: [
          ...baseline[messageKey]!,
          isChat
            ? { role: 'user', content: input.text }
            : { type: 'message', role: 'user', content: [{ type: 'input_text', text: input.text }] },
        ],
      });
      const results = baseline[messageKey]!.filter((message) => {
        const item = message as { role?: string; type?: string };
        return isChat ? item.role === 'tool' : item.type === 'function_call_output';
      });
      expect(results).toHaveLength(2);
    });

    it('starts before the first request and before output, and reports the filtered wire tools', async () => {
      const order: string[] = [];
      let info: RequestInfo | undefined;
      const definitions = vi.spyOn(micaTools, 'getDefinitions');
      create.mockImplementationOnce((request: WireRequest) => {
        order.push('wire');
        expect(info?.tools).toBe(request.tools);
        expect(info?.messageCount).toBe((request.messages ?? request.input)?.length);
        return textStream();
      });
      const agent = client();
      agent.onText = () => {
        order.push('text');
      };
      await expect(
        agent.query('hello', {
          onRequestStart: (value) => {
            info = value;
            order.push('request:start');
          },
          rewriteIterationMessages: () => {
            order.push('rewrite');
            return null;
          },
        }),
      ).resolves.toBe('done');
      expect(order).toEqual(['rewrite', 'request:start', 'wire', 'text']);
      expect(info).toEqual({ messageCount: initialMessageCount, tools: expectedTools() });
      expect(definitions).toHaveBeenCalledTimes(1);
    });

    it.each(['create', 'stream'] as const)(
      'counts the first request when %s fails before any output',
      async (failureSite) => {
        const error = Object.assign(new Error('invalid request'), { status: 400 });
        const order: string[] = [];
        create.mockImplementationOnce(() => {
          order.push('wire');
          if (failureSite === 'create') throw error;
          return (async function* () {
            throw error;
          })();
        });
        const start = vi.fn(() => {
          order.push('request:start');
        });
        const rewrite = vi.fn();
        await expect(
          client().query('hello', { onRequestStart: start, rewriteIterationMessages: rewrite }),
        ).rejects.toBe(error);
        expect(order).toEqual(['request:start', 'wire']);
        expect(start).toHaveBeenCalledExactlyOnceWith({ messageCount: initialMessageCount, tools: expectedTools() });
        expect(rewrite).toHaveBeenCalledTimes(1);
      },
    );

    it('counts transport retries separately and reuses the same filtered tool snapshot', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const definitions = vi.spyOn(micaTools, 'getDefinitions');
      const order: string[] = [];
      const busy = Object.assign(new Error('busy'), { status: 503 });
      const agent = client();
      let info: RequestInfo | undefined;
      create
        .mockImplementationOnce(() => {
          order.push('wire');
          return (async function* () {
            throw busy;
          })();
        })
        .mockImplementationOnce(() => {
          order.push('wire');
          return textStream();
        });
      const start = vi.fn((value: RequestInfo) => {
        info = value;
        order.push('request:start');
      });
      const retry = vi.fn(() => {
        order.push('retry');
        // A registry/filter change during retry must not alter this logical request.
        agent.toolFilter = () => false;
      });
      const pending = agent.query('hello', { onRequestStart: start, onRetry: retry });
      const completed = expect(pending).resolves.toBe('done');
      await vi.advanceTimersByTimeAsync(2000);
      await completed;
      expect(order).toEqual(['request:start', 'wire', 'retry', 'wire']);
      expect(start).toHaveBeenCalledTimes(1);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(definitions).toHaveBeenCalledTimes(1);
      expect(info?.tools).toEqual(expectedTools());
      expect(create.mock.calls[0]![0].tools).toBe(info?.tools);
      expect(create.mock.calls[1]![0].tools).toBe(info?.tools);
    });

    it('starts once per tool iteration and uses the rewritten history for the following request', async () => {
      const order: string[] = [];
      const starts: RequestInfo[] = [];
      const requests: WireRequest[] = [];
      create
        .mockImplementationOnce((request: WireRequest) => {
          requests.push({ ...request, messages: request.messages?.slice(), input: request.input?.slice() });
          order.push('wire');
          return toolStream();
        })
        .mockImplementationOnce((request: WireRequest) => {
          requests.push({ ...request, messages: request.messages?.slice(), input: request.input?.slice() });
          order.push('wire');
          return textStream();
        });
      const agent = client();
      agent.onToolCall = () => {
        order.push('tool');
      };
      agent.onToolResult = () => {
        order.push('result');
      };
      await expect(
        agent.query('hello', {
          onRequestStart: (info) => {
            starts.push(info);
            order.push('request:start');
          },
          rewriteIterationMessages: (messages) => {
            order.push('rewrite');
            return messages.slice(0, 1);
          },
        }),
      ).resolves.toBe('done');
      expect(order).toEqual(['rewrite', 'request:start', 'wire', 'tool', 'result', 'rewrite', 'request:start', 'wire']);
      expect(starts).toHaveLength(2);
      for (const [index, info] of starts.entries()) {
        const request = requests[index]!;
        expect(info.messageCount).toBe((request.messages ?? request.input)?.length);
        expect(info.tools).toBe(request.tools);
      }
    });

    it.each(['abort', 'stale', 'maxTurns'] as const)(
      'does not start requests rejected by the %s guard',
      async (guard) => {
        const start = vi.fn();
        const signal = AbortSignal.abort();
        await expect(
          client().query('hello', {
            onRequestStart: start,
            ...(guard === 'abort' ? { signal } : guard === 'stale' ? { shouldContinue: () => false } : { maxTurns: 0 }),
          }),
        ).rejects.toThrow();
        expect(start).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      },
    );

    it('does not start an extra request after the maximum number of turns', async () => {
      create.mockImplementationOnce(() => toolStream());
      const start = vi.fn();
      await expect(client().query('hello', { maxTurns: 1, onRequestStart: start })).rejects.toMatchObject({
        name: 'AgentMaxTurnsError',
      });
      expect(start).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it.each([true, false])(
      'preserves the complete wire request with absent or throwing observers (tools: %s)',
      async (tools) => {
        const requests: unknown[] = [];
        create.mockImplementation((request: unknown) => {
          requests.push(structuredClone(request));
          return textStream();
        });
        await client({ tools }).query('hello');
        const baseline = requests[0];
        const start = vi.fn();
        await client({ tools }).query('hello', { onRequestStart: start });
        await client({ tools }).query('hello', {
          onRequestStart: () => {
            throw new Error('observer failed');
          },
        });
        expect(requests).toEqual([baseline, baseline, baseline]);
        expect(baseline).toEqual({
          model: 'test-model',
          stream: true,
          ...(isChat
            ? {
                messages: [
                  { role: 'system', content: 'test system' },
                  { role: 'user', content: 'hello' },
                ],
                stream_options: { include_usage: true },
              }
            : {
                instructions: 'test system',
                input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
              }),
          ...(tools ? { tools: expectedTools(), tool_choice: 'auto' } : {}),
        });
        expect(start).toHaveBeenCalledExactlyOnceWith({
          messageCount: initialMessageCount,
          tools: tools ? expectedTools() : undefined,
        });
        if (!tools) expect(baseline).not.toHaveProperty('tools');
      },
    );
  });
}
