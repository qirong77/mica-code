import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadFileDiff, parseUnifiedDiff } from '../git/gitDiff.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('gitDiff', () => {
  it('把删除和新增行左右对齐', () => {
    const result = parseUnifiedDiff(
      ['diff --git a/file.ts b/file.ts', '@@ -1,3 +1,3 @@', ' same', '-old one', '-old two', '+new one', ' tail'].join(
        '\n',
      ),
    );

    expect(result.rows).toEqual([
      expect.objectContaining({ kind: 'hunk' }),
      expect.objectContaining({ leftLine: 1, rightLine: 1, leftText: 'same', rightText: 'same' }),
      expect.objectContaining({ leftLine: 2, rightLine: 2, leftText: 'old one', rightText: 'new one' }),
      expect.objectContaining({ leftLine: 3, rightLine: undefined, leftText: 'old two', rightText: '' }),
      expect.objectContaining({ leftLine: 4, rightLine: 3, leftText: 'tail', rightText: 'tail' }),
    ]);
  });

  it('为 MM 文件生成 staged 和 worktree 两个区块', () => {
    const root = createRepo();
    writeFileSync(join(root, 'file.txt'), 'staged\n');
    git(root, ['add', 'file.txt']);
    writeFileSync(join(root, 'file.txt'), 'worktree\n');

    const detail = loadFileDiff({ path: 'file.txt', status: 'MM', owner: 'agent' }, root);
    expect(detail.rows.filter((row) => row.kind === 'section').map((row) => row.leftText)).toEqual([
      'STAGED  HEAD',
      'WORKTREE  INDEX',
    ]);
    expect(detail.rows.some((row) => row.leftText === 'base' && row.rightText === 'staged')).toBe(true);
    expect(detail.rows.some((row) => row.leftText === 'staged' && row.rightText === 'worktree')).toBe(true);
  });

  it('把未跟踪文本文件显示为右侧新增', () => {
    const root = createRepo();
    writeFileSync(join(root, 'new.txt'), 'one\ntwo\n');
    const detail = loadFileDiff({ path: 'new.txt', status: '??', owner: 'other' }, root);
    expect(detail.rows.at(1)).toEqual(expect.objectContaining({ leftText: '', rightText: 'one', rightLine: 1 }));
    expect(detail.rows.at(2)).toEqual(expect.objectContaining({ leftText: '', rightText: 'two', rightLine: 2 }));
  });
});

function createRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'mica-git-diff-test-'));
  tempDirs.push(root);
  git(root, ['init']);
  git(root, ['config', 'core.hooksPath', '/dev/null']);
  git(root, ['config', 'user.name', 'Mica Test']);
  git(root, ['config', 'user.email', 'mica@example.com']);
  writeFileSync(join(root, 'file.txt'), 'base\n');
  git(root, ['add', 'file.txt']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
