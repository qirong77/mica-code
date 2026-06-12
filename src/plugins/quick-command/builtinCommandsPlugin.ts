import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MicaPlugin } from '../MicaPlugin.js';
import { getContextUsage, getTotalBilledTokens } from '../../utils/getContextUsage.js';
import { systemLogAtom, sessionToolRecordsAtom } from '../../store/logAtom.js';

export class BuiltinCommandsPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'exit',
      description: '退出程序',
      action: () => process.exit(0),
    });

    this.addQuickCommand({
      name: 'clear',
      description: '开始新会话（旧会话可通过 /resume 恢复）',
      action: () => {
        this.agent.agentTurn.session.replaceMessages([]);
        this.atoms.currentSessionId.set('');
        this.showMessage('已开启新会话，旧会话已保存');
      },
    });

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
