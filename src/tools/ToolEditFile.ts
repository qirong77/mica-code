import { readFile, writeFile } from 'fs/promises';
import { MicaTool, ToolExecuteCallbacks } from './MicaTool';
import { backupFile } from '../utils/fileHistory.js';
import { truncateDisplayText } from '../utils/display.js';

export class ToolEditFile extends MicaTool {
  constructor() {
    super('edit_file', '通过精确字符串替换编辑文件。', {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '要替换的字符串' },
        new_string: { type: 'string', description: '替换后的字符串' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    });
  }

  async execute(input: {
    file_path: string;
    old_string: string;
    new_string: string;
  }, _callbacks?: ToolExecuteCallbacks): Promise<string> {
    await backupFile(input.file_path);
    const content = await readFile(input.file_path, 'utf-8');
    if (!content.includes(input.old_string)) return `未找到匹配文本`;
    const newContent = content.replace(input.old_string, input.new_string);
    await writeFile(input.file_path, newContent);
    return `编辑成功: ${input.file_path}`;
  }

  onToolUseDisplayText(input: Record<string, any>): string {
    return `edit ${truncateDisplayText(input.file_path as string, 5)}`;
  }
  
}
