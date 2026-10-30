/** 字符数的展示换算：详情页的列表行与提示词统计共用一份，避免各处阈值不一样。 */
export function formatCharCount(chars: number): string {
  const value = Number(chars) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}
