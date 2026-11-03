/**
 * 日期字段的纯逻辑：`YYYY-MM-DD` 字符串、按整天算、周一起排。
 *
 * 与 `plugins/schedule/dates.ts` 算的是同一件事，但那份属于插件、不能被共享包反向
 * 依赖；这里是设置页与插件页面共用的唯一实现，日期算术一律走 UTC 日序号，本地时区
 * 只影响「今天」——用户日历上的今天不是 UTC 的今天。
 */

export const DAY_MS = 86_400_000;

const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 从 1970-01-01 起的第几天。 */
export function dayNumberOf(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  return Date.UTC(year!, month! - 1, day!) / DAY_MS;
}

export function isoFromDayNumber(value: number): string {
  const date = new Date(value * DAY_MS);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 形状对 **并且** 回写一遍不变：挡掉 `2026-02-30` 这种会被 Date 悄悄换成 3 月 2 日的输入。 */
export function isIsoDate(value: string): boolean {
  if (!ISO_SHAPE.test(value)) return false;
  return isoFromDayNumber(dayNumberOf(value)) === value;
}

export function addDaysIso(iso: string, delta: number): string {
  return isoFromDayNumber(dayNumberOf(iso) + delta);
}

export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function monthOfIso(iso: string): { year: number; month: number } {
  const [year, month] = iso.split('-').map(Number);
  return { year: year!, month: month! };
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** 这个月 1 号是周几（0=周日）；面板按周一起排。 */
function mondayOffset(year: number, month: number): number {
  const weekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return (weekday + 6) % 7;
}

/**
 * 一屏 6 行 × 7 天的日期格：前后各补上相邻月份的日子，格子始终对齐星期。
 * 返回的每格都带 `inMonth`，调用方据此把邻月日期画淡。
 */
export function buildMonthGrid(year: number, month: number): { iso: string; inMonth: boolean }[] {
  const first = isoFromDayNumber(Date.UTC(year, month - 1, 1) / DAY_MS);
  const start = addDaysIso(first, -mondayOffset(year, month));
  return Array.from({ length: 42 }, (_, index) => {
    const iso = addDaysIso(start, index);
    return { iso, inMonth: monthOfIso(iso).month === month && monthOfIso(iso).year === year };
  });
}

/** 落在 `min` / `max` 之外的日期夹回来；两者都没给时原样返回。 */
export function clampIsoDate(iso: string, min?: string, max?: string): string {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

/**
 * 键盘在日期格里移动：左右 ±1 天、上下 ±7 天，跨月由调用方按新日期重新开月份。
 * 越界（早于 `min` 或晚于 `max`）时保持原位，不把选中点推出可用范围。
 */
export function moveIsoDate(iso: string, deltaDays: number, min?: string, max?: string): string {
  const next = addDaysIso(iso, deltaDays);
  if (min && next < min) return iso;
  if (max && next > max) return iso;
  return next;
}

/** 月份标题：`2026 年 11 月`。 */
export function monthLabel(year: number, month: number): string {
  return `${year} 年 ${month} 月`;
}
