import { glob } from 'glob';
import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import { truncateDisplayText } from './utils/display.js';
import { clampNumber } from './utils/outputLimits.js';

const DEFAULT_LIMIT = 500;
const HARD_LIMIT = 5_000;
const DEFAULT_IGNORE = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '.next/**',
  '.cache/**',
  'target/**',
];

export class ToolListFiles extends MicaTool {
  constructor() {
    super('list_files', '按 glob 模式列出文件。', {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 **/*.ts' },
        path: { type: 'string', description: '搜索目录，默认当前目录' },
        limit: { type: 'number', description: `最多返回文件数，默认 ${DEFAULT_LIMIT}，最大 ${HARD_LIMIT}` },
      },
      required: ['pattern'],
    });
  }

  async execute(
    input: { pattern: string; path?: string; limit?: number },
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const limit = clampNumber(input.limit, DEFAULT_LIMIT, 1, HARD_LIMIT);
    const files = await glob(input.pattern, {
      cwd: input.path || process.cwd(),
      nodir: true,
      ignore: DEFAULT_IGNORE,
    });
    if (files.length === 0) return '没有匹配的文件。';

    const shown = files.slice(0, limit);
    const suffix =
      files.length > limit
        ? `\n\n[显示 ${limit} 个文件，共 ${files.length} 个。请缩小 path/pattern 或调整 limit。]`
        : '';
    return shown.join('\n') + suffix;
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `list ${truncateDisplayText(input.pattern as string, 10)} in ${String(input.path || '.')}`;
  }
}
