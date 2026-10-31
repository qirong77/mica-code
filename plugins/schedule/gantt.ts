import { DAY_MS, addDays, dayNumber, daysBetween, isValidDate } from './dates.js';
import { COLOR_KEYS, type ScheduleColor } from './palette.js';
import type { ScheduleScale, ScheduleTask } from './schedule.js';

/**
 * 甘特图的纯逻辑：时间轴范围、行、刻度和缩放。
 *
 * 同色的任务排在同一行；同一行里时间重叠的任务上下错开一条道，不叠在一起。行序按
 * `COLOR_KEYS` 固定，颜色换了位置也不会跳。界面那一侧只按 `rows` 从上往下画、不做日期算术。
 */

export type GanttBar = {
  /** `${taskId}:${lane}`，React key 用它（同一条任务换了道也会重挂） */
  id: string;
  /** 任务身份，拖拽与编辑都用它 */
  taskId: string;
  color: ScheduleColor;
  /** 条上的字（任务名）；太窄时不画 */
  label: string;
  start: string;
  end: string;
  /** 本行内的第几条道 */
  lane: number;
  /** 离时间轴左端几天 */
  offset: number;
  /** 占几天（含首尾） */
  span: number;
};

export type GanttRow = {
  color: ScheduleColor;
  /** 这行有几条道（决定行高） */
  lanes: number;
  bars: GanttBar[];
};

export type GanttLayout = {
  rows: GanttRow[];
  /** 时间轴第一天（含）与最后一天（含） */
  start: string;
  end: string;
  days: number;
};

/** 时间轴两端各留几天：条贴着边缘看不出它有没有超出 */
const AXIS_PADDING_DAYS = 4;

/**
 * 把任务排成甘特图的行：一个颜色一行。
 *
 * - 行内按开始时间排，时间重叠的任务上下错开一条道；
 * - 时间轴从最早一条到最晚一条，两端各留几天，并保证今天在轴内；
 * - 没有任务的颜色不占行——空行没有意义，新建任务的入口在空白处。
 */
export function buildGantt(tasks: ScheduleTask[], options: { today: string }): GanttLayout {
  const today = options.today;
  const valid = tasks.filter((task) => isValidDate(task.start) && isValidDate(task.end));

  const first = [today, ...valid.map((task) => task.start)].reduce((left, right) => (left < right ? left : right));
  const last = [today, ...valid.map((task) => task.end)].reduce((left, right) => (left > right ? left : right));
  const start = addDays(first, -AXIS_PADDING_DAYS);
  const end = addDays(last, AXIS_PADDING_DAYS);
  const days = daysBetween(start, end) + 1;

  const rows: GanttRow[] = [];
  for (const color of COLOR_KEYS) {
    const group = valid
      .filter((task) => task.color === color)
      .sort((left, right) => left.start.localeCompare(right.start) || left.name.localeCompare(right.name));
    if (group.length === 0) continue;

    const laneEnds: string[] = [];
    const bars: GanttBar[] = group.map((task) => {
      let lane = laneEnds.findIndex((laneEnd) => daysBetween(laneEnd, task.start) > 0);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(task.end);
      } else {
        laneEnds[lane] = task.end;
      }
      return {
        id: `${task.id}:${lane}`,
        taskId: task.id,
        color: task.color,
        label: task.name,
        start: task.start,
        end: task.end,
        lane,
        offset: daysBetween(start, task.start),
        span: daysBetween(task.start, task.end) + 1,
      };
    });
    rows.push({ color, lanes: Math.max(1, laneEnds.length), bars });
  }

  return { rows, start, end, days };
}

/* ------------------------------------------------------------------ 刻度 */

type ScaleSpec = { key: ScheduleScale; label: string; pxPerDay: number };

/** 三档密度的基准像素；实际宽度还要乘缩放倍数 */
export const SCALES: ScaleSpec[] = [
  { key: 'day', label: '日', pxPerDay: 34 },
  { key: 'week', label: '周', pxPerDay: 12 },
  { key: 'month', label: '月', pxPerDay: 4.5 },
];

export function scaleSpec(scale: ScheduleScale): ScaleSpec {
  return SCALES.find((item) => item.key === scale) ?? SCALES[0]!;
}

export const ZOOM_MIN = 0.35;
export const ZOOM_MAX = 6;
export const ZOOM_STEP = 1.25;

export function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

export function pxPerDayOf(scale: ScheduleScale, zoom: number): number {
  return scaleSpec(scale).pxPerDay * clampZoom(zoom);
}

/** 任务条的高度、行内边距与行高：页面与测试共用。 */
export const BAR_HEIGHT = 28;
export const LANE_GAP = 4;
export const ROW_PADDING = 6;

export function rowHeight(lanes: number): number {
  return ROW_PADDING * 2 + Math.max(1, lanes) * BAR_HEIGHT + (Math.max(1, lanes) - 1) * LANE_GAP;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export function weekdayOf(date: string): number {
  return new Date(dayNumber(date) * DAY_MS).getUTCDay();
}

export function isWeekend(date: string): boolean {
  const weekday = weekdayOf(date);
  return weekday === 0 || weekday === 6;
}

export type AxisCell = { label: string; sub?: string; offset: number; span: number };

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function nextMonthOf(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
}

function monthLabel(date: string): string {
  return `${Number(date.slice(5, 7))} 月`;
}

function yearMonthLabel(date: string): string {
  return `${date.slice(0, 4)} 年 ${monthLabel(date)}`;
}

/**
 * 时间轴的两层刻度。
 *
 * 日视角：上层按月的区间、下层每天（数字 + 周几）；周视角：下层按周；月视角：上层按年、
 * 下层按月。区间里的第一格带上名字，其余留空——标签只在需要的地方出现。
 */
export function axisCells(start: string, days: number, scale: ScheduleScale): { major: AxisCell[]; minor: AxisCell[] } {
  const major: AxisCell[] = [];
  const minor: AxisCell[] = [];
  const end = addDays(start, days);

  if (scale === 'day' || scale === 'week') {
    // 月区间：从 start 所在月开始，按自然月切
    let cursor = monthStart(start);
    while (cursor < end) {
      const next = nextMonthOf(cursor);
      const from = cursor < start ? start : cursor;
      const to = next > end ? end : next;
      major.push({
        label: yearMonthLabel(cursor),
        offset: daysBetween(start, from),
        span: Math.max(1, daysBetween(from, to)),
      });
      cursor = next;
    }

    if (scale === 'day') {
      for (let index = 0; index < days; index += 1) {
        const date = addDays(start, index);
        minor.push({
          label: String(Number(date.slice(8, 10))),
          sub: WEEKDAYS[weekdayOf(date)],
          offset: index,
          span: 1,
        });
      }
    } else {
      // 周：从 start 所在周的周一开始，每 7 天一格
      let cursorDay = start;
      while (weekdayOf(cursorDay) !== 1) cursorDay = addDays(cursorDay, -1);
      while (cursorDay < end) {
        const from = cursorDay < start ? start : cursorDay;
        const next = addDays(cursorDay, 7);
        const to = next > end ? end : next;
        minor.push({
          // 标签写的是这一周本身（周一那天），哪怕轴从左端把它裁掉了
          label: `${Number(cursorDay.slice(5, 7))}.${Number(cursorDay.slice(8, 10))}`,
          offset: daysBetween(start, from),
          span: Math.max(1, daysBetween(from, to)),
        });
        cursorDay = next;
      }
    }
    return { major, minor };
  }

  // 月视角：上层按年、下层按月
  let year = Number(start.slice(0, 4));
  while (`${year}-01-01` < end) {
    const from = [`${year}-01-01`, start].sort()[1]!;
    const nextYear = `${year + 1}-01-01`;
    const to = nextYear > end ? end : nextYear;
    major.push({ label: `${year} 年`, offset: daysBetween(start, from), span: Math.max(1, daysBetween(from, to)) });
    year += 1;
  }
  let month = monthStart(start);
  while (month < end) {
    const from = month < start ? start : month;
    const nextMonth = nextMonthOf(month);
    const to = nextMonth > end ? end : nextMonth;
    minor.push({
      label: monthLabel(from),
      offset: daysBetween(start, from),
      span: Math.max(1, daysBetween(from, to)),
    });
    month = nextMonth;
  }
  return { major, minor };
}

/* ------------------------------------------------------------------ 交互换算 */

/** 窗口滚动到「今天落在视口左侧三分之一处」时的偏移量。 */
export function todayScrollLeft(start: string, today: string, pxPerDay: number, viewportWidth: number): number {
  const offset = daysBetween(start, today) * pxPerDay;
  return Math.max(0, offset - Math.max(0, viewportWidth) / 3);
}

/**
 * 滚轮缩放后的新偏移量：让光标下面那一天留在原地（锚点）。
 *
 * 「原地」= 缩放前后同一日期落在同一个屏幕位置上，所以按锚点处已经过了几天来反推新
 * 偏移。传 `anchorX = null` 时以视口中心为锚点。
 */
export function zoomAnchor(input: {
  start: string;
  scrollLeft: number;
  pxPerDay: number;
  scale: ScheduleScale;
  zoom: number;
  anchorX: number | null;
  viewportWidth: number;
}): { scrollLeft: number } {
  const anchorX = input.anchorX ?? input.viewportWidth / 2;
  const dayAtAnchor = (input.scrollLeft + anchorX) / input.pxPerDay;
  const nextPx = pxPerDayOf(input.scale, input.zoom);
  return { scrollLeft: Math.max(0, dayAtAnchor * nextPx - anchorX) };
}
