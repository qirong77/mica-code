import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SyncStore, type StoredSession } from './store.js';

describe('SyncStore session revisions', () => {
  it('rejects a delayed snapshot older than the stored revision', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mica-sync-store-'));
    try {
      const store = new SyncStore(dataDir);
      const completed = makeSession(2, 'completed');
      const delayedRunning = makeSession(1, 'running');

      expect(store.writeSession('machine', completed)).toBe(true);
      expect(store.writeSession('machine', delayedRunning)).toBe(false);
      expect(store.readSession('machine', completed.id)).toMatchObject({ revision: 2, turnState: 'completed' });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

function makeSession(revision: number, turnState: string): StoredSession {
  return {
    id: 'shared-session',
    revision,
    title: 'Shared session',
    updatedAt: `2026-07-31T00:00:0${revision}.000Z`,
    cwd: '/tmp/project',
    turnState,
    snapshot: { providerId: 'test', model: 'test-model', conversationMessages: [] },
  };
}
