import { describe, expect, it, vi } from 'vitest';
import { createRecapCommand } from './recap.js';
import type { CommandAgent, CommandRuntimeServices } from './services.js';

describe('createRecapCommand', () => {
  it('runs saved recap through current agent and owner session', async () => {
    const agent = makeAgent();
    const currentAgent = makeAgent();
    const services = makeServices({ currentAgent });
    const command = createRecapCommand(agent, services);

    await command.action('focus next step');

    expect(services.recap).toHaveBeenCalledWith(currentAgent, 'session-1', {
      customInstructions: 'focus next step',
    });
  });

  it('does not recap while agent is busy', async () => {
    const services = makeServices({ busy: true });
    const command = createRecapCommand(makeAgent(), services);

    await command.action();

    expect(services.recap).not.toHaveBeenCalled();
    expect(services.showMessage).toHaveBeenCalledWith('recap: agent is busy; wait or abort first', 5000, 'session-1');
  });
});

function makeAgent(): CommandAgent {
  return {
    config: {
      provider: {
        id: 'test',
        name: 'Test',
        api_base: '',
        api_key: '',
        protocol: 'openai_chat_completions',
        models: ['m'],
        contextWindowSize: 1000,
      },
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

function makeServices(options: { currentAgent?: CommandAgent; busy?: boolean } = {}): CommandRuntimeServices {
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
    getCurrentSessionController: vi.fn(),
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
    compact: vi.fn(),
    recap: vi.fn(async () => ({ summary: 'summary', messageCount: 2 })),
    requestExit: vi.fn(),
  };
  return services as unknown as CommandRuntimeServices;
}
