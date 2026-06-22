import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from './services.js';

const previousHome = process.env.HOME;
const previousMicaHome = process.env.MICA_HOME;
const tempHome = mkdtempSync(join(tmpdir(), 'mica-config-switch-'));
let micaUi: typeof import('@packages/mica-ui/index.js').micaUi;

beforeAll(async () => {
  process.env.HOME = tempHome;
  process.env.MICA_HOME = tempHome;
  ({ micaUi } = await import('@packages/mica-ui/index.js'));
});

afterAll(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousMicaHome === undefined) {
    delete process.env.MICA_HOME;
  } else {
    process.env.MICA_HOME = previousMicaHome;
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

  it('clamps effort when switching to a model with narrower effort support', async () => {
    const { micaConfig } = await import('@packages/mica-config/index.js');
    const provider = {
      id: 'openai',
      name: 'OpenAI',
      api_base: 'https://api.openai.com/v1',
      api_key: 'test-key',
      model: 'gpt-5.4',
      effort: 'medium' as const,
      models: ['gpt-5.5', 'gpt-5.4'],
      contextWindowSize: 1000,
    };
    micaConfig.update(() => ({
      provider: provider.id,
      model: 'gpt-5.4',
      effort: 'minimal',
      contextWindowSize: provider.contextWindowSize,
      providers: [provider],
    }));
    const services = makeServices(async () => {
      throw new Error('compact should not run');
    });
    const agent = makeAgent([], {
      provider,
      model: 'gpt-5.4',
      effort: 'minimal',
    });
    const session = makeSession();

    try {
      const command = await makeConfigSwitchCommand('model', agent, session, services);
      await command.action();
      const panel = micaUi.panels.pluginUIs.get()[0];
      expect(panel?.id).toBe('select-model');

      panel?.onInput?.('', { upArrow: true });
      panel?.onInput?.('', { return: true });
      await waitForSelectCommand();

      expect(micaConfig.get().model).toBe('gpt-5.5');
      expect(micaConfig.get().effort).toBe('low');
      const persistedConfig = JSON.parse(readFileSync(micaConfig.path, 'utf-8')) as Record<string, unknown>;
      const persistedStorage = JSON.parse(readFileSync(micaConfig.storage.path, 'utf-8')) as {
        lastUsed?: Record<string, unknown>;
      };
      expect(persistedConfig.provider).toBeUndefined();
      expect(persistedConfig.model).toBeUndefined();
      expect(persistedConfig.effort).toBeUndefined();
      expect(persistedConfig.contextWindowSize).toBeUndefined();
      expect(persistedStorage.lastUsed).toMatchObject({
        provider: 'openai',
        model: 'gpt-5.5',
        effort: 'low',
        contextWindowSize: 256000,
      });
      expect(agent.reloadConfig).toHaveBeenCalledWith(false);
      expect(session.saveCurrent).toHaveBeenCalled();
    } finally {
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

function makeAgent(
  messages: unknown[],
  config: CommandAgent['config'] = {
    provider: {
      id: 'test',
      api_base: 'https://example.com/v1',
      model: 'test-model',
      effort: 'none',
      contextWindowSize: 1000,
    },
    model: 'test-model',
    effort: 'none',
  },
): CommandAgent {
  return {
    config,
    currentRunId: 0,
    isRunning: false,
    reloadConfig: vi.fn(),
    createSubAgent: () => ({ query: async () => '' }),
    getSnapshot: () => ({
      providerId: config.provider.id,
      model: config.model,
      effort: config.effort,
      messages,
      usageHistory: [],
    }),
  };
}

function waitForSelectCommand(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
    requestExit: vi.fn(),
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
