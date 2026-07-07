export const MAX_HISTORICAL_TOOL_RESULT_CHARS = 12_000;

export function compactHistoricalToolResultText(text: string, maxChars = MAX_HISTORICAL_TOOL_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;
  let omitted = text.length - maxChars;
  let marker = '';
  let headChars = 0;
  for (let index = 0; index < 10; index++) {
    marker = `\n\n[历史工具结果已压缩，省略 ${omitted} 字符。如需完整内容，请重新读取对应文件或重新运行相关工具。]`;
    headChars = Math.max(0, maxChars - marker.length);
    const nextOmitted = text.length - headChars;
    if (nextOmitted === omitted) break;
    omitted = nextOmitted;
  }
  return `${text.slice(0, headChars)}${marker}`;
}
