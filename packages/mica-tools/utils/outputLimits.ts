export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 60_000;
export const DEFAULT_PREVIEW_CHARS = 4_000;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function truncateMiddle(text: string, maxChars: number, markerPrefix = '内容已截断'): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 200) return text.slice(0, maxChars);

  const marker = `\n\n[${markerPrefix}，省略 ${text.length - maxChars} 字符]\n\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(budget * 0.65);
  const tail = Math.floor(budget * 0.35);
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

export function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  const omitted = line.length - maxChars;
  const head = Math.ceil(maxChars * 0.75);
  const tail = Math.floor(maxChars * 0.25);
  return `${line.slice(0, head)} ... [单行截断，省略 ${omitted} 字符] ... ${line.slice(line.length - tail)}`;
}

export function finalizeTextOutput(
  text: string,
  options: {
    maxChars?: number;
    label?: string;
    emptyMessage?: string;
  } = {},
): string {
  const emptyMessage = options.emptyMessage ?? '(no output)';
  const value = text.length === 0 ? emptyMessage : text;
  const maxChars = options.maxChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  return truncateMiddle(value, maxChars, `${options.label ?? '工具输出'}过大`);
}
