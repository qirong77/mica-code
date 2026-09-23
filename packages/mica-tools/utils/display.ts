/**
 * 工具调用展示文案的终端裁剪。
 *
 * 只在**有终端列宽**时裁剪：这段文案的唯一目的是在终端里占一行，宽度就是终端宽度。
 * `process.stdout.columns` 在非 TTY（管道、app-server 的 stdio、headless 捕获）下是
 * undefined，此时按 80 列裁剪没有任何依据，只会让网页端看到 `cd /Users/... && LINKCORE_GOME...`
 * 这种被砍掉一半的命令。
 */
export function truncateDisplayText(text: string, prefixLen: number): string {
  const columns = process.stdout.columns;
  if (!columns) return text;
  const maxLen = Math.max(4, columns - prefixLen - 4);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
