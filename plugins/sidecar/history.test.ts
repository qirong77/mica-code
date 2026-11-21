import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSessionHistory, turnsFromMessages } from './history.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-sidecar-history-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('turnsFromMessages', () => {
  it('opens a turn per user message and folds the answers into it', () => {
    const turns = turnsFromMessages([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: [{ type: 'text', text: '第二问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '第二答' }] },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.userInputs[0]?.text).toBe('第一问');
    expect(turns[0]?.text).toBe('第一答');
    expect(turns[1]?.text).toBe('第二答');
  });

  it('marks turns with unknown time instead of pretending they just happened', () => {
    const turns = turnsFromMessages([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }]);
    // 0 让 views 显示「—」：这些轮次发生在接管之前，编一个时间等于撒谎。
    expect(turns[0]?.startedAt).toBe(0);
    expect(turns[0]?.finishedAt).toBe(0);
  });

  it('keeps tool names so the history is not just prose', () => {
    const turns = turnsFromMessages([
      { role: 'user', content: '跑测试' },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'run_shell' }, { type: 'text', text: '跑完了' }] },
    ]);
    expect(turns[0]?.tools.map((tool) => tool.title)).toEqual(['run_shell']);
    expect(turns[0]?.text).toBe('跑完了');
  });

  it('skips notices: they are UI chatter, not conversation', () => {
    const turns = turnsFromMessages([
      { role: 'user', content: 'q' },
      { role: 'notice', content: '压缩完成' },
      { role: 'assistant', content: 'a' },
    ]);
    expect(turns[0]?.text).toBe('a');
    expect(turns[0]?.text).not.toContain('压缩');
  });

  it('starts a turn even when the transcript opens with an assistant message', () => {
    const turns = turnsFromMessages([{ role: 'assistant', content: '自说自话' }]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.userInputs).toEqual([]);
    expect(turns[0]?.text).toBe('自说自话');
  });
});

describe('readSessionHistory', () => {
  it('reads the persisted conversation of a session', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'abc.json'),
      JSON.stringify({
        version: 1,
        id: 'abc',
        title: '跑测试那条',
        cwd: '/repo/api',
        snapshot: {
          conversationMessages: [
            { role: 'user', content: '跑一遍' },
            { role: 'assistant', content: '三个用例失败' },
          ],
        },
      }),
    );
    const history = readSessionHistory('abc', dir);
    expect(history).toMatchObject({ id: 'abc', title: '跑测试那条', cwd: '/repo/api', totalTurns: 1 });
    expect(history?.turns[0]?.text).toBe('三个用例失败');
  });

  it('returns null for a session that never landed on disk', () => {
    // 第一轮结束前会话文件还不存在：attach 必须报「接不到」，而不是接一条空会话。
    expect(readSessionHistory('missing', tempDir())).toBeNull();
  });

  it('returns null instead of throwing on a corrupt file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    expect(readSessionHistory('broken', dir)).toBeNull();
  });
});
