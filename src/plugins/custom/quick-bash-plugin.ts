import { spawn } from 'node:child_process';
import { MicaPlugin } from '../MicaPlugin';

export class QuickBashPlugin extends MicaPlugin {
  onInstall(): void {
    this.agent.agentTurn.use(async (userInput, next, onIteration) => {
      if (!userInput.startsWith('!')) return next(userInput, onIteration);

      const command = userInput.slice(1).trim();
      if (!command) {
        this.showMessage('请输入要执行的命令');
        return;
      }

      this.atoms.thinkingText.set(this.atoms.thinkingText.get() + `$ ${command}\n`);

      const msgId = this.showMessage(`执行中: ${command}`, 0);

      try {
        const output = await new Promise<string>((resolve, reject) => {
          const child = spawn(command, {
            shell: true,
            cwd: process.cwd(),
            timeout: 30000,
          });

          const lines: string[] = [];

          child.stdout.on('data', (data: Buffer) => {
            const text = data.toString();
            this.atoms.thinkingText.set(this.atoms.thinkingText.get() + text);
            for (const line of text.split('\n')) {
              const trimmed = line.trimEnd();
              if (trimmed) lines.push(trimmed);
            }
          });

          child.stderr.on('data', (data: Buffer) => {
            const text = data.toString();
            this.atoms.thinkingText.set(this.atoms.thinkingText.get() + text);
            for (const line of text.split('\n')) {
              const trimmed = line.trimEnd();
              if (trimmed) lines.push(trimmed);
            }
          });

          child.on('error', (err) => {
            reject(err);
          });

          child.on('close', (code) => {
            if (code === 0) {
              resolve(lines.join('\n') || '(no output)');
            } else {
              reject(new Error(`命令退出码: ${code}`));
            }
          });
        });

        this.removeMessage(msgId);

        const lineCount = output.split('\n').length;
        this.showMessage(`命令完成，输出 ${lineCount} 行`);
      } catch (err) {
        this.removeMessage(msgId);
        const errMsg = err instanceof Error ? err.message : String(err);
        this.atoms.thinkingText.set(this.atoms.thinkingText.get() + `[错误] ${errMsg}\n`);
        this.showMessage(`命令失败: ${errMsg}`);
      }
    });
  }
}
