export function truncateDisplayText(text: string, prefixLen: number): string {
  const columns = process.stdout.columns - 1;
  const maxLen = columns - 3;
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
