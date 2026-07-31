import { MicaTool } from '../MicaTool.js';
import type { ToolExecuteCallbacks } from '../MicaTool.js';
import { truncateDisplayText } from '../utils/display.js';
import { getPtyManager } from './shared.js';

const DEFAULT_WINDOW_SIZE = 80_000;

export class ToolPtyWait extends MicaTool {
  constructor() {
    super(
      'pty_wait',
      '等待 PTY 会话满足条件：pattern 匹配输出、进程退出、或 idle_ms 内无新输出（静默）。' +
        '返回终止原因与当前输出尾部。用于等待程序启动完成或一轮交互结束。',
      {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'pty_spawn 返回的会话 ID。' },
          pattern: { type: 'string', description: '要等待出现的正则表达式（做全文匹配，正则以 s 标志执行）。' },
          timeout_ms: { type: 'number', description: '最长等待毫秒，默认 30000。' },
          idle_ms: { type: 'number', description: '若设置，连续 idle_ms 毫秒无新输出即返回（静默判定）。' },
          window_size: {
            type: 'number',
            description: `返回输出尾部窗口字符数，默认 ${DEFAULT_WINDOW_SIZE}。`,
          },
        },
        required: ['session_id'],
      },
    );
  }

  async execute(
    input: {
      session_id: string;
      pattern?: string;
      timeout_ms?: number;
      idle_ms?: number;
      window_size?: number;
    },
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    if (input.pattern === undefined && input.idle_ms === undefined) {
      return 'pty_wait 需要提供 pattern 或 idle_ms 之一。';
    }
    try {
      const manager = await getPtyManager();
      const timeoutMs = Math.max(100, Math.min(input.timeout_ms ?? 30_000, 600_000));
      const idleMs = input.idle_ms === undefined ? 0 : Math.max(1, input.idle_ms);
      const windowSize = Math.max(1, input.window_size ?? DEFAULT_WINDOW_SIZE);
      const result = await manager.wait(input.session_id, {
        pattern: input.pattern,
        timeoutMs,
        idleMs,
        windowSize,
      });
      const reasonText =
        result.reason === 'pattern'
          ? '匹配到 pattern'
          : result.reason === 'idle'
            ? '输出静默'
            : result.reason === 'exited'
              ? '进程退出'
              : '等待超时';
      return [
        `session: ${input.session_id}`,
        `result: ${result.matched ? 'matched' : 'not_matched'}`,
        `reason: ${reasonText}`,
        `exited: ${result.exited}`,
        `total_bytes: ${result.totalBytes}`,
        ``,
        `--- output (tail) ---`,
        result.output.length ? result.output : '(no output)',
      ].join('\n');
    } catch (error) {
      return `pty_wait 失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `pty wait ${truncateDisplayText(String(input.pattern ?? ''), 20)} @ ${truncateDisplayText(String(input.session_id ?? ''), 10)}`;
  }
}
