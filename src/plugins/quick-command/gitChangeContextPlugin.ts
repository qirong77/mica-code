import { execSync } from 'child_process';
import { MicaPlugin } from '../MicaPlugin.js';

const MAX_DIFF_BYTES = 80_000;

export class QuickCommandGitChangeContextPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'git-change-context',
      description: '对比当前分支和目标分支的代码改动，让 AI 总结并生成上下文',
      action: (arg?: string) => {
        const branch = arg?.trim() || 'master';

        let stat: string;
        let diff: string;
        try {
          stat = execSync(`git diff ${branch}...HEAD --stat`, {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
          });
          diff = execSync(
            `git diff ${branch}...HEAD -- . ':(exclude)package-lock.json' ':(exclude)pnpm-lock.yaml' ':(exclude)yarn.lock' ':(exclude)go.sum' ':(exclude)*.lock'`,
            { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
          );
        } catch (e: any) {
          const stderr = e.stderr?.toString() || e.message;
          this.showMessage(`git diff 失败: ${stderr.split('\n')[0]}`, 5000);
          return;
        }

        if (!stat.trim() && !diff.trim()) {
          this.showMessage(`当前分支与 ${branch} 无差异`, 3000);
          return;
        }

        let diffSnippet = diff;
        if (Buffer.byteLength(diff, 'utf-8') > MAX_DIFF_BYTES) {
          diffSnippet = Buffer.from(diff, 'utf-8').subarray(0, MAX_DIFF_BYTES).toString('utf-8');
          diffSnippet += '\n\n... (diff 过长，已截断)';
        }

        const prompt = [
          `请分析当前分支相对于 \`${branch}\` 分支的代码改动，简洁总结变更要点，作为后续开发的上下文参考。`,
          '',
          '## 文件变更概览',
          '```',
          stat.trim(),
          '```',
          '',
          '## 具体代码变更',
          '```diff',
          diffSnippet,
          '```',
        ].join('\n');

        this.agent.ui.TerminalInput.submit(prompt);
      },
    });
  }
}
