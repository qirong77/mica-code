import { MicaTool } from '../MicaTool.js';
import type { ToolExecuteCallbacks } from '../MicaTool.js';
import { truncateDisplayText } from '../utils/display.js';
import { getPtyManager } from './shared.js';

const DEFAULT_WINDOW_SIZE = 80_000;
const MAX_OUTPUT_BYTES = 200_000;

export class ToolPtyRead extends MicaTool {
  constructor() {
    super(
      'pty_read',
      '读取 PTY 会话的输出。默认返回全部已捕获内容（去除 ANSI 控制序列）；mode=tail 只返回尾部窗口。' +
        '结果受输出上限截断（超出部分丢弃头部，total_bytes 反映已捕获总量）。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'pty_spawn 返回的会话 ID。' },
          mode: { type: 'string', enum: ['all', 'tail'], description: 'all(默认) 全部 / tail 尾部窗口。' },
          window_size: {
            type: 'number',
            description: `tail 模式的窗口字符数，默认 ${DEFAULT_WINDOW_SIZE}。`,
          },
          strip_ansi: { type: 'boolean', description: '是否剥离 ANSI 控制序列，默认 true。' },
          clear: { type: 'boolean', description: '读取后清空缓冲区，默认 false。' },
        },
        required: ['session_id'],
      },
    );
  }

  async execute(
    input: {
      session_id: string;
      mode?: 'all' | 'tail';
      window_size?: number;
      strip_ansi?: boolean;
      clear?: boolean;
    },
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    try {
      const manager = await getPtyManager();
      const windowSize = Math.max(1, Math.min(input.window_size ?? DEFAULT_WINDOW_SIZE, MAX_OUTPUT_BYTES));
      const result = manager.read(input.session_id, {
        mode: input.mode === 'tail' ? 'tail' : 'all',
        windowSize,
        stripAnsi: input.strip_ansi !== false,
        clear: input.clear === true,
      });
      const status = result.exited
        ? `exited (code=${result.exitCode}, signal=${result.signal ?? 'none'})`
        : 'running';
      return [
        `session: ${input.session_id}`,
        `status: ${status}`,
        `total_bytes: ${result.totalBytes}`,
        ``,
        `--- output ---`,
        result.output.length ? result.output : '(no output)',
      ].join('\n');
    } catch (error) {
      return `pty_read 失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `pty read ${truncateDisplayText(String(input.session_id ?? ''), 10)}`;
  }
}
