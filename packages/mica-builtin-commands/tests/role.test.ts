import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '../services.js';

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

const { createRoleCommand, cycleNextRole } = await import('../commands/role.js');

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
    const showNotice = vi.fn();
    const syncModelDisplay = vi.fn();
    const agent = makeAgent({ setRole });
    const session = makeSession({ saveCurrent });
    const services = makeServices({ agent, session, showNotice, syncModelDisplay });

    createRoleCommand(agent, session, services).action('reviewer');

    expect(setRole).toHaveBeenCalledWith('reviewer');
    expect(saveCurrent).toHaveBeenCalledOnce();
    expect(syncModelDisplay).toHaveBeenCalledWith(agent);
    expect(showNotice).toHaveBeenCalledWith('Role: reviewer', 'agent-1', { command: '/role', status: 'success' });
  });

  it('does not switch to an unknown role', () => {
    mocks.getRole.mockReturnValue(undefined);
    const setRole = vi.fn();
    const saveCurrent = vi.fn();
    const showNotice = vi.fn();
    const agent = makeAgent({ setRole });
    const session = makeSession({ saveCurrent });
    const services = makeServices({ agent, session, showNotice });

    createRoleCommand(agent, session, services).action('missing');

    expect(setRole).not.toHaveBeenCalled();
    expect(saveCurrent).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalledWith('Role not found: missing', 'agent-1', {
      command: '/role',
      status: 'warning',
    });
  });

  it('cycles to the next available role', () => {
    mocks.listRoles.mockReturnValue([
      { name: 'default', prompt: 'default', builtIn: true },
      { name: 'reviewer', prompt: 'Review carefully.', builtIn: false, path: '/tmp/.mica/role/reviewer' },
      { name: 'writer', prompt: 'Write carefully.', builtIn: false, path: '/tmp/.mica/role/writer' },
    ]);
    mocks.getRole.mockImplementation((name: string) =>
      mocks.listRoles().find((role: { name: string }) => role.name === name),
    );
    const setRole = vi.fn();
    const saveCurrent = vi.fn();
    const showNotice = vi.fn();
    const syncModelDisplay = vi.fn();
    const agent = makeAgent({ setRole, role: 'default' });
    const session = makeSession({ saveCurrent });
    const services = makeServices({ agent, session, showNotice, syncModelDisplay });

    expect(cycleNextRole(agent, session, services)).toBe(true);

    expect(setRole).toHaveBeenCalledWith('reviewer');
    expect(saveCurrent).toHaveBeenCalledOnce();
    expect(syncModelDisplay).toHaveBeenCalledWith(agent);
    expect(showNotice).toHaveBeenCalledWith('Role: reviewer', 'agent-1', { command: '/role', status: 'success' });
  });

  it('wraps role cycle from the last role back to default', () => {
    mocks.listRoles.mockReturnValue([
      { name: 'default', prompt: 'default', builtIn: true },
      { name: 'reviewer', prompt: 'Review carefully.', builtIn: false, path: '/tmp/.mica/role/reviewer' },
    ]);
    mocks.getRole.mockImplementation((name: string) =>
      mocks.listRoles().find((role: { name: string }) => role.name === name),
    );
    const setRole = vi.fn();
    const agent = makeAgent({ setRole, role: 'reviewer' });
    const session = makeSession({ saveCurrent: vi.fn() });
    const services = makeServices({ agent, session, showNotice: vi.fn() });

    expect(cycleNextRole(agent, session, services)).toBe(true);
    expect(setRole).toHaveBeenCalledWith('default');
  });
});

function makeAgent(options: { setRole: (roleName: string) => void; role?: string }): CommandAgent {
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
    role: options.role ?? 'default',
    reloadConfig() {},
    setRole: options.setRole,
    buildSystemPrompt: () => '<system>test</system>',
    createSubAgent: () => ({ query: async () => '' }),
    getSnapshot: () => ({
      providerId: 'test',
      model: 'test-model',
      effort: 'none',
      role: options.role ?? 'default',
      messages: [],
      usageHistory: [],
    }),
  };
}

function makeSession(options: { saveCurrent: () => void }): CommandSessionController {
  return {
    list: () => [],
    listRecent: () => [],
    resume: () => ({ ok: false, message: 'not found' }),
    startNewSession() {},
    saveCurrent: options.saveCurrent,
    renameCurrent() {},
  };
}

function makeServices(options: {
  agent: CommandAgent;
  session: CommandSessionController;
  showNotice: CommandRuntimeServices['showNotice'];
  syncModelDisplay?: CommandRuntimeServices['syncModelDisplay'];
}): CommandRuntimeServices {
  return {
    isAgentBusy: () => false,
    getCurrentAgent: () => options.agent,
    getCurrentSessionController: () => options.session,
    getCurrentAgentSessionId: () => 'agent-1',
    showMessage: vi.fn(),
    showNotice: options.showNotice,
    syncModelDisplay: options.syncModelDisplay ?? (() => undefined),
  } as unknown as CommandRuntimeServices;
}
