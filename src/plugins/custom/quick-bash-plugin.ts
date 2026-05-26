import { exec } from 'node:child_process';
import { MicaPlugin } from '../MicaPlugin';
import { appendSystemLog } from '../../store/logAtom.js';

export class QuickBashPlugin extends MicaPlugin {
  onInstall(): void {
    this.agent.agentTurn.use(async (userInput, next, onIteration) => {
      if (!userInput.startsWith('!')) return next(userInput, onIteration);

      const command = userInput.slice(1).trim();
      if (!command) {
        this.showMessage('请输入要执行的命令');
        return;
      }

      appendSystemLog(`! ${command}`);

      const msgId = this.showMessage(`执行中: ${command}`, 0);

      try {
        const output = await new Promise<string>((resolve, reject) => {
          exec(command, {
            cwd: process.cwd(),
            maxBuffer: 1024 * 1024,
            timeout: 30000,
          }, (error, stdout, stderr) => {
            if (error) {
              reject(new Error(stderr || error.message));
              return;
            }
            const trimmed = (stdout + (stderr ? `\n${stderr}` : '')).trim();
            resolve(trimmed || '(no output)');
          });
        });

        this.removeMessage(msgId);

        for (const line of output.split('\n')) {
          appendSystemLog(line);
        }

        if (output.length > 200) {
          this.showMessage(`命令完成，输出 ${output.split('\n').length} 行`);
        } else {
          this.showMessage(output.slice(0, 200));
        }
      } catch (err) {
        this.removeMessage(msgId);
        const errMsg = err instanceof Error ? err.message : String(err);
        appendSystemLog(`[错误] ${errMsg}`);
        this.showMessage(`命令失败: ${errMsg.slice(0, 200)}`);
      }
    });
  }
}
