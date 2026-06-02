import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { spawn } from 'node:child_process';
import { UIPanelPlugin } from '../MicaPlugin';
import type { WritableAtom } from 'nanostores';
import { useScheduleState } from '../../components/ui/hooks/useScheduleState.js';

function BashOutput({ atom }: { atom: WritableAtom<string> }) {
  const text = useScheduleState(atom);
  if (!text) return null;
  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Text, null, text),
  );
}

export class QuickBashPlugin extends UIPanelPlugin {
  private outputAtom!: WritableAtom<string>;
  private uiShown = false;

  onInstall(): void {
    this.outputAtom = this.createState('');

    this.agent.agentTurn.use(async (userInput, next, onIteration) => {
      if (!userInput.startsWith('!')) return next(userInput, onIteration);

      const command = userInput.slice(1).trim();
      if (!command) {
        this.showMessage('请输入要执行的命令');
        return;
      }

      if (command === 'clear') {
        this.outputAtom.set('');
        this.hideUI();
        this.uiShown = false;
        this.showMessage('输出已清除');
        return;
      }

      const OutputComponent = () => React.createElement(BashOutput, { atom: this.outputAtom });
      if (!this.uiShown) {
        this.showUISimple(OutputComponent);
        this.uiShown = true;
      }

      this.outputAtom.set(this.outputAtom.get() + `$ ${command}\n`);

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
            this.outputAtom.set(this.outputAtom.get() + text);
            for (const line of text.split('\n')) {
              const trimmed = line.trimEnd();
              if (trimmed) lines.push(trimmed);
            }
          });

          child.stderr.on('data', (data: Buffer) => {
            const text = data.toString();
            this.outputAtom.set(this.outputAtom.get() + text);
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
        this.outputAtom.set(this.outputAtom.get() + `[错误] ${errMsg}\n`);
        this.showMessage(`命令失败: ${errMsg}`);
      }
    });
  }
}
