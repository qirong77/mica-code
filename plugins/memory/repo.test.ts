import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearRepoIdentityCache, normalizeRemote, resolveRepoIdentity } from './repo.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-memory-repo-'));
  tempDirs.push(dir);
  return dir;
}

/** 造一个最小仓库：只有 `.git/config`，够身份解析用，不需要真的 git 二进制。 */
function makeRepo(root: string, remote?: string): void {
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(
    join(root, '.git', 'config'),
    ['[core]', '\trepositoryformatversion = 0', ...(remote ? ['[remote "origin"]', `\turl = ${remote}`] : []), ''].join(
      '\n',
    ),
    'utf-8',
  );
}

beforeEach(() => clearRepoIdentityCache());

afterEach(() => {
  clearRepoIdentityCache();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveRepoIdentity', () => {
  it('keys every directory of a repository to the same identity', () => {
    // 这是旧设计的核心缺陷：从仓库根开会话和从 apps/desktop 开会话各写一份记忆。
    const root = tempDir();
    makeRepo(root, 'git@git.example.com:team/mica-code.git');
    mkdirSync(join(root, 'apps', 'desktop'), { recursive: true });

    const atRoot = resolveRepoIdentity(root);
    const nested = resolveRepoIdentity(join(root, 'apps', 'desktop'));

    expect(atRoot).not.toBeNull();
    expect(nested?.slug).toBe(atRoot?.slug);
    expect(nested?.root).toBe(atRoot?.root);
  });

  it('treats two clones of the same remote as the same project', () => {
    const first = tempDir();
    const second = tempDir();
    makeRepo(first, 'https://git.example.com/team/mica-code.git');
    makeRepo(second, 'git@git.example.com:team/mica-code');

    expect(resolveRepoIdentity(first)?.slug).toBe(resolveRepoIdentity(second)?.slug);
  });

  it('keys a worktree to the repository it was cut from', () => {
    const main = tempDir();
    makeRepo(main, 'git@git.example.com:team/mica-code.git');
    const mainIdentity = resolveRepoIdentity(main)!;

    // worktree 的 `.git` 是文件，指向 `<main>/.git/worktrees/demand`，那里再写 commondir。
    const worktree = join(tempDir(), 'mica-code');
    mkdirSync(join(main, '.git', 'worktrees', 'demand'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'demand', 'commondir'), '../..\n', 'utf-8');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'demand')}\n`, 'utf-8');

    expect(resolveRepoIdentity(worktree)?.slug).toBe(mainIdentity.slug);
  });

  it('falls back to the repository path when there is no remote', () => {
    const root = tempDir();
    makeRepo(root);

    const identity = resolveRepoIdentity(root);
    expect(identity?.remote).toBeNull();
    expect(identity?.key).toContain('.git');
    expect(identity?.slug).toMatch(/-[0-9a-f]{8}$/);
  });

  it('returns null outside a repository', () => {
    const dir = tempDir();
    expect(resolveRepoIdentity(dir)).toBeNull();
    expect(resolveRepoIdentity(null)).toBeNull();
    expect(resolveRepoIdentity('')).toBeNull();
  });

  it('caches the answer per directory', () => {
    const root = tempDir();
    makeRepo(root, 'git@git.example.com:team/mica-code.git');
    const first = resolveRepoIdentity(root);
    writeFileSync(
      join(root, '.git', 'config'),
      '[remote "origin"]\n\turl = git@git.example.com:team/changed.git\n',
      'utf-8',
    );

    // 缓存是刻意的：会话中途改 remote 不该让注入的记忆换一份。
    expect(resolveRepoIdentity(root)).toBe(first);
    clearRepoIdentityCache();
    expect(resolveRepoIdentity(root)?.slug).not.toBe(first?.slug);
  });
});

describe('normalizeRemote', () => {
  it('collapses ssh, scp and https spellings to host/path', () => {
    const expected = 'git.example.com/team/mica-code';
    expect(normalizeRemote('git@git.example.com:team/mica-code.git')).toBe(expected);
    expect(normalizeRemote('ssh://git@git.example.com:22/team/mica-code.git')).toBe(expected);
    expect(normalizeRemote('https://git.example.com/team/mica-code')).toBe(expected);
    expect(normalizeRemote('https://user:token@git.example.com/team/mica-code.git')).toBe(expected);
  });

  it('keeps a local path usable as identity', () => {
    expect(normalizeRemote('/Users/someone/repos/mica.git')).toBe('/Users/someone/repos/mica');
  });
});
