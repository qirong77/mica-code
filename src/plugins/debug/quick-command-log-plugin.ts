import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MicaPlugin } from '../MicaPlugin';

/**
 * 快速命令插件：导出会话记录到当前工作路径。
 *
 * 注册 `/session-export` 命令，将当前 agent 的完整对话历史（messages）
 * 保存为 JSON 文件到 process.cwd()。
 */
export class QuickCommandLogPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'debug-session-export',
      description: '导出会话记录到当前路径',
      hidden: true,
      action: async () => {
        const rawMessages = this.atoms.messages.get();
        const messages = rawMessages.filter((m: any) => m.status !== 'clear');

        if (messages.length === 0) {
          this.showMessage('没有会话记录可导出');
          return;
        }

        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const timestamp = [
          now.getFullYear(),
          pad(now.getMonth() + 1),
          pad(now.getDate()),
          '-',
          pad(now.getHours()),
          pad(now.getMinutes()),
          pad(now.getSeconds()),
        ].join('');

        const filename = `mica-session-${timestamp}.json`;
        const filePath = resolve(process.cwd(), filename);

        try {
          await writeFile(filePath, JSON.stringify(messages, null, 2), 'utf-8');
          this.showMessage(`会话记录已导出: ${filename}`);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          this.showMessage(`导出失败: ${errMsg}`);
        }
      },
    });
  }
}
