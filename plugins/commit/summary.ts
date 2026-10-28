import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { safeGitAsync } from './git.js';

/**
 * 把工作区改动压成一段可以塞进一次请求的描述。
 *
 * 模型只需要判断「这是哪一类改动」，不需要完整 diff：
 * 变更文件清单 + diff stat + 每文件抽样的 hunk 已经够写出贴题的 message，
 * 而全量 diff 在真实仓库里轻易上兆，既贵又会被截断得没有结构。
 *
 * 抽样预算按文件优先级分配：锁文件、快照、构建产物先让位给真实源码。
 */

const MAX_SUMMARY_CHARS = 20_000;
const MAX_TOTAL_DIFF_CHARS = 12_000;
const MAX_DIFF_CHARS_PER_FILE = 2_500;
const MAX_CHANGED_FILES_LINES = 100;
const MAX_STAT_LINES = 80;
const MAX_NAME_STATUS_LINES = 120;
const MAX_UNTRACKED_FILE_CHARS = 16_000;
const MAX_DIFF_FILE_CONCURRENCY = 4;

export type ChangedFile = {
  status: string;
  path: string;
};

export async function buildChangeSummary(cwd: string, status: string): Promise<string> {
  const changedFiles = parsePorcelainStatus(status);

  const [stat, nameStatus, diffSamples] = await Promise.all([
    safeGitAsync(['diff', '--stat', '--no-color'], cwd).then(
      (value) => value || safeGitAsync(['diff', '--cached', '--stat', '--no-color'], cwd),
    ),
    Promise.all([
      safeGitAsync(['diff', '--name-status', '--no-color'], cwd),
      safeGitAsync(['diff', '--cached', '--name-status', '--no-color'], cwd),
    ]).then(([a, b]) => [a, b].filter(Boolean).join('\n').trim()),
    buildDiffSamples(cwd, changedFiles),
  ]);

  const summary = [
    'Git status summary:',
    summarizeStatus(changedFiles),
    '',
    'Changed files:',
    limitLines(
      changedFiles.map((file) => `${file.status.padEnd(2)} ${file.path}`).join('\n'),
      MAX_CHANGED_FILES_LINES,
      changedFiles.length,
    ),
    '',
    'Diff stat:',
    limitLines(stat.trim() || '(empty)', MAX_STAT_LINES),
    '',
    'Name status:',
    limitLines(nameStatus || '(empty)', MAX_NAME_STATUS_LINES),
    '',
    'Compact diff samples:',
    diffSamples || '(no diff samples)',
  ].join('\n');

  return truncate(summary, MAX_SUMMARY_CHARS);
}

/** `git status --porcelain=v1` 的每一行：前两列是状态码，后面是路径（改名取新路径）。 */
export function parsePorcelainStatus(status: string): ChangedFile[] {
  return status
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const rawPath = line.slice(3).trim();
      const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) || rawPath : rawPath;
      return { status: line.slice(0, 2), path };
    });
}

async function buildDiffSamples(cwd: string, files: ChangedFile[]): Promise<string> {
  let remaining = MAX_TOTAL_DIFF_CHARS;
  const sections: string[] = [];
  const prioritized = [...files].sort(
    (a, b) => Number(isLowValueDiffFile(a.path)) - Number(isLowValueDiffFile(b.path)),
  );

  for (let index = 0; index < prioritized.length && remaining > 0; index += MAX_DIFF_FILE_CONCURRENCY) {
    const batch = prioritized.slice(index, index + MAX_DIFF_FILE_CONCURRENCY);
    const diffs = await Promise.all(batch.map((file) => getCompactDiff(cwd, file)));

    for (let batchIndex = 0; batchIndex < batch.length; batchIndex++) {
      if (remaining <= 0) break;
      const file = batch[batchIndex]!;
      const diff = diffs[batchIndex] ?? '';
      if (!diff.trim()) continue;

      const sample = truncateByHunks(diff.trim(), Math.min(MAX_DIFF_CHARS_PER_FILE, remaining));
      sections.push(`--- ${file.path}\n${sample}`);
      remaining -= sample.length;
    }
  }

  if (remaining <= 0) sections.push('[diff sample budget exhausted]');
  return sections.join('\n\n');
}

async function getCompactDiff(cwd: string, file: ChangedFile): Promise<string> {
  if (isLowValueDiffFile(file.path)) return lowValueDiffSummary(cwd, file);
  const [stagedDiff, unstagedDiff, untrackedSample] = await Promise.all([
    safeGitAsync(['diff', '--cached', '--unified=0', '--no-color', '--', file.path], cwd),
    safeGitAsync(['diff', '--unified=0', '--no-color', '--', file.path], cwd),
    file.status === '??' ? readUntrackedFileSample(cwd, file.path) : Promise.resolve(''),
  ]);
  return [
    stagedDiff.trim() ? `[staged]\n${compactDiff(stagedDiff)}` : '',
    unstagedDiff.trim() ? `[unstaged]\n${compactDiff(unstagedDiff)}` : '',
    untrackedSample.trim() ? `[untracked file sample]\n${untrackedSample.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function isLowValueDiffFile(path: string): boolean {
  return (
    /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path) ||
    /\.(lock|snap|min\.(js|css)|map)$/i.test(path) ||
    /(^|\/)(dist|build|coverage|generated|__snapshots__)(\/|$)/.test(path)
  );
}

async function lowValueDiffSummary(cwd: string, file: ChangedFile): Promise<string> {
  const [statA, statB] = await Promise.all([
    safeGitAsync(['diff', '--stat', '--no-color', '--', file.path], cwd),
    safeGitAsync(['diff', '--cached', '--stat', '--no-color', '--', file.path], cwd),
  ]);
  const stat = statA || statB;
  return [`[low-value large/generated file: ${file.status.trim() || 'changed'}]`, stat.trim()]
    .filter(Boolean)
    .join('\n');
}

function compactDiff(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => {
      if (line.startsWith('diff --git ')) return false;
      if (line.startsWith('index ')) return false;
      if (line.startsWith('new file mode ')) return false;
      if (line.startsWith('deleted file mode ')) return false;
      if (line.startsWith('similarity index ')) return false;
      if (line.startsWith('rename from ') || line.startsWith('rename to ')) return true;
      if (line.startsWith('--- ') || line.startsWith('+++ ')) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function summarizeStatus(files: ChangedFile[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const key = normalizeStatus(file.status);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [
    `total files: ${files.length}`,
    ...[...counts.entries()].map(([status, count]) => `${status}: ${count}`),
  ].join('\n');
}

function normalizeStatus(status: string): string {
  if (status === '??') return 'untracked';
  if (status.includes('R')) return 'renamed';
  if (status.includes('A')) return 'added';
  if (status.includes('D')) return 'deleted';
  if (status.includes('M')) return 'modified';
  return status.trim() || 'changed';
}

function limitLines(text: string, maxLines: number, totalLinesOverride?: number): string {
  const lines = text.split('\n').filter(Boolean);
  const total = totalLinesOverride ?? lines.length;
  if (lines.length <= maxLines && total <= maxLines) return text;
  const visible = lines.slice(0, maxLines).join('\n');
  return `${visible}\n[omitted ${Math.max(0, total - maxLines)} lines]`;
}

function truncateByHunks(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const hunks = text.split(/(?=^@@ )/m);
  if (hunks.length <= 1) return truncate(text, maxChars);

  const selected: string[] = [];
  let remaining = maxChars;
  let omitted = 0;
  for (const hunk of hunks) {
    if (remaining <= 0) {
      omitted += 1;
      continue;
    }
    const sample = truncate(hunk.trim(), Math.min(remaining, Math.ceil(maxChars / Math.min(hunks.length, 4))));
    if (!sample) continue;
    selected.push(sample);
    remaining -= sample.length;
    if (sample.length < hunk.trim().length) omitted += 1;
  }

  const result = selected.join('\n');
  return omitted > 0 ? `${truncate(result, maxChars)}\n[omitted/truncated ${omitted} hunks]` : result;
}

function readUntrackedFileSample(cwd: string, path: string): Promise<string> {
  try {
    const absolute = resolve(cwd, path);
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > 512 * 1024) return Promise.resolve('');
    const content = readFileSync(absolute, 'utf-8').slice(0, MAX_UNTRACKED_FILE_CHARS);
    if (content.includes('\u0000')) return Promise.resolve('');
    return Promise.resolve(
      stat.size > MAX_UNTRACKED_FILE_CHARS
        ? `${content}\n[untracked file truncated ${stat.size - MAX_UNTRACKED_FILE_CHARS} bytes]`
        : content,
    );
  } catch {
    return Promise.resolve('');
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 80))}\n[truncated ${text.length - maxChars} chars]`;
}
