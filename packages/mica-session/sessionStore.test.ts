import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersistedSession } from './sessionStore.js';

const previousMicaHome = process.env.MICA_HOME;

afterEach(() => {
  if (previousMicaHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = previousMicaHome;
  vi.resetModules();
});

describe('SessionStore path', () => {
  it('keeps daemon sessions inside MICA_HOME when it is set', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-home-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SESSION_DIR } = await import('./sessionStore.js');
      expect(SESSION_DIR).toBe(resolve(micaHome, 'sessions'));
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('lists sessions strictly by recency before applying the limit', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-recent-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore } = await import('./sessionStore.js');
      const store = new SessionStore();

      store.save(makeSession('old-current-cwd', process.cwd(), '2026-01-01T00:00:00.000Z'));
      store.save(makeSession('newest', '/tmp/newest', '2026-01-03T00:00:00.000Z'));
      store.save(makeSession('middle', '/tmp/middle', '2026-01-02T00:00:00.000Z'));

      expect(store.listRecent(2).map((session) => session.id)).toEqual(['newest', 'middle']);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });
});

describe('SessionStore.replaceValidated', () => {
  it('validates and atomically replaces an existing completed session', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-replace-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore } = await import('./sessionStore.js');
      const store = new SessionStore();
      const original = makeSession('editable', '/tmp/editable', '2026-01-01T00:00:00.000Z');
      store.save(original);

      const replacement = { ...original, title: 'Edited title', updatedAt: '2026-01-02T00:00:00.000Z' };
      expect(store.replaceValidated('editable', JSON.stringify(replacement)).title).toBe('Edited title');
      expect(store.load('editable')).toMatchObject({ title: 'Edited title', updatedAt: replacement.updatedAt });
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('rejects malformed JSON, mismatched ids, and running sessions', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-reject-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore } = await import('./sessionStore.js');
      const store = new SessionStore();
      const completed = makeSession('completed', '/tmp/completed', '2026-01-01T00:00:00.000Z');
      const running = {
        ...makeSession('running', '/tmp/running', '2026-01-01T00:00:00.000Z'),
        turnState: 'running' as const,
      };
      store.save(completed);
      store.save(running);

      expect(() => store.replaceValidated('completed', '{')).toThrow('Invalid session JSON');
      expect(() => store.replaceValidated('completed.json', JSON.stringify(completed))).toThrow('Invalid session id');
      expect(() => store.replaceValidated('completed', JSON.stringify({ ...completed, id: 'other' }))).toThrow(
        'Session id mismatch',
      );
      expect(() => store.replaceValidated('running', JSON.stringify(running))).toThrow(
        'Cannot replace running session',
      );
      expect(() => store.replaceValidated('completed', JSON.stringify({ ...completed, turnState: 'running' }))).toThrow(
        'Cannot save running session',
      );
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('parses legacy defaults without mutating the caller value', async () => {
    const { parsePersistedSession } = await import('./sessionStore.js');
    const raw = {
      version: 1,
      id: 'legacy-compatible',
      title: 'Legacy compatible',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp/project',
      snapshot: {
        providerId: 'test',
        model: 'test-model',
        effort: 'none',
        messages: [],
        conversationMessages: [],
        usageHistory: [],
      },
    };
    const before = JSON.stringify(raw);

    expect(parsePersistedSession(raw)).toMatchObject({
      turnState: 'completed',
      snapshot: { protocol: 'openai_chat_completions', role: 'default' },
    });
    expect(JSON.stringify(raw)).toBe(before);
    expect(parsePersistedSession({ ...raw, snapshot: { ...raw.snapshot, usageHistory: {} } })).toBeNull();
  });
});

function makeSession(id: string, cwd: string, updatedAt: string): PersistedSession {
  return {
    version: 1,
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    cwd,
    turnState: 'completed',
    snapshot: {
      providerId: 'test',
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
