export function truncateDisplayText(text: string, prefixLen: number): string {
  const maxLen = Math.max(30, 50 - prefixLen);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
