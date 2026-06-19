import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { micaUI } from '../../packages/mica-ui/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { logRuntime } from '../../packages/mica-logger/index.js';

const MAX_TOTAL_DIFF_CHARS = 18_000;
const MAX_DIFF_CHARS_PER_FILE = 3_000;
const COMMIT_TYPES = [
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

export function registerCommitPlugin(agent: AgentRuntime) {
  return {
    name: 'commit',
    description: '分析当前 git 变化，生成提交信息，提交并推送',
    action: () => {
      logRuntime('plugin.commit', 'requested');
      void runCommit(agent);
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}

const STATUS_ID = 'commit-status';

function setStatusMessage(text: string) {
  micaUI.messageBar.removeMessage(STATUS_ID);
  micaUI.messageBar.addMessage({ id: STATUS_ID, text });
}

function clearStatusMessage() {
  setTimeout(() => micaUI.messageBar.removeMessage(STATUS_ID), 5000);
}

function showTerminalMessage(text: string) {
  micaUI.messageBar.removeMessage(STATUS_ID);
  const id = `commit-msg-${Date.now()}`;
  micaUI.messageBar.addMessage({ id, text });
  setTimeout(() => micaUI.messageBar.removeMessage(id), 5000);
}

async function runCommit(agent: AgentRuntime) {
  try {
    logRuntime('plugin.commit', 'start');
    setStatusMessage('commit: 正在分析 git 变化...');

    const status = git(['status', '--porcelain=v1']);
    logRuntime('plugin.commit', 'status:loaded', { files: parsePorcelainStatus(status).length });
    if (!status.trim()) {
      logRuntime('plugin.commit', 'status:empty');
      showTerminalMessage('commit: 没有可提交的变化');
      return;
    }
    if (hasUnmergedFiles(status)) {
      logRuntime('plugin.commit', 'blocked:unmerged_files', undefined, 'warn');
      showTerminalMessage('commit: 存在未解决冲突，请先处理');
      return;
    }

    const summary = buildChangeSummary(status);
    logRuntime('plugin.commit', 'summary:built', { chars: summary.length });
    const commitMessage = await generateCommitMessage(agent, summary);
    logRuntime('plugin.commit', 'message:generated', { firstLine: firstLine(commitMessage) });

    setStatusMessage(`commit: ${firstLine(commitMessage)}`);
    git(['add', '-A']);
    logRuntime('plugin.commit', 'git:add_done');

    const stagedStatus = git(['diff', '--cached', '--name-only']);
    if (!stagedStatus.trim()) {
      logRuntime('plugin.commit', 'blocked:no_staged_changes', undefined, 'warn');
      showTerminalMessage('commit: git add 后没有 staged 变化');
      return;
    }
    logRuntime('plugin.commit', 'staged:ready', { files: stagedStatus.trim().split('\n').filter(Boolean).length });

    commitWithMessage(commitMessage);
    const commitHash = git(['rev-parse', '--short', 'HEAD']).trim();
    logRuntime('plugin.commit', 'git:commit_done', { commit: commitHash });

    setStatusMessage(`commit: 已提交 ${commitHash}(${commitMessage})，正在 push...`);
    const pushed = pushCurrentBranch();
    setStatusMessage(
      pushed
        ? `commit: 已提交并推送 ${commitHash}(${commitMessage})`
        : `commit: 已提交 ${commitHash}，未找到远程分支，已跳过 push`,
    );
    clearStatusMessage();
    logRuntime('plugin.commit', pushed ? 'push:done' : 'push:skipped_no_remote_branch', { commit: commitHash });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logRuntime('plugin.commit', 'error', { message }, 'error');
    showTerminalMessage(`commit failed: ${message}`);
  }
}

function buildChangeSummary(status: string) {
  const changedFiles = parsePorcelainStatus(status);
  logRuntime('plugin.commit', 'changes:parsed', { files: changedFiles.length });
  const stat = safeGit(['diff', '--stat']) || safeGit(['diff', '--cached', '--stat']);
  const nameStatus = [safeGit(['diff', '--name-status']), safeGit(['diff', '--cached', '--name-status'])]
    .filter(Boolean)
    .join('\n')
    .trim();
  const diffSamples = buildDiffSamples(changedFiles);

  return [
    'Git status:',
    status.trim(),
    '',
    'Changed files:',
    changedFiles.map((file) => `${file.status.padEnd(2)} ${file.path}`).join('\n'),
    '',
    'Diff stat:',
    stat.trim() || '(empty)',
    '',
    'Name status:',
    nameStatus || '(empty)',
    '',
    'Bounded diff samples:',
    diffSamples || '(no diff samples)',
  ].join('\n');
}

async function generateCommitMessage(agent: AgentRuntime, summary: string) {
  logRuntime('plugin.commit', 'message:generate_start', { summaryChars: summary.length });
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

function buildDiffSamples(files: Array<{ status: string; path: string }>) {
  let remaining = MAX_TOTAL_DIFF_CHARS;
  const sections: string[] = [];

  for (const file of files) {
    if (remaining <= 0) break;
    const diff =
      safeGit(['diff', '--', file.path]) ||
      safeGit(['diff', '--cached', '--', file.path]) ||
      (file.status === '??' ? readUntrackedFileSample(file.path) : '');
    if (!diff.trim()) continue;

    const sample = truncate(diff.trim(), Math.min(MAX_DIFF_CHARS_PER_FILE, remaining));
    sections.push(`--- ${file.path}\n${sample}`);
    remaining -= sample.length;
    logRuntime('plugin.commit', 'diff:sampled', { file: file.path, chars: sample.length });
  }

  if (remaining <= 0) {
    sections.push('[diff sample budget exhausted]');
    logRuntime('plugin.commit', 'diff:budget_exhausted', undefined, 'warn');
  }

  return sections.join('\n\n');
}

function parsePorcelainStatus(status: string) {
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

function hasUnmergedFiles(status: string) {
  return status
    .split('\n')
    .filter(Boolean)
    .some((line) => {
      const code = line.slice(0, 2);
      return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code);
    });
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

function readUntrackedFileSample(path: string) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 512 * 1024) return '';
    const content = readFileSync(path, 'utf-8');
    if (content.includes('\u0000')) return '';
    return content;
  } catch {
    return '';
  }
}

function commitWithMessage(message: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mica-commit-'));
  const messagePath = join(dir, 'message.txt');
  try {
    writeFileSync(messagePath, `${message.trim()}\n`, 'utf-8');
    logRuntime('plugin.commit', 'git:commit_start', { firstLine: firstLine(message) });
    git(['commit', '-F', messagePath], 120_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function pushCurrentBranch() {
  const upstream = safeGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim();
  if (upstream) {
    logRuntime('plugin.commit', 'push:start', { upstream });
    git(['push'], 120_000);
    return true;
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const remoteBranch = safeGit(['ls-remote', '--heads', 'origin', branch]).trim();
  if (!remoteBranch) {
    logRuntime('plugin.commit', 'push:skip_no_remote_branch', { branch }, 'warn');
    return false;
  }

  logRuntime('plugin.commit', 'push:start', { branch, remote: 'origin' });
  git(['push', 'origin', branch], 120_000);
  return true;
}

function git(args: string[], timeout = 30_000) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf-8',
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(formatExecError(error));
  }
}

function safeGit(args: string[], timeout = 30_000) {
  try {
    return git(args, timeout);
  } catch {
    return '';
  }
}

function formatExecError(error: unknown) {
  if (!error || typeof error !== 'object') return String(error);
  const err = error as {
    message?: string;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
  };
  const stderr = bufferToString(err.stderr).trim();
  const stdout = bufferToString(err.stdout).trim();
  return stderr || stdout || err.message || String(error);
}

function bufferToString(value: Buffer | string | undefined) {
  if (!value) return '';
  return Buffer.isBuffer(value) ? value.toString('utf-8') : value;
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 80))}\n[truncated ${text.length - maxChars} chars]`;
}

function firstLine(text: string) {
  return (
    text
      .split('\n')
      .find((line) => line.trim())
      ?.trim() || '(empty)'
  );
}
