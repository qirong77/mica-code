// 行内元素宽度估算：spinner(2) + icon(3) + 前后缀(~12) + elapsed(~9) = ~26
const BASE_OVERHEAD = 26;

export function truncateDisplayText(text: string, overhead = 0): string {
  const cols = process.stdout.columns ?? 80;
  const maxLen = Math.max(20, cols - BASE_OVERHEAD - overhead);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}
