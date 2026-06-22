import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { micaUi } from '@packages/mica-ui/index.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from './services.js';

const previousHome = process.env.HOME;
const tempHome = mkdtempSync(join(tmpdir(), 'mica-config-switch-'));

beforeAll(() => {
  process.env.HOME = tempHome;
});

afterAll(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

describe('compactBeforeConfigSwitch', () => {
  it('skips compact-not-needed errors so config switches can continue', async () => {
    const { compactBeforeConfigSwitch } = await import('./configSwitch.js');
    const { CompactionNotNeededError } = await import('@packages/mica-context/index.js');
    const services = makeServices(async () => {
      throw new CompactionNotNeededError();
    });

    await expect(
      compactBeforeConfigSwitch(
        makeAgent([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }]),
        makeSession(),
        services,
        'provider',
      ),
    ).resolves.toBeUndefined();

    expect(services.compact).toHaveBeenCalledTimes(1);
    expect(services.showMessage).toHaveBeenCalledWith(
      'Current session is short; switching without compact',
      4000,
      'session-1',
    );
  });

  it('still fails on real compact errors', async () => {
    const { compactBeforeConfigSwitch } = await import('./configSwitch.js');
    const services = makeServices(async () => {
      throw new Error('summarizer unavailable');
    });

    await expect(
      compactBeforeConfigSwitch(
        makeAgent([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }]),
        makeSession(),
        services,
        'model',
      ),
    ).rejects.toThrow('summarizer unavailable');
  });
});

describe('config switch commands', () => {
  it.each([
    ['provider', 'Agent is busy; wait or abort before switching provider'],
    ['model', 'Agent is busy; wait or abort before switching model'],
    ['effort', 'Agent is busy; wait or abort before switching effort'],
  ] as const)('does not open the %s selector while the agent is busy', async (commandName, message) => {
    const services = makeServices(async () => {
      throw new Error('compact should not run');
    });
    services.isAgentBusy = vi.fn(() => true);
    services.showMessage = vi.fn();
    const setPluginUIs = vi.spyOn(micaUi.panels, 'setPluginUIs');
    const agent = makeAgent([]);
    const session = makeSession();

    try {
      const command = await makeConfigSwitchCommand(commandName, agent, session, services);
      await command.action();

      expect(services.showMessage).toHaveBeenCalledWith(message);
      expect(setPluginUIs).not.toHaveBeenCalled();
    } finally {
      setPluginUIs.mockRestore();
      micaUi.panels.clearPluginUIs();
    }
  });
});

async function makeConfigSwitchCommand(
  commandName: 'provider' | 'model' | 'effort',
  agent: CommandAgent,
  session: CommandSessionController,
  services: CommandRuntimeServices,
) {
  if (commandName === 'provider') {
    const { createProviderCommand } = await import('./provider.js');
    return createProviderCommand(agent, session, services);
  }
  if (commandName === 'model') {
    const { createModelCommand } = await import('./model.js');
    return createModelCommand(agent, session, services);
  }
  const { createEffortCommand } = await import('./effort.js');
  return createEffortCommand(agent, session, services);
}

function makeAgent(messages: unknown[]): CommandAgent {
  return {
    config: {
      provider: {
        id: 'test',
        contextWindowSize: 1000,
      },
      model: 'test-model',
      effort: 'none',
    },
    currentRunId: 0,
    isRunning: false,
    reloadConfig: vi.fn(),
    createSubAgent: () => ({ query: async () => '' }),
    getSnapshot: () => ({
      providerId: 'test',
      model: 'test-model',
      effort: 'none',
      messages,
      usageHistory: [],
    }),
  };
}

function makeSession(): CommandSessionController {
  return {
    list: () => [],
    resume: () => ({ ok: false, message: 'not found' }),
    startNewSession: vi.fn(),
    saveCurrent: vi.fn(),
  };
}

function makeServices(compact: CommandRuntimeServices['compact']): CommandRuntimeServices {
  return {
    clearUI: vi.fn(),
    showMessage: vi.fn(),
    setPluginStatus: vi.fn(),
    clearPluginStatus: vi.fn(),
    syncModelDisplay: vi.fn(),
    isAgentRunning: () => false,
    isAgentBusy: () => false,
    getCurrentAgentSessionId: () => 'session-1',
    getCurrentAgent: () => undefined,
    getCurrentSessionController: () => undefined,
    listRunningAgents: () => [],
    clearIdleAgents: () => ({ cleared: [], remaining: [] }),
    newAgentSession: makeRunningAgent,
    submitAgentSessionInput: async () => ({ ok: true }),
    forkCurrentAgent: () => ({ ...makeRunningAgent(), sourceWasRunning: false }),
    switchAgentSession: makeRunningAgent,
    refreshCurrentAgentSessionUi: vi.fn(),
    getRewindPreview: () => ({ ok: false, message: 'no checkpoint' }),
    applyRewind: () => ({
      id: 'rewind-1',
      conversationLabel: 'test',
      messageCount: 0,
      fileStateAvailable: false,
      files: [],
    }),
    runExclusiveTask: vi.fn((_agent, _options, task) => task()),
    compact: vi.fn(compact),
  };
}

function makeRunningAgent() {
  return {
    id: 'session-1',
    index: 1,
    title: 'Test session',
    cwd: process.cwd(),
    providerId: 'test',
    providerName: 'Test',
    model: 'test-model',
    status: { type: 'idle' as const },
    current: true,
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}
