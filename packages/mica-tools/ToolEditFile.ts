import { readFile, writeFile } from 'fs/promises';
import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import { truncateDisplayText } from './utils/display.js';
import { backupFile } from './utils/fileHistory.js';

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

  async execute(
    input: {
      file_path: string;
      old_string: string;
      new_string: string;
    },
    _callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    if (input.old_string.length === 0) return '编辑失败：old_string 不能为空';
    const content = await readFile(input.file_path, 'utf-8');
    if (!content.includes(input.old_string)) return `未找到匹配文本`;
    const occurrences = countOccurrences(content, input.old_string);
    if (occurrences > 1) {
      return `找到 ${occurrences} 处匹配文本。请提供更长的 old_string，使匹配唯一。`;
    }
    const newContent = content.replace(input.old_string, input.new_string);
    await backupFile(input.file_path);
    await writeFile(input.file_path, newContent);
    return `编辑成功: ${input.file_path}`;
  }

  onToolUseDisplayText(input: Record<string, any>): string {
    return `edit ${truncateDisplayText(input.file_path as string, 5)}`;
  }
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(needle, index);
    if (index === -1) return count;
    count++;
    index += needle.length;
  }
}
