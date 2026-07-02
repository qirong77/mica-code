import { describe, expect, it, vi } from 'vitest';
import { CompactionNotNeededError, type CompactResult } from '@packages/mica-context/index.js';
import { createCompactCommand } from './compact.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from './services.js';

describe('createCompactCommand', () => {
  it('passes current session controller, owner session, and fixed compact options', async () => {
    const agent = makeAgent();
    const currentAgent = makeAgent();
    const session = makeSession();
    const currentSession = makeSession();
    const result = makeResult();
    const services = makeServices({ currentAgent, currentSession, result });
    const command = createCompactCommand(agent, session, services);

    await command.action();

    expect(services.compact).toHaveBeenCalledWith(currentAgent, currentSession, 'session-1', {
      aggressive: true,
      force: true,
      keepRecentRounds: 1,
    });
    expect(services.showMessage).toHaveBeenCalledWith(expect.stringContaining('compact'), 8000, 'session-1');
  });

  it('rejects arguments instead of treating them as compact options', async () => {
    const services = makeServices({});
    const command = createCompactCommand(makeAgent(), makeSession(), services);

    await command.action('--force --keep-recent=1');

    expect(services.compact).not.toHaveBeenCalled();
    expect(services.showMessage).toHaveBeenCalledWith(
      'compact: /compact 不支持参数，请直接运行 /compact',
      5000,
      'session-1',
    );
  });

  it('shows not-needed compaction as a normal message', async () => {
    const services = makeServices({ error: new CompactionNotNeededError('too small') });
    const command = createCompactCommand(makeAgent(), makeSession(), services);

    await command.action();

    expect(services.showMessage).toHaveBeenCalledWith('compact: too small', 5000, 'session-1');
    expect(String(vi.mocked(services.showMessage).mock.calls[0]?.[0])).not.toContain('failed');
  });

  it('does not compact while agent is busy', async () => {
    const services = makeServices({ busy: true });
    const command = createCompactCommand(makeAgent(), makeSession(), services);

    await command.action();

    expect(services.compact).not.toHaveBeenCalled();
    expect(services.showMessage).toHaveBeenCalledWith('compact: agent is busy; wait or abort first', 5000, 'session-1');
  });
});

function makeAgent(): CommandAgent {
  return {
    config: {
      provider: { id: 'test', name: 'Test', api_base: '', api_key: '', model: 'm', contextWindowSize: 1000 },
      model: 'm',
      effort: 'none',
    },
    currentRunId: 0,
    isRunning: false,
    reloadConfig: vi.fn(),
    createSubAgent: vi.fn(() => ({ query: vi.fn() })),
    getSnapshot: vi.fn(() => ({ providerId: 'test', model: 'm', effort: 'none', messages: [], usageHistory: [] })),
  } as unknown as CommandAgent;
}

function makeSession(): CommandSessionController {
  return {
    list: vi.fn(() => []),
    resume: vi.fn(() => ({ ok: false as const, message: 'not found' })),
    startNewSession: vi.fn(),
    saveCurrent: vi.fn(),
    renameCurrent: vi.fn(),
  };
}

function makeResult(overrides: Partial<CompactResult> = {}): CompactResult {
  return {
    messages: [],
    summary: 'summary',
    beforeCount: 20,
    afterCount: 6,
    summarizedCount: 14,
    keptCount: 4,
    beforeTokenEstimate: 10_000,
    afterTokenEstimate: 2_000,
    savedTokenEstimate: 8_000,
    savedRatio: 0.8,
    boundaryIndex: -1,
    promptTooLongRetries: 0,
    forced: false,
    preview: false,
    ...overrides,
  };
}

function makeServices(options: {
  currentAgent?: CommandAgent;
  currentSession?: CommandSessionController;
  result?: CompactResult;
  error?: Error;
  busy?: boolean;
}): CommandRuntimeServices {
  const services = {
    clearUI: vi.fn(),
    showMessage: vi.fn(),
    showNotice: vi.fn(),
    setPluginStatus: vi.fn(),
    clearPluginStatus: vi.fn(),
    syncModelDisplay: vi.fn(),
    isAgentRunning: vi.fn(() => false),
    isAgentBusy: vi.fn(() => Boolean(options.busy)),
    getCurrentAgentSessionId: vi.fn(() => 'session-1'),
    getCurrentAgent: vi.fn(() => options.currentAgent),
    getCurrentSessionController: vi.fn(() => options.currentSession),
    renameCurrentAgentSession: vi.fn(),
    listRunningAgents: vi.fn(() => []),
    clearIdleAgents: vi.fn(() => ({ cleared: [], remaining: [] })),
    newAgentSession: vi.fn(),
    submitAgentSessionInput: vi.fn(),
    forkCurrentAgent: vi.fn(),
    switchAgentSession: vi.fn(),
    refreshCurrentAgentSessionUi: vi.fn(),
    getRewindPreview: vi.fn(),
    applyRewind: vi.fn(),
    runExclusiveTask: vi.fn(async (_agent, _taskOptions, task) => task()),
    compact: vi.fn(async () => {
      if (options.error) throw options.error;
      return options.result ?? makeResult();
    }),
    recap: vi.fn(),
    requestExit: vi.fn(),
  };
  return services as unknown as CommandRuntimeServices;
}
