import { describe, expect, it, vi } from 'vitest';
import { createClearCommand } from '../../../plugins/builtin/command-clear.mjs';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '../services.js';

describe('createClearCommand', () => {
  it('starts a fresh persisted session in the current agent', () => {
    const agent = makeAgent();
    const sessionController = makeSessionController();
    const services = makeServices();
    const onCleared = vi.fn();
    const command = createClearCommand(agent, sessionController, services, onCleared);

    command.action();

    expect(services.clearUI).toHaveBeenCalledWith(agent, sessionController);
    expect(services.clearSubagentTasks).toHaveBeenCalledWith(agent);
    expect(services.newAgentSession).not.toHaveBeenCalled();
    expect(services.switchAgentSession).not.toHaveBeenCalled();
    expect(onCleared).toHaveBeenCalledOnce();
    expect(services.showNotice).toHaveBeenCalledWith('Started new session', undefined, {
      command: '/clear',
      status: 'success',
    });
  });

  it('does not create a new session while the current agent is busy', () => {
    const services = makeServices({ busy: true });
    const onCleared = vi.fn();
    const command = createClearCommand(makeAgent(), makeSessionController(), services, onCleared);

    command.action();

    expect(services.clearUI).not.toHaveBeenCalled();
    expect(services.clearSubagentTasks).not.toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
    expect(services.showNotice).toHaveBeenCalledWith('Agent is busy; wait or abort before starting a new session', undefined, {
      command: '/clear',
      status: 'warning',
    });
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

function makeSessionController(): CommandSessionController {
  return {
    list: vi.fn(() => []),
    listRecent: vi.fn(() => []),
    resume: vi.fn(() => ({ ok: false as const, message: 'not found' })),
    startNewSession: vi.fn(),
    saveCurrent: vi.fn(),
    renameCurrent: vi.fn(),
  };
}

function makeServices(options: { busy?: boolean } = {}): CommandRuntimeServices {
  return {
    clearUI: vi.fn(),
    clearSubagentTasks: vi.fn(() => 0),
    showMessage: vi.fn(),
    showNotice: vi.fn(),
    setPluginStatus: vi.fn(),
    clearPluginStatus: vi.fn(),
    syncModelDisplay: vi.fn(),
    isAgentRunning: vi.fn(() => false),
    isAgentBusy: vi.fn(() => Boolean(options.busy)),
    getCurrentAgentSessionId: vi.fn(() => 'session-1'),
    getCurrentAgent: vi.fn(),
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
  } as unknown as CommandRuntimeServices;
}
