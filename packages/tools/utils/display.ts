export function truncateDisplayText(text: string, prefixLen: number): string {
  const row = process.stdout.rows - 1;
  const maxLen = row;
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
