import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import {
  getBackgroundTaskOutputSize,
  listBackgroundTasks,
  type BackgroundTaskStatus,
} from './ToolRunShellBackground.js';
import { truncateDisplayText } from './utils/display.js';
import { clampNumber, formatSize } from './utils/outputLimits.js';

const DEFAULT_LIMIT = 50;
const HARD_LIMIT = 200;

function formatAge(startedAt: string, finishedAt?: string): string {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return 'unknown';
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export class ToolBackgroundTasks extends MicaTool {
  constructor() {
    super('background_tasks', '列出 run_shell 后台任务。', {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description: '过滤任务状态：running、finished、killed、failed、unknown_exited 或 all。默认 all。',
        },
        limit: { type: 'number', description: `最多返回任务数，默认 ${DEFAULT_LIMIT}，最大 ${HARD_LIMIT}。` },
      },
    });
  }

  async execute(input: { status?: string; limit?: number }, _callbacks?: ToolExecuteCallbacks): Promise<string> {
    const status = normalizeStatus(input.status);
    if (!status) return `无效 status: ${input.status}`;

    const limit = clampNumber(input.limit, DEFAULT_LIMIT, 1, HARD_LIMIT);
    const tasks = listBackgroundTasks({ status, limit });
    if (tasks.length === 0) return '没有后台任务。';

    const header = `${pad('id', 12)}  ${pad('status', 14)}  ${pad('pid', 7)}  ${pad('age', 8)}  ${pad('output', 9)}  command`;
    const rows = tasks.map((task) => {
      const outputSize = formatSize(getBackgroundTaskOutputSize(task));
      const pid = task.pid ? String(task.pid) : '-';
      return `${pad(task.id, 12)}  ${pad(task.status, 14)}  ${pad(pid, 7)}  ${pad(formatAge(task.started_at, task.finished_at), 8)}  ${pad(outputSize, 9)}  ${truncateDisplayText(task.command, 72)}`;
    });

    return [
      header,
      ...rows,
      '',
      '使用 read_task_output(task_id="...") 查看输出；使用 kill_task(task_id="...") 终止运行中的任务。',
    ].join('\n');
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const status = typeof input.status === 'string' ? input.status : 'all';
    return `background tasks (${status})`;
  }
}

function normalizeStatus(value: string | undefined): BackgroundTaskStatus | 'all' | undefined {
  if (value === undefined || value === '' || value === 'all') return 'all';
  if (
    value === 'starting' ||
    value === 'running' ||
    value === 'finished' ||
    value === 'killed' ||
    value === 'failed' ||
    value === 'unknown_exited'
  ) {
    return value;
  }
  return undefined;
}
