import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PersistedSession, SessionStoreLike } from '@packages/mica-session/index.js';
import type { AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';
import type { SessionAgentAdapter } from './SessionController.js';

const previousHome = process.env.HOME;
const previousMicaHome = process.env.MICA_HOME;
const tempHome = mkdtempSync(join(tmpdir(), 'mica-session-controller-'));

beforeAll(() => {
  process.env.HOME = tempHome;
  process.env.MICA_HOME = tempHome;
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

describe('SessionController', () => {
  it('preserves a manually renamed current session across later saves', async () => {
    const { SessionController } = await import('./SessionController.js');
    const saves: PersistedSession[] = [];
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messages: [{ role: 'user', content: 'original prompt' }],
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => [{ role: 'user' as const, content: 'original prompt' }]),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn((id: string) => saves.find((session) => session.id === id) ?? null),
      save: vi.fn((session: PersistedSession) => {
        saves.push(session);
      }),
      delete: vi.fn(() => false),
    };
    const controller = new SessionController({ agent, store });

    controller.renameCurrent('Manual title');
    controller.saveCurrent({ turnState: 'running' });
    controller.saveCurrent();

    expect(saves.at(-1)?.title).toBe('Manual title');
    expect(saves.at(-1)?.turnState).toBe('running');
    expect(saves.at(-1)?.snapshot.conversationMessages).toEqual([{ role: 'user', content: 'original prompt' }]);
    expect(controller.getCurrentTitle()).toBe('Manual title');

    controller.saveCurrent({ turnState: 'completed' });
    expect(saves.at(-1)?.turnState).toBe('completed');
  });

  it('ignores compact metadata messages when deriving the session title', async () => {
    const { SessionController } = await import('./SessionController.js');
    const saves: PersistedSession[] = [];
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messages: [{ role: 'user', content: '[Mica compact boundary]\n\n{"mode":"pruned"}' }],
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => [
        { role: 'user' as const, content: '[Mica compact boundary]\n\n{"mode":"pruned"}' },
        { role: 'user' as const, content: '[Mica compact checkpoint]\n\nsummary' },
        { role: 'user' as const, content: 'Fix the resume session title' },
      ]),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn((id: string) => saves.find((session) => session.id === id) ?? null),
      save: vi.fn((session: PersistedSession) => {
        saves.push(session);
      }),
      delete: vi.fn(() => false),
    };
    const controller = new SessionController({ agent, store });

    controller.saveCurrent();

    expect(saves.at(-1)?.title).toBe('Fix the resume session title');
  });

  it('repairs previously persisted compact metadata titles in session lists', async () => {
    const { SessionController } = await import('./SessionController.js');
    const session: PersistedSession = {
      version: 1,
      id: 'compacted-session',
      title: '[Mica compact boundary] {"mode":"pruned"}',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      cwd: process.cwd(),
      turnState: 'completed',
      snapshot: {
        providerId: 'openai',
        protocol: 'openai_chat_completions',
        model: 'test-model',
        effort: 'none',
        role: 'default',
        messages: [],
        conversationMessages: [{ role: 'user', content: 'Original user prompt' }],
        usageHistory: [],
        lastUsage: undefined,
      },
    };
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({ ...session.snapshot, messages: [] })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => []),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => [
        {
          id: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
          cwd: session.cwd,
          providerId: session.snapshot.providerId,
          model: session.snapshot.model,
          uncompleted: false,
        },
      ]),
      listRecent: vi.fn(() => []),
      load: vi.fn(() => session),
      save: vi.fn(),
      delete: vi.fn(() => false),
    };

    const controller = new SessionController({ agent, store });

    expect(controller.list()).toEqual([expect.objectContaining({ title: 'Original user prompt' })]);
  });

  it('restores persisted UI conversation messages without loading notices into agent history', async () => {
    const { SessionController } = await import('./SessionController.js');
    const snapshot = {
      providerId: 'openai',
      protocol: 'openai_chat_completions' as const,
      model: 'test-model',
      effort: 'none' as const,
      role: 'default',
      messages: [{ role: 'user', content: 'model prompt' }],
      conversationMessages: [
        { role: 'user' as const, content: 'model prompt' },
        { role: 'notice' as const, content: 'saved notice' },
        {
          role: 'notice' as const,
          content: 'saved compact',
          variant: 'compact' as const,
          command: '/compact',
          status: 'info' as const,
        },
        {
          role: 'notice' as const,
          content: 'saved retry',
          variant: 'error' as const,
          command: '/error',
          status: 'error' as const,
        },
      ],
      usageHistory: [],
      lastUsage: undefined,
    };
    const session: PersistedSession = {
      version: 1,
      id: 'session-with-notice',
      title: 'model prompt',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      cwd: process.cwd(),
      turnState: 'completed',
      snapshot,
    };
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(
        (): AgentRuntimeSnapshot => ({
          providerId: snapshot.providerId,
          protocol: snapshot.protocol,
          model: snapshot.model,
          effort: snapshot.effort,
          role: snapshot.role,
          messages: snapshot.messages,
          usageHistory: snapshot.usageHistory,
          lastUsage: snapshot.lastUsage,
        }),
      ),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => [{ role: 'user' as const, content: 'model prompt' }]),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn((id: string) => (id === session.id ? session : null)),
      save: vi.fn(),
      delete: vi.fn(() => false),
    };
    const restore = vi.fn();

    const controller = new SessionController({
      agent,
      store,
      config: { apply: vi.fn() },
      ui: { restore },
    });
    const result = controller.resume(session.id);

    expect(result.ok).toBe(true);
    expect(agent.loadSnapshot).toHaveBeenCalledWith({
      providerId: snapshot.providerId,
      protocol: snapshot.protocol,
      model: snapshot.model,
      effort: snapshot.effort,
      role: snapshot.role,
      messages: snapshot.messages,
      usageHistory: snapshot.usageHistory,
      lastUsage: snapshot.lastUsage,
    });
    expect(restore).toHaveBeenCalledWith(agent, undefined, snapshot.conversationMessages);
  });

  it('clamps restored session effort before reloading config', async () => {
    const { micaConfig } = await import('@packages/mica-config/index.js');
    const { SessionController } = await import('./SessionController.js');
    const provider = {
      id: 'deepseek',
      name: 'DeepSeek',
      api_base: 'https://api.deepseek.com',
      api_key: 'test-key',
      protocol: 'openai_chat_completions' as const,
      models: ['deepseek-v4-pro'],
    };
    micaConfig.update(() => ({
      provider: provider.id,
      model: 'deepseek-v4-pro',
      effort: 'high',
      contextWindowSize: 1000000,
      providers: [provider],
    }));

    const session: PersistedSession = {
      version: 1,
      id: 'session-1',
      title: 'Old DeepSeek session',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      cwd: process.cwd(),
      turnState: 'completed',
      snapshot: {
        providerId: provider.id,
        protocol: provider.protocol,
        model: 'deepseek-v4-pro',
        effort: 'low',
        role: 'default',
        messages: [],
        conversationMessages: [],
        usageHistory: [],
        lastUsage: undefined,
      },
    };
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(
        (): AgentRuntimeSnapshot => ({
          providerId: session.snapshot.providerId,
          protocol: session.snapshot.protocol,
          model: session.snapshot.model,
          effort: session.snapshot.effort,
          role: session.snapshot.role ?? 'default',
          messages: session.snapshot.messages,
          usageHistory: session.snapshot.usageHistory,
          lastUsage: session.snapshot.lastUsage,
        }),
      ),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(() => {
        expect(micaConfig.get().effort).toBe('low');
      }),
      toConversationMessages: vi.fn(() => []),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn((id: string) => (id === session.id ? session : null)),
      save: vi.fn(),
      delete: vi.fn(() => false),
    };
    const restore = vi.fn();

    const controller = new SessionController({
      agent,
      store,
      ui: { restore },
    });
    const result = controller.resume(session.id);

    expect(result.ok).toBe(true);
    expect(micaConfig.get().effort).toBe('low');
    expect(agent.reloadConfig).toHaveBeenCalledWith(false);
    expect(agent.loadSnapshot).toHaveBeenCalledWith({
      providerId: session.snapshot.providerId,
      protocol: session.snapshot.protocol,
      model: session.snapshot.model,
      effort: session.snapshot.effort,
      role: session.snapshot.role,
      messages: session.snapshot.messages,
      usageHistory: session.snapshot.usageHistory,
      lastUsage: session.snapshot.lastUsage,
    });
    expect(restore).toHaveBeenCalled();
  });

  it('restores legacy sessions without a role as default', async () => {
    const { SessionController } = await import('./SessionController.js');
    const snapshot = {
      providerId: 'openai',
      protocol: 'openai_chat_completions' as const,
      model: 'test-model',
      effort: 'none' as const,
      messages: [],
      conversationMessages: [],
      usageHistory: [],
      lastUsage: undefined,
    };
    const session = {
      version: 1 as const,
      id: 'legacy-without-role',
      title: 'legacy',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      cwd: process.cwd(),
      snapshot,
    };
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({ ...snapshot, role: 'default' })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => []),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn(() => session as unknown as PersistedSession),
      save: vi.fn(),
      delete: vi.fn(() => false),
    };
    const controller = new SessionController({
      agent,
      store,
      config: { apply: vi.fn() },
      ui: { restore: vi.fn() },
    });

    expect(controller.resume(session.id).ok).toBe(true);
    expect(agent.loadSnapshot).toHaveBeenCalledWith(expect.objectContaining({ role: 'default' }));
  });
});
