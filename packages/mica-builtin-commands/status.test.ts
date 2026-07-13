import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import type { PersistedSession } from '@packages/mica-session/index.js';
import type { CommandAgent, CommandSessionController } from './services.js';

const mocks = vi.hoisted(() => ({
  createStore: vi.fn(),
}));

vi.mock('@packages/mica-session/index.js', () => ({
  micaSession: {
    dir: '/tmp/mica-sessions',
    createStore: mocks.createStore,
  },
}));

vi.mock('@packages/mica-ui/index.js', () => ({
  micaUi: {
    dropdown: {
      setQuickCommands: vi.fn(),
    },
    Dialog: ({ children }: { children: unknown }) => children,
    BottomScrollBox: ({ children }: { children: unknown }) => children,
    KeyHints: () => null,
    theme: {
      colors: {
        dim: 'gray',
      },
    },
    panels: {
      upsertPluginUI: vi.fn(),
      removePluginUI: vi.fn(),
      contextSize: { get: vi.fn(() => 0) },
      modelDisplay: {
        contextWindowSize: { get: vi.fn(() => 0) },
      },
    },
    terminalInput: {
      text: { get: vi.fn(() => '') },
    },
  },
}));

const { createStatusCommand, summarizeAllSessionUsage } = await import('./status.js');

describe('status command', () => {
  beforeEach(() => {
    mocks.createStore.mockReset();
  });

  it('exposes the total completion item', () => {
    const command = createStatusCommand(makeAgent([]));

    expect(command.completionItems).toEqual([{ arg: 'total', description: '显示本地全部 session 的累计 token 使用' }]);
  });

  it('sums persisted session usage and replaces the current session with the live snapshot', () => {
    const persistedCurrent = makeSession('current', [
      makeUsage({ inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 25 }),
    ]);
    const persistedOther = makeSession('other', [
      makeUsage({ inputTokens: 200, outputTokens: 20, totalTokens: 220, cachedInputTokens: 50 }),
    ]);
    mocks.createStore.mockReturnValue(makeStore([persistedCurrent, persistedOther]));

    const liveCurrentUsage = makeUsage({
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: 1100,
      cachedInputTokens: 400,
    });
    const totals = summarizeAllSessionUsage(makeAgent([liveCurrentUsage]), makeSessionController('current'));

    expect(totals).toMatchObject({
      sessions: 2,
      sessionsWithUsage: 2,
      records: 2,
      inputTokens: 1200,
      outputTokens: 120,
      totalTokens: 1320,
      cachedInputTokens: 450,
      currentSessionIncluded: true,
    });
  });

  it('includes an unsaved active session when it has usage', () => {
    mocks.createStore.mockReturnValue(makeStore([]));

    const liveUsage = makeUsage({
      inputTokens: 300,
      outputTokens: 30,
      totalTokens: 330,
      cachedInputTokens: 90,
    });
    const totals = summarizeAllSessionUsage(makeAgent([liveUsage]), makeSessionController('current'));

    expect(totals).toMatchObject({
      sessions: 1,
      sessionsWithUsage: 1,
      records: 1,
      inputTokens: 300,
      outputTokens: 30,
      totalTokens: 330,
      cachedInputTokens: 90,
      currentSessionIncluded: true,
    });
  });

  it('uses the usage-specific store scan so legacy sessions are included', () => {
    const legacy = makeSession('legacy', [makeUsage({ inputTokens: 500, outputTokens: 50, totalTokens: 550 })]);
    const store = makeStore([legacy]);
    store.list.mockReturnValue([]);
    mocks.createStore.mockReturnValue(store);

    const totals = summarizeAllSessionUsage(makeAgent([]));

    expect(store.listAllForUsage).toHaveBeenCalledOnce();
    expect(totals).toMatchObject({ sessions: 1, records: 1, totalTokens: 550 });
  });
});

function makeStore(sessions: PersistedSession[]) {
  return {
    listAllForUsage: vi.fn(() => sessions),
    list: vi.fn(() =>
      sessions.map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        cwd: session.cwd,
        providerId: session.snapshot.providerId,
        model: session.snapshot.model,
      })),
    ),
    load: vi.fn((id: string) => sessions.find((session) => session.id === id) ?? null),
    save: vi.fn(),
  };
}

function makeSession(id: string, usageHistory: AgentUsageRecord[]): PersistedSession {
  return {
    version: 1,
    id,
    title: id,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(1000).toISOString(),
    cwd: '/tmp/project',
    snapshot: {
      providerId: 'openai',
      protocol: 'openai_chat_completions',
      model: 'gpt-5',
      effort: 'medium',
      role: 'default',
      messages: [],
      conversationMessages: [],
      usageHistory,
      lastUsage: usageHistory.at(-1),
    },
  };
}

function makeUsage(overrides: Partial<AgentUsageRecord>): AgentUsageRecord {
  return {
    provider: 'openai_chat_completions',
    turnId: 1,
    requestIndex: 0,
    messageCount: 2,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    paidTokenRate: 1,
    ...overrides,
  };
}

function makeAgent(usageHistory: AgentUsageRecord[]): CommandAgent {
  return {
    config: {
      model: 'gpt-5',
      effort: 'medium',
      provider: {
        api_base: 'https://api.openai.com',
        id: 'openai',
        name: 'OpenAI',
        protocol: 'openai_chat_completions',
        contextWindowSize: 256000,
        supportsEffort: true,
      },
    },
    currentRunId: 0,
    isRunning: false,
    role: 'default',
    reloadConfig() {},
    setRole() {},
    buildSystemPrompt() {
      return '<system>test</system>';
    },
    createSubAgent() {
      return { query: async () => '' };
    },
    getSnapshot() {
      return {
        providerId: 'openai',
        model: 'gpt-5',
        effort: 'medium',
        role: 'default',
        messages: [],
        usageHistory,
        lastUsage: usageHistory.at(-1),
      };
    },
  };
}

function makeSessionController(id: string): CommandSessionController {
  return {
    list: vi.fn(() => []),
    resume: vi.fn((_sessionId: string) => ({ ok: false as const, message: 'not implemented' })),
    startNewSession: vi.fn(),
    saveCurrent: vi.fn(),
    renameCurrent: vi.fn(),
    getCurrentSessionId: vi.fn(() => id),
  };
}
