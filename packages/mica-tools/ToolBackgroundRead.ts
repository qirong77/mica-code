import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import {
  cleanBackgroundTaskOutput,
  loadBackgroundTask,
  readBackgroundTaskOutput,
} from './ToolRunShellBackground.js';
import { truncateDisplayText } from './utils/display.js';
import { clampNumber } from './utils/outputLimits.js';

const DEFAULT_MAX_BYTES = 20_000;
const HARD_MAX_BYTES = 200_000;

const DESCRIPTION = [
  '读取 background_tasks_start 启动的后台任务的输出与状态，默认返回最新输出。',
  '',
  '默认取尾部；需要从中间续读时传 `offset`（配合上次返回的 `next_offset`），或直接给 `tail_bytes`。',
  '只看状态不读内容时用 `background_tasks_list`；要等任务结束再读时先用 `wait_for(kind="task")`。',
].join('\n');

export class ToolBackgroundRead extends MicaTool {
  constructor() {
    super(
      'background_tasks_read',
      DESCRIPTION,
      {
        type: 'object' as const,
        properties: {
          task_id: { type: 'string', description: '后台任务 ID。' },
          offset: { type: 'number', description: '从输出文件的字节偏移开始读取。' },
          max_bytes: {
            type: 'number',
            description: `最多读取字节数，默认 ${DEFAULT_MAX_BYTES}，最大 ${HARD_MAX_BYTES}。`,
          },
          tail_bytes: { type: 'number', description: '从输出末尾读取的字节数；传入后优先于 offset。' },
        },
        required: ['task_id'],
      },
      { readOnly: true },
    );
  }

  async execute(
    input: { task_id: string; offset?: number; max_bytes?: number; tail_bytes?: number },
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const meta = loadBackgroundTask(input.task_id);
    if (!meta) return `未知后台任务: ${input.task_id}`;

    const maxBytes = clampNumber(input.max_bytes, DEFAULT_MAX_BYTES, 1, HARD_MAX_BYTES);
    const tailBytes =
      input.tail_bytes === undefined ? maxBytes : clampNumber(input.tail_bytes, maxBytes, 1, HARD_MAX_BYTES);
    const offset = clampNumber(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const range = readBackgroundTaskOutput(meta, {
      offset,
      maxBytes,
      tailBytes: input.tail_bytes === undefined && input.offset !== undefined ? undefined : tailBytes,
    });

    const finished = meta.status !== 'starting' && meta.status !== 'running';
    const header = [
      `Task ${meta.id}`,
      `status: ${meta.status}`,
      `pid: ${meta.pid ?? 'unknown'}`,
      `command: ${meta.command}`,
      `output: ${meta.output_path}`,
      `bytes: ${range.start}-${range.end} of ${range.size}`,
      finished ? `exit_code: ${meta.exit_code ?? 'null'}` : undefined,
      finished ? `signal: ${meta.signal ?? 'null'}` : undefined,
      range.end < range.size ? `next_offset: ${range.end}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');

    // 与 TUI / 桌面 / `wait_for(kind=task)` 保持同一份投影：任务簿记行
    // （spawned / kill requested / exited）不属于命令输出，不该喂给模型。
    const output = cleanBackgroundTaskOutput(range.content);
    return `${header}\n\n--- output ---\n${output || '(no output)'}`;
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `read task ${truncateDisplayText(String(input.task_id ?? ''), 10)}`;
  }
}
