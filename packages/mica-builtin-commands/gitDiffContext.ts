import { execSync } from 'node:child_process';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';

export function createGitDiffContextCommand() {
  return {
    name: 'git-diff-context',
    description: '将当前分支与 master 的差异作为上下文发送给 agent',
    action: () => {
      try {
        micaLogger.logRuntime('plugin.git-diff-context', 'start');
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
        micaLogger.logRuntime('plugin.git-diff-context', 'branch:detected', { branch });

        let diff: string;
        try {
          diff = execSync('git diff origin/master...HEAD', {
            encoding: 'utf-8',
            timeout: 10000,
          }).trim();
          micaLogger.logRuntime('plugin.git-diff-context', 'diff:loaded', { base: 'origin/master', chars: diff.length });
        } catch {
          diff = execSync('git diff master...HEAD', {
            encoding: 'utf-8',
            timeout: 10000,
          }).trim();
          micaLogger.logRuntime('plugin.git-diff-context', 'diff:loaded', { base: 'master', chars: diff.length });
        }

        if (!diff) {
          micaLogger.logRuntime('plugin.git-diff-context', 'diff:empty', { branch });
          showTemporaryMessage(`branch ${branch} has no diff from master`);
          return;
        }

        const message = `Give me a summery. Here is the git diff between the current branch \`${branch}\` and \`master\`:\n\n\`\`\`diff\n${diff}\n\`\`\``;
        micaUi.terminalInput.submit(message);
        micaLogger.logRuntime('plugin.git-diff-context', 'submitted', { branch, chars: message.length });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        micaLogger.logRuntime('plugin.git-diff-context', 'error', { message: msg }, 'error');
        showTemporaryMessage(`git diff failed: ${msg}`);
      }
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function showTemporaryMessage(text: string) {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  micaUi.messageBar.addMessage({ id, text });
  setTimeout(() => micaUi.messageBar.removeMessage(id), 5000);
}
