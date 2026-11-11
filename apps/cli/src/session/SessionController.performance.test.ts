import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PersistedSession, SessionStoreLike } from '@packages/mica-session/index.js';
import type { AgentRuntimeEvents, AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';
import { piAssistant, piToolResult, piUser } from './piTestMessages.js';
import type { SessionAgentAdapter } from './SessionController.js';

const previousMicaHome = process.env.MICA_HOME;
const tempHome = mkdtempSync(join(tmpdir(), 'mica-session-performance-'));

beforeAll(() => {
  process.env.MICA_HOME = tempHome;
});

afterAll(() => {
  if (previousMicaHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = previousMicaHome;
  rmSync(tempHome, { recursive: true, force: true });
});

function historySnapshot(): AgentRuntimeSnapshot {
  return {
    providerId: 'test',
    protocol: 'openai_responses',
    model: 'test-model',
    effort: 'none',
    role: 'default',
    messageFormat: 'pi-ai-v1',
    messages: [
      piUser('work'),
      piAssistant('long history '.repeat(100_000)),
    ],
    usageHistory: [],
    lastUsage: undefined,
  };
}

function persisted(snapshot: AgentRuntimeSnapshot): PersistedSession {
  return {
    version: 1,
    revision: 1,
    id: 'performance-session',
    title: 'work',
    titleSource: 'derived',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: process.cwd(),
    turnState: 'running',
    snapshot: { ...snapshot, conversationMessages: [{ role: 'user', content: 'work' }] },
  };
}

/** Parse a fresh object on every load, like the file store, without test-only aliases. */
function jsonStore(initial: PersistedSession | null) {
  let text = initial ? JSON.stringify(initial) : null;
  const load = vi.fn((): PersistedSession | null => (text ? (JSON.parse(text) as PersistedSession) : null));
  const save = vi.fn((session: PersistedSession) => {
    text = JSON.stringify(session);
  });
  const store: SessionStoreLike = {
    list: () => [],
    listRecent: () => [],
    load,
    save,
    delete: () => false,
  };
  return { store, load, save, read: () => load()!, replace: save };
}

function agentFor(getSnapshot: () => AgentRuntimeSnapshot): SessionAgentAdapter {
  return {
    getSnapshot,
    loadSnapshot: vi.fn(),
    reloadConfig: vi.fn(),
    toConversationMessages: vi.fn(() => [{ role: 'user' as const, content: 'work' }]),
  };
}

function fullSessionSerializations(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(
    ([value]) => value && typeof value === 'object' && 'version' in value && 'snapshot' in value,
  ).length;
}

describe('SessionController long-session work', () => {
  it('compares an unchanged JSON-loaded session without serializing both candidates', async () => {
    const { SessionController } = await import('./SessionController.js');
    const snapshot = historySnapshot();
    const disk = jsonStore(persisted(snapshot));
    const controller = new SessionController({
      agent: agentFor(() => snapshot),
      store: disk.store,
      config: { apply: () => undefined },
      ui: { restore: vi.fn() },
    });
    expect(controller.resume('performance-session').ok).toBe(true);
    disk.load.mockClear();
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      expect(controller.saveCurrent()).toBe(true);
      expect(disk.load).toHaveBeenCalledOnce();
      expect(disk.save).not.toHaveBeenCalled();
      // One hash of the persisted document, no pair of equality JSON strings.
      expect(fullSessionSerializations(stringify)).toBe(1);
    } finally {
      stringify.mockRestore();
    }
  });

  it('writes a new iteration without serializing the old history for equality and preserves external metadata', async () => {
    const { SessionController } = await import('./SessionController.js');
    let snapshot = historySnapshot();
    const disk = jsonStore(persisted(snapshot));
    const controller = new SessionController({
      agent: agentFor(() => snapshot),
      store: disk.store,
      config: { apply: () => undefined },
      ui: { restore: vi.fn() },
    });
    expect(controller.resume('performance-session').ok).toBe(true);
    const externallyUpdated = disk.read();
    externallyUpdated.parentSessionId = 'external-parent';
    externallyUpdated.title = 'external title';
    externallyUpdated.titleSource = 'manual';
    externallyUpdated.revision = 40;
    externallyUpdated.snapshot.displayUsage = { totalTokens: 100, compactedAt: '2026-01-02T00:00:00.000Z' };
    disk.replace(externallyUpdated);
    disk.load.mockClear();
    disk.save.mockClear();
    snapshot = { ...snapshot, messages: [...snapshot.messages, piAssistant('next iteration')] };

    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      expect(controller.saveCurrent({ turnState: 'running', preserveTitle: true })).toBe(true);
      expect(disk.load).toHaveBeenCalledOnce();
      expect(disk.save).toHaveBeenCalledOnce();
      // The store write and the retained short hash each serialize once.
      expect(fullSessionSerializations(stringify)).toBe(2);
    } finally {
      stringify.mockRestore();
    }
    expect(disk.read()).toMatchObject({
      parentSessionId: 'external-parent',
      title: 'external title',
      titleSource: 'manual',
      revision: 41,
      snapshot: { messages: snapshot.messages, displayUsage: externallyUpdated.snapshot.displayUsage },
    });
  });

  it('does not serialize provider history to compare a changed thinking part and restores retry rollback history', async () => {
    const { default: mitt } = await import('mitt');
    const { SessionController } = await import('./SessionController.js');
    const events = mitt<AgentRuntimeEvents>();
    const preTurn = historySnapshot();
    let snapshot = preTurn;
    let running = false;
    const disk = jsonStore(persisted(snapshot));
    const controller = new SessionController({
      agent: {
        ...agentFor(() => snapshot),
        events,
        get isRunning() {
          return running;
        },
      },
      store: disk.store,
      config: { apply: () => undefined },
      ui: { restore: vi.fn() },
    });
    expect(controller.resume('performance-session').ok).toBe(true);
    const external = disk.read();
    external.parentSessionId = 'external-parent';
    disk.replace(external);
    disk.save.mockClear();
    running = true;
    snapshot = {
      ...snapshot,
      messages: [...snapshot.messages, piToolResult('call-1', 'read_file', 'result')],
      activeThinking: {
        providerId: 'test',
        protocol: 'openai_responses',
        model: 'test-model',
        apiBase: 'https://test',
        text: 'complete',
      },
      activeTurn: { input: 'work', committed: true },
    };
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      events.emit('thinkingCheckpoint', undefined);
      expect(fullSessionSerializations(stringify)).toBe(2);
      expect(stringify.mock.calls.some(([value]) => Array.isArray(value))).toBe(false);
      expect(disk.save).toHaveBeenCalledOnce();

      stringify.mockClear();
      events.emit('thinkingCheckpoint', undefined);
      expect(stringify).not.toHaveBeenCalled();
      expect(disk.save).toHaveBeenCalledOnce();

      snapshot = preTurn;
      events.emit('textRollback', undefined);
      expect(fullSessionSerializations(stringify)).toBe(2);
      expect(disk.save).toHaveBeenCalledTimes(2);
    } finally {
      stringify.mockRestore();
    }
    const restored = disk.read();
    expect(restored.parentSessionId).toBe('external-parent');
    expect(restored.snapshot.messages).toEqual(preTurn.messages);
    expect(restored.snapshot.activeThinking).toBeUndefined();
    expect(restored.snapshot.activeTurn).toBeUndefined();
    expect(restored.snapshot.conversationMessages).toEqual([{ role: 'user', content: 'work' }]);
  });

  it('loads an explicit empty crash checkpoint only once', async () => {
    const { SessionController } = await import('./SessionController.js');
    const snapshot = { ...historySnapshot(), messages: [] };
    const disk = jsonStore(null);
    const controller = new SessionController({
      agent: { ...agentFor(() => snapshot), toConversationMessages: () => [] },
      store: disk.store,
      config: { apply: () => undefined },
      ui: { restore: vi.fn() },
    });
    expect(controller.saveCurrent({ allowEmpty: true, turnState: 'running' })).toBe(true);
    expect(disk.load).toHaveBeenCalledOnce();
    expect(disk.save).toHaveBeenCalledOnce();
  });

  it('uses a real display user message for its title without rebuilding provider conversation', async () => {
    const { SessionController } = await import('./SessionController.js');
    const snapshot = historySnapshot();
    const agent = agentFor(() => snapshot);
    const disk = jsonStore(null);
    const controller = new SessionController({
      agent,
      store: disk.store,
      config: { apply: () => undefined },
      ui: { restore: vi.fn() },
    });
    expect(controller.saveCurrent({ conversationMessages: [{ role: 'user', content: 'display title' }] })).toBe(true);
    expect(agent.toConversationMessages).not.toHaveBeenCalled();
    expect(disk.read().title).toBe('display title');
  });
});
