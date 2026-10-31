import { addDays, daysBetween, formatStamp, isValidDate, isValidRange, startOfWeek, todayOf } from './dates.js';
import { COLOR_KEYS, isScheduleColor, normalizeColor, type ScheduleColor } from './palette.js';

/**
 * 排期的数据模型与全部写操作。
 *
 * 一份排期就是一串任务：每条有名字、起止日期、颜色和 Markdown 备注。同色的任务在页面里
 * 排成同一行，所以颜色也是数据的一部分，而不是显示时从名字临时猜出来的。
 *
 * 界面拖拽与模型经 `schedule` 工具改的都是同一份 `data.json`，改法都是这里的几条操作——
 * 两边各写一套迟早会写出两种语义。
 *
 * 这个文件也被渲染层直接用，所以不能 import 任何 node 模块。
 */

export const SCHEDULE_VERSION = 1;
export const MAX_TASKS = 300;
export const MAX_NAME_LENGTH = 60;
export const MAX_NOTE_LENGTH = 4000;
export const MAX_TITLE_LENGTH = 40;
export const DEFAULT_TITLE = '我的排期';

export const SCALES = ['day', 'week', 'month'] as const;
export type ScheduleScale = (typeof SCALES)[number];

export type ScheduleTask = {
  id: string;
  /** 显示名，如「联调」「上线」。 */
  name: string;
  /** `YYYY-MM-DD`，含首尾。 */
  start: string;
  end: string;
  /** 同色的任务排在同一行。 */
  color: ScheduleColor;
  /** Markdown 备注，可空。 */
  note: string;
};

export type ScheduleData = {
  version: number;
  /** 最近一次写盘时间（毫秒，0 表示从来没写过）。 */
  updatedAtMs: number;
  /** 同上，给人看：`10-29 20:40`。配置页的「运行状态」读它。 */
  updatedAt: string;
  /** 给人看的一句话：`12 个任务`。配置页的「运行状态」读它。 */
  summary: string;
  /** 这份排期的名字，显示在页面顶部。 */
  title: string;
  /** 上次关掉页面时的刻度；打开时沿用它。 */
  scale: ScheduleScale;
  tasks: ScheduleTask[];
};

export function emptyData(): ScheduleData {
  return {
    version: SCHEDULE_VERSION,
    updatedAtMs: 0,
    updatedAt: '',
    summary: '',
    title: DEFAULT_TITLE,
    scale: 'day',
    tasks: [],
  };
}

/**
 * 本地 id。
 *
 * 不用 `node:crypto`：这个模块要进渲染层。时间戳 + 随机后缀在单机一份排期里够用
 * （同一毫秒连建两条也不会撞），而且 id 只在本地被引用，不需要全局唯一。
 */
export function newId(): string {
  return `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function summarize(tasks: ScheduleTask[]): string {
  return tasks.length === 0 ? '还没有任务' : `${tasks.length} 个任务`;
}

/** 写盘前打一次时间戳与摘要：界面顶部和配置页的运行状态都读这两个字段。 */
export function stamp(data: ScheduleData, now: Date = new Date()): ScheduleData {
  return {
    ...data,
    version: SCHEDULE_VERSION,
    updatedAtMs: now.getTime(),
    updatedAt: formatStamp(now),
    summary: summarize(data.tasks),
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

export function normalizeTitle(value: unknown): string {
  return text(value, MAX_TITLE_LENGTH) || DEFAULT_TITLE;
}

export function normalizeScale(value: unknown): ScheduleScale {
  return typeof value === 'string' && (SCALES as readonly string[]).includes(value) ? (value as ScheduleScale) : 'day';
}

/**
 * 读回的数据一律过一遍这里。
 *
 * 这份文件可能被别的版本写过、被 `$MICA_HOME` 拷来拷去、也可能被手改坏：认不出的部分
 * 丢掉，能显示的照常显示——一条坏任务不该让整张时间线消失。
 *
 * 旧形态（`plans` / `stages`）不再支持：这里只读 `tasks`，旧文件读出来就是一张空排期。
 */
export function normalizeData(value: unknown): ScheduleData {
  const record = asRecord(value);
  if (!record) return emptyData();
  const seen = new Set<string>();
  const tasks: ScheduleTask[] = [];
  for (const entry of asArray(record.tasks)) {
    const task = asRecord(entry);
    if (!task) continue;
    const id = text(task.id, MAX_NAME_LENGTH);
    const name = text(task.name, MAX_NAME_LENGTH);
    const start = text(task.start, 10);
    const end = text(task.end, 10) || start;
    if (!id || !name || seen.has(id) || !isValidRange(start, end)) continue;
    seen.add(id);
    tasks.push({
      id,
      name,
      start,
      end,
      color: normalizeColor(task.color),
      note: text(task.note, MAX_NOTE_LENGTH),
    });
  }
  return {
    version: typeof record.version === 'number' ? record.version : SCHEDULE_VERSION,
    updatedAtMs: typeof record.updatedAtMs === 'number' ? record.updatedAtMs : 0,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    summary: typeof record.summary === 'string' ? record.summary : summarize(tasks),
    title: normalizeTitle(record.title),
    scale: normalizeScale(record.scale),
    tasks,
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
  | { type: 'add-task'; task: ScheduleTask }
  | {
      type: 'update-task';
      taskId: string;
      name?: string;
      start?: string;
      end?: string;
      color?: ScheduleColor;
      note?: string;
    }
  | { type: 'delete-task'; taskId: string }
  | { type: 'update-title'; title: string }
  | { type: 'update-scale'; scale: ScheduleScale }
  | { type: 'replace'; title: string; scale: ScheduleScale; tasks: ScheduleTask[] }
  | { type: 'clear-tasks' };

function requireName(value: string | undefined): string {
  const name = (value ?? '').trim();
  if (!name) throw new Error('任务名称不能为空');
  if (name.length > MAX_NAME_LENGTH) throw new Error(`任务名称最多 ${MAX_NAME_LENGTH} 个字`);
  return name;
}

function requireRange(start: string, end: string): { start: string; end: string } {
  if (!isValidDate(start)) throw new Error(`开始日期不是有效日期：${start || '（空）'}，要 YYYY-MM-DD`);
  if (!isValidDate(end)) throw new Error(`结束日期不是有效日期：${end || '（空）'}，要 YYYY-MM-DD`);
  if (daysBetween(start, end) < 0) throw new Error('结束日期不能早于开始日期');
  return { start, end };
}

function requireColor(value: unknown): ScheduleColor {
  if (!isScheduleColor(value)) throw new Error(`颜色只能是 ${COLOR_KEYS.join(' / ')}`);
  return value;
}

function findTask(data: ScheduleData, taskId: string): ScheduleTask {
  const task = data.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error('这个任务已经不在了（可能刚被删掉），先重新读一次排期');
  return task;
}

function normalizeTask(task: ScheduleTask): ScheduleTask {
  const name = requireName(task.name);
  const range = requireRange(task.start, task.end || task.start);
  return {
    id: task.id,
    name,
    ...range,
    color: normalizeColor(task.color),
    note: (task.note ?? '').slice(0, MAX_NOTE_LENGTH),
  };
}

function normalizeTasks(tasks: ScheduleTask[]): ScheduleTask[] {
  if (tasks.length > MAX_TASKS) throw new Error(`任务最多 ${MAX_TASKS} 条`);
  const seen = new Set<string>();
  const normalized: ScheduleTask[] = [];
  for (const task of tasks) {
    if (!task.id || seen.has(task.id)) continue;
    seen.add(task.id);
    normalized.push(normalizeTask(task));
  }
  return normalized;
}

/**
 * 把一次操作应用到数据上，返回新数据；不修改入参。
 *
 * 任务已经不在时抛错而不是静默跳过：界面上是「刚被别的窗口删了」，工具那边是
 * 「你手里的 id 过期了」，两种都该让人看见，而不是改了个寂寞。
 */
export function applyOperation(data: ScheduleData, operation: ScheduleOperation): ScheduleData {
  switch (operation.type) {
    case 'add-task': {
      const task = normalizeTask(operation.task);
      // 同一次操作重放（写盘超时后重试）不该变成两条
      const existing = data.tasks.some((item) => item.id === task.id);
      if (!existing && data.tasks.length >= MAX_TASKS) throw new Error(`任务最多 ${MAX_TASKS} 条`);
      return {
        ...data,
        tasks: existing ? data.tasks.map((item) => (item.id === task.id ? task : item)) : [...data.tasks, task],
      };
    }
    case 'update-task': {
      const task = findTask(data, operation.taskId);
      const name = operation.name === undefined ? task.name : requireName(operation.name);
      const range = requireRange(operation.start ?? task.start, operation.end ?? task.end);
      const color = operation.color === undefined ? task.color : requireColor(operation.color);
      const note = operation.note === undefined ? task.note : operation.note.slice(0, MAX_NOTE_LENGTH);
      const next: ScheduleTask = { id: task.id, name, ...range, color, note };
      return { ...data, tasks: data.tasks.map((item) => (item.id === task.id ? next : item)) };
    }
    case 'delete-task':
      findTask(data, operation.taskId);
      return { ...data, tasks: data.tasks.filter((task) => task.id !== operation.taskId) };
    case 'update-title':
      return { ...data, title: normalizeTitle(operation.title) };
    case 'update-scale':
      return { ...data, scale: normalizeScale(operation.scale) };
    case 'replace':
      return {
        ...data,
        title: normalizeTitle(operation.title),
        scale: normalizeScale(operation.scale),
        tasks: normalizeTasks(operation.tasks),
      };
    case 'clear-tasks':
      return { ...data, tasks: [] };
  }
}

/* ------------------------------------------------------------------ 导入 / 导出 / 示例 */

export type ScheduleDocument = {
  version: number;
  title: string;
  scale: ScheduleScale;
  tasks: ScheduleTask[];
};

/** 导出的 JSON 与参考项目同形（title / scale / tasks），双方可以互相导入。 */
export function exportDocument(data: ScheduleData): ScheduleDocument {
  return { version: SCHEDULE_VERSION, title: data.title, scale: data.scale, tasks: data.tasks };
}

/**
 * 导入：解析失败或没有任何合法任务都直接报错，避免用户以为导入成功了。
 * 认不出的字段（包括旧形态的 `plans`）被丢掉；颜色、日期不合法的任务不会进来。
 */
export function parseImport(value: unknown): { title: string; scale: ScheduleScale; tasks: ScheduleTask[] } {
  const data = normalizeData(value);
  if (data.tasks.length === 0) throw new Error('任务列表为空或全部字段不合法');
  if (data.tasks.length > MAX_TASKS) throw new Error(`任务最多 ${MAX_TASKS} 条`);
  return { title: data.title, scale: data.scale, tasks: data.tasks };
}

/** 「载入示例」：以本周一为第 0 天排布，落到哪一周都好看。 */
export function sampleData(today: string = todayOf()): ScheduleData {
  const monday = startOfWeek(today);
  const samples: Array<[name: string, from: number, to: number, color: ScheduleColor]> = [
    ['调研与竞品分析', 0, 4, 'slate'],
    ['需求梳理与评审', 5, 6, 'slate'],
    ['原型与视觉稿', 4, 9, 'violet'],
    ['数据模型与服务端存储', 7, 11, 'blue'],
    ['甘特图时间轴视图', 10, 17, 'blue'],
    ['任务编辑与拖拽调整', 14, 21, 'cyan'],
    ['移动端适配', 20, 25, 'emerald'],
    ['联调与自测', 26, 30, 'amber'],
    ['文档与部署', 29, 33, 'rose'],
  ];
  return {
    ...emptyData(),
    title: DEFAULT_TITLE,
    scale: 'day',
    tasks: samples.map(([name, from, to, color]) => ({
      id: newId(),
      name,
      start: addDays(monday, from),
      end: addDays(monday, to),
      color,
      note: '',
    })),
  };
}

/* ------------------------------------------------------------------ 给模型看 */

function daysLabel(start: string, end: string): string {
  const span = daysBetween(start, end) + 1;
  return span <= 1 ? '1 天' : `${span} 天`;
}

/** 一条任务的相对时间提示：进行中 / 还有几天 / 已结束。 */
export function taskHint(task: Pick<ScheduleTask, 'start' | 'end'>, today: string): string {
  const toStart = daysBetween(today, task.start);
  const toEnd = daysBetween(today, task.end);
  if (toStart > 0) return toStart === 1 ? '明天开始' : `${toStart} 天后开始`;
  if (toEnd < 0) return `已结束 ${-toEnd} 天`;
  return `进行中，第 ${daysBetween(task.start, today) + 1}/${daysBetween(task.start, task.end) + 1} 天`;
}

function noteLine(note: string): string {
  const flat = note.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return `\n   备注：${flat.length > 120 ? `${flat.slice(0, 120)}…` : flat}`;
}

/** 工具回复里的排期：id 与日期都写全，模型下一句话就能直接拿 id 去改。 */
export function formatSchedule(data: ScheduleData, today: string = todayOf()): string {
  if (data.tasks.length === 0) return `今天 ${today}\n排期「${data.title}」是空的（还没有任何任务）。`;
  const lines = [`今天 ${today}`, `排期「${data.title}」 · ${data.tasks.length} 个任务`];
  const tasks = [...data.tasks].sort(
    (left, right) => left.start.localeCompare(right.start) || left.name.localeCompare(right.name),
  );
  tasks.forEach((task, index) => {
    const range = task.start === task.end ? task.start : `${task.start} → ${task.end}`;
    lines.push(
      `${index + 1}. [${task.id}] ${task.name}｜${range}｜${daysLabel(task.start, task.end)}｜${taskHint(
        task,
        today,
      )}｜${task.color}`,
    );
    const note = noteLine(task.note);
    if (note) lines.push(note);
  });
  return lines.join('\n');
}
