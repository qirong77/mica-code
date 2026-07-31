import { MicaTool } from '../MicaTool.js';
import type { ToolExecuteCallbacks } from '../MicaTool.js';
import { truncateDisplayText } from '../utils/display.js';
import { getPtyManager } from './shared.js';

export class ToolPtyKill extends MicaTool {
  constructor() {
    super('pty_kill', '终止 PTY 会话对应的子进程并清理会话。默认 SIGTERM，超时后升级 SIGKILL。', {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string', description: 'pty_spawn 返回的会话 ID。' },
        signal: { type: 'string', description: '终止信号，默认 SIGTERM。' },
        force_after_ms: { type: 'number', description: '升级为 SIGKILL 的等待毫秒，默认 3000。' },
      },
      required: ['session_id'],
    });
  }

  async execute(
    input: { session_id: string; signal?: string; force_after_ms?: number },
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    try {
      const manager = await getPtyManager();
      const forceAfterMs = Math.max(0, Math.min(input.force_after_ms ?? 3_000, 30_000));
      await manager.kill(input.session_id, input.signal ?? 'SIGTERM', forceAfterMs);
      return `会话 ${input.session_id} 已终止`;
    } catch (error) {
      return `pty_kill 失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `pty kill ${truncateDisplayText(String(input.session_id ?? ''), 10)}`;
  }
}
