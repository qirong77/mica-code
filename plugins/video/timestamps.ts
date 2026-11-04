/**
 * 视频时间点的解析与格式化。
 *
 * 工具的可寻址单位是**时间**而不是帧序号：下一轮的模型看不到上一轮返回的图片，也拿不到
 * 「第 7 帧」这个映射，而 `"1:03.5"` 写进工具参数后一直是自洽的。所以这里接受几种人读的
 * 写法，输出统一成秒。
 */

const SECONDS_PER_MINUTE = 60;

/**
 * 解析一个时间点，失败返回 null（调用方决定是报错还是跳过）。
 *
 * 接受：`90`、`5.5`（秒）、`1:03.5`（分:秒）、`01:02:03`（时:分:秒）。
 * 段内数值不做「秒必须小于 60」的约束——`1:90` 归一成 150 秒，比让模型因为格式被拒绝有用。
 */
export function parseTimePoint(input: string): number | null {
  const text = input.trim();
  if (!text) return null;
  if (text.startsWith('-')) return null;

  const parts = text.split(':');
  if (parts.length > 3) return null;

  let total = 0;
  for (const [index, raw] of parts.entries()) {
    const part = raw.trim();
    if (!/^\d+(\.\d+)?$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isFinite(value)) return null;
    const isLast = index === parts.length - 1;
    // 只有最后一段允许小数，`1.5:30` 没有意义。
    if (!isLast && part.includes('.')) return null;
    total += value * Math.pow(SECONDS_PER_MINUTE, parts.length - 1 - index);
  }
  return total;
}

/**
 * 秒数格式化成 `m:ss.s`（一小时以上是 `h:mm:ss.s`）。
 *
 * 一位小数是刻意的：`4:50.0` 读起来就是个时间点，而 `290` 会被模型当成帧序号。
 */
export function formatTimePoint(seconds: number): string {
  const safe = Math.max(0, seconds);
  const totalTenths = Math.round(safe * 10);
  const tenths = totalTenths % 10;
  const totalSeconds = (totalTenths - tenths) / 10;
  const s = totalSeconds % SECONDS_PER_MINUTE;
  const totalMinutes = (totalSeconds - s) / SECONDS_PER_MINUTE;
  const m = totalMinutes % SECONDS_PER_MINUTE;
  const h = (totalMinutes - m) / SECONDS_PER_MINUTE;

  const tail = `${String(s).padStart(2, '0')}.${tenths}`;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${tail}`;
  return `${m}:${tail}`;
}

/** 时长用来说明用，不要求精确到十分之一秒。 */
export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const s = safe % SECONDS_PER_MINUTE;
  const totalMinutes = (safe - s) / SECONDS_PER_MINUTE;
  const m = totalMinutes % SECONDS_PER_MINUTE;
  const h = (totalMinutes - m) / SECONDS_PER_MINUTE;
  const tail = `${String(s).padStart(2, '0')}`;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${tail}`;
  return `${m}:${tail}`;
}
