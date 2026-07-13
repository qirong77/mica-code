import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from './services.js';

const mocks = vi.hoisted(() => ({
  listRoles: vi.fn(),
  getRole: vi.fn(),
}));

vi.mock('@packages/mica-agent/index.js', () => ({
  micaAgent: {
    roles: {
      list: mocks.listRoles,
      get: mocks.getRole,
      directory: () => '/tmp/.mica/role',
    },
  },
}));

vi.mock('@packages/mica-ui/index.js', () => ({
  micaUi: {
    dropdown: { setQuickCommands: vi.fn() },
  },
}));

const { createRoleCommand } = await import('./role.js');

describe('role command', () => {
  beforeEach(() => {
    mocks.listRoles.mockReset();
    mocks.getRole.mockReset();
  });

  it('switches role, preserves command ownership, and saves the session', () => {
    mocks.getRole.mockReturnValue({
      name: 'reviewer',
      prompt: 'Review carefully.',
      builtIn: false,
      path: '/tmp/.mica/role/reviewer',
    });
    const setRole = vi.fn();
    const saveCurrent = vi.fn();
    const showMessage = vi.fn();
    const agent = makeAgent({ setRole });
    const session = makeSession({ saveCurrent });
    const services = makeServices({ agent, session, showMessage });

    createRoleCommand(agent, session, services).action('reviewer');

    expect(setRole).toHaveBeenCalledWith('reviewer');
    expect(saveCurrent).toHaveBeenCalledOnce();
    expect(showMessage).toHaveBeenCalledWith('Role: reviewer', 3000, 'agent-1');
  });

  it('does not switch to an unknown role', () => {
    mocks.getRole.mockReturnValue(undefined);
    const setRole = vi.fn();
    const saveCurrent = vi.fn();
    const showMessage = vi.fn();
    const agent = makeAgent({ setRole });
    const session = makeSession({ saveCurrent });
    const services = makeServices({ agent, session, showMessage });

    createRoleCommand(agent, session, services).action('missing');

    expect(setRole).not.toHaveBeenCalled();
    expect(saveCurrent).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith('Role not found: missing', 5000, 'agent-1');
  });
});

function makeAgent(options: { setRole: (roleName: string) => void }): CommandAgent {
  return {
    config: {
      provider: {
        id: 'test',
        api_base: 'https://example.com/v1',
        protocol: 'openai_chat_completions',
        contextWindowSize: 1000,
      },
      model: 'test-model',
      effort: 'none',
    },
    currentRunId: 0,
    isRunning: false,
    role: 'default',
    reloadConfig() {},
    setRole: options.setRole,
    buildSystemPrompt: () => '<system>test</system>',
    createSubAgent: () => ({ query: async () => '' }),
    getSnapshot: () => ({
      providerId: 'test',
      model: 'test-model',
      effort: 'none',
      role: 'default',
      messages: [],
      usageHistory: [],
    }),
  };
}

function makeSession(options: { saveCurrent: () => void }): CommandSessionController {
  return {
    list: () => [],
    resume: () => ({ ok: false, message: 'not found' }),
    startNewSession() {},
    saveCurrent: options.saveCurrent,
    renameCurrent() {},
  };
}

function makeServices(options: {
  agent: CommandAgent;
  session: CommandSessionController;
  showMessage: CommandRuntimeServices['showMessage'];
}): CommandRuntimeServices {
  return {
    isAgentBusy: () => false,
    getCurrentAgent: () => options.agent,
    getCurrentSessionController: () => options.session,
    getCurrentAgentSessionId: () => 'agent-1',
    showMessage: options.showMessage,
  } as unknown as CommandRuntimeServices;
}
