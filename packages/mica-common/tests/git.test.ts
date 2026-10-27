import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitText } from '../git.js';

const snapshot = (file: string) => readFileSync(file).toString('base64');

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-common-git-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  gitText(['add', '--', 'a.txt'], { cwd: dir });
  gitText(['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

describe('gitText', () => {
  let dir: string;

  beforeEach(() => {
    dir = repo();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // 读命令必须抑制 git 的「可选锁」：`git status` 默认会刷新索引并写回磁盘（占一次
  // `.git/index.lock`），agent 每改文件都要跑它，会和用户在桌面端点下的暂存 / 放弃
  // 更改抢锁。写操作必需的锁不受影响（下面的 add 断言顺带锁住这一点）。
  it('does not write the index back while reading', () => {
    const index = join(dir, '.git', 'index');

    // 走 gitText 的读命令原封不动。
    writeFileSync(join(dir, 'a.txt'), 'three\n');
    const stale = snapshot(index);
    expect(gitText(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: dir })).toContain('a.txt');
    expect(snapshot(index)).toBe(stale);

    // 写操作照旧落盘（可选锁被关掉不影响必需的锁）。
    gitText(['add', '--', 'a.txt'], { cwd: dir });
    expect(snapshot(index)).not.toBe(stale);
  });

  // 这个变量只有真的进了子进程才有用。以前这里靠「不带 GIT_OPTIONAL_LOCKS=0 的 status
  // 会写回刷新后的索引」做对照，但 git 2.50（Apple Git-155）起读命令不再写索引了，
  // 对照在本地恒失败；直接看子进程拿到什么，才和 git 版本无关。
  it('passes GIT_OPTIONAL_LOCKS=0 to the git child process', () => {
    const bin = mkdtempSync(join(tmpdir(), 'mica-common-git-bin-'));
    const out = join(bin, 'locks.txt');
    const fakeGit = join(bin, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\nprintf %s "${GIT_OPTIONAL_LOCKS-unset}" > "$MICA_GIT_LOCKS_OUT"\n');
    chmodSync(fakeGit, 0o755);
    const previousPath = process.env.PATH;
    const previousOut = process.env.MICA_GIT_LOCKS_OUT;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    process.env.MICA_GIT_LOCKS_OUT = out;
    try {
      gitText(['status', '--porcelain']);
      expect(readFileSync(out, 'utf-8')).toBe('0');

      // 对照：同一个假 git，不经 gitText 调用时拿不到这个变量。
      const ambient = { ...process.env };
      delete ambient.GIT_OPTIONAL_LOCKS;
      execFileSync('git', ['status', '--porcelain'], { env: ambient });
      expect(readFileSync(out, 'utf-8')).toBe('unset');
    } finally {
      process.env.PATH = previousPath;
      if (previousOut === undefined) delete process.env.MICA_GIT_LOCKS_OUT;
      else process.env.MICA_GIT_LOCKS_OUT = previousOut;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
