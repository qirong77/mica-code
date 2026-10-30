// 统计页按「本地日历日」分桶：host 在扫描时聚合出日行，renderer 再按范围过滤，
// 两边必须用同一套日边界，否则同一个请求会落在不同的一天。纯函数，无依赖。

export const DAY_MS = 86_400_000;

/** 本地日历日键 'YYYY-MM-DD'（机器本地时区）。 */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** 'YYYY-MM-DD' 键的本地当日零点毫秒。 */
export function dayStartMs(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).getTime();
}

/** 本地日 day 往后 n 天（n 可为负）。 */
export function addDays(day: string, n: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const dt = new Date(year, month - 1, date);
  dt.setDate(dt.getDate() + n);
  return localDayKey(dt.getTime());
}
