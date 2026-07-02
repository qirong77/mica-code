import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { formatExecError } from '@packages/mica-common/index.js';
import type { CommandRuntimeServices } from './services.js';
import { getCurrentBranch, loadCurrentGitChanges, summarizeDiff } from './gitDiffContext.js';

export function createReviewCommand(services: CommandRuntimeServices) {
  return {
    name: 'review',
    description: '将当前工作区 git 变化发送给 agent 做代码审查',
    action: () => {
      runReview(services);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function runReview(services: CommandRuntimeServices): void {
  try {
    micaLogger.logRuntime('plugin.review', 'start');
    const branch = getCurrentBranch();
    const diff = loadCurrentGitChanges({ includeUntracked: true });
    micaLogger.logRuntime('plugin.review', 'diff:loaded', { branch, chars: diff.length });

    if (!diff) {
      micaLogger.logRuntime('plugin.review', 'diff:empty', { branch });
      services.showMessage(`review: branch ${branch} has no current git changes`, 5000);
      return;
    }

    const message = buildReviewMessage(branch, diff);
    micaUi.terminalInput.submit(message, { displayText: buildReviewDisplayMessage(branch, diff) });
    micaLogger.logRuntime('plugin.review', 'submitted', { branch, chars: message.length });
  } catch (error) {
    const msg = formatExecError(error);
    micaLogger.logRuntime('plugin.review', 'error', { message: msg }, 'error');
    services.showMessage(`review failed: ${msg}`, 5000);
  }
}

function buildReviewMessage(branch: string, diff: string): string {
  return [
    '请 review 当前工作区的代码变更。',
    '',
    '请按 code review 的方式输出：',
    '- 先列出明确的问题，按严重程度排序。',
    '- 优先关注 bug、行为回归、数据丢失风险、并发/状态问题和缺失测试。',
    '- 每个问题尽量给出文件和行号依据。',
    '- 如果没有发现明确问题，请直接说明，并补充剩余风险或建议验证项。',
    '- 不要只复述 diff；总结只能作为问题说明的辅助。',
    '',
    `当前分支：${branch}`,
    '当前工作区 Git 变化如下：',
    '',
    '```diff',
    diff,
    '```',
  ].join('\n');
}

function buildReviewDisplayMessage(branch: string, diff: string): string {
  const stats = summarizeDiff(diff);
  return [
    '已发送当前工作区 Git 变化给 agent review。',
    `分支：${branch}`,
    `文件：${stats.files}，新增：${stats.additions} 行，删除：${stats.deletions} 行`,
  ].join('\n');
}
