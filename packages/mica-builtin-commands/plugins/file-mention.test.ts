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
  it('renders basename as label and full path as description in a stable order', async () => {
    const workspace = await createWorkspace(['a.ts', 'src/plain.ts', 'src/utils/fuzzy.ts']);

    const results = await findFileMentions(workspace, '');

    expect(results.map((item) => item.path)).toEqual(['a.ts', 'src/plain.ts', 'src/utils/fuzzy.ts']);
    expect(results[0]).toMatchObject({ label: 'a.ts', description: 'a.ts' });
    expect(results[1]).toMatchObject({ label: 'plain.ts', description: 'src/plain.ts' });
    expect(results[2]).toMatchObject({ label: 'fuzzy.ts', description: 'src/utils/fuzzy.ts' });
  });

  it('grades base-name matches ahead of path-only matches', async () => {
    const workspace = await createWorkspace([
      'node-api/server.ts',
      'packages/node-sdk/index.ts',
      'src/node/api.ts',
      'src/mynode/helper.ts',
      'src/other.ts',
    ]);

    const results = await findFileMentions(workspace, 'node');

    const paths = results.map((item) => item.path);
    expect(paths).toContain('src/node/api.ts');
    expect(paths).toContain('node-api/server.ts');
    expect(paths).toContain('packages/node-sdk/index.ts');
    expect(paths).toContain('src/mynode/helper.ts');
    expect(paths).not.toContain('src/other.ts');
    // Non-directory entries keep a plain basename; directory entries carry a
    // trailing slash so they render as `node/` (mirrors kimi-code).
    expect(
      results
        .filter((item) => !item.path.endsWith('/'))
        .every((item) => item.label === item.path.split('/').pop()),
    ).toBe(true);
  });

  it('surfaces directories ahead of path-only file matches', async () => {
    const workspace = await createWorkspace([
      'docs/architecture.astro',
      'docs/readme.md',
      'packages/ink/docs/08-keybindings.md',
      'src/doc-like.ts',
    ]);

    const results = await findFileMentions(workspace, 'doc');

    // Directories whose base name matches rank first (score = 80 + 10).
    expect(results[0]?.label).toBe('docs/');
    expect(results[1]?.label).toBe('docs/');
    // They are distinct directories, each shown as a `docs/` entry with its own full path.
    expect(results[0]?.description).toBe('docs');
    expect(results[1]?.description).toBe('packages/ink/docs');
    // Files that only match via their path come after the directories.
    expect(results.some((item) => item.path === 'docs/architecture.astro')).toBe(true);
    expect(results.some((item) => item.path === 'docs/readme.md')).toBe(true);
  });

  it('does not surface files whose path only contains out-of-order query letters', async () => {
    const workspace = await createWorkspace([
      'file_type_ai.svg',
      'docs/readme.md',
      'src/DocsLayout.astro',
      'src/other.ts',
    ]);

    const results = await findFileMentions(workspace, 'doc');

    const paths = results.map((item) => item.path);
    expect(paths).toContain('docs/readme.md');
    expect(paths).toContain('src/DocsLayout.astro');
    expect(paths).not.toContain('file_type_ai.svg');
    expect(paths).not.toContain('src/other.ts');
  });

  it('fuzzy-matches a path with slashes against the file path', async () => {
    const workspace = await createWorkspace([
      'src/a/b/one.ts',
      'src/a/b/nested/two.ts',
      'src/a/b-other/wrong.ts',
      'other/src/a/b/wrong.ts',
    ]);

    const results = await findFileMentions(workspace, 'src/a/b');

    const paths = results.map((item) => item.path);
    expect(paths).toContain('src/a/b/one.ts');
    expect(paths).toContain('src/a/b/nested/two.ts');
    expect(paths).toContain('src/a/b-other/wrong.ts');
    expect(paths).toContain('other/src/a/b/wrong.ts');
  });

  it('highlights the matched part of the basename', async () => {
    const workspace = await createWorkspace(['src/one.ts']);

    const results = await findFileMentions(workspace, 'one');

    expect(results.find((item) => item.path === 'src/one.ts')).toMatchObject({
      label: 'one.ts',
      labelHighlights: [0, 1, 2],
    });
  });

  it('includes gitignored files in a Git workspace', async () => {
    const workspace = await createWorkspace(['visible.ts', 'generated/ignored.ts']);
    await writeFile(join(workspace, '.gitignore'), 'generated/\n');
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });

    const results = await findFileMentions(workspace, '');

    expect(results.map((item) => item.path)).toContain('visible.ts');
    expect(results.map((item) => item.path)).toContain('generated/ignored.ts');
  });

  it('filters ignored build directories in a Git workspace', async () => {
    const workspace = await createWorkspace([
      'visible.ts',
      'node_modules/pkg/index.js',
      'dist/bundle.js',
      'src/app.ts',
    ]);
    await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });

    const results = await findFileMentions(workspace, '');

    expect(results.map((item) => item.path)).toEqual(['src/app.ts', 'visible.ts']);
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
