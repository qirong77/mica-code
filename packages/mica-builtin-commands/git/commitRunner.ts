import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitText, gitTextAsync, safeGitText, safeGitTextAsync } from '@packages/mica-common/index.js';

const MAX_SUMMARY_CHARS = 20_000;
const MAX_TOTAL_DIFF_CHARS = 12_000;
const MAX_DIFF_CHARS_PER_FILE = 2_500;
const MAX_CHANGED_FILES_LINES = 100;
const MAX_STAT_LINES = 80;
const MAX_NAME_STATUS_LINES = 120;
const MAX_UNTRACKED_FILE_CHARS = 16_000;
const MAX_DIFF_FILE_CONCURRENCY = 4;

export const COMMIT_TYPES = [
  'feat: 新功能 ✨',
  'fix: 问题修复 🐛',
  'refactor: 重构 ♻️',
  'chore: 工程杂务 🔧',
  'docs: 文档 📝',
  'test: 测试 ✅',
  'perf: 性能优化 ⚡',
  'style: 代码样式 🎨',
  'build: 构建或依赖 📦',
  'ci: CI 配置 👷',
];

export type CommitMessageAgent = {
  createSubAgent(options?: { systemPrompt?: string | (() => string) }): {
    query(input: string): Promise<string>;
  };
};

export async function generateCommitMessage(agent: CommitMessageAgent, summary: string) {
  const subAgent = agent.createSubAgent({
    systemPrompt: [
      'You write concise git commit messages.',
      'Return only the commit message, with no markdown fences and no explanation.',
      `Choose exactly one format category from: ${COMMIT_TYPES.join(', ')}.`,
      'Use this subject format: type: 中文摘要 emoji',
      'Put only the plain type before the colon; put the emoji at the end.',
      'Examples:',
      'feat: 开发了提交插件 ✨',
      'fix: 修复模型配置读取失败 🐛',
      'refactor: 简化 agent 运行时配置 ♻️',
      'chore: 更新项目配置 🔧',
      'Keep the subject under 72 characters.',
      'Add a short Chinese body only if it materially clarifies multiple changes.',
      'Do not include step-by-step reasoning.',
    ].join('\n'),
  });

  const response = await subAgent.query(
    [
      'Create a git commit message for these changes.',
      'The diff is intentionally summarized and sampled, so infer conservatively.',
      '',
      summary,
    ].join('\n'),
  );

  return sanitizeCommitMessage(response);
}

export async function buildChangeSummary(status: string) {
  const changedFiles = parsePorcelainStatus(status);

  const [stat, nameStatus, diffSamples] = await Promise.all([
    safeGitTextAsync(['diff', '--stat', '--no-color']).then(
      (s) => s || safeGitTextAsync(['diff', '--cached', '--stat', '--no-color']),
    ),
    Promise.all([
      safeGitTextAsync(['diff', '--name-status', '--no-color']),
      safeGitTextAsync(['diff', '--cached', '--name-status', '--no-color']),
    ]).then(([a, b]) => [a, b].filter(Boolean).join('\n').trim()),
    buildDiffSamples(changedFiles),
  ]);

  const statusSummary = summarizeStatus(changedFiles);

  const summary = [
    'Git status summary:',
    statusSummary,
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

export function parsePorcelainStatus(status: string) {
  return status
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const rawPath = line.slice(3).trim();
      const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) || rawPath : rawPath;
      return {
        status: line.slice(0, 2),
        path,
      };
    });
}

export function hasUnmergedFiles(status: string) {
  return status
    .split('\n')
    .filter(Boolean)
    .some((line) => {
      const code = line.slice(0, 2);
      return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code);
    });
}

export function commitWithMessage(message: string, indexPath?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mica-commit-'));
  const messagePath = join(dir, 'message.txt');
  try {
    writeFileSync(messagePath, `${message.trim()}\n`, 'utf-8');
    if (indexPath) {
      execFileSync('git', ['commit', '-F', messagePath], {
        encoding: 'utf8',
        env: { ...process.env, GIT_INDEX_FILE: indexPath },
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } else {
      git(['commit', '-F', messagePath], 120_000);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function pushCurrentBranch() {
  const upstream = safeGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim();
  if (upstream) {
    await gitAsync(['push'], 120_000);
    return true;
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const remoteBranch = safeGit(['ls-remote', '--heads', 'origin', branch]).trim();
  if (!remoteBranch) {
    return false;
  }
  await gitAsync(['push', 'origin', branch], 120_000);
  return true;
}

export function git(args: string[], timeout = 30_000) {
  return gitText(args, { timeout });
}

export function safeGit(args: string[], timeout = 30_000) {
  return safeGitText(args, { timeout });
}

export async function gitAsync(args: string[], timeout = 30_000) {
  return gitTextAsync(args, { timeout });
}

async function buildDiffSamples(files: Array<{ status: string; path: string }>) {
  let remaining = MAX_TOTAL_DIFF_CHARS;
  const sections: string[] = [];
  const prioritized = prioritizeFilesForDiff(files);

  for (let index = 0; index < prioritized.length && remaining > 0; index += MAX_DIFF_FILE_CONCURRENCY) {
    const batch = prioritized.slice(index, index + MAX_DIFF_FILE_CONCURRENCY);
    const diffs = await Promise.all(batch.map((file) => getCompactDiff(file)));

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

  if (remaining <= 0) {
    sections.push('[diff sample budget exhausted]');
  }

  return sections.join('\n\n');
}

async function getCompactDiff(file: { status: string; path: string }) {
  if (isLowValueDiffFile(file.path)) return lowValueDiffSummary(file);
  const [stagedDiff, unstagedDiff, untrackedSample] = await Promise.all([
    safeGitTextAsync(['diff', '--cached', '--unified=0', '--no-color', '--', file.path]),
    safeGitTextAsync(['diff', '--unified=0', '--no-color', '--', file.path]),
    file.status === '??' ? readUntrackedFileSample(file.path) : Promise.resolve(''),
  ]);
  return [
    stagedDiff.trim() ? `[staged]\n${compactDiff(stagedDiff)}` : '',
    unstagedDiff.trim() ? `[unstaged]\n${compactDiff(unstagedDiff)}` : '',
    untrackedSample.trim() ? `[untracked file sample]\n${untrackedSample.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function prioritizeFilesForDiff(files: Array<{ status: string; path: string }>) {
  return [...files].sort((a, b) => Number(isLowValueDiffFile(a.path)) - Number(isLowValueDiffFile(b.path)));
}

function isLowValueDiffFile(path: string) {
  return (
    /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path) ||
    /\.(lock|snap|min\.(js|css)|map)$/i.test(path) ||
    /(^|\/)(dist|build|coverage|generated|__snapshots__)(\/|$)/.test(path)
  );
}

async function lowValueDiffSummary(file: { status: string; path: string }) {
  const [statA, statB] = await Promise.all([
    safeGitTextAsync(['diff', '--stat', '--no-color', '--', file.path]),
    safeGitTextAsync(['diff', '--cached', '--stat', '--no-color', '--', file.path]),
  ]);
  const stat = statA || statB;
  return [`[low-value large/generated file: ${file.status.trim() || 'changed'}]`, stat.trim()]
    .filter(Boolean)
    .join('\n');
}

function compactDiff(diff: string) {
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

function sanitizeCommitMessage(response: string) {
  const lines = response
    .replace(/^```(?:\w+)?\s*/g, '')
    .replace(/```\s*$/g, '')
    .split('\n')
    .map((line) => line.trimEnd());

  while (lines.length && !lines[0]?.trim()) lines.shift();
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();

  const message = lines.join('\n').trim();
  if (!message) return 'chore: 更新项目文件 🔧';
  return message;
}

function summarizeStatus(files: Array<{ status: string; path: string }>) {
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

function normalizeStatus(status: string) {
  if (status === '??') return 'untracked';
  if (status.includes('R')) return 'renamed';
  if (status.includes('A')) return 'added';
  if (status.includes('D')) return 'deleted';
  if (status.includes('M')) return 'modified';
  return status.trim() || 'changed';
}

function limitLines(text: string, maxLines: number, totalLinesOverride?: number) {
  const lines = text.split('\n').filter(Boolean);
  const total = totalLinesOverride ?? lines.length;
  if (lines.length <= maxLines && total <= maxLines) return text;
  const visible = lines.slice(0, maxLines).join('\n');
  return `${visible}\n[omitted ${Math.max(0, total - maxLines)} lines]`;
}

function truncateByHunks(text: string, maxChars: number) {
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

function readUntrackedFileSample(path: string) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 512 * 1024) return '';
    const content = readFileSync(path, 'utf-8').slice(0, MAX_UNTRACKED_FILE_CHARS);
    if (content.includes('\u0000')) return '';
    return stat.size > MAX_UNTRACKED_FILE_CHARS
      ? `${content}\n[untracked file truncated ${stat.size - MAX_UNTRACKED_FILE_CHARS} bytes]`
      : content;
  } catch {
    return '';
  }
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 80))}\n[truncated ${text.length - maxChars} chars]`;
}
