import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';
import { daysBetween, todayOf } from './dates.js';
import { COLOR_KEYS, COLOR_META, isScheduleColor, type ScheduleColor } from './palette.js';
import {
  applyOperation,
  formatSchedule,
  newId,
  type ScheduleData,
  type ScheduleOperation,
  type ScheduleTask,
} from './schedule.js';
import { mutateSchedule, readScheduleData } from './store.js';

/**
 * `schedule` 工具：让模型直接读改这台机器上的排期。
 *
 * 排期是插件自己的数据（`plugin-data/schedule/data.json`），和任何聊天工具都无关；工具是
 * 除桌面端页面之外的第二个入口——用户说「把联调推到下周」，模型读一次、改一条就完事，
 * 不需要用户自己去拖。写盘走 `mutateSchedule`：与页面共用同一把锁与同一条原子写，
 * 所以两边同时改不会互相覆盖。
 *
 * 操作按 id 定位、只改一条，而不是「把整份排期交回去」：整份覆盖是最容易把别人刚改的
 * 东西抹掉的做法，而模型本来也不需要知道别的任务长什么样。
 */

const OPERATIONS = ['list', 'add_task', 'update_task', 'delete_task'] as const;

type Operation = (typeof OPERATIONS)[number];

const DESCRIPTION = [
  'Read and edit the local schedule (the gantt page "Schedule" in this app). The schedule is independent local data — it has nothing to do with any chat app.',
  'Every task has a name, a start and end date, a color, and an optional Markdown note. Tasks with the same color are drawn on one row; the color only groups rows visually.',
  "Always call operation=list first: it returns every task_id together with today's date and a status relative to today. Dates are plain `YYYY-MM-DD`; a task covers its start and end day.",
  `Writes are per item (by id), so unrelated tasks are never touched. To reschedule use update_task with the new start/end; to add work use add_task. Colors: ${COLOR_KEYS.join(
    ' / ',
  )} (default blue).`,
  'After writing, report the change to the user in one short sentence — do not paste the whole schedule unless they asked to see it.',
].join(' ');

export class ScheduleTool extends MicaTool {
  constructor(private readonly dataFile: string) {
    super('schedule', DESCRIPTION, {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [...OPERATIONS],
          description:
            'list = read the whole schedule. add_task = create a task. update_task = rename, reschedule, recolor or change the note. delete_task = remove one task.',
        },
        task_id: { type: 'string', description: 'Task id from `list` (required by update_task / delete_task).' },
        name: { type: 'string', description: 'Task name, e.g. "联调", "上线", "客户验收". Required by add_task.' },
        start: { type: 'string', description: 'Start date `YYYY-MM-DD` (required by add_task).' },
        end: {
          type: 'string',
          description:
            'End date `YYYY-MM-DD`, inclusive. Defaults to `start` for add_task; defaults to the current end for update_task.',
        },
        color: {
          type: 'string',
          enum: [...COLOR_KEYS],
          description: 'Row color. Defaults to blue for add_task; unchanged for update_task.',
        },
        note: { type: 'string', description: 'Markdown note (optional; empty string clears it).' },
      },
      required: ['operation'],
      additionalProperties: false,
    });
  }

  async execute(input: ToolInput, _callbacks?: ToolExecuteCallbacks): Promise<string> {
    const operation = readOperation(input);
    const today = todayOf();
    if (operation === 'list') {
      return formatSchedule(readScheduleData(this.dataFile), today);
    }

    const message = await mutateSchedule(this.dataFile, (data) => {
      const request = toScheduleOperation(operation, input, data.tasks.length);
      const next = applyOperation(data, request);
      return { data: next, message: describeOperation(request, data, next, today) };
    });
    const saved = readScheduleData(this.dataFile);
    return `${message}\n\n${formatSchedule(saved, today)}`;
  }

  onToolUseDisplayText(input: ToolInput): string {
    switch (input.operation) {
      case 'list':
        return 'Reading schedule';
      case 'add_task':
        return `Adding task ${String(input.name ?? '')}`.trim();
      case 'update_task':
        return 'Updating task';
      case 'delete_task':
        return 'Deleting task';
      default:
        return 'Updating schedule';
    }
  }
}

function readOperation(input: ToolInput): Operation {
  const value = input.operation;
  if (typeof value === 'string' && (OPERATIONS as readonly string[]).includes(value)) return value as Operation;
  throw new Error(`operation 只能是 ${OPERATIONS.join(' / ')}`);
}

function readString(input: ToolInput, key: string, required: boolean): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (required) throw new Error(`缺少 ${key}`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${key} 应该是字符串`);
  const text = value.trim();
  if (!text) {
    if (required) throw new Error(`${key} 不能为空`);
    return undefined;
  }
  return text;
}

/** 备注允许空串（＝清空），所以不能走 `readString`：那个把空串当成「没传」。 */
function readNote(input: ToolInput): string | undefined {
  const value = input.note;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('note 应该是字符串');
  return value.trim();
}

function readColor(input: ToolInput): ScheduleColor | undefined {
  const value = input.color;
  if (value === undefined || value === null || value === '') return undefined;
  if (!isScheduleColor(value)) throw new Error(`color 只能是 ${COLOR_KEYS.join(' / ')}`);
  return value;
}

/** 把工具入参翻成一条写操作。校验只做「字段齐不齐」，日期合法性在 `applyOperation` 里。 */
function toScheduleOperation(operation: Operation, input: ToolInput, taskCount: number): ScheduleOperation {
  switch (operation) {
    case 'add_task': {
      const name = readString(input, 'name', true)!;
      const start = readString(input, 'start', true)!;
      const task: ScheduleTask = {
        id: newId(),
        name,
        start,
        end: readString(input, 'end', false) ?? start,
        // 模型没指定颜色时换着用，和页面里「新建任务」的默认行为一致
        color: readColor(input) ?? COLOR_KEYS[taskCount % COLOR_KEYS.length]!,
        note: readNote(input) ?? '',
      };
      return { type: 'add-task', task };
    }
    case 'update_task':
      return {
        type: 'update-task',
        taskId: readString(input, 'task_id', true)!,
        name: readString(input, 'name', false),
        start: readString(input, 'start', false),
        end: readString(input, 'end', false),
        color: readColor(input),
        note: readNote(input),
      };
    case 'delete_task':
      return { type: 'delete-task', taskId: readString(input, 'task_id', true)! };
    default:
      throw new Error(`operation ${operation} 不需要写盘`);
  }
}

function findTask(data: ScheduleData, taskId: string): ScheduleTask | undefined {
  return data.tasks.find((task) => task.id === taskId);
}

function span(start: string, end: string): string {
  const days = daysBetween(start, end) + 1;
  return days <= 1 ? start : `${start} → ${end}（${days} 天）`;
}

/**
 * 改动说明：给用户和模型看的一句话。
 *
 * 描述用**改动前后**算，所以像「把测试往后挪两天」这种挪动，模型与用户看到的是具体日期，
 * 而不是「已更新」——后者没法核对。
 */
function describeOperation(
  operation: ScheduleOperation,
  before: ScheduleData,
  after: ScheduleData,
  today: string,
): string {
  switch (operation.type) {
    case 'add-task': {
      const task = findTask(after, operation.task.id)!;
      return `已添加任务「${task.name}」：${span(task.start, task.end)}`;
    }
    case 'update-task': {
      const previous = findTask(before, operation.taskId)!;
      const task = findTask(after, operation.taskId)!;
      if (previous.start !== task.start || previous.end !== task.end) {
        return `「${task.name}」改成 ${span(task.start, task.end)}${task.end < today ? '（已结束）' : ''}`;
      }
      if (previous.name !== task.name) return `任务已改名为「${task.name}」`;
      if (previous.color !== task.color) return `「${task.name}」的颜色改成${COLOR_META[task.color].label}`;
      if (previous.note !== task.note) {
        return task.note ? `已更新任务「${task.name}」的备注` : `已清空任务「${task.name}」的备注`;
      }
      return `「${task.name}」没有变化`;
    }
    case 'delete-task': {
      const task = findTask(before, operation.taskId)!;
      return `已删除任务「${task.name}」（${span(task.start, task.end)}）`;
    }
    default:
      return '已更新排期';
  }
}
