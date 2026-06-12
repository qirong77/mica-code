import { stat, readFile } from 'fs/promises';
import { MicaTool, ToolExecuteCallbacks } from './MicaTool.js';
import { truncateDisplayText } from '../utils/display.js';

const MAX_SIZE_BYTES = 256 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export class ToolReadFile extends MicaTool {
  constructor() {
    super('read_file', '读取文件内容，返回带行号的文本。', {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: '文件路径' },
        offset: {
          type: 'number',
          description: '起始行号。文件过大时使用，与 limit 配合分段读取。',
        },
        limit: {
          type: 'number',
          description: '读取行数。文件过大时使用，与 offset 配合分段读取。',
        },
      },
      required: ['file_path'],
    });
  }

  async execute(
    input: { file_path: string; offset?: number; limit?: number },
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const stats = await stat(input.file_path);

    if (stats.isDirectory()) {
      return `错误：${input.file_path} 是一个目录，无法读取。`;
    }

    if (stats.size > MAX_SIZE_BYTES && input.offset === undefined) {
      return [
        `文件过大（${formatSize(stats.size)}，超过 ${formatSize(MAX_SIZE_BYTES)} 限制）。`,
        `请使用 offset 和 limit 参数分段读取，或用 grep_search 搜索特定内容。`,
        `示例：read_file(file_path="${input.file_path}", offset=1, limit=200)`,
      ].join('\n');
    }

    const content = await readFile(input.file_path, 'utf-8');
    const allLines = content.split('\n');

    const start = (input.offset ?? 1) - 1;
    const end = input.limit !== undefined ? start + input.limit : allLines.length;
    const lines = allLines.slice(start, end);

    const result = lines
      .map((line, i) => `${String(start + i + 1).padStart(4)} | ${line}`)
      .join('\n');

    if (input.offset !== undefined || input.limit !== undefined) {
      const header = `[第 ${start + 1}-${start + lines.length} 行，共 ${allLines.length} 行]`;
      return header + '\n' + result;
    }

    return result;
  }
  onToolUseDisplayText(input: Record<string, any>): string {
    const filePath = truncateDisplayText(input.file_path as string, 5); // "read " prefix
    const parts = [filePath];
    if (input.offset) parts.push(`:${input.offset}`);
    if (input.limit) parts.push(`+${input.limit}行`);
    return `read ${parts.join(' ')}`;
  }
  
}
