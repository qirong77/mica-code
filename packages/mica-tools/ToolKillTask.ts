import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import { killBackgroundTask } from './ToolRunShellBackground.js';
import { truncateDisplayText } from './utils/display.js';
import { clampNumber } from './utils/outputLimits.js';

const DEFAULT_FORCE_AFTER_MS = 5_000;
const HARD_FORCE_AFTER_MS = 30_000;
const ALLOWED_SIGNALS = new Set<NodeJS.Signals>(['SIGTERM', 'SIGKILL', 'SIGINT']);

export class ToolKillTask extends MicaTool {
  constructor() {
    super('kill_task', '终止 run_shell 启动的后台任务。', {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: '后台任务 ID。' },
        signal: { type: 'string', description: '终止信号：SIGTERM、SIGKILL 或 SIGINT。默认 SIGTERM。' },
        force_after_ms: {
          type: 'number',
          description: `发送非 SIGKILL 信号后等待多久再强制 SIGKILL，默认 ${DEFAULT_FORCE_AFTER_MS}，最大 ${HARD_FORCE_AFTER_MS}。传 0 表示不自动强杀。`,
        },
      },
      required: ['task_id'],
    });
  }

  async execute(
    input: { task_id: string; signal?: string; force_after_ms?: number },
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const signal = normalizeSignal(input.signal);
    if (!signal) return `无效 signal: ${input.signal}`;

    const forceAfterMs = clampNumber(input.force_after_ms, DEFAULT_FORCE_AFTER_MS, 0, HARD_FORCE_AFTER_MS);
    const result = await killBackgroundTask(input.task_id, signal, forceAfterMs);
    const meta = result.meta;
    const details = meta
      ? [`id: ${meta.id}`, `status: ${meta.status}`, `pid: ${meta.pid ?? 'unknown'}`, `output: ${meta.output_path}`].join('\n')
      : '';
    return details ? `${result.message}\n${details}` : result.message;
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `kill task ${truncateDisplayText(String(input.task_id ?? ''), 10)}`;
  }
}

function normalizeSignal(value: string | undefined): NodeJS.Signals | undefined {
  const signal = (value || 'SIGTERM') as NodeJS.Signals;
  return ALLOWED_SIGNALS.has(signal) ? signal : undefined;
}
