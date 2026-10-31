import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import * as gitHelpers from './git.js';
import { buildChangeSummary } from './summary.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it('summarizes many tiny untracked files with bounded Git work', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'mica-commit-summary-'));
  directories.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const paths = Array.from({ length: 80 }, (_, index) => `new-${index}.txt`);
  await Promise.all(paths.map((path) => writeFile(join(repo, path), 'new content\n')));
  const preview = vi.spyOn(gitHelpers, 'gitPreview');
  const started = performance.now();
  const summary = await buildChangeSummary(repo, paths.map((path) => `?? ${path}\0`).join(''));
  console.log(
    JSON.stringify({
      sample: '80 tiny untracked files',
      summaryMs: +(performance.now() - started).toFixed(2),
      gitPreviews: preview.mock.calls.length,
    }),
  );
  expect(summary).toContain('total files: 80');
  expect(summary).toContain('[untracked file sample]');
  expect(summary.length).toBeLessThanOrEqual(20_000);
  expect(preview.mock.calls.length).toBeLessThanOrEqual(4);
});

it('treats wildcard characters in a tracked filename literally', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'mica-commit-summary-'));
  directories.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  await writeFile(join(repo, 'literal*.txt'), 'original literal\n');
  await writeFile(join(repo, 'literal-other.txt'), 'original other\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  await writeFile(join(repo, 'literal*.txt'), 'updated literal\n');
  await writeFile(join(repo, 'literal-other.txt'), 'unrelated-content-canary\n');
  const summary = await buildChangeSummary(repo, ' M literal*.txt\0');
  const samples = summary.split('Compact diff samples:')[1];
  expect(samples).toContain('updated literal');
  expect(samples).not.toContain('unrelated-content-canary');
});

it('retains a bounded diff prefix when Git output exceeds its buffer', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'mica-commit-summary-'));
  directories.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  await writeFile(join(repo, 'large.txt'), 'visible-prefix\n' + 'ordinary source line\n'.repeat(100_000));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  const preview = await gitHelpers.gitPreview(['diff', '--cached', '--no-color'], repo, 32_000);
  expect(preview).toContain('visible-prefix');
  expect(preview).toContain('[git output truncated]');
  expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(32_128);
});
