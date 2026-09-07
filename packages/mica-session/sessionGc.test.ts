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

function session(id: string, turnState: PersistedSession['turnState']): PersistedSession {
  return {
    version: 1,
    id,
    title: id,
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

describe('SessionStore.performGarbageCollection', () => {
  it('reclaims an orphan turn-lock whose owner pid is dead', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-gc-lock-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();

      const lockDir = resolve(SESSION_DIR, '.turn-locks');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        resolve(lockDir, 'orphan.lock'),
        JSON.stringify({ pid: 999_999_999, token: 'stale', createdAt: new Date().toISOString() }),
        'utf-8',
      );
      // A live lock owned by the current process must survive the sweep.
      writeFileSync(resolve(lockDir, 'live.lock'), JSON.stringify({ pid: process.pid, token: 'x' }), 'utf-8');

      const result = store.performGarbageCollection();
      expect(result.reclaimedLocks).toBe(1);
      expect(existsSync(resolve(lockDir, 'orphan.lock'))).toBe(false);
      expect(existsSync(resolve(lockDir, 'live.lock'))).toBe(true);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('demotes a running session whose lock is dead (crashed mid-turn) to aborted', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-gc-demote-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();

      const crashed = session('crashed', 'running');
      store.save(crashed);
      // The turn owned a lock that was never released; its owner pid is dead.
      const lockDir = resolve(SESSION_DIR, '.turn-locks');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        resolve(lockDir, 'crashed.lock'),
        JSON.stringify({ pid: 999_999_999, token: 'stale', createdAt: new Date().toISOString() }),
        'utf-8',
      );

      // A running session with a live lock (still genuinely in flight) must not
      // be touched.
      const active = session('active', 'running');
      store.save(active);
      writeFileSync(resolve(lockDir, 'active.lock'), JSON.stringify({ pid: process.pid, token: 'x' }), 'utf-8');

      const result = store.performGarbageCollection();
      expect(result.demotedSessions).toBe(1);
      expect(store.load('crashed')?.turnState).toBe('aborted');
      expect(store.load('active')?.turnState).toBe('running');
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('deletes completed junk empty sessions but keeps titled ones', async () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-gc-junk-'));
    try {
      process.env.MICA_HOME = micaHome;
      vi.resetModules();
      const { SessionStore, SESSION_DIR } = await import('./sessionStore.js');
      const store = new SessionStore();

      // Write crash leftovers directly to disk: going through store.save()
      // would let rebuildIndex auto-delete junk files before the sweep — the
      // very behavior this GC is meant to make explicit and deterministic.
      const writeSession = (s: PersistedSession): void => {
        mkdirSync(SESSION_DIR, { recursive: true });
        writeFileSync(resolve(SESSION_DIR, `${s.id}.json`), `${JSON.stringify(s, null, 2)}\n`, 'utf8');
      };

      const staleJunk = session('stale-junk', 'completed');
      staleJunk.title = 'Untitled session';
      const titled = session('titled', 'completed');
      titled.title = 'A real conversation';
      writeSession(staleJunk);
      writeSession(titled);

      const result = store.performGarbageCollection();
      expect(result.deletedSessions).toBe(1);
      expect(result.demotedSessions).toBe(0);
      expect(existsSync(resolve(SESSION_DIR, 'stale-junk.json'))).toBe(false);
      expect(existsSync(resolve(SESSION_DIR, 'titled.json'))).toBe(true);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });
});
