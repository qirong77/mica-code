import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MicaPlugin } from '../MicaPlugin.js';
import { systemLogAtom, sessionToolRecordsAtom } from '../../store/logAtom.js';

export class DebugExportLogPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'debug-export-log',
      description: '导出 conversation.json 和 log.txt 到当前目录',
      action: async () => {
        const cwd = process.cwd();
        const results: string[] = [];
        const errors: string[] = [];

        await this.exportConversation(cwd, results, errors);
        await this.exportLog(cwd, results, errors);

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

  private async exportConversation(cwd: string, results: string[], errors: string[]): Promise<void> {
    const rawMessages = this.atoms.messages.get();
    const messages = rawMessages.filter((m: any) => m.status !== 'clear');
    if (messages.length === 0) return;
    const filename = 'conversation.json';
    try {
      await writeFile(resolve(cwd, filename), JSON.stringify(messages, null, 2), 'utf-8');
      results.push(filename);
    } catch (error) {
      errors.push(`conversation.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async exportLog(cwd: string, results: string[], errors: string[]): Promise<void> {
    const sysLogs = systemLogAtom.get();
    const toolRecords = sessionToolRecordsAtom.get();
    const lines: string[] = [];

    if (sysLogs.length > 0) {
      lines.push('=== System Logs ===');
      lines.push(...sysLogs);
      lines.push('');
    }
    if (toolRecords.length > 0) {
      const mcpRecords = toolRecords.filter((r) => r.toolName.startsWith('mcp__'));
      const skillRecords = toolRecords.filter((r) => r.toolName === 'Skill');
      const otherRecords = toolRecords.filter(
        (r) => r.toolName !== 'Skill' && !r.toolName.startsWith('mcp__'),
      );

      if (mcpRecords.length > 0) {
        lines.push('=== MCP Tool Calls ===');
        for (const rec of mcpRecords) {
          const parts = rec.toolName.split('__');
          const server = parts[1] ?? '?';
          const tool = parts.slice(2).join('__');
          lines.push(`[${rec.elapsedMs}ms] ${server}/${tool}(${JSON.stringify(rec.toolInput)})`);
        }
        lines.push('');
      }

      if (skillRecords.length > 0) {
        lines.push('=== Skill Calls ===');
        for (const rec of skillRecords) {
          lines.push(`[${rec.elapsedMs}ms] ${rec.toolInput.skill}${rec.toolInput.args ? ` args: ${rec.toolInput.args}` : ''}`);
        }
        lines.push('');
      }

      if (otherRecords.length > 0) {
        lines.push('=== Other Tool Execution Records ===');
        for (const rec of otherRecords) {
          lines.push(`[${rec.elapsedMs}ms] ${rec.toolName}(${JSON.stringify(rec.toolInput)})`);
        }
        lines.push('');
      }
    }
    if (lines.length === 0) return;
    const filename = 'log.txt';
    try {
      await writeFile(resolve(cwd, filename), lines.join('\n') + '\n', 'utf-8');
      results.push(filename);
    } catch (error) {
      errors.push(`log.txt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
