import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentChangeTracker } from '../git/agentChangeTracker.js';
import type { ToolExecutionEvent } from '@packages/mica-tools/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('AgentChangeTracker', () => {
  it('区分当前 Agent 与后续混合修改', async () => {
    const root = createRepo();
    const tracker = new AgentChangeTracker(root);
    const observer = tracker.createObserver();
    const event = toolEvent('agent-a');
    const state = await observer.before?.(event);
    writeFileSync(join(root, 'file.txt'), 'agent\n');
    await observer.after?.({ ...event, state, result: 'ok' });

    expect(tracker.list('agent-a')).toEqual([{ path: 'file.txt', status: ' M', owner: 'agent' }]);

    writeFileSync(join(root, 'file.txt'), 'agent and user\n');
    expect(tracker.list('agent-a')).toEqual([{ path: 'file.txt', status: ' M', owner: 'mixed' }]);
  });

  it('识别两次 Agent 工具调用之间的外部修改', async () => {
    const root = createRepo();
    const tracker = new AgentChangeTracker(root);
    const observer = tracker.createObserver();
    const event = toolEvent('agent-a');

    let state = await observer.before?.(event);
    writeFileSync(join(root, 'file.txt'), 'agent-1\n');
    await observer.after?.({ ...event, state, result: 'ok' });
    writeFileSync(join(root, 'file.txt'), 'agent-1 and user\n');

    state = await observer.before?.(event);
    writeFileSync(join(root, 'file.txt'), 'agent-1 and user and agent-2\n');
    await observer.after?.({ ...event, state, result: 'ok' });

    expect(tracker.list('agent-a')).toEqual([{ path: 'file.txt', status: ' M', owner: 'mixed' }]);
  });

  it('临时 index 只包含 Agent 增量，并在提交后保留用户改动', async () => {
    const root = createRepo('a\nb\nc\n');
    writeFileSync(join(root, 'file.txt'), 'user-a\nb\nc\n');
    const tracker = new AgentChangeTracker(root);
    const observer = tracker.createObserver();
    const event = toolEvent('agent-a');
    const state = await observer.before?.(event);
    writeFileSync(join(root, 'file.txt'), 'user-a\nb\nagent-c\n');
    await observer.after?.({ ...event, state, result: 'ok' });

    const prepared = tracker.prepareIndex('agent-a');
    try {
      expect(git(root, ['show', ':file.txt'], prepared.indexPath)).toBe('a\nb\nagent-c\n');
      git(root, ['commit', '-m', 'agent change'], prepared.indexPath);
      prepared.finish();
    } finally {
      prepared.dispose();
    }

    expect(git(root, ['diff', '--', 'file.txt'])).toContain('-a');
    expect(git(root, ['diff', '--', 'file.txt'])).toContain('+user-a');
    expect(git(root, ['diff', '--cached', '--', 'file.txt'])).toBe('');
  });
});

function createRepo(content = 'base\n'): string {
  const root = mkdtempSync(join(tmpdir(), 'mica-change-tracker-test-'));
  tempDirs.push(root);
  git(root, ['init']);
  git(root, ['config', 'core.hooksPath', '/dev/null']);
  git(root, ['config', 'user.name', 'Mica Test']);
  git(root, ['config', 'user.email', 'mica@example.com']);
  writeFileSync(join(root, 'file.txt'), content);
  git(root, ['add', 'file.txt']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

function toolEvent(ownerId: string): ToolExecutionEvent {
  return {
    name: 'write_file',
    input: {},
    callbacks: { context: { agent: { taskOwnerId: ownerId } } },
    readOnly: false,
  };
}

function git(root: string, args: string[], indexPath?: string): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: indexPath ? { ...process.env, GIT_INDEX_FILE: indexPath } : process.env,
  });
}
