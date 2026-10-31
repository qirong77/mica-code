/**
 * 排期页上的说明文字（纯函数，便于单测）。
 *
 * 规则只有一条：**说人话**。「今天」「还有 3 天」「第 2/3 天」比一串 ISO 日期有用，
 * 完整日期只在需要精确的地方出现。
 */

import { daysBetween, todayOf } from './dates.js';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export { todayOf };

/** `10.28`：条窄，年份没有必要。 */
export function shortDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}.${Number(day)}`;
}

/** `11-02 周一`。 */
export function dayLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay()] ?? '';
  return `${pad(month!)}-${pad(day!)} ${weekday}`;
}

/** 一条阶段占几天（含首尾）。 */
export function spanDays(start: string, end: string): number {
  return daysBetween(start, end) + 1;
}

/** 「3 天后开始」「进行中，第 2/4 天」「已结束 5 天」。 */
export function describeWhen(start: string, end: string, today: string = todayOf()): string {
  const toStart = daysBetween(today, start);
  const toEnd = daysBetween(today, end);
  if (toStart > 0) return toStart === 1 ? '明天开始' : `${toStart} 天后开始`;
  if (toEnd < 0) return `已结束 ${-toEnd} 天`;
  return `进行中，第 ${-toStart + 1}/${spanDays(start, end)} 天`;
}

/** 数据多久以前改的：页面顶部用它提醒「这份是几时的」。 */
export function freshness(updatedAtMs: number, now: number = Date.now()): string {
  if (!updatedAtMs) return '还没改过';
  const minutes = Math.max(0, Math.round((now - updatedAtMs) / 60_000));
  if (minutes < 2) return '刚刚改过';
  if (minutes < 60) return `${minutes} 分钟前改过`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前改过`;
  return `${Math.round(hours / 24)} 天前改过`;
}
