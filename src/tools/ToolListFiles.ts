import { glob } from 'glob';
import { MicaTool, ToolExecuteCallbacks } from './MicaTool';

export class ToolListFiles extends MicaTool {
  constructor() {
    super('list_files', '按 glob 模式列出文件。', {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 **/*.ts' },
        path: { type: 'string', description: '搜索目录，默认当前目录' },
      },
      required: ['pattern'],
    });
  }

  async execute(input: { pattern: string; path?: string }, _callbacks?: ToolExecuteCallbacks): Promise<string> {
    const files = await glob(input.pattern, {
      cwd: input.path || process.cwd(),
      nodir: true,
      ignore: ['node_modules/**', '.git/**'],
    });
    if (files.length === 0) return '没有匹配的文件。';
    return files.slice(0, 200).join('\n');
  }
  onToolUseDisplayText(input: Record<string, any>): string {
    return `list ${input.pattern} in ${input.path || '.'}`;
  }
  
}
