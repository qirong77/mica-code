import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '../services.js';

const previousHome = process.env.HOME;
const previousMicaHome = process.env.MICA_HOME;
const tempHome = mkdtempSync(join(tmpdir(), 'mica-config-switch-'));
let micaUi: typeof import('@packages/mica-ui/index.js').micaUi;
let micaConfig: typeof import('@packages/mica-config/index.js').micaConfig;

beforeAll(async () => {
  process.env.HOME = tempHome;
  process.env.MICA_HOME = tempHome;
  ({ micaUi } = await import('@packages/mica-ui/index.js'));
  ({ micaConfig } = await import('@packages/mica-config/index.js'));
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

describe('config switch commands', () => {
  it.each([
    ['provider', 'Agent is busy; wait or abort before switching provider'],
    ['model', 'Agent is busy; wait or abort before switching model'],
    ['effort', 'Agent is busy; wait or abort before switching effort'],
  ] as const)('does not open the %s selector while the agent is busy', async (commandName, message) => {
    const services = makeServices();
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
      protocol: 'openai_chat_completions' as const,
      models: ['gpt-5.5', 'gpt-5.4'],
    };
    micaConfig.update(() => ({
      provider: provider.id,
      model: 'gpt-5.4',
      effort: 'low',
      contextWindowSize: 256000,
      providers: [provider],
    }));
    const services = makeServices();
    const agent = makeAgent([], {
      provider: { ...provider, contextWindowSize: 256000 },
      model: 'gpt-5.4',
      effort: 'low',
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

      expect(micaUi.panels.pluginUIs.get()[0]?.id).toBe('select-effort');
      expect(micaConfig.get().model).toBe('gpt-5.5');
      expect(micaConfig.get().effort).toBe('low');
      expect(services.showMessage).toHaveBeenLastCalledWith('Model: gpt-5.5', undefined);
      const persistedConfig = JSON.parse(readFileSync(micaConfig.path, 'utf-8')) as Record<string, unknown>;
      const persistedStorage = JSON.parse(readFileSync(micaConfig.storage.path, 'utf-8')) as {
        lastUsedByDirectory?: Record<string, Record<string, unknown>>;
      };
      expect(persistedConfig.provider).toBeUndefined();
      expect(persistedConfig.model).toBeUndefined();
      expect(persistedConfig.effort).toBeUndefined();
      expect(persistedConfig.contextWindowSize).toBeUndefined();
      expect(persistedStorage.lastUsedByDirectory?.[process.cwd()]).toMatchObject({
        provider: 'openai',
        model: 'gpt-5.5',
        effort: 'low',
      });
      expect(agent.reloadConfig).toHaveBeenCalledWith(false);
      expect(session.saveCurrent).toHaveBeenCalled();
    } finally {
      micaUi.panels.clearPluginUIs();
    }
  });

  it('normalizes effort and context defaults when switching provider', async () => {
    const { micaConfig } = await import('@packages/mica-config/index.js');
    const openai = {
      id: 'openai',
      name: 'OpenAI',
      api_base: 'https://api.openai.com/v1',
      api_key: 'test-key',
      protocol: 'openai_chat_completions' as const,
      models: ['gpt-5.4'],
    };
    const deepseek = {
      id: 'deepseek',
      name: 'DeepSeek',
      api_base: 'https://api.deepseek.com',
      api_key: 'test-key',
      protocol: 'openai_chat_completions' as const,
      models: ['deepseek-v4-pro'],
    };
    micaConfig.update(() => ({
      provider: openai.id,
      model: 'gpt-5.4',
      effort: 'low',
      contextWindowSize: 256000,
      providers: [openai, deepseek],
    }));
    const services = makeServices();
    const agent = makeAgent([], {
      provider: { ...openai, contextWindowSize: 256000 },
      model: 'gpt-5.4',
      effort: 'low',
    });
    const session = makeSession();

    try {
      const command = await makeConfigSwitchCommand('provider', agent, session, services);
      await command.action();
      const panel = micaUi.panels.pluginUIs.get()[0];
      expect(panel?.id).toBe('select-provider');

      panel?.onInput?.('', { downArrow: true });
      panel?.onInput?.('', { return: true });
      await waitForSelectCommand();

      let activePanel = micaUi.panels.pluginUIs.get()[0];
      expect(activePanel?.id).toBe('select-model');
      expect(micaConfig.get()).toMatchObject({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        effort: 'low',
        contextWindowSize: 1000000,
      });

      activePanel?.onInput?.('', { return: true });
      await waitForSelectCommand();

      activePanel = micaUi.panels.pluginUIs.get()[0];
      expect(activePanel?.id).toBe('select-effort');

      activePanel?.onInput?.('', { return: true });
      await waitForSelectCommand();

      expect(micaConfig.get()).toMatchObject({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        effort: 'low',
        contextWindowSize: 1000000,
      });
      expect(services.showMessage).toHaveBeenLastCalledWith('Provider: deepseek', 3000);
      expect(agent.reloadConfig).toHaveBeenCalledWith(false);
      expect(session.saveCurrent).toHaveBeenCalled();
    } finally {
      micaUi.panels.clearPluginUIs();
    }
  });

  it('uses the target agent provider when the global config belongs to another agent', async () => {
    const { micaConfig } = await import('@packages/mica-config/index.js');
    const deepseek = {
      id: 'deepseek',
      name: 'DeepSeek',
      api_base: 'https://api.deepseek.com',
      api_key: 'test-key',
      protocol: 'openai_chat_completions' as const,
      models: ['deepseek-v4-pro'],
    };
    const openai = {
      id: 'openai',
      name: 'OpenAI',
      api_base: 'https://api.openai.com/v1',
      api_key: 'test-key',
      protocol: 'openai_chat_completions' as const,
      models: ['gpt-5.5', 'gpt-5.4'],
    };
    micaConfig.update(() => ({
      provider: deepseek.id,
      model: 'deepseek-v4-pro',
      effort: 'low',
      contextWindowSize: 1000000,
      providers: [deepseek, openai],
    }));
    const services = makeServices();
    const agent = makeAgent([], {
      provider: { ...openai, contextWindowSize: 256000 },
      model: 'gpt-5.4',
      effort: 'low',
    });
    const session = makeSession();

    try {
      const command = await makeConfigSwitchCommand('model', agent, session, services);
      await command.action();

      expect(micaConfig.get().provider).toBe('openai');
      const panel = micaUi.panels.pluginUIs.get()[0];
      expect(panel?.id).toBe('select-model');

      panel?.onInput?.('', { upArrow: true });
      panel?.onInput?.('', { return: true });
      await waitForSelectCommand();

      expect(micaConfig.get().provider).toBe('openai');
      expect(micaConfig.get().model).toBe('gpt-5.5');
      expect(services.showMessage).toHaveBeenLastCalledWith('Model: gpt-5.5', undefined);
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
    const { createProviderCommand } = await import('../commands/provider.js');
    return createProviderCommand(agent, session, services);
  }
  if (commandName === 'model') {
    const { createModelCommand } = await import('../commands/model.js');
    return createModelCommand(agent, session, services);
  }
  const { createEffortCommand } = await import('../commands/effort.js');
  return createEffortCommand(agent, session, services);
}

function makeAgent(
  messages: unknown[],
  config: CommandAgent['config'] = {
    provider: {
      id: 'test',
      api_base: 'https://example.com/v1',
      protocol: 'openai_chat_completions',
      models: ['test-model'],
      contextWindowSize: 1000,
    },
    model: 'test-model',
    effort: 'none',
  },
): CommandAgent {
  let currentConfig = config;
  const reloadConfig = vi.fn(() => {
    const runtimeConfig = micaConfig.get();
    const provider = runtimeConfig.providers.find((item) => item.id === runtimeConfig.provider);
    if (!provider) return;
    currentConfig = {
      provider: { ...provider, contextWindowSize: runtimeConfig.contextWindowSize },
      model: runtimeConfig.model,
      effort: runtimeConfig.effort,
    };
  });
  return {
    get config() {
      return currentConfig;
    },
    currentRunId: 0,
    isRunning: false,
    role: 'default',
    reloadConfig,
    setRole: vi.fn(),
    buildSystemPrompt: () => '<system>test</system>',
    createSubAgent: () => ({ query: async () => '' }),
    getSnapshot: () => ({
      providerId: currentConfig.provider.id,
      model: currentConfig.model,
      effort: currentConfig.effort,
      role: 'default',
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
    listRecent: () => [],
    resume: () => ({ ok: false, message: 'not found' }),
    startNewSession: vi.fn(),
    saveCurrent: vi.fn(),
    renameCurrent: vi.fn(),
  };
}

function makeServices(): CommandRuntimeServices {
  return {
    clearUI: vi.fn(),
    showMessage: vi.fn(),
    showNotice: vi.fn(),
    showCommitNotice: vi.fn(),
    setPluginStatus: vi.fn(),
    clearPluginStatus: vi.fn(),
    syncModelDisplay: vi.fn(),
    isAgentRunning: () => false,
    isAgentBusy: () => false,
    getCurrentAgentSessionId: () => 'session-1',
    getCurrentAgent: () => undefined,
    getCurrentSessionController: () => undefined,
    renameCurrentAgentSession: vi.fn(),
    listRunningAgents: () => [],
    listSubagentTasks: () => [],
    getSubagentTask: () => undefined,
    clearIdleAgents: () => ({ cleared: [], remaining: [] }),
    requestExit: vi.fn(),
    newAgentSession: makeRunningAgent,
    submitAgentSessionInput: async () => ({ ok: true }),
    forkCurrentAgent: () => ({ ...makeRunningAgent(), sourceWasRunning: false }),
    switchAgentSession: makeRunningAgent,
    refreshCurrentAgentSessionUi: vi.fn(),
    listRewindCheckpoints: () => [],
    getRewindPreview: () => ({ ok: false, message: 'no checkpoint' }),
    applyRewind: () => ({
      id: 'rewind-1',
      mode: 'conversation_only',
      conversationLabel: 'test',
      inputText: 'test',
      messageCountBefore: 0,
      messageCountNow: 0,
      messageCountRemoved: 0,
      conversationMessagesBefore: [],
      fileStateAvailable: false,
      files: [],
    }),
    runExclusiveTask: vi.fn((_agent, _options, task) => task()),
    compact: vi.fn(),
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
