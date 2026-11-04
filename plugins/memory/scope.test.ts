import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearRepoIdentityCache } from './repo.js';
import { contextScopes, resolveMemoryContext, scopeTitle } from './scope.js';

const tempDirs: string[] = [];

function makeRepo(name: string, markers: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), `mica-memory-scope-${name}-`));
  tempDirs.push(dir);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'config'), `[remote "origin"]\n  url = git@git.example.com:team/${name}.git\n`);
  for (const marker of markers) writeFileSync(join(dir, marker), '');
  return dir;
}

function makeMemoryRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-memory-scope-root-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => clearRepoIdentityCache());

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveMemoryContext', () => {
  it('defaults the write target to the repository the session is in', () => {
    const root = makeMemoryRoot();
    const repo = makeRepo('mica-code');
    const context = resolveMemoryContext(root, join(repo, 'apps/desktop'));
    expect(context.repo?.name).toBe('mica-code');
    expect(context.project).toEqual({ kind: 'project', repo: context.repo });
    expect(context.taskRepos).toEqual([]);
  });

  it('prefers the repository the task actually touched over the session directory', () => {
    const root = makeMemoryRoot();
    const cwdRepo = makeRepo('mis');
    const target = makeRepo('sass');
    const cwdContext = resolveMemoryContext(root, cwdRepo);
    const touched = { ...cwdContext.repo!, ...{ name: 'sass', root: target, slug: 'sass-11111111' } };
    const context = resolveMemoryContext(root, cwdRepo, [touched]);
    expect(context.repo?.name).toBe('mis');
    expect(context.taskRepos.map((repo) => repo.name)).toEqual(['sass']);
    expect(context.project).toEqual({ kind: 'project', repo: touched, note: '本次任务目标' });
    expect(context.repos.map((repo) => repo.name)).toEqual(['mis', 'sass']);
  });

  it('gives a project scope even when the session directory is not a repository', () => {
    const root = makeMemoryRoot();
    const bare = mkdtempSync(join(tmpdir(), 'mica-memory-bare-'));
    tempDirs.push(bare);
    const target = makeRepo('zuche-staff-service');
    const targetContext = resolveMemoryContext(root, target);
    const context = resolveMemoryContext(root, bare, [targetContext.repo!]);
    expect(context.repo).toBeNull();
    expect(context.project).toEqual({ kind: 'project', repo: targetContext.repo });
  });

  it('drops the session repository from the task list', () => {
    const root = makeMemoryRoot();
    const repo = makeRepo('mica-code');
    const context = resolveMemoryContext(root, repo);
    const same = resolveMemoryContext(root, repo, [context.repo!]);
    expect(same.taskRepos).toEqual([]);
  });

  it('matches a domain through the repository the task touched', () => {
    const root = makeMemoryRoot();
    mkdirSync(join(root, 'domains'), { recursive: true });
    const sass = makeRepo('sass');
    writeFileSync(join(root, 'domains', '租车.md'), `---\nmatch:\n  - ${sass}\n---\n\n- 灰度配置在 config/gray.json\n`);
    const bare = mkdtempSync(join(tmpdir(), 'mica-memory-bare-'));
    tempDirs.push(bare);
    const touched = resolveMemoryContext(root, sass).repo!;
    const context = resolveMemoryContext(root, bare, [touched]);
    expect(context.domains.map((domain) => domain.name)).toEqual(['租车']);
  });
});

describe('contextScopes', () => {
  it('shows the local directory name next to the shared repository name', () => {
    // 同一个上游仓库的多个 clone 共用一个 slug，名字取远端；目录名不同时一起显示，
    // 否则 `sass` 目录里开会话却看到「项目记忆 · zuche-ui-service」会让人以为写错了地方。
    const title = scopeTitle({
      kind: 'project',
      repo: {
        slug: 'x-1',
        name: 'zuche-ui-service',
        dirName: 'sass',
        root: '/r',
        key: 'k',
        remote: null,
        source: 'git',
      },
    });
    expect(title).toBe('项目记忆 · zuche-ui-service · sass');
  });

  it('injects the session repository, then the task target, then domains', () => {
    const root = makeMemoryRoot();
    mkdirSync(join(root, 'domains'), { recursive: true });
    const mis = makeRepo('mis');
    const sass = makeRepo('sass');
    writeFileSync(join(root, 'domains', '租车.md'), `---\nmatch:\n  - ${mis}\n  - ${sass}\n---\n\n- x\n`);
    const base = resolveMemoryContext(root, mis);
    const context = resolveMemoryContext(root, mis, [resolveMemoryContext(root, sass).repo!]);
    const kinds = contextScopes(context).map((scope) => scope.kind);
    expect(kinds).toEqual(['profile', 'project', 'project', 'domain']);
    expect(contextScopes(context)[0]).toEqual({ kind: 'profile' });
    const cwdScope = contextScopes(base)[1]!;
    expect(cwdScope.kind === 'project' ? cwdScope.repo.name : '').toBe('mis');
    expect(scopeTitle(cwdScope)).toContain('项目记忆 · mis');
  });

  it('labels only the first task repository as the target', () => {
    const root = makeMemoryRoot();
    const mis = makeRepo('mis');
    const sass = makeRepo('sass');
    const zuche = makeRepo('zuche-release');
    const context = resolveMemoryContext(root, mis, [
      resolveMemoryContext(root, sass).repo!,
      resolveMemoryContext(root, zuche).repo!,
    ]);
    const projects = contextScopes(context).filter((scope) => scope.kind === 'project');
    expect(projects.map((scope) => (scope.kind === 'project' ? scope.repo.name : ''))).toEqual([
      'mis',
      'sass',
      'zuche-release',
    ]);
    expect(projects.map((scope) => (scope.kind === 'project' ? scope.note : undefined))).toEqual([
      undefined,
      '本次任务目标',
      undefined,
    ]);
  });
});
