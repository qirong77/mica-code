import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  it('keeps headless sessions inside MICA_HOME when it is set', async () => {
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

describe('SessionStore metadata index', () => {
  it('persists recency order and reloads from the index without parsing session bodies', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-index-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();

      store.save(makeSession('newest', '/tmp/newest', '2026-01-03T00:00:00.000Z'));
      store.save(makeSession('middle', '/tmp/middle', '2026-01-02T00:00:00.000Z'));
      store.save(makeSession('oldest', '/tmp/oldest', '2026-01-01T00:00:00.000Z'));

      // The index lives outside sessions/ so directory scans stay unaffected.
      const indexFile = join(micaHome, 'session-index.json');
      expect(existsSync(indexFile)).toBe(true);
      expect(existsSync(join(SESSION_DIR, 'session-index.json'))).toBe(false);

      // A fresh store reads the index: a corrupt session body must be ignored.
      writeFileSync(join(SESSION_DIR, 'newest.json'), '{ not valid json', 'utf-8');
      const reloaded = new SessionStore();
      expect(reloaded.listRecent(10).map((session) => session.id)).toEqual(['newest', 'middle', 'oldest']);

      reloaded.delete('newest');
      expect(reloaded.listRecent(10).map((session) => session.id)).toEqual(['middle', 'oldest']);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });
});

describe('session turn lease', () => {
  it('serializes turns for one session and releases idempotently', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-lease-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { acquireSessionTurnLease } = await import('./sessionStore.js');

      const first = acquireSessionTurnLease('shared-session');
      expect(first).not.toBeNull();
      expect(acquireSessionTurnLease('shared-session')).toBeNull();
      const other = acquireSessionTurnLease('other-session');
      expect(other).not.toBeNull();

      first?.release();
      first?.release();
      const next = acquireSessionTurnLease('shared-session');
      expect(next).not.toBeNull();
      next?.release();
      other?.release();
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('reclaims a stale lock left by a dead host process', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-stale-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { acquireSessionTurnLease, SESSION_DIR } = await import('./sessionStore.js');

      // Simulate a host that crashed mid-turn: its pid is no longer alive and
      // the lock file was never released. A fresh acquire must reclaim it.
      const lockDir = resolve(SESSION_DIR, '.turn-locks');
      mkdirSync(lockDir, { recursive: true });
      const lockPath = resolve(lockDir, 'crashed-session.lock');
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 999_999_999, token: 'stale', createdAt: new Date().toISOString() }),
        'utf-8',
      );

      const lease = acquireSessionTurnLease('crashed-session');
      expect(lease).not.toBeNull();
      lease?.release();
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('deletes a session together with any leftover turn-lock', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-delete-lock-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();
      store.save(makeSession('to-delete', '/tmp/to-delete', '2026-01-01T00:00:00.000Z'));

      const lockPath = resolve(SESSION_DIR, '.turn-locks', 'to-delete.lock');
      mkdirSync(resolve(SESSION_DIR, '.turn-locks'), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'x' }), 'utf-8');

      expect(store.delete('to-delete')).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('clears an orphan turn-lock when deleting an id whose session file is already gone', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-delete-orphan-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();

      // A crash left a lock behind after the session file was removed elsewhere.
      // Deleting the id must clean up the orphan lock even though no session file
      // exists anymore, otherwise a later continue/resume of the id stays stuck.
      const lockPath = resolve(SESSION_DIR, '.turn-locks', 'gone-session.lock');
      mkdirSync(resolve(SESSION_DIR, '.turn-locks'), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'x' }), 'utf-8');

      expect(store.delete('gone-session')).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
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

describe('SessionStore index reconciliation', () => {
  it('rebuilds the index to recover sessions a stale index dropped', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-recover-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();
      store.save(makeSession('real', '/tmp/real', '2026-01-01T00:00:00.000Z'));

      // Simulate another process persisting a session without updating the
      // index (as happens when a stale in-memory index overwrites the file).
      writeFileSync(
        join(SESSION_DIR, 'orphan.json'),
        JSON.stringify(makeSession('orphan', '/tmp/orphan', '2026-01-02T00:00:00.000Z')),
        'utf-8',
      );

      expect(store.listRecent(10).map((session) => session.id)).toEqual(['orphan', 'real']);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('keeps sessions saved by another store instance instead of dropping them', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-merge-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore } = await import('./sessionStore.js');
      const first = new SessionStore();
      first.save(makeSession('a', '/tmp/a', '2026-01-01T00:00:00.000Z'));
      const second = new SessionStore();
      second.save(makeSession('b', '/tmp/b', '2026-01-02T00:00:00.000Z'));

      // The second writer must not clobber the first writer's entry from the index.
      expect(new SessionStore().listRecent(10).map((session) => session.id)).toEqual(['b', 'a']);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });
});

describe('SessionStore junk session cleanup', () => {
  it('removes empty Untitled sessions that never carried a conversation', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-junk-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();
      store.save(makeSession('real', '/tmp/real', '2026-01-01T00:00:00.000Z'));

      const junkId = 'junk-completed';
      const junkPath = join(SESSION_DIR, `${junkId}.json`);
      writeFileSync(junkPath, JSON.stringify(junkSession(junkId, 'completed')), 'utf-8');

      // A stale index cannot account for the extra file, so the rebuild drops
      // the empty completed session and hides it from the listing.
      expect(store.listRecent(10).map((session) => session.id)).toEqual(['real']);
      expect(existsSync(junkPath)).toBe(false);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('lists an interrupted running session so a crashed turn stays recoverable', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-junk-running-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();
      store.save(makeSession('real', '/tmp/real', '2026-01-01T00:00:00.000Z'));

      const runningPath = join(SESSION_DIR, 'junk-running.json');
      writeFileSync(runningPath, JSON.stringify(junkSession('junk-running', 'running')), 'utf-8');

      // `running` marks a turn that was in flight when the process went away.
      // Hiding it would make the session look lost after an unexpected
      // termination, which is exactly the case the user must be able to find
      // in /resume (rendered as `（uncompleted）`).
      expect(store.listRecent(10).map((session) => session.id).sort()).toEqual(['junk-running', 'real']);
      expect(existsSync(runningPath)).toBe(true);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('lists a session whose stored title is still the placeholder but which has content', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-junk-title-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();
      mkdirSync(SESSION_DIR, { recursive: true });

      // A crash can land before the title is re-derived from the prompt; the
      // placeholder title alone must never hide a session that holds a
      // conversation (the deletion rule already spares it).
      for (const [id, turnState] of [
        ['placeholder-with-conversation', 'completed'],
        ['placeholder-usage-only', 'completed'],
      ] as const) {
        writeFileSync(join(SESSION_DIR, `${id}.json`), JSON.stringify(placeholderSession(id, turnState)), 'utf-8');
      }

      const listed = store.listRecent(10).map((session) => session.id).sort();
      expect(listed).toEqual(['placeholder-usage-only', 'placeholder-with-conversation']);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('rebuilds an index written before the junk rule honoured conversation content', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-session-index-legacy-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();
      mkdirSync(SESSION_DIR, { recursive: true });
      writeFileSync(
        join(SESSION_DIR, 'placeholder-with-conversation.json'),
        JSON.stringify(placeholderSession('placeholder-with-conversation', 'running')),
        'utf-8',
      );
      // Legacy index entry: same id, but without the content flags the current
      // junk rule needs. Treating its missing flags as "no content" would hide
      // a real session, so the entry must be rejected and rebuilt instead.
      writeFileSync(
        join(micaHome, 'session-index.json'),
        JSON.stringify({
          version: 1,
          sessions: [
            {
              id: 'placeholder-with-conversation',
              title: 'Untitled session',
              updatedAt: '2026-01-01T00:00:00.000Z',
              cwd: '/tmp',
              providerId: 'test',
              model: 'test-model',
              uncompleted: true,
              turnState: 'running',
            },
          ],
        }),
        'utf-8',
      );

      expect(store.listRecent(10).map((session) => session.id)).toEqual(['placeholder-with-conversation']);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
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

function junkSession(id: string, turnState: 'running' | 'completed'): PersistedSession {
  return {
    version: 1,
    id,
    title: 'Untitled session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    turnState,
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

/** A placeholder-titled session that already carries real content: a real user
 *  message (`placeholder-with-conversation`) or model usage
 *  (`placeholder-usage-only`). */
function placeholderSession(id: string, turnState: 'running' | 'completed'): PersistedSession {
  const withConversation = id === 'placeholder-with-conversation';
  return {
    version: 1,
    id,
    title: 'Untitled session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    turnState,
    snapshot: {
      providerId: 'test',
      protocol: 'openai_chat_completions',
      model: 'test-model',
      effort: 'none',
      role: 'default',
      messages: withConversation ? [{ role: 'user', content: 'hello' }] : [],
      conversationMessages: withConversation ? [{ role: 'user', content: 'hello' }] : [],
      usageHistory: withConversation
        ? []
        : [
            {
              provider: 'openai_chat_completions',
              turnId: 1,
              requestIndex: 0,
              messageCount: 1,
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              totalTokens: 15,
              paidTokenRate: 1,
            },
          ],
      lastUsage: undefined,
    },
  };
}
