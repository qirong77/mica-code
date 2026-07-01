import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices } from './services.js';
import { formatExecError, gitText } from '@packages/mica-common/index.js';

const DEFAULT_BASE_BRANCH = 'master';

export function createGitDiffContextCommand(services: CommandRuntimeServices) {
  return {
    name: 'git-diff-context',
    description: '将当前分支与指定 base 分支的差异作为上下文发送给 agent，默认 master',
    action: (arg?: string) => {
      runGitDiffContext(services, resolveBaseDiffTarget(arg));
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

export function createGitDiffContextCurrentCommand(services: CommandRuntimeServices) {
  return {
    name: 'git-diff-context-current',
    description: '将当前 git 变化作为上下文发送给 agent',
    hidden: true,
    hiddenMenuParent: 'git-diff-context',
    action: () => {
      runGitDiffContext(services, { type: 'current' });
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function runGitDiffContext(services: CommandRuntimeServices, target: DiffTarget) {
  try {
    micaLogger.logRuntime('plugin.git-diff-context', 'start', target);
    const branch = gitText(['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 }).trim();
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

function resolveBaseDiffTarget(arg?: string): DiffTarget {
  const baseBranch = arg?.trim().split(/\s+/)[0] || DEFAULT_BASE_BRANCH;
  return { type: 'base', baseBranch };
}

function loadDiffContext(target: DiffTarget): DiffContext {
  return target.type === 'current' ? loadCurrentGitChanges() : loadDiffFromBase(target.baseBranch);
}

function loadCurrentGitChanges(): DiffContext {
  const stagedDiff = gitText(['diff', '--cached'], { timeout: 10000 }).trim();
  const unstagedDiff = gitText(['diff'], { timeout: 10000 }).trim();
  const diff = [
    stagedDiff ? `# Staged changes\n${stagedDiff}` : '',
    unstagedDiff ? `# Unstaged changes\n${unstagedDiff}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    diff,
    label: 'current git changes',
    promptLead: (branch) => `Give me a summery. Here are the current git changes on branch \`${branch}\`:`,
    emptyMessage: (branch) => `branch ${branch} has no current git changes`,
  };
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
          `Give me a summery. Here is the git diff between the current branch \`${branch}\` and \`${baseBranch}\`:`,
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

function summarizeDiff(diff: string): { files: number; additions: number; deletions: number } {
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
