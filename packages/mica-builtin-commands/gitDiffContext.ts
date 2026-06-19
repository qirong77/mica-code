import { execSync } from 'node:child_process';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices } from './services.js';

export function createGitDiffContextCommand(services: CommandRuntimeServices) {
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
          services.showMessage(`branch ${branch} has no diff from master`, 5000);
          return;
        }

        const message = `Give me a summery. Here is the git diff between the current branch \`${branch}\` and \`master\`:\n\n\`\`\`diff\n${diff}\n\`\`\``;
        micaUi.terminalInput.submit(message);
        micaLogger.logRuntime('plugin.git-diff-context', 'submitted', { branch, chars: message.length });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        micaLogger.logRuntime('plugin.git-diff-context', 'error', { message: msg }, 'error');
        services.showMessage(`git diff failed: ${msg}`, 5000);
      }
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}
