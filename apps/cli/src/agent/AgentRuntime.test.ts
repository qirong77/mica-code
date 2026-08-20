import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMicaConfig } from '@packages/mica-config/index.js';
import type {
  AgentQueryContent,
  AgentQueryOptions,
  AgentUsageRecord,
  IAgent,
  ModelClientOptions,
} from '@packages/mica-agent/index.js';

const modelClient = createModelClientStub();

let configState: IMicaConfig | null = null;
const testConfig: IMicaConfig = {
  provider: 'test-provider',
  model: 'test-model',
  effort: 'none',
  contextWindowSize: 1000,
  providers: [
    {
      id: 'test-provider',
      name: 'Test Provider',
      api_base: 'https://example.com/v1',
      api_key: 'test-key',
      protocol: 'openai_chat_completions',
      models: ['test-model'],
      supportsEffort: false,
    },
  ],
};

vi.mock('@packages/mica-config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@packages/mica-config/index.js')>();
  return {
    ...actual,
    micaConfig: {
      ...actual.micaConfig,
      get: () => configState,
      update: (updater: (c: IMicaConfig) => IMicaConfig) => {
        if (!configState) throw new Error('config not initialized');
        configState = updater(configState);
        return configState;
      },
      assertValid: () => {},
      getModelRule: () => ({ contextSize: 1000 }),
    },
  };
});

vi.mock('@packages/mica-agent/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@packages/mica-agent/index.js')>();
  return {
    ...actual,
    micaAgent: {
      ...actual.micaAgent,
      createModelClient: vi.fn(() => modelClient),
    },
  };
});

describe('AgentRuntime tool status', () => {
  beforeEach(() => {
    modelClient.resetState();
    configState = { ...testConfig, providers: [...testConfig.providers] };
  });

  it('returns to model-waiting status after a tool result is received', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const statuses: string[] = [];

    agent.events.on('status', (status) => statuses.push(status.type));
    modelClient.queryImpl = async () => {
      modelClient.onToolCall?.('run_shell', '{"command":"true"}', 'tool-1');
      modelClient.onToolResult?.('run_shell', 'done', 'tool-1');
      return 'ok';
    };

    await agent.run('hello');

    expect(statuses).toEqual(['connecting', 'calling_tool', 'connecting', 'completed']);
  });

  it('emits a retrying status when the provider reports a retry', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const statuses: Array<{ type: string; attempt?: number }> = [];

    agent.events.on('status', (status) => {
      statuses.push(
        status.type === 'retrying' ? { type: status.type, attempt: status.attempt } : { type: status.type },
      );
    });
    modelClient.queryImpl = async (_question, options) => {
      options?.onRetry?.({
        attempt: 2,
        error: new Error('503 Our servers are currently overloaded. Please try again later.'),
        delayMs: 4000,
      });
      return 'ok';
    };

    await agent.run('hello');

    expect(statuses).toContainEqual({ type: 'retrying', attempt: 2 });
    expect(statuses).toContainEqual({ type: 'completed' });
  });

  it('tracks each active module start time separately', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const { AgentRuntime } = await import('./AgentRuntime.js');
      const agent = new AgentRuntime();
      const statuses: Array<{ type: string; moduleStartedAt?: number }> = [];

      agent.events.on('status', (status) => {
        if ('moduleStartedAt' in status) statuses.push({ type: status.type, moduleStartedAt: status.moduleStartedAt });
        else statuses.push({ type: status.type });
      });
      modelClient.queryImpl = async () => {
        vi.setSystemTime(1100);
        modelClient.onToolCall?.('read_file', '{"file_path":"a"}', 'tool-1');
        vi.setSystemTime(1300);
        modelClient.onToolResult?.('read_file', 'done', 'tool-1');
        vi.setSystemTime(1600);
        modelClient.onText?.('ok');
        vi.setSystemTime(1700);
        return 'ok';
      };

      await agent.run('hello');

      expect(statuses).toEqual([
        { type: 'connecting', moduleStartedAt: 1000 },
        { type: 'calling_tool', moduleStartedAt: 1100 },
        { type: 'connecting', moduleStartedAt: 1300 },
        { type: 'streaming', moduleStartedAt: 1600 },
        { type: 'completed' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches role without dropping the existing client snapshot', async () => {
    const { micaAgent } = await import('@packages/mica-agent/index.js');
    const createModelClient = vi.mocked(micaAgent.createModelClient);
    const reviewerClient = createModelClientStub();
    createModelClient.mockReturnValueOnce(modelClient).mockReturnValueOnce(reviewerClient);
    vi.spyOn(micaAgent.roles, 'get').mockImplementation((name: string) =>
      name === 'reviewer'
        ? { name: 'reviewer', prompt: 'Review carefully.', builtIn: false, path: '/tmp/role/reviewer' }
        : { name: 'default', prompt: 'Default prompt.', builtIn: true },
    );
    modelClient.getSnapshot = vi.fn(() => ({
      model: 'test-model',
      messages: [{ role: 'user', content: 'keep this' }],
      usageHistory: [],
      lastUsage: undefined,
      conversationMessages: [],
    }));

    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    agent.setRole('reviewer');

    expect(agent.role).toBe('reviewer');
    expect(reviewerClient.loadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: 'user', content: 'keep this' }] }),
    );
    expect(agent.getSnapshot().role).toBe('reviewer');
    const options = createModelClient.mock.calls.at(-1)?.[0];
    expect(typeof options?.systemPrompt).toBe('function');
    expect((options?.systemPrompt as () => string)()).toContain('<system>\nReview carefully.\n</system>');
  });

  it('carries recorded subagent usage through snapshots and emits an event', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const emitted: unknown[] = [];
    agent.events.on('subagentUsage', (record) => emitted.push(record));

    agent.recordSubagentUsage({
      taskId: 'task-1',
      subagentType: 'Explore',
      description: 'search',
      effort: 'medium',
      status: 'completed',
      startedAt: '2026-08-01T00:00:00.000Z',
      finishedAt: '2026-08-01T00:01:00.000Z',
      requests: [
        {
          provider: 'openai_chat_completions',
          turnId: 1,
          requestIndex: 1,
          messageCount: 2,
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          paidTokenRate: 1,
        },
      ],
      summary: { records: 1, inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12 },
    });

    expect(agent.getSnapshot().subagentUsageHistory).toHaveLength(1);
    expect(agent.getSubagentUsageHistory()).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ taskId: 'task-1', status: 'completed' });

    agent.loadSnapshot(agent.getSnapshot());
    expect(agent.getSnapshot().subagentUsageHistory).toHaveLength(1);

    agent.loadSnapshot({
      providerId: 'test-provider',
      protocol: 'openai_chat_completions',
      model: 'test-model',
      effort: 'none',
      role: 'default',
      messages: [],
      usageHistory: [],
      lastUsage: undefined,
    });
    expect(agent.getSnapshot().subagentUsageHistory).toEqual([]);
  });

  it('applies a daemon-selected model without mutating global config and forwards maxTurns', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime({ model: 'daemon-model', effort: 'high' });
    let queryOptions: AgentQueryOptions | undefined;
    modelClient.queryImpl = async (_question, options) => {
      queryOptions = options;
      return 'ok';
    };

    await agent.run('hello', { maxTurns: 4 });
    agent.configureForRun({ effort: 'low' });

    expect(agent.config.model).toBe('daemon-model');
    expect(configState?.model).toBe('test-model');
    expect(queryOptions?.maxTurns).toBe(4);
  });

  it('builds the provider system prompt through synchronous plugin hooks', async () => {
    const { micaPlugin } = await import('@packages/mica-plugin/index.js');
    const hooks = new micaPlugin.HookRegistry();
    hooks.on('system-prompt:build', (event: { prompt: string }) => ({
      event: { ...event, prompt: `${event.prompt}\n\nPlugin system guidance.` },
    }));

    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime({}, hooks);
    const { micaAgent } = await import('@packages/mica-agent/index.js');
    const options = vi.mocked(micaAgent.createModelClient).mock.calls.at(-1)?.[0];

    expect(agent.buildSystemPrompt()).toContain('Plugin system guidance.');
    expect(typeof options?.systemPrompt).toBe('function');
    expect((options?.systemPrompt as () => string)()).toContain('Plugin system guidance.');
  });

  it('shares system prompt hooks with agents created for new terminal sessions', async () => {
    const { micaPlugin } = await import('@packages/mica-plugin/index.js');
    const hooks = new micaPlugin.HookRegistry();
    hooks.on('system-prompt:build', (event: { prompt: string }) => ({
      event: { ...event, prompt: `${event.prompt}\n\nShared session guidance.` },
    }));

    const { TerminalAgentSessionManager } = await import('../agents/terminalAgentSessions.js');
    const sessions = new TerminalAgentSessionManager(hooks);
    sessions.createSession();

    expect(sessions.current().agent.buildSystemPrompt()).toContain('Shared session guidance.');
  });
});

describe('AgentRuntime without a configured model', () => {
  beforeEach(() => {
    modelClient.resetState();
    configState = {
      ...testConfig,
      providers: [...testConfig.providers],
      model: '',
    };
  });

  it('constructs without throwing when model is empty (first-run UX)', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    expect(() => new AgentRuntime()).not.toThrow();
  });

  it('reports a clear error on run() when model is empty', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    await expect(agent.run('hello')).rejects.toThrow(/未配置模型/);
  });
});

function createModelClientStub(): IAgent<ModelClientOptions> & {
  queryImpl?: (question: AgentQueryContent, options?: AgentQueryOptions) => Promise<string>;
  resetState(): void;
} {
  return {
    model: 'test-model',
    messages: [],
    usageHistory: [],
    lastUsage: undefined,
    onText: undefined,
    onThinking: undefined,
    onToolCall: undefined,
    onToolResult: undefined,
    onUsage: undefined,
    configure: vi.fn(),
    reset: vi.fn(),
    async query(question, options) {
      return this.queryImpl?.(question, options) ?? '';
    },
    preserveAbortedTurn: vi.fn(() => false),
    toConversationMessages: vi.fn(() => []),
    getSnapshot: vi.fn(() => ({
      model: 'test-model',
      messages: [],
      usageHistory: [] as AgentUsageRecord[],
      lastUsage: undefined,
      conversationMessages: [],
    })),
    loadSnapshot: vi.fn(),
    resetState() {
      this.messages = [];
      this.usageHistory = [];
      this.lastUsage = undefined;
      this.onText = undefined;
      this.onThinking = undefined;
      this.onToolCall = undefined;
      this.onToolResult = undefined;
      this.onUsage = undefined;
      this.queryImpl = undefined;
      vi.mocked(this.configure).mockClear();
      vi.mocked(this.reset).mockClear();
      vi.mocked(this.preserveAbortedTurn).mockClear();
      vi.mocked(this.toConversationMessages).mockClear();
      vi.mocked(this.getSnapshot).mockClear();
      vi.mocked(this.loadSnapshot).mockClear();
    },
  };
}
