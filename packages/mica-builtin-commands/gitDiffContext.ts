import { readFileSync, statSync } from 'node:fs';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices } from './services.js';
import { formatExecError, gitText } from '@packages/mica-common/index.js';

const DEFAULT_BASE_BRANCH = 'master';
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024;
const MAX_UNTRACKED_TOTAL_CHARS = 80_000;

export function createGitDiffContextCommand(services: CommandRuntimeServices) {
  return {
    name: 'git-diff-context',
    description: '将 git diff 作为上下文发送给 agent，默认对比 master，传 - 使用当前工作区变化',
    action: (arg?: string) => {
      runGitDiffContext(services, resolveDiffTarget(arg));
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function runGitDiffContext(services: CommandRuntimeServices, target: DiffTarget) {
  try {
    micaLogger.logRuntime('plugin.git-diff-context', 'start', target);
    const branch = getCurrentBranch();
    micaLogger.logRuntime('plugin.git-diff-context', 'branch:detected', { branch });

    const context = loadDiffContext(target);
    micaLogger.logRuntime('plugin.git-diff-context', 'diff:loaded', {
      target: context.label,
      chars: context.diff.length,
    });

    if (!context.diff) {
      micaLogger.logRuntime('plugin.git-diff-context', 'diff:empty', { branch, target: context.label });
      services.showMessage(context.emptyMessage(branch), 5000);
      return;
    }

    const message = buildMessage(branch, context);
    micaUi.terminalInput.submit(message, { displayText: buildDisplayMessage(branch, context) });
    micaLogger.logRuntime('plugin.git-diff-context', 'submitted', {
      branch,
      target: context.label,
      chars: message.length,
    });
  } catch (error) {
    const msg = formatExecError(error);
    micaLogger.logRuntime('plugin.git-diff-context', 'error', { message: msg }, 'error');
    services.showMessage(`git diff failed: ${msg}`, 5000);
  }
}

type DiffTarget = { type: 'current' } | { type: 'base'; baseBranch: string };

type DiffContext = {
  diff: string;
  label: string;
  promptLead: (branch: string) => string;
  emptyMessage: (branch: string) => string;
};

export function getCurrentBranch(): string {
  return gitText(['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 }).trim();
}

function resolveDiffTarget(arg?: string): DiffTarget {
  const firstArg = arg?.trim().split(/\s+/)[0];
  if (firstArg === '-') return { type: 'current' };
  const baseBranch = firstArg || DEFAULT_BASE_BRANCH;
  return { type: 'base', baseBranch };
}

function loadDiffContext(target: DiffTarget): DiffContext {
  return target.type === 'current' ? loadCurrentGitChangesContext() : loadDiffFromBase(target.baseBranch);
}

function loadCurrentGitChangesContext(): DiffContext {
  const diff = loadCurrentGitChanges();
  return {
    diff,
    label: 'current git changes',
    promptLead: (branch) => `Give me a summary. Here are the current git changes on branch \`${branch}\`:`,
    emptyMessage: (branch) => `branch ${branch} has no current git changes`,
  };
}

export function loadCurrentGitChanges(options: { includeUntracked?: boolean } = {}): string {
  const stagedDiff = gitText(['diff', '--cached'], { timeout: 10000 }).trim();
  const unstagedDiff = gitText(['diff'], { timeout: 10000 }).trim();
  return [
    stagedDiff ? `# Staged changes\n${stagedDiff}` : '',
    unstagedDiff ? `# Unstaged changes\n${unstagedDiff}` : '',
    options.includeUntracked ? loadUntrackedGitChanges() : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function loadUntrackedGitChanges(): string {
  const paths = gitText(['ls-files', '--others', '--exclude-standard', '-z'], { timeout: 10000 })
    .split('\0')
    .filter(Boolean);
  const sections: string[] = [];
  let remainingChars = MAX_UNTRACKED_TOTAL_CHARS;

  for (const path of paths) {
    if (remainingChars <= 0) break;
    const section = formatUntrackedFileDiff(path, remainingChars);
    if (!section) continue;
    sections.push(section);
    remainingChars -= section.length;
  }

  return sections.length ? `# Untracked files\n${sections.join('\n\n')}` : '';
}

function formatUntrackedFileDiff(path: string, maxChars: number): string | null {
  const stats = statSync(path);
  if (!stats.isFile()) return null;
  const content = stats.size > MAX_UNTRACKED_FILE_BYTES ? null : readFileSync(path);
  const body = content ? formatUntrackedFileBody(content, maxChars) : '+[untracked file omitted: file too large]';
  return [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, body].join('\n');
}

function formatUntrackedFileBody(content: Buffer, maxChars: number): string {
  if (content.includes(0)) return '+[untracked file omitted: binary content]';
  const prefixed = content
    .toString('utf-8')
    .split('\n')
    .map((line) => `+${line}`)
    .join('\n');
  if (prefixed.length <= maxChars) return prefixed;
  return `${prefixed.slice(0, maxChars)}\n+[untracked file truncated]`;
}

function loadDiffFromBase(baseBranch: string): DiffContext {
  let lastError: unknown;
  for (const baseRef of getBaseRefCandidates(baseBranch)) {
    try {
      const diff = gitText(['diff', `${baseRef}...HEAD`], { timeout: 10000 }).trim();
      return {
        diff,
        label: baseRef,
        promptLead: (branch) =>
          `Give me a summary. Here is the git diff between the current branch \`${branch}\` and \`${baseBranch}\`:`,
        emptyMessage: (branch) => `branch ${branch} has no diff from ${baseBranch}`,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function getBaseRefCandidates(baseBranch: string): string[] {
  const candidates = baseBranch.startsWith('origin/') ? [baseBranch] : [`origin/${baseBranch}`, baseBranch];
  return [...new Set(candidates)];
}

function buildMessage(branch: string, context: DiffContext): string {
  return `${context.promptLead(branch)}\n\n\`\`\`diff\n${context.diff}\n\`\`\``;
}

function buildDisplayMessage(branch: string, context: DiffContext): string {
  const stats = summarizeDiff(context.diff);
  const scope =
    context.label === 'current git changes'
      ? '总结当前工作区 Git 变化'
      : `总结当前分支相对 ${context.label} 的 Git diff`;
  const summary = [
    `已发送 ${scope} 给 agent。`,
    `分支：${branch}`,
    `文件：${stats.files}，新增：${stats.additions} 行，删除：${stats.deletions} 行`,
  ];
  return summary.join('\n');
}

export function summarizeDiff(diff: string): { files: number; additions: number; deletions: number } {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) files.add(line);
    else if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }

  return { files: files.size, additions, deletions };
}
