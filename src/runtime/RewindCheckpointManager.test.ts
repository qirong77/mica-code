import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeInput } from '@packages/mica-runtime/index.js';
import type { AgentRuntime, AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';
import { RewindCheckpointManager } from './RewindCheckpointManager.js';

describe('RewindCheckpointManager', () => {
  it('restores messages and file state captured before a turn', () => {
    const previousCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'mica-rewind-'));
    try {
      git(dir, ['init']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      git(dir, ['config', 'user.name', 'Test User']);
      writeFileSync(join(dir, 'tracked.txt'), 'base\n');
      git(dir, ['add', 'tracked.txt']);
      git(dir, ['commit', '-m', 'initial']);

      writeFileSync(join(dir, 'tracked.txt'), 'before dirty\n');
      writeFileSync(join(dir, 'keep.txt'), 'before untracked\n');

      process.chdir(dir);
      const beforeSnapshot = makeSnapshot([{ role: 'user', content: 'before' }]);
      let currentSnapshot = beforeSnapshot;
      const agent = {
        getSnapshot: () => currentSnapshot,
        loadSnapshot: (snapshot: AgentRuntimeSnapshot) => {
          currentSnapshot = snapshot;
        },
      } as unknown as AgentRuntime;

      const manager = new RewindCheckpointManager();
      manager.capture(agent, makeInput('change files'));

      currentSnapshot = makeSnapshot([
        { role: 'user', content: 'before' },
        { role: 'user', content: 'change files' },
        { role: 'assistant', content: 'changed' },
      ]);
      writeFileSync(join(dir, 'tracked.txt'), 'after dirty\n');
      writeFileSync(join(dir, 'keep.txt'), 'after untracked\n');
      writeFileSync(join(dir, 'new.txt'), 'new file\n');

      const preview = manager.preview(agent);
      expect(preview.ok).toBe(true);
      if (!preview.ok) throw new Error(preview.message);
      expect(preview.files.map((file) => file.path)).toEqual(['keep.txt', 'new.txt', 'tracked.txt']);

      manager.apply(agent, preview.id);

      expect(currentSnapshot.messages).toEqual(beforeSnapshot.messages);
      expect(readFileSync(join(dir, 'tracked.txt'), 'utf-8')).toBe('before dirty\n');
      expect(readFileSync(join(dir, 'keep.txt'), 'utf-8')).toBe('before untracked\n');
      expect(() => readFileSync(join(dir, 'new.txt'), 'utf-8')).toThrow();
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('skips checkpoints when the conversation snapshot is too large', () => {
    const manager = new RewindCheckpointManager();
    const agent = {
      getSnapshot: () => makeSnapshot([{ role: 'user', content: 'x'.repeat(2_000_000) }]),
      loadSnapshot: () => {
        throw new Error('should not load snapshot');
      },
    } as unknown as AgentRuntime;

    manager.capture(agent, makeInput('large turn'));

    expect(manager.preview(agent)).toMatchObject({
      ok: false,
      message: 'rewind: 没有可回退的上一轮对话',
    });
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeInput(text: string): RuntimeInput {
  return {
    id: 'input-test',
    text,
    source: 'ui',
    createdAt: Date.now(),
  };
}

function makeSnapshot(messages: unknown[]): AgentRuntimeSnapshot {
  return {
    providerId: 'test',
    model: 'test-model',
    effort: 'none',
    messages,
    usageHistory: [],
    lastUsage: undefined,
  };
}
