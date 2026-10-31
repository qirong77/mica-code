/**
 * 排期用的日期算术：`YYYY-MM-DD` 字符串、按整天算。
 *
 * 全部走 UTC 日序号，所以「哪天到哪天差几天」不受本地夏令时影响；只有 `todayOf`
 * 需要本地时区——「今天」是用户日历上的今天，不是 UTC 的今天。
 *
 * 这个文件同时也被打进渲染层（`desktop.jsx`），所以只能是纯函数，不能碰 node 模块。
 */

export const DAY_MS = 86_400_000;

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0');
}

/** 从 1970-01-01 起的第几天。 */
export function dayNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year!, month! - 1, day!) / DAY_MS;
}

export function isoFromDayNumber(value: number): string {
  const date = new Date(value * DAY_MS);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(date: string, delta: number): string {
  return isoFromDayNumber(dayNumber(date) + delta);
}

/** `to - from` 的天数：`daysBetween('2026-10-01', '2026-10-03') === 2`。 */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** 真日期：形状对，并且回写一遍不变（挡掉 2 月 30 日这类会被 Date 悄悄换掉的输入）。 */
export function isValidDate(value: string): boolean {
  if (!DATE_SHAPE.test(value)) return false;
  return isoFromDayNumber(dayNumber(value)) === value;
}

export function isValidRange(start: string, end: string): boolean {
  return isValidDate(start) && isValidDate(end) && daysBetween(start, end) >= 0;
}

/** 本地日历上的今天。 */
export function todayOf(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 写进 `data.json` 给人看的时间戳：`10-29 20:40`。 */
export function formatStamp(date: Date = new Date()): string {
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
