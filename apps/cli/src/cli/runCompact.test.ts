import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCompact } from './runCompact.js';

const mocks = vi.hoisted(() => ({
  compact: vi.fn(),
  agent: null as any,
  sessionController: null as any,
}));

vi.mock('../agent/AgentRuntime.js', () => ({
  AgentRuntime: vi.fn(function () {
    return mocks.agent;
  }),
}));

vi.mock('../session/SessionController.js', () => ({
  SessionController: vi.fn(function () {
    return mocks.sessionController;
  }),
}));

vi.mock('@packages/mica-context/index.js', () => ({
  micaContext: {
    CompactionService: class {
      compact = mocks.compact;
    },
    CompactionNotNeededError: class CompactionNotNeededError extends Error {},
    resolveRequestOverhead: () => 0,
  },
}));

vi.mock('@packages/mica-config/index.js', () => ({
  micaConfig: {
    get: () => ({ model: 'test-model' }),
    ensureModelRule: vi.fn().mockResolvedValue(undefined),
    providerForModel: () => ({ id: 'test-provider' }),
    getModelRule: () => ({ contextSize: 1000 }),
  },
}));

vi.mock('@packages/mica-builtin-commands/startup/model-effort-context/index.js', () => ({
  default: () => () => {},
}));

vi.mock('../plugins/commands/compactConversation.js', () => ({
  toCompactedConversationDisplay: () => [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'checkpoint' },
  ],
}));

const compactResult = {
  messages: [{ type: 'message', role: 'assistant', content: 'checkpoint' }],
  summary: 'checkpoint',
  mode: 'summarized',
  strategy: 'summary_with_recent',
  beforeCount: 4,
  afterCount: 2,
  summarizedCount: 2,
  keptCount: 2,
  beforeTokenEstimate: 100,
  afterTokenEstimate: 50,
  savedTokenEstimate: 50,
  savedRatio: 0.5,
  boundaryIndex: 1,
  promptTooLongRetries: 0,
  forced: false,
  preview: false,
};

function addUsage(agent: any): void {
  agent.subAgent.usageHistory.push({
    usageId: 'summary-usage',
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 0,
    totalTokens: 15,
  });
}

beforeEach(() => {
  mocks.compact.mockReset();
  const snapshot = {
    messages: [
      { type: 'message', role: 'user', content: 'question' },
      { type: 'message', role: 'assistant', content: 'answer' },
      { type: 'message', role: 'user', content: 'follow-up' },
      { type: 'message', role: 'assistant', content: 'more' },
    ],
    usageHistory: [],
    lastUsage: undefined,
    subagentUsageHistory: [],
    contextWindowSize: 1000,
  };
  mocks.agent = {
    config: { model: 'test-model', provider: { id: 'test-provider' }, effort: 'low' },
    snapshot,
    getSnapshot: vi.fn(() => snapshot),
    configureForRun: vi.fn(),
    loadSnapshot: vi.fn(),
    toConversationMessages: vi.fn(() => []),
    getSubagentUsageHistory: vi.fn(() => mocks.agent.snapshot.subagentUsageHistory),
    recordSubagentUsage: vi.fn((record: unknown) => mocks.agent.snapshot.subagentUsageHistory.push(record)),
    createSubAgent: vi.fn(() => {
      const subAgent = { usageHistory: [] as any[], query: vi.fn() };
      mocks.agent.subAgent = subAgent;
      return subAgent;
    }),
  };
  mocks.sessionController = {
    resume: vi.fn(() => ({ ok: true, session: { cwd: '/tmp' } })),
    getCurrentSessionId: vi.fn(() => 'session-1'),
    saveCurrent: vi.fn(),
  };
  mocks.compact.mockImplementation(async (input) => {
    await input.summarize('transcript', 'prompt');
    return compactResult;
  });
});

describe('runCompact', () => {
  it('records a successful summary and applies the compacted session', async () => {
    mocks.agent.createSubAgent.mockImplementation(() => {
      const subAgent = {
        usageHistory: [],
        query: vi.fn(async () => {
          addUsage({ subAgent });
          return 'checkpoint';
        }),
      };
      mocks.agent.subAgent = subAgent;
      return subAgent;
    });

    const result = await runCompact({ sessionId: 'session-1' });

    expect(result).toMatchObject({ ok: true, sessionId: 'session-1' });
    expect(mocks.agent.recordSubagentUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        requests: [expect.objectContaining({ usageId: 'summary-usage' })],
      }),
    );
    expect(mocks.agent.loadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ messages: compactResult.messages, subagentUsageHistory: expect.any(Array) }),
    );
    expect(mocks.sessionController.saveCurrent).toHaveBeenCalledTimes(1);
  });

  it('records query failures as failed while retaining usage', async () => {
    mocks.agent.createSubAgent.mockImplementation(() => {
      const subAgent = {
        usageHistory: [],
        query: vi.fn(async () => {
          addUsage({ subAgent });
          throw new Error('summary failed');
        }),
      };
      mocks.agent.subAgent = subAgent;
      return subAgent;
    });

    const result = await runCompact({ sessionId: 'session-1' });

    expect(result).toMatchObject({ ok: false, code: 'error', error: 'summary failed' });
    expect(mocks.agent.recordSubagentUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', requests: [expect.objectContaining({ usageId: 'summary-usage' })] }),
    );
    expect(mocks.agent.loadSnapshot).not.toHaveBeenCalled();
    expect(mocks.sessionController.saveCurrent).not.toHaveBeenCalled();
  });

  it('passes abort to the query and does not apply or save compacted history', async () => {
    const controller = new AbortController();
    mocks.agent.createSubAgent.mockImplementation(() => {
      const subAgent = {
        usageHistory: [],
        query: vi.fn((_prompt: string, options: { signal?: AbortSignal }) => {
          return new Promise<string>((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => {
                addUsage({ subAgent });
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          });
        }),
      };
      mocks.agent.subAgent = subAgent;
      return subAgent;
    });

    const pending = runCompact({ sessionId: 'session-1', signal: controller.signal });
    await vi.waitFor(() => expect(mocks.agent.subAgent.query).toHaveBeenCalled());
    expect(mocks.compact).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(mocks.agent.subAgent.query).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );

    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, code: 'error' });
    expect(mocks.agent.recordSubagentUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'killed', requests: [expect.objectContaining({ usageId: 'summary-usage' })] }),
    );
    expect(mocks.agent.loadSnapshot).not.toHaveBeenCalled();
    expect(mocks.sessionController.saveCurrent).not.toHaveBeenCalled();
  });
});
