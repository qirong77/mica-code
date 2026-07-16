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
