import { execSync } from 'node:child_process';
import { micaUI } from '../../packages/mica-ui/index.js';

export function registerGitDiffContextPlugin() {
  return {
    name: 'git-diff-context',
    description: '将当前分支与 master 的差异作为上下文发送给 agent',
    action: () => {
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();

        let diff: string;
        try {
          diff = execSync('git diff origin/master...HEAD', {
            encoding: 'utf-8',
            timeout: 10000,
          }).trim();
        } catch {
          diff = execSync('git diff master...HEAD', {
            encoding: 'utf-8',
            timeout: 10000,
          }).trim();
        }

        if (!diff) {
          showTemporaryMessage(`branch ${branch} has no diff from master`);
          return;
        }

        const message = `Here is the git diff between the current branch \`${branch}\` and \`master\`:\n\n\`\`\`diff\n${diff}\n\`\`\``;
        micaUI.terminalInput.submit(message);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        showTemporaryMessage(`git diff failed: ${msg}`);
      }
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}

function showTemporaryMessage(text: string) {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  micaUI.messageBar.addMessage({ id, text });
  setTimeout(() => micaUI.messageBar.removeMessage(id), 5000);
}
