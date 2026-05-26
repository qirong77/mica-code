import { MicaPlugin } from '../MicaPlugin';

const MAX_INPUT_LEN = 80;

function truncate(value: unknown, maxLen: number): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

export class QuickCommandSessionToolsPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'debug-session-tools',
      description: '列出本轮对话的工具调用及耗时',
      hidden: true,
      action: () => {
        const records = this.atoms.sessionToolRecords.get();
        if (records.length === 0) {
          this.showMessage('本轮对话暂无工具调用记录');
          return;
        }

        const lines: string[] = [];
        let maxNameLen = 0;
        for (const r of records) {
          if (r.toolName.length > maxNameLen) maxNameLen = r.toolName.length;
        }

        for (let i = 0; i < records.length; i++) {
          const r = records[i];
          const idx = `[${i + 1}]`;
          const name = r.toolName.padEnd(maxNameLen);
          const elapsed = `${(r.elapsedMs / 1000).toFixed(2)}s`;

          const entries = Object.entries(r.toolInput);
          if (entries.length === 0) {
            lines.push(`${idx} ${name}  ${elapsed}`);
          } else {
            lines.push(`${idx} ${name}  ${elapsed}`);
            for (const [key, val] of entries) {
              lines.push(`     ${key}: ${truncate(val, MAX_INPUT_LEN)}`);
            }
          }
        }

        this.showMessage(lines.join('\n'), 0);
      },
    });
  }
}
