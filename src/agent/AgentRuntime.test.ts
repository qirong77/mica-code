import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffortOption, IMicaConfig, ProviderDefinition } from '@packages/mica-config/index.js';
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
      clampProviderEffort: (_p: ProviderDefinition, effort: EffortOption) => effort,
      getModelContextWindowSizeFromConfig: () => 1000,
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
