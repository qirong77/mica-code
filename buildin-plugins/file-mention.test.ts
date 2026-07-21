import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { findFileMentions } from './file-mention.js';

const workspaces: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

describe('findFileMentions', () => {
  it('ranks filename fuzzy matches ahead of path-only matches', async () => {
    const workspace = await createWorkspace([
      'nested/src',
      'nested/srcHelper.ts',
      'nested/my-src-file.ts',
      'nested/searchHighlight.ts',
      'src/plain.ts',
    ]);

    const results = await findFileMentions(workspace, 'src');

    expect(results.map((item) => item.path)).toEqual([
      'nested/src',
      'nested/srcHelper.ts',
      'nested/my-src-file.ts',
      'nested/searchHighlight.ts',
      'src/plain.ts',
    ]);
    expect(results.find((item) => item.path === 'nested/searchHighlight.ts')).toMatchObject({
      label: 'nested/searchHighlight.ts',
      labelHighlights: [7, 10, 11],
    });
  });

  it('limits an exact directory path query to that directory tree', async () => {
    const workspace = await createWorkspace([
      'src/a/b/one.ts',
      'src/a/b/nested/two.ts',
      'src/a/b-other/wrong.ts',
      'src/a/c/b-match.ts',
      'other/src/a/b/wrong.ts',
    ]);

    const results = await findFileMentions(workspace, 'src/a/b');

    expect(results.map((item) => item.path)).toEqual(['src/a/b/one.ts', 'src/a/b/nested/two.ts']);
    expect(results.every((item) => item.label === item.path && item.description === undefined)).toBe(true);
  });

  it('matches a filename only inside the explicitly entered parent directory', async () => {
    const workspace = await createWorkspace([
      'src/a/b/one.ts',
      'src/a/b/other.ts',
      'src/a/b/nested/one-more.ts',
      'src/a/c/one.ts',
    ]);

    const results = await findFileMentions(workspace, 'src/a/b/on');

    expect(results.map((item) => item.path)).toEqual(['src/a/b/one.ts', 'src/a/b/nested/one-more.ts']);
  });

  it('returns a stable path order when the query is empty', async () => {
    const workspace = await createWorkspace(['z.ts', 'nested/b.ts', 'a.ts']);

    const results = await findFileMentions(workspace, '');

    expect(results.map((item) => item.path)).toEqual(['a.ts', 'z.ts', 'nested/b.ts']);
  });

  it('excludes gitignored files in a Git workspace', async () => {
    const workspace = await createWorkspace(['visible.ts', 'generated/ignored.ts']);
    await writeFile(join(workspace, '.gitignore'), 'generated/\n');
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });

    const results = await findFileMentions(workspace, '');

    expect(results.map((item) => item.path)).toContain('visible.ts');
    expect(results.map((item) => item.path)).not.toContain('generated/ignored.ts');
  });
});

async function createWorkspace(paths: string[]): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'mica-file-mentions-'));
  workspaces.push(workspace);
  for (const path of paths) {
    await mkdir(join(workspace, path, '..'), { recursive: true });
    await writeFile(join(workspace, path), '');
  }
  return workspace;
}
