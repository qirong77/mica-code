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
        providerId: 'test-provider',
        model: 'test-model',
        effort: 'none' as const,
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
      load: vi.fn((id: string) => saves.find((session) => session.id === id) ?? null),
      save: vi.fn((session: PersistedSession) => {
        saves.push(session);
      }),
    };
    const controller = new SessionController({ agent, store });

    controller.renameCurrent('Manual title');
    controller.saveCurrent();

    expect(saves.at(-1)?.title).toBe('Manual title');
    expect(saves.at(-1)?.snapshot.conversationMessages).toEqual([{ role: 'user', content: 'original prompt' }]);
    expect(controller.getCurrentTitle()).toBe('Manual title');
  });

  it('restores persisted UI conversation messages without loading notices into agent history', async () => {
    const { SessionController } = await import('./SessionController.js');
    const snapshot = {
      providerId: 'test-provider',
      model: 'test-model',
      effort: 'none' as const,
      messages: [{ role: 'user', content: 'model prompt' }],
      conversationMessages: [
        { role: 'user' as const, content: 'model prompt' },
        { role: 'notice' as const, content: 'saved recap', variant: 'recap' as const, command: '/recap' },
        { role: 'notice' as const, content: 'saved compact', variant: 'compact' as const, command: '/compact' },
      ],
      usageHistory: [],
      lastUsage: undefined,
    };
    const session: PersistedSession = {
      version: 1,
      id: 'session-with-recap',
      title: 'model prompt',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      cwd: process.cwd(),
      snapshot,
    };
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(
        (): AgentRuntimeSnapshot => ({
          providerId: snapshot.providerId,
          model: snapshot.model,
          effort: snapshot.effort,
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
      load: vi.fn((id: string) => (id === session.id ? session : null)),
      save: vi.fn(),
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
      model: snapshot.model,
      effort: snapshot.effort,
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
      model: 'deepseek-v4-pro',
      effort: 'high' as const,
      models: ['deepseek-v4-pro'],
      contextWindowSize: 1000,
    };
    micaConfig.update(() => ({
      provider: provider.id,
      model: provider.model,
      effort: 'high',
      contextWindowSize: provider.contextWindowSize,
      providers: [provider],
    }));
    const session: PersistedSession = {
      version: 1,
      id: 'session-1',
      title: 'Old DeepSeek session',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      cwd: process.cwd(),
      snapshot: {
        providerId: provider.id,
        model: provider.model,
        effort: 'low',
        messages: [],
        usageHistory: [],
        lastUsage: undefined,
      },
    };
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(
        (): AgentRuntimeSnapshot => ({
          providerId: session.snapshot.providerId,
          model: session.snapshot.model,
          effort: session.snapshot.effort,
          messages: session.snapshot.messages,
          usageHistory: session.snapshot.usageHistory,
          lastUsage: session.snapshot.lastUsage,
        }),
      ),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(() => {
        expect(micaConfig.get().effort).toBe('high');
      }),
      toConversationMessages: vi.fn(() => []),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      load: vi.fn((id: string) => (id === session.id ? session : null)),
      save: vi.fn(),
    };
    const restore = vi.fn();

    const controller = new SessionController({
      agent,
      store,
      ui: { restore },
    });
    const result = controller.resume(session.id);

    expect(result.ok).toBe(true);
    expect(micaConfig.get().effort).toBe('high');
    expect(agent.reloadConfig).toHaveBeenCalledWith(false);
    expect(agent.loadSnapshot).toHaveBeenCalledWith(session.snapshot);
    expect(restore).toHaveBeenCalled();
  });
});
