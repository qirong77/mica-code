import { MicaTool } from '../MicaTool.js';
import type { ToolExecuteCallbacks } from '../MicaTool.js';
import { truncateDisplayText } from '../utils/display.js';
import { getPtyManager } from './shared.js';

const MAX_ENV_ENTRIES = 32;

export class ToolPtySpawn extends MicaTool {
  constructor() {
    super(
      'pty_spawn',
      '启动一个交互式终端程序（PTY）并返回 session_id。用于驱动 TUI 程序做端到端验证：' +
        '先 pty_spawn，再用 pty_send 输入、pty_read 读取输出、pty_wait 等待条件，最后 pty_kill 结束。' +
        '基于 node-pty，需本机 Node >= 22（经 Node helper 进程桥接）。',
      {
        type: 'object' as const,
        properties: {
          command: { type: 'string', description: '要运行的可执行文件路径，如 /bin/sh 或 node。' },
          args: { type: 'array', items: { type: 'string' }, description: '命令行参数。' },
          cols: { type: 'number', description: '终端宽度，默认 120。' },
          rows: { type: 'number', description: '终端高度，默认 40。' },
          cwd: { type: 'string', description: '子进程工作目录，默认当前目录。' },
          env: {
            type: 'object',
            description: `额外环境变量（最多 ${MAX_ENV_ENTRIES} 项），合并到当前环境。`,
          },
          name: { type: 'string', description: 'TERM 值，默认 xterm-256color。' },
        },
        required: ['command'],
      },
    );
  }

  async execute(
    input: {
      command: string;
      args?: string[];
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
      name?: string;
    },
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    try {
      const manager = await getPtyManager();
      const argv = [input.command, ...(input.args ?? [])];
      const { sessionId, pid } = await manager.spawn(argv, {
        cols: input.cols,
        rows: input.rows,
        cwd: input.cwd,
        env: input.env,
        name: input.name,
      });
      return [
        `PTY 会话已启动`,
        `session_id: ${sessionId}`,
        `pid: ${pid}`,
        `command: ${argv.join(' ')}`,
        ``,
        `后续可用 pty_send(输入/按键)、pty_read(读取输出)、pty_wait(等待条件)、pty_kill(结束) 操作该会话。`,
      ].join('\n');
    } catch (error) {
      return `pty_spawn 失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `pty spawn ${truncateDisplayText(String(input.command ?? ''), 40)}`;
  }
}
