import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices } from './services.js';
import { formatExecError, gitText } from '@packages/mica-common/index.js';

const DEFAULT_BASE_BRANCH = 'master';
const CURRENT_CHANGES_ARG = '-';

export function createGitDiffContextCommand(services: CommandRuntimeServices) {
  return {
    name: 'git-diff-context',
    description: '将当前分支与指定 base 分支的差异作为上下文发送给 agent，默认 master；传 - 发送当前 git 变化',
    action: (arg?: string) => {
      try {
        const target = resolveDiffTarget(arg);
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
        micaUi.terminalInput.submit(message);
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
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

type DiffTarget = { type: 'current' } | { type: 'base'; baseBranch: string };

type DiffContext = {
  diff: string;
  label: string;
  promptLead: (branch: string) => string;
  emptyMessage: (branch: string) => string;
};

function resolveDiffTarget(arg?: string): DiffTarget {
  const firstArg = arg?.trim().split(/\s+/)[0] || DEFAULT_BASE_BRANCH;
  if (firstArg === CURRENT_CHANGES_ARG) return { type: 'current' };
  return { type: 'base', baseBranch: firstArg };
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
