import { spawn } from 'child_process';
import { MicaTool, ToolExecuteCallbacks } from './MicaTool';

function truncate(s: string, maxLen = 200): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

export class ToolRunShell extends MicaTool {
  constructor() {
    super('run_shell', '执行 shell 命令并返回输出。', {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeout: { type: 'number', description: '超时毫秒，默认 30000' },
      },
      required: ['command'],
    });
  }

  async execute(input: { command: string; timeout?: number }, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const timeout = input.timeout || 30000;

    return new Promise((resolve) => {
      const child = spawn(input.command, {
        shell: true,
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const abortHandler = () => {
        if (!child.killed) {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL');
          }, 5000);
        }
      };

      callbacks?.signal?.addEventListener('abort', abortHandler, { once: true });

      let output = '';

      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        callbacks?.onChunk?.(chunk);
      });

      child.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        callbacks?.onChunk?.(chunk);
      });

      child.on('close', (code) => {
        callbacks?.signal?.removeEventListener('abort', abortHandler);
        const msg = output || '(no output)';
        if (code !== 0 && code !== null) {
          resolve(`(退出码: ${code})\n${msg}`);
        } else {
          resolve(msg);
        }
      });

      child.on('error', (error) => {
        callbacks?.signal?.removeEventListener('abort', abortHandler);
        if (output) {
          resolve(`(错误: ${error.message})\n${output}`);
        } else {
          resolve(`(错误: ${error.message})`);
        }
      });
    });
  }

  onToolUseDisplayText(input: Record<string, any>): string {
    return `$ ${truncate(input.command as string, 80)}`;
  }
  getSlowText(ms: number, input: Record<string, any>): string {
    const cmd = truncate(input.command as string);
    return `执行命令 ${cmd} (${(ms / 1000).toFixed(1)}s)`;
  }
}
