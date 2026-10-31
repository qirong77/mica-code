import { daysBetween, formatStamp, isValidDate, isValidRange, todayOf } from './dates.js';

/**
 * 排期的数据模型与全部写操作。
 *
 * 排期是**插件自己的数据**，不再从群公告里读：一行是一个计划（项目 / 主题），行里的条
 * 是它的阶段。界面拖拽与模型经 `schedule` 工具改的都是同一份 `data.json`，改法都是这里的
 * 几条操作——两边各写一套迟早会写出两种语义（一边允许交叉、一边拒绝之类）。
 *
 * 这个文件也被渲染层直接用，所以不能 import 任何 node 模块。
 */

export const SCHEDULE_VERSION = 1;
export const MAX_PLANS = 40;
export const MAX_STAGES_PER_PLAN = 40;
export const MAX_NAME_LENGTH = 40;
export const MAX_NOTE_LENGTH = 200;

/** 新建阶段时给用户挑的常用名字；阶段名本身是自由的，颜色按名字猜。 */
export const STAGE_NAMES = [
  '评审',
  '开发',
  '联调',
  '提测',
  'case 评审',
  '测试',
  '验收',
  '走查',
  '上线',
  'showcase',
] as const;

export type ScheduleStage = {
  id: string;
  /** 显示名，如「联调」「上线」；也决定条的配色。 */
  name: string;
  /** `YYYY-MM-DD`，含首尾。 */
  start: string;
  end: string;
};

export type SchedulePlan = {
  id: string;
  name: string;
  /** 备注，可空。 */
  note: string;
  stages: ScheduleStage[];
};

export type ScheduleData = {
  version: number;
  /** 最近一次写盘时间（毫秒，0 表示从来没写过）。 */
  updatedAtMs: number;
  /** 同上，给人看：`10-29 20:40`。配置页的「运行状态」读它。 */
  updatedAt: string;
  /** 给人看的一句话：`3 个计划 · 12 条阶段`。配置页的「运行状态」读它。 */
  summary: string;
  plans: SchedulePlan[];
};

export function emptyData(): ScheduleData {
  return {
    version: SCHEDULE_VERSION,
    updatedAtMs: 0,
    updatedAt: '',
    summary: '',
    plans: [],
  };
}

/**
 * 本地 id。
 *
 * 不用 `node:crypto`：这个模块要进渲染层。时间戳 + 随机后缀在单机一份排期里够用
 * （同一毫秒连建两条也不会撞），而且 id 只在本地被引用，不需要全局唯一。
 */
export function newId(prefix: 'p' | 's'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function summarize(plans: SchedulePlan[]): string {
  if (plans.length === 0) return '还没有计划';
  const stages = plans.reduce((sum, plan) => sum + plan.stages.length, 0);
  return `${plans.length} 个计划 · ${stages} 条阶段`;
}

/** 写盘前打一次时间戳与摘要：界面顶部和配置页的运行状态都读这两个字段。 */
export function stamp(data: ScheduleData, now: Date = new Date()): ScheduleData {
  return {
    ...data,
    version: SCHEDULE_VERSION,
    updatedAtMs: now.getTime(),
    updatedAt: formatStamp(now),
    summary: summarize(data.plans),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/**
 * 读回的数据一律过一遍这里。
 *
 * 这份文件可能被别的版本写过、被 `$MICA_HOME` 拷来拷去、也可能被手改坏：认不出的部分
 * 丢掉，能显示的照常显示——一条坏阶段不该让整张时间线消失。
 */
export function normalizeData(value: unknown): ScheduleData {
  const record = asRecord(value);
  if (!record) return emptyData();
  const seenPlans = new Set<string>();
  const seenStages = new Set<string>();
  const plans: SchedulePlan[] = [];
  for (const entry of asArray(record.plans)) {
    const plan = asRecord(entry);
    if (!plan) continue;
    const id = text(plan.id, MAX_NAME_LENGTH);
    const name = text(plan.name, MAX_NAME_LENGTH);
    if (!id || !name || seenPlans.has(id)) continue;
    seenPlans.add(id);
    const stages: ScheduleStage[] = [];
    for (const item of asArray(plan.stages)) {
      const stage = asRecord(item);
      if (!stage) continue;
      const stageId = text(stage.id, MAX_NAME_LENGTH);
      const stageName = text(stage.name, MAX_NAME_LENGTH);
      const start = text(stage.start, 10);
      const end = text(stage.end, 10) || start;
      if (!stageId || !stageName || seenStages.has(stageId)) continue;
      if (!isValidRange(start, end)) continue;
      seenStages.add(stageId);
      stages.push({ id: stageId, name: stageName, start, end });
    }
    plans.push({ id, name, note: text(plan.note, MAX_NOTE_LENGTH), stages });
  }
  return {
    version: typeof record.version === 'number' ? record.version : SCHEDULE_VERSION,
    updatedAtMs: typeof record.updatedAtMs === 'number' ? record.updatedAtMs : 0,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    summary: typeof record.summary === 'string' ? record.summary : summarize(plans),
    plans,
  };
}

/* ------------------------------------------------------------------ 写操作 */

/**
 * 一次改动。
 *
 * 界面与工具都把它交给同一条写盘路径：按 id 定位、只改这一条，别的条（可能是另一个窗口
 * 或模型刚改的）原样保留。所以操作里带的是「目标改成什么」，不是「整份数据长什么样」。
 */
export type ScheduleOperation =
  | { type: 'add-plan'; plan: SchedulePlan }
  | { type: 'update-plan'; planId: string; name?: string; note?: string }
  | { type: 'delete-plan'; planId: string }
  | { type: 'add-stage'; planId: string; stage: ScheduleStage }
  | { type: 'update-stage'; stageId: string; name?: string; start?: string; end?: string }
  | { type: 'delete-stage'; stageId: string };

function requireName(value: string | undefined): string {
  const name = (value ?? '').trim();
  if (!name) throw new Error('名称不能为空');
  if (name.length > MAX_NAME_LENGTH) throw new Error(`名称最多 ${MAX_NAME_LENGTH} 个字`);
  return name;
}

function requireRange(start: string, end: string): { start: string; end: string } {
  if (!isValidDate(start)) throw new Error(`开始日期不是有效日期：${start || '（空）'}，要 YYYY-MM-DD`);
  if (!isValidDate(end)) throw new Error(`结束日期不是有效日期：${end || '（空）'}，要 YYYY-MM-DD`);
  if (daysBetween(start, end) < 0) throw new Error('结束日期不能早于开始日期');
  return { start, end };
}

function findPlan(data: ScheduleData, planId: string): SchedulePlan {
  const plan = data.plans.find((item) => item.id === planId);
  if (!plan) throw new Error('这个计划已经不在了（可能刚被删掉），先重新读一次排期');
  return plan;
}

function findStage(data: ScheduleData, stageId: string): { plan: SchedulePlan; stage: ScheduleStage } {
  for (const plan of data.plans) {
    const stage = plan.stages.find((item) => item.id === stageId);
    if (stage) return { plan, stage };
  }
  throw new Error('这条阶段已经不在了（可能刚被删掉），先重新读一次排期');
}

/**
 * 把一次操作应用到数据上，返回新数据；不修改入参。
 *
 * 计划 / 阶段已经不在时抛错而不是静默跳过：界面上是「刚被别的窗口删了」，工具那边是
 * 「你手里的 id 过期了」，两种都该让人看见，而不是改了个寂寞。
 */
export function applyOperation(data: ScheduleData, operation: ScheduleOperation): ScheduleData {
  switch (operation.type) {
    case 'add-plan': {
      const name = requireName(operation.plan.name);
      const note = (operation.plan.note ?? '').slice(0, MAX_NOTE_LENGTH);
      const existing = data.plans.find((plan) => plan.id === operation.plan.id);
      if (existing) {
        return {
          ...data,
          plans: data.plans.map((plan) => (plan.id === existing.id ? { ...plan, name, note } : plan)),
        };
      }
      if (data.plans.length >= MAX_PLANS) throw new Error(`计划最多 ${MAX_PLANS} 个`);
      return { ...data, plans: [...data.plans, { id: operation.plan.id, name, note, stages: [] }] };
    }
    case 'update-plan': {
      const plan = findPlan(data, operation.planId);
      const name = operation.name === undefined ? plan.name : requireName(operation.name);
      const note = operation.note === undefined ? plan.note : operation.note.slice(0, MAX_NOTE_LENGTH);
      return {
        ...data,
        plans: data.plans.map((item) => (item.id === plan.id ? { ...item, name, note } : item)),
      };
    }
    case 'delete-plan':
      findPlan(data, operation.planId);
      return { ...data, plans: data.plans.filter((plan) => plan.id !== operation.planId) };
    case 'add-stage': {
      const plan = findPlan(data, operation.planId);
      const name = requireName(operation.stage.name);
      const range = requireRange(operation.stage.start, operation.stage.end || operation.stage.start);
      const stage: ScheduleStage = { id: operation.stage.id, name, ...range };
      // 同一次操作重放（写盘超时后重试）不该变成两条
      const replaced = plan.stages.some((item) => item.id === stage.id);
      if (!replaced && plan.stages.length >= MAX_STAGES_PER_PLAN) {
        throw new Error(`一个计划最多 ${MAX_STAGES_PER_PLAN} 条阶段`);
      }
      return {
        ...data,
        plans: data.plans.map((item) => {
          if (item.id !== plan.id) return item;
          return {
            ...item,
            stages: replaced
              ? item.stages.map((existing) => (existing.id === stage.id ? stage : existing))
              : [...item.stages, stage],
          };
        }),
      };
    }
    case 'update-stage': {
      const { plan, stage } = findStage(data, operation.stageId);
      const name = operation.name === undefined ? stage.name : requireName(operation.name);
      const range = requireRange(operation.start ?? stage.start, operation.end ?? stage.end);
      const next: ScheduleStage = { id: stage.id, name, ...range };
      return {
        ...data,
        plans: data.plans.map((item) =>
          item.id === plan.id
            ? { ...item, stages: item.stages.map((existing) => (existing.id === stage.id ? next : existing)) }
            : item,
        ),
      };
    }
    case 'delete-stage': {
      const { plan, stage } = findStage(data, operation.stageId);
      return {
        ...data,
        plans: data.plans.map((item) =>
          item.id === plan.id ? { ...item, stages: item.stages.filter((existing) => existing.id !== stage.id) } : item,
        ),
      };
    }
  }
}

/* ------------------------------------------------------------------ 给模型看 */

function daysLabel(start: string, end: string): string {
  const span = daysBetween(start, end) + 1;
  return span <= 1 ? '1 天' : `${span} 天`;
}

/** 一条阶段的相对时间提示：正在走 / 还有几天 / 已结束。 */
export function stageHint(stage: Pick<ScheduleStage, 'start' | 'end'>, today: string): string {
  const toStart = daysBetween(today, stage.start);
  const toEnd = daysBetween(today, stage.end);
  if (toStart > 0) return toStart === 1 ? '明天开始' : `${toStart} 天后开始`;
  if (toEnd < 0) return `已结束 ${-toEnd} 天`;
  return `进行中，第 ${daysBetween(stage.start, today) + 1}/${daysBetween(stage.start, stage.end) + 1} 天`;
}

/** 工具回复里的排期：id 与日期都写全，模型下一句话就能直接拿 id 去改。 */
export function formatSchedule(data: ScheduleData, today: string = todayOf()): string {
  if (data.plans.length === 0) return `今天 ${today}\n排期是空的（还没有任何计划）。`;
  const lines = [`今天 ${today}`];
  data.plans.forEach((plan, index) => {
    lines.push(`${index + 1}. ${plan.name}（${plan.id}）${plan.note ? ` — ${plan.note}` : ''}`);
    if (plan.stages.length === 0) {
      lines.push('   （还没有阶段，用 add_stage 往里加）');
      return;
    }
    const stages = [...plan.stages].sort((left, right) => left.start.localeCompare(right.start));
    for (const stage of stages) {
      const range = stage.start === stage.end ? stage.start : `${stage.start} → ${stage.end}`;
      lines.push(
        `   - ${stage.name}｜${range}｜${daysLabel(stage.start, stage.end)}｜${stageHint(stage, today)}｜${stage.id}`,
      );
    }
  });
  return lines.join('\n');
}
