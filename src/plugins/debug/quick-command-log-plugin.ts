import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MicaPlugin } from '../MicaPlugin';
import { systemLogAtom, sessionToolRecordsAtom } from '../../store/logAtom';

export class QuickCommandLogPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'debug-log-export',
      description: '导出日志和会话记录到当前路径',
      hidden: true,
      action: async () => {
        const timestamp = this.makeTimestamp();
        const cwd = process.cwd();
        const results: string[] = [];
        const errors: string[] = [];

        await this.exportConversation(cwd, timestamp, results, errors);
        await this.exportLogs(cwd, timestamp, results, errors);

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

  private makeTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      '-',
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
    ].join('');
  }

  private async exportConversation(
    cwd: string,
    timestamp: string,
    results: string[],
    errors: string[],
  ): Promise<void> {
    const rawMessages = this.atoms.messages.get();
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

  private async exportLogs(
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
        lines.push(
          `[${rec.elapsedMs}ms] ${rec.toolName}(${JSON.stringify(rec.toolInput)})`,
        );
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
}
