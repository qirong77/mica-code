import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SubagentUsageRecord } from '@packages/mica-agent/index.js';
import type { PersistedSession, SessionStoreLike } from '@packages/mica-session/index.js';
import type { AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';
import type { SessionAgentAdapter } from './SessionController.js';
import { piAssistant, piUser } from './piTestMessages.js';

const previousMicaHome = process.env.MICA_HOME;
const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-usage-'));
let SessionController: typeof import('./SessionController.js').SessionController;
let micaSession: typeof import('@packages/mica-session/index.js').micaSession;

beforeAll(async () => {
  process.env.MICA_HOME = micaHome;
  ({ SessionController } = await import('./SessionController.js'));
  ({ micaSession } = await import('@packages/mica-session/index.js'));
});

afterEach(() => vi.useRealTimers());
afterAll(() => {
  if (previousMicaHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = previousMicaHome;
  rmSync(micaHome, { recursive: true, force: true });
});

function usage(taskId: string): SubagentUsageRecord {
  return {
    taskId,
    origin: 'plugin',
    pluginId: 'test',
    subagentType: 'plugin:test',
    description: taskId,
    model: 'test-model',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    requests: [
      {
        provider: 'openai_responses',
        providerId: 'test',
        model: 'test-model',
        turnId: 0,
        requestIndex: 0,
        messageCount: 2,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 30,
        totalTokens: 150,
        paidTokenRate: 1,
        occurredAt: '2026-01-01T00:00:01.000Z',
      },
    ],
    summary: { records: 1, inputTokens: 120, outputTokens: 30, cachedInputTokens: 0, totalTokens: 150 },
  };
}

function snapshot(text = 'original', records: SubagentUsageRecord[] = []): AgentRuntimeSnapshot {
  return {
    providerId: 'test',
    protocol: 'openai_responses',
    model: 'test-model',
    effort: 'none',
    role: 'default',
    messageFormat: 'pi-ai-v1',
    messages: text ? [piUser(text)] : [],
    usageHistory: [],
    lastUsage: undefined,
    subagentUsageHistory: records,
  };
}

function harness(store: SessionStoreLike = micaSession.createStore()) {
  let current = snapshot();
  let running = false;
  const recordSubagentUsage = vi.fn((record: SubagentUsageRecord) => {
    (current.subagentUsageHistory ??= []).push(record);
  });
  const agent: SessionAgentAdapter = {
    getSnapshot: () => current,
    loadSnapshot: (next) => {
      current = structuredClone(next);
    },
    reloadConfig: vi.fn(),
    recordSubagentUsage,
    get isRunning() {
      return running;
    },
    toConversationMessages: () =>
      current.messages.flatMap((message) =>
        message.role === 'user' && typeof message.content === 'string'
          ? [{ role: 'user' as const, content: message.content }]
          : [],
      ),
  };
  const controller = new SessionController({
    agent,
    store,
    config: { apply: () => undefined },
    ui: { restore: vi.fn() },
  });
  return {
    controller,
    store,
    agent,
    recordSubagentUsage,
    getSnapshot: () => current,
    setSnapshot: (value: AgentRuntimeSnapshot) => {
      current = structuredClone(value);
    },
    setRunning: (value: boolean) => {
      running = value;
    },
  };
}

describe('SessionController late model usage', () => {
  it('patches the latest disk snapshot instead of saving a stale idle agent', async () => {
    const { controller, store, getSnapshot } = harness();
    expect(controller.saveCurrent()).toBe(true);
    const sessionId = controller.getCurrentSessionId();
    const external = micaSession.createStore();
    const latest: PersistedSession = {
      ...external.load(sessionId)!,
      revision: 8,
      title: 'renamed remotely',
      titleSource: 'manual',
      parentSessionId: 'external-parent',
      turnState: 'aborted',
      snapshot: {
        ...external.load(sessionId)!.snapshot,
        messages: [piUser('original'), piAssistant('new external answer')],
        conversationMessages: [
          { role: 'user', content: 'original' },
          { role: 'assistant', content: 'new external answer' },
        ],
        pluginState: { test: { notes: 'external notes' } },
        subagentUsageHistory: [usage('external')],
        displayUsage: { totalTokens: 42, compactedAt: '2026-01-01T00:00:00.000Z' },
      },
    };
    const writer = micaSession.acquireTurnLease(sessionId)!;
    external.save(latest);
    writer.release();
    const fullSave = vi.spyOn(controller, 'saveCurrent');
    const late = usage('late');

    expect(await controller.recordSubagentUsageForSession(sessionId, late)).toBe(true);
    expect(fullSave).not.toHaveBeenCalled();
    expect(store.load(sessionId)).toEqual({
      ...latest,
      revision: 9,
      updatedAt: expect.any(String),
      snapshot: { ...latest.snapshot, subagentUsageHistory: [usage('external'), late] },
    });
    expect(getSnapshot().messages).toEqual([piUser('original')]);

    // The usage patch must not mark an old agent as refreshed. The next turn
    // still loads the other writer's answer, metadata and both usage records.
    const nextTurn = controller.acquireTurnLease()!;
    try {
      expect(controller.refreshFromStore()?.ok).toBe(true);
      expect(getSnapshot().messages).toEqual(latest.snapshot.messages);
      controller.saveCurrent();
      expect(store.load(sessionId)!.snapshot.subagentUsageHistory).toEqual([usage('external'), late]);
      expect(store.load(sessionId)!.snapshot.pluginState).toEqual(latest.snapshot.pluginState);
    } finally {
      nextTurn.release();
    }
  });

  it.each([false, true])('waits for another controller in this PID (agent running: %s)', async (running) => {
    vi.useFakeTimers();
    const local = harness();
    local.controller.saveCurrent();
    const sessionId = local.controller.getCurrentSessionId();
    const remote = harness();
    remote.controller.resume(sessionId);
    const writer = remote.controller.acquireTurnLease()!;
    local.setRunning(running);
    const late = usage('late');
    let settled = false;
    const pending = local.controller.recordSubagentUsageForSession(sessionId, late).then((result) => {
      settled = true;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(300);
      expect(settled).toBe(false);
      expect(local.recordSubagentUsage).not.toHaveBeenCalled();
      expect(local.store.load(sessionId)!.snapshot.subagentUsageHistory).toEqual([]);
      remote.setSnapshot(snapshot('remote completed a new turn', [usage('remote')]));
      remote.controller.saveCurrent({ turnState: 'completed' });
    } finally {
      writer.release();
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe(true);
    const saved = local.store.load(sessionId)!;
    expect(saved.snapshot.messages).toEqual([piUser('remote completed a new turn')]);
    expect(saved.snapshot.subagentUsageHistory).toEqual([usage('remote'), late]);
  });

  it('borrows its own registered turn lease and keeps later checkpoints consistent', async () => {
    const local = harness();
    local.controller.saveCurrent({ turnState: 'running' });
    const sessionId = local.controller.getCurrentSessionId();
    const lease = local.controller.acquireTurnLease()!;
    local.setRunning(true);
    expect(local.controller.acquireTurnLease()).toBeNull();
    try {
      const late = usage('within-turn');
      expect(await local.controller.recordSubagentUsageForSession(sessionId, late)).toBe(true);
      expect(micaSession.acquireTurnLease(sessionId)).toBeNull();
      expect(local.recordSubagentUsage).toHaveBeenCalledExactlyOnceWith(late);
      local.controller.saveCurrent({ turnState: 'running' });
      expect(local.store.load(sessionId)!.snapshot.subagentUsageHistory).toEqual([late]);
    } finally {
      lease.release();
      local.setRunning(false);
    }

    // An old handle's finally cannot release a later lease or confer ownership
    // once another writer has taken the session.
    const next = local.controller.acquireTurnLease()!;
    lease.release();
    expect(micaSession.acquireTurnLease(sessionId)).toBeNull();
    next.release();
    const external = micaSession.acquireTurnLease(sessionId)!;
    expect(external).not.toBeNull();
    external.release();
  });

  it('does not union pre-rewind usage back into a rewound snapshot', async () => {
    const local = harness();
    const kept = usage('kept');
    const removed = usage('removed-by-rewind');
    local.setSnapshot(snapshot('later turn', [kept, removed]));
    local.controller.saveCurrent();
    const lease = local.controller.acquireTurnLease()!;
    try {
      // Rewind replaces the runtime snapshot, including its usage history.
      local.setSnapshot(snapshot('earlier checkpoint', [kept]));
      local.controller.saveCurrent();
      const late = usage('arrived-after-rewind');
      const id = local.controller.getCurrentSessionId();
      expect(await local.controller.recordSubagentUsageForSession(id, late)).toBe(true);
      local.controller.saveCurrent();
      expect(local.store.load(id)!.snapshot.messages).toEqual([piUser('earlier checkpoint')]);
      expect(local.store.load(id)!.snapshot.subagentUsageHistory).toEqual([kept, late]);

      // A subsequent rewind can remove that new row too. No pending overlay or
      // permanent usage union is allowed to resurrect it on the next save.
      local.setSnapshot(snapshot('earlier checkpoint', [kept]));
      local.controller.saveCurrent();
      expect(local.store.load(id)!.snapshot.subagentUsageHistory).toEqual([kept]);
    } finally {
      lease.release();
    }
  });

  it('does not borrow an old handle after its on-disk token was replaced', async () => {
    vi.useFakeTimers();
    const local = harness();
    local.controller.saveCurrent();
    const sessionId = local.controller.getCurrentSessionId();
    const old = local.controller.acquireTurnLease()!;
    // Exercise revocation directly in the isolated home; another live writer
    // now owns the same path with a different token, even though the PID is ours.
    rmSync(join(micaSession.dir, '.turn-locks', `${sessionId}.lock`));
    const replacement = micaSession.acquireTurnLease(sessionId)!;
    let settled = false;
    const pending = local.controller.recordSubagentUsageForSession(sessionId, usage('late')).then((result) => {
      settled = true;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      expect(local.recordSubagentUsage).not.toHaveBeenCalled();
      const current = local.store.load(sessionId)!;
      local.store.save({
        ...current,
        snapshot: { ...current.snapshot, subagentUsageHistory: [usage('replacement')] },
      });
      old.release();
      expect(micaSession.acquireTurnLease(sessionId)).toBeNull();
    } finally {
      replacement.release();
      old.release();
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe(true);
    expect(local.store.load(sessionId)!.snapshot.subagentUsageHistory).toEqual([usage('replacement'), usage('late')]);
  });

  it('reacquires after revocation and keeps the new registration when the old handle releases', async () => {
    const local = harness();
    local.controller.saveCurrent();
    const sessionId = local.controller.getCurrentSessionId();
    const old = local.controller.acquireTurnLease()!;
    rmSync(join(micaSession.dir, '.turn-locks', `${sessionId}.lock`));
    expect(old.isHeld()).toBe(false);
    const next = local.controller.acquireTurnLease();
    expect(next?.isHeld()).toBe(true);
    try {
      old.release();
      expect(next?.isHeld()).toBe(true);
      expect(local.controller.acquireTurnLease()).toBeNull();
      expect(await local.controller.recordSubagentUsageForSession(sessionId, usage('new-lease'))).toBe(true);
      expect(local.store.load(sessionId)!.snapshot.subagentUsageHistory).toEqual([usage('new-lease')]);
    } finally {
      next?.release();
    }
  });

  it('does not refresh through a revoked registration while the replacement writer holds the lease', () => {
    const local = harness();
    local.controller.saveCurrent();
    const sessionId = local.controller.getCurrentSessionId();
    const old = local.controller.acquireTurnLease()!;
    rmSync(join(micaSession.dir, '.turn-locks', `${sessionId}.lock`));
    const replacement = micaSession.acquireTurnLease(sessionId)!;
    const current = local.store.load(sessionId)!;
    local.store.save({
      ...current,
      snapshot: {
        ...current.snapshot,
        messages: [piUser('replacement history')],
        conversationMessages: [{ role: 'user', content: 'replacement history' }],
      },
    });
    try {
      expect(local.controller.refreshFromStore()).toBeNull();
      expect(local.getSnapshot().messages).toEqual([piUser('original')]);
      old.release();
      expect(replacement.isHeld()).toBe(true);
    } finally {
      replacement.release();
    }
    const next = local.controller.acquireTurnLease();
    expect(next?.isHeld()).toBe(true);
    try {
      expect(local.controller.refreshFromStore()?.ok).toBe(true);
      expect(local.getSnapshot().messages).toEqual([piUser('replacement history')]);
    } finally {
      next?.release();
    }
  });

  it('re-reads a switched-away session after the remote writer releases its lease', async () => {
    vi.useFakeTimers();
    const local = harness();
    local.controller.saveCurrent();
    const originalId = local.controller.getCurrentSessionId();
    const remote = harness();
    remote.controller.resume(originalId);
    const lease = remote.controller.acquireTurnLease()!;
    local.controller.startNewSession();
    local.setSnapshot(snapshot('other session'));
    local.controller.saveCurrent();
    const otherBefore = local.store.load(local.controller.getCurrentSessionId());
    const pending = local.controller.recordSubagentUsageForSession(originalId, usage('old-session-late'));
    try {
      await vi.advanceTimersByTimeAsync(100);
      remote.setSnapshot(snapshot('new external history', [usage('remote')]));
      remote.controller.saveCurrent();
    } finally {
      lease.release();
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe(true);
    expect(local.store.load(originalId)!.snapshot.subagentUsageHistory).toEqual([
      usage('remote'),
      usage('old-session-late'),
    ]);
    expect(local.store.load(originalId)!.snapshot.messages).toEqual([piUser('new external history')]);
    expect(local.store.load(local.controller.getCurrentSessionId())).toEqual(otherBefore);
    expect(local.recordSubagentUsage).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not revive a deleted session (switched away: %s)', async (switched) => {
    vi.useFakeTimers();
    const local = harness();
    local.controller.saveCurrent();
    const originalId = local.controller.getCurrentSessionId();
    const writer = micaSession.acquireTurnLease(originalId)!;
    const pending = local.controller.recordSubagentUsageForSession(originalId, usage('deleted-late'));
    if (switched) local.controller.startNewSession();
    expect(local.store.delete(originalId)).toBe(false);
    expect(writer.isHeld()).toBe(true);
    writer.release();
    expect(local.store.delete(originalId)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe(false);
    expect(await local.controller.recordSubagentUsageForSession(originalId, usage('still-deleted'))).toBe(false);
    expect(local.store.load(originalId)).toBeNull();
    expect(local.recordSubagentUsage).not.toHaveBeenCalled();
  });

  it('serializes concurrent late charges from independent writers without dropping either', async () => {
    vi.useFakeTimers();
    const first = harness();
    first.controller.saveCurrent();
    const sessionId = first.controller.getCurrentSessionId();
    const second = harness();
    second.controller.resume(sessionId);
    const blocker = micaSession.acquireTurnLease(sessionId)!;
    const charges = [
      first.controller.recordSubagentUsageForSession(sessionId, usage('first')),
      second.controller.recordSubagentUsageForSession(sessionId, usage('second')),
    ];
    await vi.advanceTimersByTimeAsync(100);
    blocker.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.all(charges)).toEqual([true, true]);
    expect(first.store.load(sessionId)!.snapshot.subagentUsageHistory).toEqual([usage('first'), usage('second')]);
  });

  it('does not recreate a local draft that another writer persisted and then deleted while accounting waited', async () => {
    vi.useFakeTimers();
    const local = harness();
    const sessionId = local.controller.getCurrentSessionId();
    const external = micaSession.createStore();
    const writer = micaSession.acquireTurnLease(sessionId)!;
    external.save({
      version: 1,
      id: sessionId,
      title: 'external',
      cwd: process.cwd(),
      turnState: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      snapshot: { ...snapshot('external'), conversationMessages: [{ role: 'user', content: 'external' }] },
    });
    const pending = local.controller.recordSubagentUsageForSession(sessionId, usage('late'));
    expect(external.delete(sessionId)).toBe(false);
    writer.release();
    expect(external.delete(sessionId)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe(false);
    expect(external.load(sessionId)).toBeNull();
    expect(local.recordSubagentUsage).not.toHaveBeenCalled();
  });

  it('persists first usage in a new draft and keeps the used session when switching away', async () => {
    const local = harness();
    local.setSnapshot(snapshot(''));
    const sessionId = local.controller.getCurrentSessionId();
    expect(await local.controller.recordSubagentUsageForSession(sessionId, usage('first-activity'))).toBe(true);
    expect(local.controller.saveCurrent()).toBe(true);
    local.controller.startNewSession();
    expect(local.store.load(sessionId)!.snapshot.subagentUsageHistory).toEqual([usage('first-activity')]);
  });

  it('releases an acquired accounting lease when disk saving fails', async () => {
    const store = micaSession.createStore();
    const local = harness(store);
    local.controller.saveCurrent();
    const save = vi.spyOn(store, 'save').mockImplementation(() => {
      throw new Error('disk full');
    });
    const sessionId = local.controller.getCurrentSessionId();
    await expect(local.controller.recordSubagentUsageForSession(sessionId, usage('failed'))).rejects.toThrow(
      'disk full',
    );
    expect(local.recordSubagentUsage).not.toHaveBeenCalled();
    const available = micaSession.acquireTurnLease(sessionId);
    expect(available).not.toBeNull();
    available?.release();
    save.mockRestore();
  });
});
