import type Anthropic from '@anthropic-ai/sdk';

import { ToolReadFile } from './ToolReadFile';
import { ToolWriteFile } from './ToolWriteFile';
import { ToolEditFile } from './ToolEditFile';
import { ToolListFiles } from './ToolListFiles';
import { ToolGrepSearch } from './ToolGrepSearch';

import { MicaTool } from './MicaTool';
import { ToolRunShell } from './ToolRunShell';
import type { ToolExecuteCallbacks } from './MicaTool';
import { backupFile } from '../utils/fileHistory.js';

const tools: MicaTool[] = [
  new ToolReadFile(),
  new ToolWriteFile(),
  new ToolEditFile(),
  new ToolListFiles(),
  new ToolGrepSearch(),
  new ToolRunShell(),
];

export const toolDefinitions: Anthropic.Tool[] = tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}));

export async function executeTool(name: string, input: Record<string, any>, callbacks?: ToolExecuteCallbacks): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `未知工具: ${name}`;

  try {
    if (name === 'write_file' || name === 'edit_file') {
      await backupFile(input.file_path as string);
    }
    return await tool.execute(input, callbacks);
  } catch (error) {
    const message =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : typeof error === 'string'
          ? error
          : JSON.stringify(error);
    const maxLen = 2000;
    const truncated = message.length > maxLen ? `${message.slice(0, maxLen)}\n...(截断)` : message;
    return `工具 ${name} 执行失败：\n${truncated}`;
  }
}
export function getToolDisplayText(name: string, input: Record<string, any>): string {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `未知工具: ${name}`;
  try {
    return tool.onToolUseDisplayText(input);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return `工具 ${name} onToolUseDisplayText 执行失败：\n${message}`;
  }
}
