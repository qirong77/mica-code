import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';
import { daysBetween, todayOf } from './dates.js';
import { applyOperation, formatSchedule, newId, type ScheduleData, type ScheduleOperation } from './schedule.js';
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
 * 东西抹掉的做法，而模型本来也不需要知道别的计划长什么样。
 */

const OPERATIONS = [
  'list',
  'add_plan',
  'update_plan',
  'delete_plan',
  'add_stage',
  'update_stage',
  'delete_stage',
] as const;

type Operation = (typeof OPERATIONS)[number];

const DESCRIPTION = [
  'Read and edit the local schedule (the gantt page "Schedule" in this app). The schedule is independent local data — it has nothing to do with any chat app.',
  'Layout: plans are rows (one project / topic each); each plan has stages (bars with a start and end date).',
  "Always call operation=list first: it returns every plan_id and stage_id together with today's date. Dates are plain `YYYY-MM-DD`; a stage covers its start and end day.",
  'Writes are per item (by id), so unrelated plans are never touched. To reschedule a stage use update_stage with the new start/end; to add work use add_stage.',
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
            'list = read the whole schedule. add_plan = create a plan. update_plan = rename or change the note. delete_plan = remove a plan and its stages. add_stage = add a stage to a plan. update_stage = rename or reschedule a stage. delete_stage = remove one stage.',
        },
        plan_id: {
          type: 'string',
          description: 'Plan id from `list` (required by add_stage / update_plan / delete_plan).',
        },
        stage_id: { type: 'string', description: 'Stage id from `list` (required by update_stage / delete_stage).' },
        name: {
          type: 'string',
          description: 'Plan or stage name, e.g. "钱包改版", "联调", "上线". Required by add_plan / add_stage.',
        },
        note: { type: 'string', description: 'Plan note (optional; empty string clears it).' },
        start: { type: 'string', description: 'Start date `YYYY-MM-DD` (required by add_stage).' },
        end: {
          type: 'string',
          description:
            'End date `YYYY-MM-DD`, inclusive. Defaults to `start` for add_stage; defaults to the current end for update_stage.',
        },
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
      const request = toScheduleOperation(operation, input);
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
      case 'add_plan':
        return `Adding plan ${String(input.name ?? '')}`.trim();
      case 'update_plan':
        return 'Updating plan';
      case 'delete_plan':
        return 'Deleting plan';
      case 'add_stage':
        return `Adding stage ${String(input.name ?? '')}`.trim();
      case 'update_stage':
        return 'Rescheduling';
      case 'delete_stage':
        return 'Deleting stage';
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

/** 把工具入参翻成一条写操作。校验只做「字段齐不齐」，日期合法性在 `applyOperation` 里。 */
function toScheduleOperation(operation: Operation, input: ToolInput): ScheduleOperation {
  switch (operation) {
    case 'add_plan':
      return {
        type: 'add-plan',
        plan: { id: newId('p'), name: readString(input, 'name', true)!, note: readNote(input) ?? '', stages: [] },
      };
    case 'update_plan':
      return {
        type: 'update-plan',
        planId: readString(input, 'plan_id', true)!,
        name: readString(input, 'name', false),
        note: readNote(input),
      };
    case 'delete_plan':
      return { type: 'delete-plan', planId: readString(input, 'plan_id', true)! };
    case 'add_stage': {
      const start = readString(input, 'start', true)!;
      return {
        type: 'add-stage',
        planId: readString(input, 'plan_id', true)!,
        stage: {
          id: newId('s'),
          name: readString(input, 'name', true)!,
          start,
          end: readString(input, 'end', false) ?? start,
        },
      };
    }
    case 'update_stage':
      return {
        type: 'update-stage',
        stageId: readString(input, 'stage_id', true)!,
        name: readString(input, 'name', false),
        start: readString(input, 'start', false),
        end: readString(input, 'end', false),
      };
    case 'delete_stage':
      return { type: 'delete-stage', stageId: readString(input, 'stage_id', true)! };
    default:
      throw new Error(`operation ${operation} 不需要写盘`);
  }
}

function findPlan(data: ScheduleData, planId: string) {
  return data.plans.find((plan) => plan.id === planId);
}

function findStage(data: ScheduleData, stageId: string) {
  for (const plan of data.plans) {
    const stage = plan.stages.find((item) => item.id === stageId);
    if (stage) return { plan, stage };
  }
  return null;
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
    case 'add-plan': {
      const plan = findPlan(after, operation.plan.id)!;
      return `已新建计划「${plan.name}」（${plan.id}）`;
    }
    case 'update-plan': {
      const plan = findPlan(after, operation.planId)!;
      const previous = findPlan(before, operation.planId);
      if (previous && previous.name !== plan.name) return `计划已改名为「${plan.name}」`;
      return plan.note ? `已更新计划「${plan.name}」的备注` : `已清空计划「${plan.name}」的备注`;
    }
    case 'delete-plan': {
      const plan = findPlan(before, operation.planId)!;
      return `已删除计划「${plan.name}」${plan.stages.length > 0 ? `（含 ${plan.stages.length} 条阶段）` : ''}`;
    }
    case 'add-stage': {
      const found = findStage(after, operation.stage.id);
      const plan = found ? found.plan.name : '';
      const stage = found?.stage ?? operation.stage;
      return `已在「${plan}」加了一条「${stage.name}」：${span(stage.start, stage.end)}`;
    }
    case 'update-stage': {
      const previous = findStage(before, operation.stageId)!.stage;
      const stage = findStage(after, operation.stageId)!.stage;
      if (previous.start !== stage.start || previous.end !== stage.end) {
        return `「${stage.name}」改成 ${span(stage.start, stage.end)}${stage.end < today ? '（已结束）' : ''}`;
      }
      if (previous.name !== stage.name) return `阶段已改名为「${stage.name}」`;
      return `「${stage.name}」没有变化`;
    }
    case 'delete-stage': {
      const stage = findStage(before, operation.stageId)!.stage;
      return `已删除阶段「${stage.name}」（${span(stage.start, stage.end)}）`;
    }
  }
}
