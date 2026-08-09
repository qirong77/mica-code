import { describe, expect, it } from 'vitest';
import { micaSession, type PersistedSession } from '@packages/mica-session/index.js';
import { CommandExecutor } from './CommandExecutor.js';

function makeSession(id: string): PersistedSession {
  const now = new Date().toISOString();
  return {
    version: 1,
    id,
    title: 'test',
    createdAt: now,
    updatedAt: now,
    cwd: process.cwd(),
    turnState: 'completed',
    snapshot: {
      providerId: 'local',
      protocol: 'openai_chat_completions',
      model: 'test-model',
      effort: 'none',
      role: 'default',
      messages: [],
      conversationMessages: [],
      usageHistory: [],
      lastUsage: undefined,
    },
  };
}

describe('CommandExecutor lock semantics', () => {
  it('releases the daemon busy flag when the turn lease is held elsewhere (e.g. the local terminal is running the same session)', async () => {
    const sid = `lock-busy-${Date.now()}`;
    micaSession.createStore().save(makeSession(sid));

    // Simulate the local interactive terminal holding the per-session turn
    // lease while a remote Sync Web client sends a message for the same session.
    const lease = micaSession.acquireTurnLease(sid);
    expect(lease).not.toBeNull();

    const events: Array<Record<string, unknown>> = [];
    const executor = new CommandExecutor({
      onEvents: (_sessionId, evs) => events.push(...evs),
      onSessionSaved: () => {},
    });

    await executor.execute({
      type: 'run',
      id: 'cmd-1',
      sessionId: sid,
      prompt: 'hello',
      requestedAt: new Date().toISOString(),
    });

    // The remote turn must be rejected, but the daemon must NOT stay busy:
    // otherwise every later command (including other sessions) is refused
    // forever until the daemon process is restarted.
    expect(events.some((e) => e.type === 'run_rejected')).toBe(true);
    expect(executor.isBusy).toBe(false);
    expect(executor.activeSessionId).toBeNull();

    lease?.release();
  });

  it('honours an abort that arrives before the run command in the same poll batch', async () => {
    const sid = `lock-abort-${Date.now()}`;
    micaSession.createStore().save(makeSession(sid));

    const events: Array<Record<string, unknown>> = [];
    const executor = new CommandExecutor({
      onEvents: (_sessionId, evs) => events.push(...evs),
      onSessionSaved: () => {},
    });

    // The daemon may receive [abort, run] in one poll batch. The abort must
    // cancel the upcoming turn instead of being silently dropped.
    executor.abort(sid, 'cmd-2');
    await executor.execute({
      type: 'run',
      id: 'cmd-2',
      sessionId: sid,
      prompt: 'hello',
      requestedAt: new Date().toISOString(),
    });

    expect(events.some((e) => e.type === 'turn' && e.state === 'aborted')).toBe(true);
    expect(events.some((e) => e.type === 'user_input')).toBe(false);
    expect(executor.isBusy).toBe(false);
  });

  it('does not apply an idle abort to a future run', async () => {
    const sid = `lock-stale-abort-${Date.now()}`;
    micaSession.createStore().save(makeSession(sid));

    const events: Array<Record<string, unknown>> = [];
    const executor = new CommandExecutor({
      onEvents: (_sessionId, evs) => events.push(...evs),
      onSessionSaved: () => {},
    });

    const lease = micaSession.acquireTurnLease(sid);
    expect(lease).not.toBeNull();
    executor.abort(sid);
    await executor.execute({
      type: 'run',
      id: 'cmd-future',
      sessionId: sid,
      prompt: 'hello',
      requestedAt: new Date().toISOString(),
    });

    expect(events.some((event) => event.type === 'turn' && event.state === 'aborted')).toBe(false);
    expect(events.some((event) => event.type === 'run_rejected')).toBe(true);
    lease?.release();
  });
});
