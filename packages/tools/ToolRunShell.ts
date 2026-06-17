import { spawn } from 'child_process';
import { openSync, closeSync } from 'fs';
import { mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'crypto';
import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import { truncateDisplayText } from './utils/display.js';

function taskId(): string {
  return crypto.randomBytes(6).toString('hex');
}

export class ToolRunShell extends MicaTool {
  constructor() {
    super('run_shell', '执行 shell 命令并返回输出。', {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeout: { type: 'number', description: '超时毫秒，默认 30000' },
        run_in_background: {
          type: 'boolean',
          description: '设为 true 在后台运行命令，不等待结果。适用于 dev server、watch 模式等长时间运行的命令。输出写入临时文件，后续用 read_file 查看。',
        },
      },
      required: ['command'],
    });
  }

  async execute(
    input: { command: string; timeout?: number; run_in_background?: boolean },
    callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    if (input.run_in_background) {
      return this.executeBackground(input);
    }
    return this.executeForeground(input, callbacks);
  }

  private async executeForeground(
    input: { command: string; timeout?: number },
    callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const timeout = input.timeout || 30000;

    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      let timedOut = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const child = spawn(input.command, {
        shell: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const killChild = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      };

      const abortHandler = () => {
        killChild('SIGTERM');
        forceKillTimer = setTimeout(() => {
          killChild('SIGKILL');
        }, 5000);
      };

      callbacks?.signal?.addEventListener('abort', abortHandler, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        callbacks?.onChunk?.(`\n[命令超时（${timeout}ms），正在终止进程]\n`);
        killChild('SIGTERM');
        forceKillTimer = setTimeout(() => {
          killChild('SIGKILL');
        }, 5000);
      }, timeout);

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
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        callbacks?.signal?.removeEventListener('abort', abortHandler);
        const msg = output || '(no output)';
        if (timedOut) {
          resolve(`(超时: ${timeout}ms)\n${msg}`);
        } else if (code !== 0 && code !== null) {
          resolve(`(退出码: ${code})\n${msg}`);
        } else {
          resolve(msg);
        }
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        callbacks?.signal?.removeEventListener('abort', abortHandler);
        if (output) {
          resolve(`(错误: ${error.message})\n${output}`);
        } else {
          resolve(`(错误: ${error.message})`);
        }
      });
    });
  }

  private async executeBackground(input: { command: string }): Promise<string> {
    const id = taskId();
    const outputDir = path.join(tmpdir(), 'mica-tasks');
    const outputPath = path.join(outputDir, `${id}.out`);

    await mkdir(outputDir, { recursive: true });

    const fd = openSync(outputPath, 'w');
    const child = spawn(input.command, {
      shell: true,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);

    child.unref();

    return [
      `命令已在后台启动 (id: ${id})`,
      `输出文件: ${outputPath}`,
      `如需查看结果，用 read_file 读取输出文件。命令完成后再读一次获取最终输出。`,
    ].join('\n');
  }

  onToolUseDisplayText(input: Record<string, any>): string {
    const cmd = (input.command ?? '') as string;
    // "$ " prefix + " [后台]" suffix 大约占 10 个额外字符
    const truncated = truncateDisplayText(cmd.trim(), 10);
    if (input.run_in_background) {
      return `$ ${truncated} [后台]`;
    }
    return `$ ${truncated}`;
  }

  
}
