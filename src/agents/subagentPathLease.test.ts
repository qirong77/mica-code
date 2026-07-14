import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubagentPathLeaseManager, assertPathWritable } from './subagentPathLease.js';

describe('subagentPathLease', () => {
  it('rejects overlapping owned paths for the same owner', () => {
    const manager = new SubagentPathLeaseManager();
    manager.acquire({
      taskId: 'a',
      ownerKey: 'owner-1',
      ownedPaths: ['packages/mica-ui'],
      cwd: '/repo',
    });

    expect(() =>
      manager.acquire({
        taskId: 'b',
        ownerKey: 'owner-1',
        ownedPaths: ['packages/mica-ui/src'],
        cwd: '/repo',
      }),
    ).toThrow('owned_paths conflict');
  });

  it('allows non-overlapping owned paths', () => {
    const manager = new SubagentPathLeaseManager();
    manager.acquire({
      taskId: 'a',
      ownerKey: 'owner-1',
      ownedPaths: ['packages/mica-ui'],
      cwd: '/repo',
    });
    expect(() =>
      manager.acquire({
        taskId: 'b',
        ownerKey: 'owner-1',
        ownedPaths: ['packages/mica-tools'],
        cwd: '/repo',
      }),
    ).not.toThrow();
  });

  it('enforces writable path ownership', () => {
    const owned = [resolve('/repo/packages/mica-ui')];
    expect(() => assertPathWritable('/repo/packages/mica-ui/App.tsx', owned, '/repo')).not.toThrow();
    expect(() => assertPathWritable('/repo/packages/mica-tools/index.ts', owned, '/repo')).toThrow(
      'outside subagent owned_paths',
    );
  });
});
