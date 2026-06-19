export function truncateDisplayText(text: string, prefixLen: number): string {
  const columns = process.stdout.columns || 80;
  const maxLen = Math.max(4, columns - prefixLen - 4);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
