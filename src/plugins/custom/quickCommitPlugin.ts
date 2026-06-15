import { execSync } from 'child_process';
import type { TextBlock } from '@mica/llm';
import { UIPanelPlugin } from '../MicaPlugin.js';
import { getClient } from '../../agent/client.js';
import { model } from '../../store/config.js';
import {
  pushLog,
  clearLog,
  LogView,
} from '../../components/panels/LogView.js';
import { C } from '../../components/data.js';

const COMMIT_PROMPT = `根据以下 git diff 信息生成一条简洁的 commit message。

格式: <prefix>: <description> <emoji>

| 前缀     | emoji | 适用场景                     |
|----------|-------|---------------------------|
| feat     | ✨     | 新功能、新模块、新接口         |
| fix      | 🐛     | bug 修复                    |
| refactor | ♻️     | 重构代码，不改变外部行为       |
| chore    | 🔧     | 构建/配置/依赖/脚本等杂项     |

description 简洁清楚，控制在 50 字内。
只输出 commit message 本身，不要其他内容。
commit message 请使用中文
`;

const MAX_PER_FILE_DIFF = 200;
const MAX_TOTAL_DIFF = 1000;

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
          const cachedStat = git('diff --cached --stat', true);
          const status = git('status --short', true);

          if (!status && !cachedStat) {
            pushLog({ text: '工作区没有变更可提交', color: C.warning });
            setTimeout(() => this.hideUI(), 2000);
            return;
          }

          const overview = diffStat || cachedStat || status;
          for (const line of overview.split('\n').filter(Boolean)) {
            pushLog({ text: line, dimColor: true });
          }

          const fileNames = new Set<string>();
          for (const ref of ['diff', 'diff --cached']) {
            const names = git(`${ref} --name-only`, true);
            for (const f of names.split('\n').filter(Boolean)) {
              fileNames.add(f);
            }
          }

          let diffContent = '';
          let totalLen = 0;
          let truncated = false;

          for (const file of fileNames) {
            if (totalLen >= MAX_TOTAL_DIFF) {
              truncated = true;
              break;
            }

            const unstaged = git(`diff -- "${file.replace(/"/g, '\\"')}"`, true);
            const staged = git(`diff --cached -- "${file.replace(/"/g, '\\"')}"`, true);

            let fileDiff = '';
            if (unstaged && staged) {
              fileDiff = `${staged}\n${unstaged}`;
            } else {
              fileDiff = staged || unstaged;
            }

            if (!fileDiff) continue;

            const sliced = fileDiff.slice(0, MAX_PER_FILE_DIFF);
            const label = fileDiff.length > MAX_PER_FILE_DIFF
              ? `${file} [truncated ${fileDiff.length - MAX_PER_FILE_DIFF} chars]\n`
              : `${file}\n`;

            const remaining = MAX_TOTAL_DIFF - totalLen;
            const toAdd = label + sliced.slice(0, remaining - label.length);

            if (toAdd.length > label.length) {
              diffContent += (diffContent ? '\n\n' : '') + toAdd;
              totalLen += toAdd.length;
            }
          }

          if (truncated) {
            const skipped = fileNames.size - [...fileNames].reduce((c, f) => diffContent.includes(f) ? c + 1 : c, 0);
            diffContent += `\n\n[${skipped} more files omitted due to total size limit]`;
          }

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
                content: `## 变更总览\n${overview}\n\n## 变更详情\n${diffContent || overview}`,
              },
            ],
            thinking: { type: 'disabled' },
            output_config: effort !== 'none' ? { effort } : undefined,
          });

          const textBlock = response.content.find((b): b is TextBlock => b.type === 'text');
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
