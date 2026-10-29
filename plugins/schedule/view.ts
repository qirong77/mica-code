import type { AgendaItem } from './parse.js';

/**
 * 卡片上的说明文字（纯函数，便于单测）。
 *
 * 规则只有一条：**说人话**。「今天」「还有 3 天」「第 2/3 天」比一串 ISO 日期有用，
 * 完整日期只在窗口边缘出现。
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地日期 `YYYY-MM-DD`。 */
export function todayOf(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `10.28`：卡片窄，年份没有必要。 */
export function shortDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}.${Number(day)}`;
}

/** 阶段落在哪几天：公告写的是区间就画区间，写的是几个日子就列出来。 */
export function formatRange(stage: {
  start: string;
  end: string;
  days: string[];
  range: boolean;
}): string {
  if (stage.start === stage.end) return shortDate(stage.start);
  if (stage.range) return `${shortDate(stage.start)}–${shortDate(stage.end)}`;
  return stage.days.map(shortDate).join('、');
}

/** 一行时间提示：「第 2/3 天」/「今天开始」/「3 天后」。 */
export function describeWhen(item: AgendaItem): string {
  if (item.dayIndex > 0) return `第 ${item.dayIndex}/${item.span} 天`;
  if (item.startIn === 0) return '今天';
  if (item.startIn === 1) return '明天';
  return `${item.startIn} 天后`;
}

/** 「接下来」按天分组，界面上一组一天的标题。 */
export function groupByDay(items: AgendaItem[]): Array<{ date: string; label: string; items: AgendaItem[] }> {
  const buckets = new Map<string, AgendaItem[]>();
  for (const item of items) {
    const key = item.start;
    const list = buckets.get(key);
    if (list) list.push(item);
    else buckets.set(key, [item]);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, list]) => ({ date, label: dayLabel(date), items: list }));
}

/** `11-02 周一`。 */
export function dayLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(year!, month! - 1, day!).getDay()] ?? '';
  return `${pad(month!)}-${pad(day!)} ${weekday}`;
}

/**
 * 阶段上色。
 *
 * 只区分三类：上线（要盯的那一天）、走查/验收（上线前一天）、其余进行中的阶段。
 * 卡片是「扫一眼」的地方，颜色多了等于没有颜色。
 */
export function stageTone(key: string): 'release' | 'review' | 'normal' {
  if (key === 'release') return 'release';
  if (key === 'walkthrough' || key === 'acceptance' || key === 'showcase') return 'review';
  return 'normal';
}

/** 数据多久以前整理的：卡片脚注用它提醒「这份可能过期了」。 */
export function freshness(updatedAtMs: number, now: number = Date.now()): string {
  if (!updatedAtMs) return '还没整理过';
  const minutes = Math.max(0, Math.round((now - updatedAtMs) / 60_000));
  if (minutes < 2) return '刚刚整理';
  if (minutes < 60) return `${minutes} 分钟前整理`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前整理`;
  return `${Math.round(hours / 24)} 天前整理`;
}
