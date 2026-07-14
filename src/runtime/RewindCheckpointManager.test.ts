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
      manager.capture(agent, makeInput('change files'), [
        { role: 'notice', content: 'keep this notice', command: '/compact', status: 'success' },
        { role: 'user', content: 'before', displayContent: 'formatted before' },
      ]);

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

      const result = manager.apply(agent, {
        id: preview.id,
        mode: 'conversation_and_files',
        previewToken: preview.previewToken,
      });

      expect(currentSnapshot.messages).toEqual(beforeSnapshot.messages);
      expect(result).toMatchObject({
        inputText: 'change files',
        messageCountBefore: 1,
        messageCountNow: 3,
        messageCountRemoved: 2,
        mode: 'conversation_and_files',
        conversationMessagesBefore: [
          { role: 'notice', content: 'keep this notice', command: '/compact', status: 'success' },
          { role: 'user', content: 'before', displayContent: 'formatted before' },
        ],
      });
      expect(readFileSync(join(dir, 'tracked.txt'), 'utf-8')).toBe('before dirty\n');
      expect(readFileSync(join(dir, 'keep.txt'), 'utf-8')).toBe('before untracked\n');
      expect(() => readFileSync(join(dir, 'new.txt'), 'utf-8')).toThrow();
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('lists newest checkpoints first and can rewind to an intermediate input', () => {
    const manager = new RewindCheckpointManager();
    let currentSnapshot = makeSnapshot([]);
    const agent = {
      getSnapshot: () => currentSnapshot,
      loadSnapshot: (snapshot: AgentRuntimeSnapshot) => {
        currentSnapshot = snapshot;
      },
    } as unknown as AgentRuntime;

    manager.capture(agent, makeInput('first input'));
    currentSnapshot = makeSnapshot([
      { role: 'user', content: 'first input' },
      { role: 'assistant', content: 'first answer' },
    ]);
    manager.capture(agent, makeInput('second raw input', 'second display input'));
    currentSnapshot = makeSnapshot([
      ...currentSnapshot.messages,
      { role: 'user', content: 'second input' },
      { role: 'assistant', content: 'second answer' },
    ]);
    manager.capture(agent, makeInput('third input'));
    currentSnapshot = makeSnapshot([
      ...currentSnapshot.messages,
      { role: 'user', content: 'third input' },
      { role: 'assistant', content: 'third answer' },
    ]);

    const checkpoints = manager.list(agent);
    expect(checkpoints.map((checkpoint) => checkpoint.conversationLabel)).toEqual([
      'third input',
      'second display input',
      'first input',
    ]);

    const selected = checkpoints[1]!;
    const preview = manager.preview(agent, selected.id);
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error(preview.message);
    const result = manager.apply(agent, {
      id: selected.id,
      mode: 'conversation_only',
      previewToken: preview.previewToken,
    });

    expect(result).toMatchObject({
      id: selected.id,
      inputText: 'second raw input',
      messageCountBefore: 2,
      messageCountNow: 6,
      messageCountRemoved: 4,
      mode: 'conversation_only',
    });
    expect(currentSnapshot.messages).toEqual([
      { role: 'user', content: 'first input' },
      { role: 'assistant', content: 'first answer' },
    ]);
    expect(manager.list(agent).map((checkpoint) => checkpoint.conversationLabel)).toEqual(['first input']);
  });

  it('keeps workspace changes when rewinding conversation only', () => {
    const previousCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'mica-rewind-conversation-'));
    try {
      git(dir, ['init']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      git(dir, ['config', 'user.name', 'Test User']);
      writeFileSync(join(dir, 'tracked.txt'), 'base\n');
      git(dir, ['add', 'tracked.txt']);
      git(dir, ['commit', '-m', 'initial']);

      process.chdir(dir);
      let currentSnapshot = makeSnapshot([{ role: 'user', content: 'before' }]);
      const agent = {
        getSnapshot: () => currentSnapshot,
        loadSnapshot: (snapshot: AgentRuntimeSnapshot) => {
          currentSnapshot = snapshot;
        },
      } as unknown as AgentRuntime;
      const manager = new RewindCheckpointManager();
      manager.capture(agent, makeInput('leave my file alone'));
      currentSnapshot = makeSnapshot([
        { role: 'user', content: 'before' },
        { role: 'user', content: 'leave my file alone' },
        { role: 'assistant', content: 'done' },
      ]);
      writeFileSync(join(dir, 'tracked.txt'), 'changed after turn\n');

      const preview = manager.preview(agent);
      if (!preview.ok) throw new Error(preview.message);
      const result = manager.apply(agent, {
        id: preview.id,
        mode: 'conversation_only',
        previewToken: preview.previewToken,
      });

      expect(result.files).toEqual([]);
      expect(result.inputText).toBe('leave my file alone');
      expect(currentSnapshot.messages).toEqual([{ role: 'user', content: 'before' }]);
      expect(readFileSync(join(dir, 'tracked.txt'), 'utf-8')).toBe('changed after turn\n');
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('rejects a stale file preview before making any modification', () => {
    const previousCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'mica-rewind-stale-'));
    try {
      git(dir, ['init']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      git(dir, ['config', 'user.name', 'Test User']);
      writeFileSync(join(dir, 'tracked.txt'), 'base\n');
      git(dir, ['add', 'tracked.txt']);
      git(dir, ['commit', '-m', 'initial']);

      process.chdir(dir);
      let currentSnapshot = makeSnapshot([{ role: 'user', content: 'before' }]);
      const agent = {
        getSnapshot: () => currentSnapshot,
        loadSnapshot: () => {
          throw new Error('stale apply must not load the conversation snapshot');
        },
      } as unknown as AgentRuntime;
      const manager = new RewindCheckpointManager();
      manager.capture(agent, makeInput('change tracked'));
      currentSnapshot = makeSnapshot([
        { role: 'user', content: 'before' },
        { role: 'user', content: 'change tracked' },
        { role: 'assistant', content: 'done' },
      ]);
      writeFileSync(join(dir, 'tracked.txt'), 'changed after turn\n');

      const preview = manager.preview(agent);
      if (!preview.ok) throw new Error(preview.message);
      expect(preview.files.map((file) => file.path)).toEqual(['tracked.txt']);

      writeFileSync(join(dir, 'new-after-preview.txt'), 'must survive\n');
      expect(() =>
        manager.apply(agent, {
          id: preview.id,
          mode: 'conversation_and_files',
          previewToken: preview.previewToken,
        }),
      ).toThrow(/rewind stale preview/);

      expect(readFileSync(join(dir, 'tracked.txt'), 'utf-8')).toBe('changed after turn\n');
      expect(readFileSync(join(dir, 'new-after-preview.txt'), 'utf-8')).toBe('must survive\n');
      expect(currentSnapshot.messages).toHaveLength(3);
      expect(manager.list(agent)).toHaveLength(1);
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('removes a file created and staged during the rewound turn from both worktree and index', () => {
    const previousCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'mica-rewind-new-staged-'));
    try {
      git(dir, ['init']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      git(dir, ['config', 'user.name', 'Test User']);
      writeFileSync(join(dir, 'tracked.txt'), 'base\n');
      git(dir, ['add', 'tracked.txt']);
      git(dir, ['commit', '-m', 'initial']);

      process.chdir(dir);
      let currentSnapshot = makeSnapshot([{ role: 'user', content: 'before' }]);
      const agent = {
        getSnapshot: () => currentSnapshot,
        loadSnapshot: (snapshot: AgentRuntimeSnapshot) => {
          currentSnapshot = snapshot;
        },
      } as unknown as AgentRuntime;
      const manager = new RewindCheckpointManager();
      manager.capture(agent, makeInput('create staged file'));
      currentSnapshot = makeSnapshot([
        { role: 'user', content: 'before' },
        { role: 'user', content: 'create staged file' },
        { role: 'assistant', content: 'done' },
      ]);
      writeFileSync(join(dir, 'new.ts'), 'export const value = 1;\n');
      git(dir, ['add', 'new.ts']);

      const preview = manager.preview(agent);
      if (!preview.ok) throw new Error(preview.message);
      expect(preview.files).toContainEqual({ path: 'new.ts', action: 'delete' });
      manager.apply(agent, {
        id: preview.id,
        mode: 'conversation_and_files',
        previewToken: preview.previewToken,
      });

      expect(() => readFileSync(join(dir, 'new.ts'), 'utf-8')).toThrow();
      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf-8' });
      expect(staged.trim()).toBe('');
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('restores both sides of a staged rename made during the rewound turn', () => {
    const previousCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'mica-rewind-rename-'));
    try {
      git(dir, ['init']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      git(dir, ['config', 'user.name', 'Test User']);
      writeFileSync(join(dir, 'old.ts'), 'export const value = 1;\n');
      git(dir, ['add', 'old.ts']);
      git(dir, ['commit', '-m', 'initial']);

      process.chdir(dir);
      let currentSnapshot = makeSnapshot([{ role: 'user', content: 'before' }]);
      const agent = {
        getSnapshot: () => currentSnapshot,
        loadSnapshot: (snapshot: AgentRuntimeSnapshot) => {
          currentSnapshot = snapshot;
        },
      } as unknown as AgentRuntime;
      const manager = new RewindCheckpointManager();
      manager.capture(agent, makeInput('rename file'));
      currentSnapshot = makeSnapshot([
        { role: 'user', content: 'before' },
        { role: 'user', content: 'rename file' },
        { role: 'assistant', content: 'done' },
      ]);
      git(dir, ['mv', 'old.ts', 'new.ts']);

      const preview = manager.preview(agent);
      if (!preview.ok) throw new Error(preview.message);
      expect(preview.files).toEqual([
        { path: 'new.ts', action: 'delete' },
        { path: 'old.ts', action: 'restore' },
      ]);
      manager.apply(agent, {
        id: preview.id,
        mode: 'conversation_and_files',
        previewToken: preview.previewToken,
      });

      expect(readFileSync(join(dir, 'old.ts'), 'utf-8')).toBe('export const value = 1;\n');
      expect(() => readFileSync(join(dir, 'new.ts'), 'utf-8')).toThrow();
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' });
      expect(status.trim()).toBe('');
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('allows conversation-only rewind when file state is unavailable', () => {
    const previousCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'mica-rewind-no-git-'));
    try {
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
      manager.capture(agent, makeInput('conversation only'));
      currentSnapshot = makeSnapshot([
        { role: 'user', content: 'before' },
        { role: 'user', content: 'conversation only' },
        { role: 'assistant', content: 'answer' },
      ]);

      const preview = manager.preview(agent);
      if (!preview.ok) throw new Error(preview.message);
      expect(preview.fileStateAvailable).toBe(false);
      expect(() =>
        manager.apply(agent, {
          id: preview.id,
          mode: 'conversation_and_files',
          previewToken: preview.previewToken,
        }),
      ).toThrow(/rewind file state unavailable/);

      const result = manager.apply(agent, {
        id: preview.id,
        mode: 'conversation_only',
        previewToken: preview.previewToken,
      });
      expect(result.fileStateAvailable).toBe(false);
      expect(result.inputText).toBe('conversation only');
      expect(currentSnapshot.messages).toEqual(beforeSnapshot.messages);
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('disables file rewind when Git HEAD changed after the checkpoint', () => {
    const previousCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'mica-rewind-head-'));
    try {
      git(dir, ['init']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      git(dir, ['config', 'user.name', 'Test User']);
      writeFileSync(join(dir, 'tracked.txt'), 'base\n');
      git(dir, ['add', 'tracked.txt']);
      git(dir, ['commit', '-m', 'initial']);

      process.chdir(dir);
      let currentSnapshot = makeSnapshot([{ role: 'user', content: 'before' }]);
      const agent = {
        getSnapshot: () => currentSnapshot,
        loadSnapshot: (snapshot: AgentRuntimeSnapshot) => {
          currentSnapshot = snapshot;
        },
      } as unknown as AgentRuntime;
      const manager = new RewindCheckpointManager();
      manager.capture(agent, makeInput('commit something'));
      currentSnapshot = makeSnapshot([
        { role: 'user', content: 'before' },
        { role: 'user', content: 'commit something' },
        { role: 'assistant', content: 'done' },
      ]);
      git(dir, ['commit', '--allow-empty', '-m', 'turn commit']);

      const preview = manager.preview(agent);
      if (!preview.ok) throw new Error(preview.message);
      expect(preview.fileStateAvailable).toBe(false);
      expect(preview.fileStateError).toContain('HEAD changed');
      expect(() =>
        manager.apply(agent, {
          id: preview.id,
          mode: 'conversation_and_files',
          previewToken: preview.previewToken,
        }),
      ).toThrow(/file state unavailable/);

      manager.apply(agent, {
        id: preview.id,
        mode: 'conversation_only',
        previewToken: preview.previewToken,
      });
      expect(currentSnapshot.messages).toEqual([{ role: 'user', content: 'before' }]);
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('disables file rewind when the checkpoint starts with staged changes', () => {
    const previousCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'mica-rewind-staged-'));
    try {
      git(dir, ['init']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      git(dir, ['config', 'user.name', 'Test User']);
      writeFileSync(join(dir, 'tracked.txt'), 'base\n');
      git(dir, ['add', 'tracked.txt']);
      git(dir, ['commit', '-m', 'initial']);
      writeFileSync(join(dir, 'tracked.txt'), 'staged before turn\n');
      git(dir, ['add', 'tracked.txt']);

      process.chdir(dir);
      const snapshot = makeSnapshot([{ role: 'user', content: 'before' }]);
      const agent = {
        getSnapshot: () => snapshot,
        loadSnapshot: () => undefined,
      } as unknown as AgentRuntime;
      const manager = new RewindCheckpointManager();
      manager.capture(agent, makeInput('do not disturb staging'));

      const preview = manager.preview(agent);
      if (!preview.ok) throw new Error(preview.message);
      expect(preview.fileStateAvailable).toBe(false);
      expect(preview.fileStateError).toContain('staged or partially-staged');
      expect(readFileSync(join(dir, 'tracked.txt'), 'utf-8')).toBe('staged before turn\n');
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('skips an oversized checkpoint without discarding selectable earlier history', () => {
    const manager = new RewindCheckpointManager();
    let currentSnapshot = makeSnapshot([{ role: 'user', content: 'small' }]);
    const agent = {
      getSnapshot: () => currentSnapshot,
      loadSnapshot: () => {
        throw new Error('should not load snapshot');
      },
    } as unknown as AgentRuntime;

    manager.capture(agent, makeInput('valid turn'));
    expect(manager.list(agent)).toHaveLength(1);

    currentSnapshot = makeSnapshot([{ role: 'user', content: 'x'.repeat(2_000_000) }]);
    manager.capture(agent, makeInput('large turn'));

    expect(manager.list(agent)).toMatchObject([{ conversationLabel: 'valid turn' }]);
    expect(manager.preview(agent)).toMatchObject({ ok: true, conversationLabel: 'valid turn' });
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeInput(text: string, displayText?: string): RuntimeInput {
  return {
    id: 'input-test',
    text,
    displayText,
    source: 'ui',
    createdAt: Date.now(),
  };
}

function makeSnapshot(messages: unknown[]): AgentRuntimeSnapshot {
  return {
    providerId: 'openai',
    protocol: 'openai_chat_completions',
    model: 'test-model',
    effort: 'none',
    role: 'default',
    messages,
    usageHistory: [],
    lastUsage: undefined,
  };
}
