import { daysBetween, STAGE_LABELS, type ScheduleStage } from './parse.js';
import type { EditedStage } from './edits.js';

/**
 * 甘特图的纯逻辑：时间轴范围、行、刻度和缩放。
 *
 * 一个项目一行，它的阶段是这行里的条；时间重叠的阶段上下错开一条道，不叠在一起。
 * 界面那一侧只按 `rows` 从上往下画、不做日期算术。
 */

/** 应用过修订的阶段（界面传进来的那份），纯解析结果也能直接用。 */
export type GanttStage = ScheduleStage &
  Partial<Pick<EditedStage, 'stageId' | 'edited' | 'added' | 'originalStart' | 'originalEnd'>>;

export type GanttBar = {
  /** `${groupId}:${key}:${start}:${lane}`，React key 与点击定位都用它 */
  id: string;
  /** 这条阶段的身份（公告阶段 `key:start`，新建的 `new:…`）；拖动后仍不变，用来存修订 */
  stageId: string;
  groupId: string;
  key: string;
  label: string;
  /** 用户拖过（或新建）；界面画虚线与「还原」 */
  edited: boolean;
  added: boolean;
  /** 公告里的原区间，只在 `edited` 时有 */
  originalStart?: string;
  originalEnd?: string;
  start: string;
  end: string;
  days: string[];
  range: boolean;
  /** 本行内的第几条道：同一项目里时间重叠的阶段（测试跨过上线）不会叠在一起 */
  lane: number;
  /** 离时间轴左端几天 */
  offset: number;
  /** 占几天（含首尾） */
  span: number;
};

export type GanttRow = {
  groupId: string;
  name: string;
  author: string;
  announcedAt: number;
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

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function isoFromDayNumber(value: number): string {
  const date = new Date(value * DAY_MS);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(date: string, delta: number): string {
  return isoFromDayNumber(dayNumber(date) + delta);
}

/** 时间轴两端各留几天：条贴着边缘看不出它有没有超出 */
const AXIS_PADDING_DAYS = 4;

/**
 * 把各群的阶段排成甘特图的行：一个项目一行，阶段是这行里的条。
 *
 * - 行内按开始时间排，时间重叠的阶段上下错开一条道；
 * - 时间轴从最早一个阶段到最晚一个阶段，两端各留几天，并保证今天在轴内；
 * - 行序按「谁更急着看」：正在进行的排最前，然后是还没开始的，全都结束的沉底。
 */
export function buildGantt(
  groups: Array<{
    id: string;
    name: string;
    author?: string;
    announcedAt?: number;
    stages: GanttStage[];
  }>,
  options: { today: string },
): GanttLayout {
  const today = options.today;
  const prepared: Array<{ group: (typeof groups)[number]; stages: GanttStage[] }> = [];
  for (const group of groups) {
    const stages = [...group.stages]
      .filter((stage) => stage.start && stage.end)
      .sort((left, right) => left.start.localeCompare(right.start) || left.key.localeCompare(right.key));
    if (stages.length > 0) prepared.push({ group, stages });
  }

  const allStarts = prepared.flatMap((item) => item.stages.map((stage) => stage.start));
  const allEnds = prepared.flatMap((item) => item.stages.map((stage) => stage.end));
  const first = [today, ...allStarts].reduce((left, right) => (left < right ? left : right));
  const last = [today, ...allEnds].reduce((left, right) => (left > right ? left : right));
  const start = addDays(first, -AXIS_PADDING_DAYS);
  const end = addDays(last, AXIS_PADDING_DAYS);
  const days = daysBetween(start, end) + 1;

  const rows: GanttRow[] = prepared.map(({ group, stages }) => {
    const laneEnds: string[] = [];
    const bars: GanttBar[] = stages.map((stage) => {
      let lane = laneEnds.findIndex((laneEnd) => daysBetween(laneEnd, stage.start) > 0);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(stage.end);
      } else {
        laneEnds[lane] = stage.end;
      }
      return {
        id: `${group.id}:${stage.key}:${stage.start}:${lane}`,
        stageId: stage.stageId ?? `${stage.key}:${stage.start}`,
        groupId: group.id,
        key: stage.key,
        label: stage.label || STAGE_LABELS[stage.key] || stage.key,
        edited: stage.edited === true,
        added: stage.added === true,
        originalStart: stage.originalStart,
        originalEnd: stage.originalEnd,
        start: stage.start,
        end: stage.end,
        days: stage.days,
        range: stage.range,
        lane,
        offset: daysBetween(start, stage.start),
        span: daysBetween(stage.start, stage.end) + 1,
      };
    });
    return {
      groupId: group.id,
      name: group.name,
      author: group.author ?? '',
      announcedAt: group.announcedAt ?? 0,
      lanes: Math.max(1, laneEnds.length),
      bars,
    };
  });

  rows.sort(
    (left, right) =>
      rowRank(left, today) - rowRank(right, today) ||
      left.bars[0]!.start.localeCompare(right.bars[0]!.start) ||
      left.name.localeCompare(right.name),
  );

  return { rows, start, end, days };
}

/** 正在进行（0）→ 还没开始（1）→ 已经全部结束（2）。 */
function rowRank(row: GanttRow, today: string): number {
  let future = false;
  for (const bar of row.bars) {
    // daysBetween(from, to) = to - from：今天落在条的区间里
    if (daysBetween(today, bar.start) <= 0 && daysBetween(today, bar.end) >= 0) return 0;
    if (bar.start > today) future = true;
  }
  return future ? 1 : 2;
}

/* ------------------------------------------------------------------ 刻度 */

export type GanttScale = 'day' | 'week' | 'month';

type ScaleSpec = { key: GanttScale; label: string; pxPerDay: number };

/** 三档密度的基准像素；实际宽度还要乘缩放倍数 */
export const SCALES: ScaleSpec[] = [
  { key: 'day', label: '日', pxPerDay: 34 },
  { key: 'week', label: '周', pxPerDay: 12 },
  { key: 'month', label: '月', pxPerDay: 4.5 },
];

export function scaleSpec(scale: GanttScale): ScaleSpec {
  return SCALES.find((item) => item.key === scale) ?? SCALES[0]!;
}

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 1.25;

export function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

export function pxPerDayOf(scale: GanttScale, zoom: number): number {
  return scaleSpec(scale).pxPerDay * clampZoom(zoom);
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

/**
 * 时间轴的两层刻度。
 *
 * 日视角：上层按月的区间、下层每天（数字 + 周几）；周视角：下层按周；月视角：上层按年、
 * 下层按月。区间里的第一格带上名字，其余留空——标签只在需要的地方出现。
 */
export function axisCells(
  start: string,
  days: number,
  scale: GanttScale,
): { major: AxisCell[]; minor: AxisCell[] } {
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
        label: monthLabel(cursor),
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
  scale: GanttScale;
  zoom: number;
  anchorX: number | null;
  viewportWidth: number;
}): { scrollLeft: number } {
  const anchorX = input.anchorX ?? input.viewportWidth / 2;
  const dayAtAnchor = (input.scrollLeft + anchorX) / input.pxPerDay;
  const nextPx = pxPerDayOf(input.scale, input.zoom);
  return { scrollLeft: Math.max(0, dayAtAnchor * nextPx - anchorX) };
}
