import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentQueryContent,
  AgentQueryOptions,
  AgentUsageRecord,
  IAgent,
  ModelClientOptions,
} from '@packages/mica-agent/index.js';
import type { AgentObservationEvent } from '@packages/mica-plugin/index.js';

const state = vi.hoisted(() => ({ apiKey: 'test-key', model: 'test-model' }));
const clients: TestClient[] = [];
const usage: AgentUsageRecord = {
  provider: 'openai_chat_completions',
  turnId: 1,
  requestIndex: 1,
  messageCount: 2,
  inputTokens: 12,
  outputTokens: 3,
  cachedInputTokens: 4,
  totalTokens: 15,
  paidTokenRate: 1,
  model: 'test-model',
};

vi.mock('@packages/mica-config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@packages/mica-config/index.js')>();
  return {
    ...actual,
    micaConfig: {
      ...actual.micaConfig,
      get: () => ({
        provider: 'test-provider',
        model: state.model,
        effort: 'none',
        providers: [
          {
            id: 'test-provider',
            api_base: 'https://example.com/v1',
            api_key: state.apiKey,
            protocol: 'openai_chat_completions',
            models: ['test-model'],
            supportsEffort: false,
          },
        ],
      }),
      assertValid: () => {},
      getModelRule: () => ({ contextSize: 1000 }),
      readCapabilityDefaults: () => ({}),
    },
  };
});
vi.mock('@packages/mica-agent/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@packages/mica-agent/index.js')>();
  return {
    ...actual,
    micaAgent: {
      ...actual.micaAgent,
      createModelClient: vi.fn((options: ModelClientOptions) => {
        const client = makeClient(options);
        clients.push(client);
        return client;
      }),
    },
  };
});

import { micaPlugin } from '@packages/mica-plugin/index.js';
import { AgentAbortError, AgentRuntime } from './AgentRuntime.js';
import { clearIterationRewrites, registerIterationRewrite } from './iterationRewrite.js';

type TestClient = IAgent<ModelClientOptions> & {
  options: ModelClientOptions;
  queryImpl: (question: AgentQueryContent, options?: AgentQueryOptions) => Promise<string>;
};
function makeClient(options: ModelClientOptions): TestClient {
  return {
    options,
    model: options.model,
    messages: [],
    usageHistory: [],
    lastUsage: undefined,
    configure: vi.fn(),
    reset: vi.fn(),
    loadSnapshot: vi.fn(),
    preserveAbortedTurn: () => false,
    toConversationMessages: () => [],
    getSnapshot: () => ({
      model: options.model,
      messages: [],
      usageHistory: [],
      lastUsage: undefined,
      conversationMessages: [],
    }),
    queryImpl: async () => 'ok',
    query(question, queryOptions) {
      return this.queryImpl(question, queryOptions);
    },
  };
}
function setup() {
  const hooks = new micaPlugin.HookRegistry();
  const events: AgentObservationEvent[] = [];
  hooks.on<AgentObservationEvent>('agent:observe', async (event) => {
    await Promise.resolve();
    events.push(event);
  });
  const runtime = new AgentRuntime({}, hooks);
  const client = clients.at(-1)!;
  return { hooks, events, runtime, client };
}
function prompt(client: TestClient): string {
  return (client.options.systemPrompt as () => string)();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  clients.length = 0;
  state.apiKey = 'test-key';
  state.model = 'test-model';
  clearIterationRewrites();
});

describe('agent:observe', () => {
  it('never waits for a hanging observer and still delivers events to later observers', async () => {
    const { hooks, runtime, client } = setup();
    const seen: string[] = [];
    hooks.on('agent:observe', () => new Promise(() => {}), { priority: -10, failPolicy: 'stop' });
    hooks.on<AgentObservationEvent>('agent:observe', (event) => {
      seen.push(event.type);
    });
    client.queryImpl = async () => 'done';
    expect(await runtime.run('hello')).toEqual({ runId: 1, text: 'done' });
    expect(seen).toEqual(['run:start', 'run:finish']);
    client.queryImpl = async () => {
      throw new DOMException('Cancelled', 'AbortError');
    };
    await expect(runtime.run('again')).rejects.toBeInstanceOf(AgentAbortError);
    expect(seen).toEqual(['run:start', 'run:finish', 'run:start', 'run:finish']);
  });

  it('orders snapshots across async callbacks and records only actual rewrites', async () => {
    const { runtime, client, hooks, events } = setup();
    hooks.on('system-prompt:build', (event: { prompt: string }) => ({
      ...event,
      prompt: `${event.prompt}\nHook guidance.`,
    }));
    runtime.promptSections.add('test', { id: 'test', render: () => 'Final section.' });
    registerIterationRewrite('test', async (messages) => messages.slice(1));
    let sentPrompt = '';
    const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];
    client.queryImpl = async (_question, options) => {
      sentPrompt = prompt(client);
      options?.onRequestStart?.({ messageCount: 2, tools });
      options?.onRetry?.({ attempt: 1, delayMs: 100, error: new Error('busy') });
      client.onThinking?.('private thought');
      client.onText?.('streamed answer');
      client.onToolCall?.('read_file', '{"file_path":"a"}', 'tool-1');
      client.onToolResult?.('read_file', 'contents', 'tool-1');
      client.onUsage?.(usage);
      await options?.rewriteIterationMessages?.([{ role: 'user' }, { role: 'assistant' }]);
      options?.onRequestStart?.({ messageCount: 1 });
      return 'answer';
    };
    expect(await runtime.run('hello')).toEqual({ runId: 1, text: 'answer' });
    expect(events.map((event) => event.type)).toEqual([
      'run:start',
      'prompt:resolved',
      'request:start',
      'retry',
      'tool:call',
      'tool:result',
      'usage',
      'history:rewritten',
      'request:start',
      'run:finish',
    ]);
    expect(
      events.every(
        (event) => event.owner === runtime && event.runId === 1 && !Number.isNaN(Date.parse(event.timestamp)),
      ),
    ).toBe(true);
    expect(events[0]).toMatchObject({
      input: 'hello',
      config: {
        providerId: 'test-provider',
        protocol: 'openai_chat_completions',
        model: 'test-model',
        effort: 'none',
        role: 'default',
      },
    });
    expect(events[1]).toMatchObject({ prompt: sentPrompt });
    expect(sentPrompt).toContain('Hook guidance.');
    expect(sentPrompt).toContain('Final section.');
    expect(events[2]).toMatchObject({ messageCount: 2, tools });
    expect(events[8]).not.toHaveProperty('tools');
    expect(events[7]).toMatchObject({ beforeCount: 2, afterCount: 1 });
    expect(events[4]).toMatchObject({ name: 'read_file', args: '{"file_path":"a"}', id: 'tool-1' });
    expect(events[6]).toMatchObject({
      usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4, totalTokens: 15, model: 'test-model' },
    });
    expect(events[6]).not.toHaveProperty('usage.provider');
    expect(events[3]).toMatchObject({ attempt: 1, delayMs: 100, error: 'busy' });
    expect(events.filter((event) => event.type === 'request:start')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ outcome: 'completed', elapsedMs: expect.any(Number) });
  });

  it('counts explicit request starts without treating iteration callbacks as requests or null as a rewrite', async () => {
    const { runtime, client, events } = setup();
    const messages = [{ role: 'user', content: 'hello' }];
    client.queryImpl = async (_question, options) => {
      options?.onRequestStart?.({ messageCount: 1 });
      expect(await options?.rewriteIterationMessages?.(messages)).toBeNull();
      options?.onRequestStart?.({ messageCount: 1 });
      expect(await options?.rewriteIterationMessages?.(messages)).toBeNull();
      return 'answer';
    };
    await runtime.run('hello');
    expect(events.map((event) => event.type)).toEqual(['run:start', 'request:start', 'request:start', 'run:finish']);
    expect(messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it.each(['failure', 'missing-key', 'missing-model', 'stale-reservation'] as const)(
    'pairs start and finish on %s',
    async (mode) => {
      if (mode === 'missing-key') state.apiKey = '';
      if (mode === 'missing-model') state.model = '';
      const { runtime, client, events } = setup();
      if (client)
        client.queryImpl = async (_question, options) => {
          options?.onRequestStart?.({ messageCount: 2 });
          throw new Error('provider failed');
        };
      const reservedRunId = mode === 'stale-reservation' ? runtime.reserveRunId() : undefined;
      if (reservedRunId !== undefined) runtime.abort();
      await expect(runtime.run('hello', { reservedRunId })).rejects.toThrow();
      expect(events.map((event) => event.type)).toEqual(
        mode === 'failure' ? ['run:start', 'request:start', 'run:finish'] : ['run:start', 'run:finish'],
      );
      expect(events[0].runId).toBe(events.at(-1)?.runId);
      expect(events.at(-1)).toMatchObject({ outcome: mode === 'stale-reservation' ? 'aborted' : 'error' });
      if (mode !== 'stale-reservation') expect(events.at(-1)).toHaveProperty('error');
    },
  );

  it('preserves abort identity and suppresses callbacks after abort', async () => {
    const { runtime, client, events } = setup();
    const entered = deferred<void>();
    const end = deferred<string>();
    client.queryImpl = async (_question, options) => {
      prompt(client);
      entered.resolve();
      try {
        return await end.promise;
      } finally {
        options?.onRequestStart?.({ messageCount: 99 });
        client.onToolResult?.('late_tool', 'ignored');
        client.onUsage?.(usage);
        options?.onRetry?.({ attempt: 1, delayMs: 1, error: 'late' });
      }
    };
    const running = runtime.run('hello');
    await entered.promise;
    runtime.abort();
    end.reject(new Error('transport closed'));
    await expect(running).rejects.toMatchObject({ name: 'AgentAbortError', runId: 1 });
    expect(runtime.currentRunId).toBe(2);
    expect(runtime.isRunning).toBe(false);
    expect(events.map((event) => event.type)).toEqual(['run:start', 'prompt:resolved', 'run:finish']);
    expect(events.at(-1)).toMatchObject({ runId: 1, outcome: 'aborted' });
  });

  it('reports aborted even when the provider resolves after abort', async () => {
    const { runtime, client, events } = setup();
    client.queryImpl = async () => {
      runtime.abort();
      return 'partial';
    };
    // Preserve the runtime's existing return semantics in this case.
    expect(await runtime.run('hello')).toEqual({ runId: 1, text: 'partial' });
    expect(events.at(-1)).toMatchObject({ outcome: 'aborted' });
  });

  it.each([false, true])('isolates throwing observers including failPolicy stop (async: %s)', async (asyncFailure) => {
    const { runtime, client, hooks, events } = setup();
    const reported: unknown[] = [];
    hooks.setHandlerErrorReporter((error) => reported.push(error));
    hooks.on(
      'agent:observe',
      () => {
        if (asyncFailure) return Promise.reject(new Error('observer rejected'));
        throw new Error('observer threw');
      },
      { failPolicy: 'stop' },
    );
    client.queryImpl = async (_question, options) => {
      prompt(client);
      options?.onRequestStart?.({ messageCount: 2, tools: [] });
      client.onToolCall?.('test', '{}');
      client.onToolResult?.('test', 'ok');
      client.onUsage?.(usage);
      return 'unchanged';
    };
    expect(await runtime.run('hello')).toEqual({ runId: 1, text: 'unchanged' });
    expect(reported).toHaveLength(events.length);
    expect(events.at(-1)).toMatchObject({ outcome: 'completed' });
  });

  it('isolates input, tools and usage snapshots and ignores observer return values', async () => {
    const { runtime, client, hooks } = setup();
    const question: AgentQueryContent = [{ type: 'text', text: 'original input' }];
    const originalUsage = { ...usage };
    const tools = [{ name: 'original_tool', parameters: { type: 'object' } }];
    let sentPrompt = '';
    hooks.on<AgentObservationEvent>('agent:observe', (event) => {
      if (event.type === 'run:start') (event.input as Array<{ text: string }>)[0].text = 'observer mutation';
      if (event.type === 'usage') Reflect.set(event.usage, 'inputTokens', 999);
      if (event.type === 'request:start') (event.tools as typeof tools)[0].name = 'observer mutation';
      return { prompt: 'replace prompt', model: 'replace model', messages: [] };
    });
    client.queryImpl = async (input, options) => {
      await Promise.resolve();
      sentPrompt = prompt(client);
      options?.onRequestStart?.({ messageCount: 2, tools });
      const messages = [{ role: 'user', content: 'original history' }];
      expect(await options?.rewriteIterationMessages?.(messages)).toBeNull();
      expect(messages[0].content).toBe('original history');
      client.onUsage?.(originalUsage);
      expect(input).toEqual([{ type: 'text', text: 'original input' }]);
      return 'answer';
    };
    await runtime.run(question);
    expect(question).toEqual([{ type: 'text', text: 'original input' }]);
    expect(originalUsage).toEqual(usage);
    expect(tools[0].name).toBe('original_tool');
    expect(sentPrompt).toBe(runtime.buildSystemPrompt());
    expect(client.options.model).toBe('test-model');
    expect(runtime.config.model).toBe('test-model');
  });

  it('does not attribute previews or shared child prompt resolvers to the main run', async () => {
    const { runtime, client, events } = setup();
    const entered = deferred<void>();
    const end = deferred<string>();
    runtime.buildSystemPrompt();
    prompt(client);
    client.onToolCall?.('outside', '{}');
    client.queryImpl = async () => {
      prompt(client);
      const childOptions = runtime.createClientOptions();
      (childOptions.systemPrompt as () => string)();
      runtime.buildSystemPrompt();
      entered.resolve();
      return end.promise;
    };
    const running = runtime.run('hello');
    await entered.promise;
    // A UI preview while the model request is pending is outside query scope.
    runtime.buildSystemPrompt();
    prompt(client);
    client.onUsage?.(usage);
    end.resolve('done');
    await running;
    prompt(client);
    expect(events.map((event) => event.type)).toEqual(['run:start', 'prompt:resolved', 'run:finish']);
  });

  it('does not misattribute callbacks from an aborted run after its replacement begins', async () => {
    const { runtime, client, events } = setup();
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const firstEnd = deferred<string>();
    const secondEnd = deferred<string>();
    client.queryImpl = async (question) => {
      if (question === 'first') {
        firstEntered.resolve();
        await firstEnd.promise;
        client.onToolCall?.('stale', '{}');
        throw new AgentAbortError(1);
      }
      secondEntered.resolve();
      client.onToolCall?.('current', '{}');
      return secondEnd.promise;
    };
    const first = runtime.run('first');
    const firstRejected = expect(first).rejects.toMatchObject({ runId: 1 });
    await firstEntered.promise;
    runtime.abort();
    const second = runtime.run('second');
    await secondEntered.promise;
    firstEnd.resolve('late');
    await firstRejected;
    expect(runtime.isRunning).toBe(true);
    secondEnd.resolve('done');
    await second;
    expect(events.filter((event) => event.type === 'tool:call')).toMatchObject([{ runId: 3, name: 'current' }]);
    expect(events.filter((event) => event.type === 'run:finish')).toMatchObject([
      { runId: 1, outcome: 'aborted' },
      { runId: 3, outcome: 'completed' },
    ]);
  });
});
