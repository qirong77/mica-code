import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_TOUCHED_REPOS,
  TouchedRepoIndex,
  extractPathCandidates,
  injectionRepos,
  weightForTool,
} from './activity.js';
import { clearRepoIdentityCache, type RepoIdentity } from './repo.js';

const tempDirs: string[] = [];

function makeRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mica-memory-${name}-`));
  tempDirs.push(dir);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'config'), `[remote "origin"]\n  url = git@git.example.com:team/${name}.git\n`);
  mkdirSync(join(dir, 'src'), { recursive: true });
  return dir;
}

beforeEach(() => clearRepoIdentityCache());

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('extractPathCandidates', () => {
  it('collects absolute paths from tool arguments', () => {
    const paths = extractPathCandidates('read_file', JSON.stringify({ file_path: '/repo/a/src/app.ts' }));
    expect(paths).toContain('/repo/a/src/app.ts');
  });

  it('strips line and column suffixes', () => {
    const paths = extractPathCandidates('grep_search', JSON.stringify({ path: '/repo/a/src/app.ts:12:3' }));
    expect(paths).toContain('/repo/a/src/app.ts');
  });

  it('reads file paths out of an apply_patch body', () => {
    const patch = ['*** Begin Patch', '*** Update File: /repo/a/src/one.ts', '@@', '*** Add File: ~/b/two.ts'].join(
      '\n',
    );
    expect(extractPathCandidates('apply_patch', patch)).toEqual(['/repo/a/src/one.ts', '~/b/two.ts']);
  });

  it('follows `cd` inside a shell command', () => {
    const args = JSON.stringify({ command: 'cd ~/Desktop/sass && bun run test' });
    expect(extractPathCandidates('run_shell', args)).toContain('~/Desktop/sass');
  });

  it('ignores URLs and relative paths', () => {
    const args = JSON.stringify({ url: 'https://example.com/a/b', path: 'src/app.ts' });
    expect(extractPathCandidates('read_file', args)).toEqual([]);
  });

  it('survives arguments that are not JSON', () => {
    expect(extractPathCandidates('custom_tool', 'not json at all /repo/a/b.ts')).toEqual(['/repo/a/b.ts']);
  });
});

describe('weightForTool', () => {
  it('ranks writes above shell above reads', () => {
    expect(weightForTool('write_file')).toBeGreaterThan(weightForTool('read_file'));
    expect(weightForTool('run_shell')).toBeGreaterThan(weightForTool('read_file'));
  });
});

describe('TouchedRepoIndex', () => {
  it('does not promote a repository that was only read once', () => {
    const repo = makeRepo('sass');
    const index = new TouchedRepoIndex();
    index.observe('s1', 'read_file', JSON.stringify({ file_path: join(repo, 'src/app.ts') }));
    const entries = index.list('s1');
    expect(entries).toHaveLength(1);
    // 只读过一次：不注入，但也不会被当成目标仓库写进去。
    expect(injectionRepos(entries, null)).toEqual([]);
  });

  it('promotes a repository that is actually being written', () => {
    const repo = makeRepo('sass');
    const index = new TouchedRepoIndex();
    index.observe('s1', 'write_file', JSON.stringify({ file_path: join(repo, 'src/app.ts') }));
    const entries = index.list('s1');
    expect(injectionRepos(entries, null).map((candidate) => candidate.name)).toEqual(['sass']);
    expect(index.primary('s1')?.name).toBe('sass');
  });

  it('accumulates weight across calls and separates sessions', () => {
    const first = makeRepo('alpha');
    const second = makeRepo('beta');

    const index = new TouchedRepoIndex();
    index.observe('s1', 'read_file', JSON.stringify({ file_path: join(first, 'src/a.ts') }));
    index.observe('s1', 'read_file', JSON.stringify({ file_path: join(first, 'src/b.ts') }));
    index.observe('s2', 'write_file', JSON.stringify({ file_path: join(second, 'src/c.ts') }));
    expect(index.list('s1')).toHaveLength(1);
    expect(index.list('s2').map((entry) => entry.repo.name)).toEqual(['beta']);
    expect(index.list('s1')[0]!.weight).toBe(2);
  });

  it('excludes the session repository from extra injection targets', () => {
    const repo = makeRepo('mica');
    const index = new TouchedRepoIndex();
    index.observe('s1', 'write_file', JSON.stringify({ file_path: join(repo, 'src/a.ts') }));
    const cwdRepo = index.list('s1')[0]!.repo;
    expect(injectionRepos(index.list('s1'), cwdRepo)).toEqual([]);
  });

  it('caps how many repositories it remembers', () => {
    const index = new TouchedRepoIndex();
    for (let i = 0; i < MAX_TOUCHED_REPOS + 4; i += 1) {
      const repo = makeRepo(`many-${i}`);
      index.observe('s1', 'write_file', JSON.stringify({ file_path: join(repo, 'src/a.ts') }));
    }
    expect(index.list('s1')).toHaveLength(MAX_TOUCHED_REPOS);
  });

  it('ignores paths that resolve to the home directory', () => {
    const index = new TouchedRepoIndex();
    index.observe('s1', 'write_file', JSON.stringify({ file_path: join(homedir(), 'notes.md') }));
    expect(index.list('s1')).toEqual([]);
  });

  it('resolves repositories for files that do not exist yet', () => {
    const repo = makeRepo('greenfield');
    const index = new TouchedRepoIndex();
    index.observe('s1', 'write_file', JSON.stringify({ file_path: join(repo, 'src/not-created-yet.ts') }));
    expect(index.primary('s1')?.name).toBe('greenfield');
  });

  it('clears state per owner', () => {
    const repo = makeRepo('gamma');
    const index = new TouchedRepoIndex();
    index.observe('s1', 'write_file', JSON.stringify({ file_path: join(repo, 'src/a.ts') }));
    index.clear('s1');
    expect(index.list('s1')).toEqual([]);
  });
});

describe('injectionRepos', () => {
  const repo = (name: string): RepoIdentity => ({
    slug: `${name}-00000000`,
    name,
    root: `/repos/${name}`,
    key: `git.example.com/team/${name}`,
    remote: `git.example.com/team/${name}`,
    source: 'git',
  });

  it('keeps at most two extra repositories, strongest first', () => {
    const entries = [
      { repo: repo('one'), weight: 9, lastAt: 1 },
      { repo: repo('two'), weight: 5, lastAt: 2 },
      { repo: repo('three'), weight: 4, lastAt: 3 },
    ];
    expect(injectionRepos(entries, null).map((candidate) => candidate.name)).toEqual(['one', 'two']);
  });
});
