import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import { loadBackgroundTask, readBackgroundTaskOutput } from './ToolRunShellBackground.js';
import { truncateDisplayText } from './utils/display.js';
import { clampNumber, formatSize } from './utils/outputLimits.js';

const DEFAULT_MAX_BYTES = 20_000;
const HARD_MAX_BYTES = 200_000;

export class ToolReadTaskOutput extends MicaTool {
  constructor() {
    super('read_task_output', '读取 run_shell 后台任务输出，默认返回最新输出。', {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: '后台任务 ID。' },
        offset: { type: 'number', description: '从输出文件的字节偏移开始读取。' },
        max_bytes: { type: 'number', description: `最多读取字节数，默认 ${DEFAULT_MAX_BYTES}，最大 ${HARD_MAX_BYTES}。` },
        tail_bytes: { type: 'number', description: '从输出末尾读取的字节数；传入后优先于 offset。' },
      },
      required: ['task_id'],
    });
  }

  async execute(
    input: { task_id: string; offset?: number; max_bytes?: number; tail_bytes?: number },
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const meta = loadBackgroundTask(input.task_id);
    if (!meta) return `未知后台任务: ${input.task_id}`;

    const maxBytes = clampNumber(input.max_bytes, DEFAULT_MAX_BYTES, 1, HARD_MAX_BYTES);
    const tailBytes = input.tail_bytes === undefined ? maxBytes : clampNumber(input.tail_bytes, maxBytes, 1, HARD_MAX_BYTES);
    const offset = clampNumber(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const range = readBackgroundTaskOutput(meta, {
      offset,
      maxBytes,
      tailBytes: input.tail_bytes === undefined && input.offset !== undefined ? undefined : tailBytes,
    });

    const header = [
      `Task ${meta.id}`,
      `status: ${meta.status}`,
      `pid: ${meta.pid ?? 'unknown'}`,
      `command: ${meta.command}`,
      `output: ${meta.output_path}`,
      `bytes: ${range.start}-${range.end} of ${range.size}`,
      range.end < range.size ? `next_offset: ${range.end}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');

    return `${header}\n\n--- output ---\n${range.content || '(no output)'}`;
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `read task ${truncateDisplayText(String(input.task_id ?? ''), 10)}`;
  }
}
