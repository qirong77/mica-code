import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { MicaTool, ToolExecuteCallbacks } from './MicaTool';
import { backupFile } from '../utils/fileHistory.js';

export class ToolWriteFile extends MicaTool {
  constructor() {
    super('write_file', '写入文件，不存在则创建，存在则覆盖。', {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['file_path', 'content'],
    });
  }

  async execute(input: { file_path: string; content: string }, _callbacks?: ToolExecuteCallbacks): Promise<string> {
    await backupFile(input.file_path);
    const dir = dirname(input.file_path);
    await mkdir(dir, { recursive: true });
    await writeFile(input.file_path, input.content);
    return `写入成功: ${input.file_path}`;
  }
  onToolUseDisplayText(input: Record<string, any>): string {
    const path = input.file_path as string;
    const len = typeof input.content === 'string' ? input.content.length : 0;
    const sizeHint = len > 0 ? ` (${len}B)` : '';
    return `write ${path}${sizeHint}`;
  }
  getSlowText(ms: number, input: Record<string, any>): string {
    const path = input.file_path as string;
    const len = typeof input.content === 'string' ? input.content.length : 0;
    const sizeHint = len > 0 ? ` (${len} 字符)` : '';
    return `写入文件 ${path}${sizeHint} (${(ms / 1000).toFixed(1)}s)`;
  }
}
