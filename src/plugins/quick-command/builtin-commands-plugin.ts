import { execSync } from 'child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MicaPlugin } from '../MicaPlugin';
import { getContextUsage, getTotalBilledTokens } from '../../utils/getContextUsage';
import { compactMessages, MIN_MESSAGES_TO_COMPACT } from '../../utils/compact';
import { model } from '../../store/config';
import { systemLogAtom, sessionToolRecordsAtom } from '../../store/logAtom';

const MAX_DIFF_BYTES = 80_000;

export class BuiltinCommandsPlugin extends MicaPlugin {
  onInstall(): void {
    // /exit
    this.addQuickCommand({
      name: 'exit',
      description: '退出程序',
      action: () => process.exit(0),
    });

    // /clear
    this.addQuickCommand({
      name: 'clear',
      description: '开始新会话（旧会话可通过 /resume 恢复）',
      action: () => {
        this.agent.agentTurn.session.replaceMessages([]);
        this.atoms.currentSessionId.set('');
        this.showMessage('已开启新会话，旧会话已保存');
      },
    });

    // /star
    this.addQuickCommand({
      name: 'star',
      description: '收藏 / 取消收藏当前会话，收藏后 /resume 优先展示',
      action: () => {
        const currentId = this.atoms.currentSessionId.get();
        if (!currentId) {
          this.showMessage('没有活跃的会话');
          return;
        }
        const idx = this.atoms.sessionsIndex.get();
        const target = idx.find((s) => s.id === currentId);
        if (!target) {
          this.showMessage('当前会话未存储');
          return;
        }
        const newStarred = !target.starred;
        this.atoms.sessionsIndex.set(
          idx.map((s) => (s.id === currentId ? { ...s, starred: newStarred } : s)),
        );
        this.showMessage(newStarred ? '已收藏 ⭐️' : '已取消收藏');
      },
    });

    // /delete
    this.addQuickCommand({
      name: 'delete',
      description: '删除当前会话（不保留记录）',
      action: () => {
        const currentId = this.atoms.currentSessionId.get();
        if (currentId) {
          this.atoms.sessionsIndex.set(
            this.atoms.sessionsIndex.get().filter((s) => s.id !== currentId),
          );
        }
        this.agent.agentTurn.session.replaceMessages([]);
        this.atoms.currentSessionId.set('');
        this.showMessage('会话已删除');
      },
    });

    // /status
    this.addQuickCommand({
      name: 'status',
      description: '显示当前状态（模型、API 配置等）',
      action: () => {
        const currentModel = this.atoms.model.get();
        const currentEffort = this.atoms.effort.get();
        const maxTokens = this.atoms.maxTokens.get();
        const contextWindow = this.atoms.contextWindowSize.get();
        const baseUrl = this.atoms.apiBaseUrl.get();
        const apiKey = this.atoms.apiKey.get();
        const modelOptions = this.atoms.modelOptions.get();
        const effortOptions = this.atoms.effortOptions.get();
        const messages = this.atoms.messages.get();
        const sessionId = this.atoms.currentSessionId.get();

        const currentModelLabel =
          modelOptions.find((m) => m.name === currentModel)?.label ?? currentModel;
        const currentEffortLabel =
          effortOptions.find((e) => e.name === currentEffort)?.label ?? currentEffort;

        const entries: [string, string][] = [
          ['Model', `${currentModelLabel} (${currentModel})`],
          ['Effort', `${currentEffortLabel} (${currentEffort})`],
          ['Max Tokens', `${maxTokens}`],
          ['Context Window', `${contextWindow}`],
          ['Context Usage', `${getContextUsage(messages)} tokens`],
          ['Base URL', baseUrl || '(not set)'],
          ['API Key', apiKey || '(not set)'],
          ['Session ID', `${sessionId}`],
          ['Messages', `${messages.length}`],
          ['Total Billed Tokens', `${getTotalBilledTokens(messages)}`],
        ];

        const maxLabelWidth = Math.max(...entries.map(([label]) => label.length));
        this.showMessage(
          entries.map(([label, value]) => `${label.padEnd(maxLabelWidth)} : ${value}`).join('\n'),
          0,
        );
      },
    });

    // /compact
    this.addQuickCommand({
      name: 'compact',
      description: '压缩当前对话上下文',
      action: async () => {
        const messages = this.agent.agentTurn.session.getMessages();
        if (messages.length < MIN_MESSAGES_TO_COMPACT) {
          this.showMessage(
            `消息条数不足（当前 ${messages.length}，最少 ${MIN_MESSAGES_TO_COMPACT}）`,
          );
          return;
        }

        const usageBefore = getContextUsage(messages);
        const maxCtx = model.contextWindowSize.get();
        const ratioBefore = maxCtx > 0 ? ((usageBefore / maxCtx) * 100).toFixed(0) : '?';

        const msgId = this.showMessage(`上下文使用 ${ratioBefore}%，正在压缩...`, 0);

        try {
          const { compacted, toCompressCount } = await compactMessages(messages);
          this.agent.agentTurn.session.replaceMessages(compacted);
          this.removeMessage(msgId);

          const usageAfter = getContextUsage(compacted);
          const ratioAfter = maxCtx > 0 ? ((usageAfter / maxCtx) * 100).toFixed(1) : '?';
          this.showMessage(
            `压缩完成：${toCompressCount} 条消息 → 1 条摘要，上下文使用 ${ratioAfter}%`,
            5000,
          );
        } catch {
          this.removeMessage(msgId);
          this.showMessage('压缩失败', 3000);
        }
      },
    });

    // /git-change-context
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

    // /debug
    this.addQuickCommand({
      name: 'debug',
      description: '调试工具（导出会话）',
      action: () => {
        this.agent.ui.DropDown.quickCommand.show('debug-', true);
      },
    });

    // /debug-log-export (hidden)
    this.addQuickCommand({
      name: 'debug-log-export',
      description: '导出日志和会话记录到当前路径',
      hidden: true,
      action: async () => {
        const timestamp = makeTimestamp();
        const cwd = process.cwd();
        const results: string[] = [];
        const errors: string[] = [];

        await exportConversation(this.atoms, cwd, timestamp, results, errors);
        await exportLogs(cwd, timestamp, results, errors);

        if (results.length > 0) {
          this.showMessage(`已导出: ${results.join(', ')}`);
        }
        if (errors.length > 0) {
          this.showMessage(`导出部分失败: ${errors.join('; ')}`);
        }
        if (results.length === 0 && errors.length === 0) {
          this.showMessage('没有内容可导出');
        }
      },
    });
  }
}

function makeTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function exportConversation(
  atoms: any,
  cwd: string,
  timestamp: string,
  results: string[],
  errors: string[],
): Promise<void> {
  const rawMessages = atoms.messages.get();
  const messages = rawMessages.filter((m: any) => m.status !== 'clear');
  if (messages.length === 0) return;
  const filename = `mica-session-${timestamp}.json`;
  try {
    await writeFile(resolve(cwd, filename), JSON.stringify(messages, null, 2), 'utf-8');
    results.push(filename);
  } catch (error) {
    errors.push(`会话记录: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exportLogs(
  cwd: string,
  timestamp: string,
  results: string[],
  errors: string[],
): Promise<void> {
  const sysLogs = systemLogAtom.get();
  const toolRecords = sessionToolRecordsAtom.get();
  const lines: string[] = [];

  if (sysLogs.length > 0) {
    lines.push('=== System Logs ===');
    lines.push(...sysLogs);
    lines.push('');
  }
  if (toolRecords.length > 0) {
    lines.push('=== Tool Execution Records ===');
    for (const rec of toolRecords) {
      lines.push(`[${rec.elapsedMs}ms] ${rec.toolName}(${JSON.stringify(rec.toolInput)})`);
    }
  }
  if (lines.length === 0) return;
  const filename = `mica-logs-${timestamp}.log`;
  try {
    await writeFile(resolve(cwd, filename), lines.join('\n') + '\n', 'utf-8');
    results.push(filename);
  } catch (error) {
    errors.push(`日志: ${error instanceof Error ? error.message : String(error)}`);
  }
}
