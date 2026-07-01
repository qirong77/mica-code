import { createReadStream } from 'fs';
import { open, stat } from 'fs/promises';
import { createInterface } from 'readline';
import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import { truncateDisplayText } from './utils/display.js';
import { clampNumber, formatSize, truncateLine } from './utils/outputLimits.js';

const DEFAULT_LIMIT_LINES = 200;
const HARD_LIMIT_LINES = 2_000;
const MAX_DIRECT_READ_BYTES = 256 * 1024;
const HARD_READ_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_LINE_CHARS = 2_000;

function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  if (buffer.includes(0)) return true;

  let suspicious = 0;
  for (const byte of buffer) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
  }
  return suspicious / buffer.length > 0.3;
}

function normalizeOffset(value: unknown): number {
  return clampNumber(value, 1, 1, Number.MAX_SAFE_INTEGER);
}

async function readLineRange(
  filePath: string,
  offset: number,
  limit: number,
): Promise<{ lines: string[]; totalLines: number }> {
  const lines: string[] = [];
  let lineNo = 0;
  const end = offset + limit - 1;
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });

  for await (const line of rl) {
    lineNo++;
    if (lineNo >= offset && lineNo <= end) lines.push(line);
  }

  return { lines, totalLines: lineNo };
}

export class ToolReadFile extends MicaTool {
  constructor() {
    super(
      'read_file',
      '读取文件内容，返回带行号的文本。',
      {
        type: 'object' as const,
        properties: {
          file_path: { type: 'string', description: '文件路径' },
          offset: {
            type: 'number',
            description: '起始行号。默认 1。文件过大时使用，与 limit 配合分段读取。',
          },
          limit: {
            type: 'number',
            description: `读取行数。默认 ${DEFAULT_LIMIT_LINES}，最大 ${HARD_LIMIT_LINES}。`,
          },
        },
        required: ['file_path'],
      },
      { readOnly: true },
    );
  }

  async execute(
    input: { file_path: string; offset?: number; limit?: number },
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const stats = await stat(input.file_path);

    if (stats.isDirectory()) {
      return `错误：${input.file_path} 是一个目录，无法读取。`;
    }

    const handle = await open(input.file_path, 'r');
    try {
      const sniffLength = Math.min(BINARY_SNIFF_BYTES, stats.size);
      if (sniffLength > 0) {
        const sniff = Buffer.alloc(sniffLength);
        await handle.read(sniff, 0, sniffLength, 0);
        if (looksBinary(sniff)) {
          return [`检测到二进制文件，未返回内容。`, `文件: ${input.file_path}`, `大小: ${formatSize(stats.size)}`].join(
            '\n',
          );
        }
      }
    } finally {
      await handle.close();
    }

    const hasExplicitRange = input.offset !== undefined || input.limit !== undefined;
    if (stats.size > HARD_READ_BYTES && !hasExplicitRange) {
      return [
        `文件过大（${formatSize(stats.size)}，超过 ${formatSize(HARD_READ_BYTES)} 硬限制），未直接读取。`,
        `请用 grep_search 搜索特定内容，或使用 offset/limit 分段读取。`,
        `示例：read_file(file_path="${input.file_path}", offset=1, limit=${DEFAULT_LIMIT_LINES})`,
      ].join('\n');
    }

    if (stats.size > MAX_DIRECT_READ_BYTES && input.limit === undefined) {
      return [
        `文件较大（${formatSize(stats.size)}，超过 ${formatSize(MAX_DIRECT_READ_BYTES)}），未直接读取。`,
        `请使用 offset 和 limit 参数分段读取，或用 grep_search 搜索特定内容。`,
        `示例：read_file(file_path="${input.file_path}", offset=1, limit=${DEFAULT_LIMIT_LINES})`,
      ].join('\n');
    }

    const offset = normalizeOffset(input.offset);
    const limit = clampNumber(input.limit, DEFAULT_LIMIT_LINES, 1, HARD_LIMIT_LINES);
    const { lines, totalLines } = await readLineRange(input.file_path, offset, limit);
    const start = offset - 1;

    if (lines.length === 0 && start >= totalLines) {
      return `[第 ${offset} 行超出文件范围，共 ${totalLines} 行]`;
    }

    const end = start + lines.length;
    const width = String(end).length;
    const body = lines
      .map(
        (line: string, i: number) => `${String(start + i + 1).padStart(width)} | ${truncateLine(line, MAX_LINE_CHARS)}`,
      )
      .join('\n');

    const truncated = end < totalLines;
    const header = [
      `[第 ${start + 1}-${end} 行，共 ${totalLines} 行]`,
      `文件: ${input.file_path}`,
      `大小: ${formatSize(stats.size)}`,
      truncated ? `后续可用 offset=${end + 1}, limit=${limit} 继续读取。` : undefined,
    ]
      .filter(Boolean)
      .join('\n');

    return `${header}\n${body}`;
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const filePath = truncateDisplayText(input.file_path as string, 5);
    const parts = [filePath];
    if (input.offset) parts.push(`:${input.offset}`);
    if (input.limit) parts.push(`+${input.limit}行`);
    return `read ${parts.join(' ')}`;
  }
}
