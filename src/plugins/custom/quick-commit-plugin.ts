import { execSync } from 'child_process';
import type Anthropic from '@anthropic-ai/sdk';
import { UIPanelPlugin } from '../MicaPlugin';
import { getClient } from '../../agent/client.js';
import { model } from '../../store/config.js';
import {
  pushLog,
  clearLog,
  LogView,
} from '../../components/ui/components/LogView/LogViewComponent.js';
import { C } from '../../components/ui/data.js';

const COMMIT_PROMPT = `根据以下 git diff 信息生成一条简洁的 commit message。

格式: <prefix>: <description> <emoji>

| 前缀     | emoji | 适用场景                     |
|----------|-------|---------------------------|
| feat     | ✨     | 新功能、新模块、新接口         |
| fix      | 🐛     | bug 修复                    |
| refactor | ♻️     | 重构代码，不改变外部行为       |
| chore    | 🔧     | 构建/配置/依赖/脚本等杂项     |

description 简洁清楚，控制在 50 字内。
只输出 commit message 本身，不要其他内容。`;

function git(args: string, tolerateError = false): string {
  try {
    return execSync(`git ${args}`, { encoding: 'utf-8', cwd: process.cwd() }).trim();
  } catch (e) {
    if (tolerateError) return '';
    throw e;
  }
}

export class QuickCommitPlugin extends UIPanelPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'commit',
      description: '根据当前变更生成 commit message 并提交',
      action: async () => {
        clearLog();
        this.showUISimple(LogView);

        try {
          pushLog('正在分析变更...');

          const diffStat = git('diff --stat', true);
          const status = git('status --short', true);

          if (!status && !git('diff --cached --stat', true)) {
            pushLog({ text: '工作区没有变更可提交', color: C.warning });
            setTimeout(() => this.hideUI(), 2000);
            return;
          }

          if (diffStat) {
            for (const line of diffStat.split('\n').filter(Boolean)) {
              pushLog({ text: line, dimColor: true });
            }
          }

          const diff = git('diff', true);
          pushLog('正在生成 commit message...');

          const client = getClient();
          const modelName = model.name.get();
          const effort = model.effort.get();

          const response = await client.messages.create({
            model: modelName,
            max_tokens: 256,
            system: COMMIT_PROMPT,
            messages: [
              {
                role: 'user',
                content: `## 变更文件\n${diffStat || status}\n\n## diff\n${diff.slice(0, 4000)}`,
              },
            ],
            thinking: { type: 'disabled' },
            output_config: effort !== 'none' ? { effort } : undefined,
          });

          const textBlock = response.content.find(
            (b): b is Anthropic.TextBlock => b.type === 'text',
          );
          const message = textBlock?.text?.trim() || 'chore: 更新代码 🔧';
          pushLog({ text: `commit: ${message}`, color: C.info });

          pushLog('正在提交...');
          git(`add -A`);
          git(`commit -m "${message.replace(/"/g, '\\"')}"`);

          const upstream = git('rev-parse --abbrev-ref @{u}', true);
          if (upstream) {
            git('push');
            pushLog({ text: '已提交并推送', color: C.success });
          } else {
            pushLog({ text: '已提交（未关联远程分支，请手动推送）', color: C.success });
          }

          setTimeout(() => this.hideUI(), 5000);
        } catch (err) {
          pushLog({
            text: `提交失败: ${err instanceof Error ? err.message : String(err)}`,
            color: C.error,
          });
          setTimeout(() => this.hideUI(), 4000);
        }
      },
    });
  }
}
